"""HTTP job server (src/server.py): submission, one-at-a-time execution, run directories and
locks, typed errors, and an end-to-end job through the real pipeline (cached alignments)."""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from src.errors import ConfigError, OffScriptError
from src.pipeline import analyze
from src.server import create_app

CONFIG = "config.yaml"
TEXT = b"Four score and seven years ago our fathers brought forth."


def wav_bytes(freq: float = 220.0, seconds: float = 3.0) -> bytes:
    t = np.arange(int(seconds * 16000)) / 16000
    buf = io.BytesIO()
    sf.write(buf, 0.3 * np.sin(2 * np.pi * freq * t), 16000, subtype="PCM_16", format="WAV")
    return buf.getvalue()


def upload(n_refs: int = 2, transcript: bool = True, **form):
    files = [("audio", ("talk.wav", wav_bytes(220), "audio/wav"))]
    files += [("references", (f"good {i}.wav", wav_bytes(330 + 110 * i), "audio/wav")) for i in range(n_refs)]
    if transcript:
        files.append(("transcript", ("script.txt", TEXT, "text/plain")))
    return {"files": files, "data": form}


class FakeRunner:
    """Stands in for src.pipeline.analyze: records calls and concurrency; can block or fail."""

    def __init__(self, error: Exception | None = None, gate: threading.Event | None = None):
        self.error, self.gate = error, gate
        self.calls, self.active, self.max_active = [], 0, 0
        self._lock = threading.Lock()

    def __call__(self, **kw):
        with self._lock:
            self.calls.append(kw)
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            assert (Path(kw["runs_dir"]) / kw["run_id"] / ".job.lock").exists(), "job runs under its lock"
            if self.gate is not None:
                assert self.gate.wait(10)
            if self.error is not None:
                raise self.error
            return {"run_id": kw["run_id"], "n_flaws": 0}
        finally:
            with self._lock:
                self.active -= 1


@pytest.fixture
def make_client(tmp_path):
    clients = []

    def make(runner, config=CONFIG):
        c = TestClient(create_app(config, tmp_path / "runs", runner))
        c.__enter__()
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.__exit__(None, None, None)


def wait(client, run_id):
    return client.app.state.jobs.wait(run_id, timeout=120)


# ---------------------------------------------------------------- submission


def test_post_returns_a_run_id_immediately_and_jobs_run_one_at_a_time(make_client, tmp_path):
    gate = threading.Event()
    runner = FakeRunner(gate=gate)
    client = make_client(runner)
    ids = []
    for _ in range(3):
        r = client.post("/analyze", **upload())
        assert r.status_code == 202, r.text
        ids.append(r.json()["run_id"])
    assert len(set(ids)) == 3 and r.json()["status_url"] == f"/status/{ids[-1]}"
    for _ in range(200):  # until the worker has taken the first job (it then blocks on the gate)
        if runner.calls:
            break
        threading.Event().wait(0.01)
    states = [client.get(f"/status/{i}").json() for i in ids]
    assert [s["state"] for s in states] == ["running", "queued", "queued"]
    assert [s["queue_position"] for s in states] == [0, 1, 2]
    for i in ids:
        assert (tmp_path / "runs" / i / ".job.lock").exists()
    r = client.get(f"/results/{ids[2]}")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_finished"
    gate.set()
    for i in ids:
        assert wait(client, i)["state"] == "succeeded"
        assert not (tmp_path / "runs" / i / ".job.lock").exists()
    assert runner.max_active == 1
    assert [c["run_id"] for c in runner.calls] == ids  # FIFO


def test_uploads_are_passed_to_the_pipeline(make_client, tmp_path):
    runner = FakeRunner()
    client = make_client(runner)
    r = client.post("/analyze", **upload(reference_ids=["good_01", "good_02"], speech_id="my-talk", take_id="take_1"))
    run_id = r.json()["run_id"]
    job = wait(client, run_id)
    kw = runner.calls[0]
    up = tmp_path / "runs" / run_id / "upload"
    assert kw["audio"] == up / "recording.wav" and kw["transcript"] == up / "transcript.txt"
    assert kw["references"] == [up / "reference_01.wav", up / "reference_02.wav"]
    assert kw["reference_ids"] == ["good_01", "good_02"] and kw["reference_names"] == ["good 0.wav", "good 1.wav"]
    assert (kw["speech_id"], kw["take_id"], kw["name"]) == ("my-talk", "take_1", "talk.wav")
    assert kw["config"] == CONFIG and "fail_on_off_script" not in kw  # the off-script stop is the config's
    assert (up / "recording.wav").read_bytes() == wav_bytes(220) and (up / "transcript.txt").read_bytes() == TEXT
    assert job["request"]["bytes"]["transcript"] == len(TEXT)


@pytest.mark.parametrize("kw,match", [
    ({"n_refs": 0}, "exactly one"),
    ({"references_from": "speech_01"}, "exactly one"),
    ({"transcript": False}, "transcript file is required"),
])
def test_malformed_requests_are_rejected_without_a_job(make_client, tmp_path, kw, match):
    client = make_client(FakeRunner())
    r = client.post("/analyze", **upload(**kw))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "invalid_input" and match in r.json()["detail"]["message"]
    assert not list((tmp_path / "runs").glob("job-*"))


def test_oversized_upload(make_client, tmp_path):
    cfg = tmp_path / "config.yaml"
    raw = Path(CONFIG).read_text(encoding="utf-8")
    assert "  max_upload_mb: 200" in raw
    cfg.write_text(raw.replace("  max_upload_mb: 200", "  max_upload_mb: 0.05"), encoding="utf-8")
    client = make_client(FakeRunner(), config=cfg)
    r = client.post("/analyze", **upload())  # 3 s of 16-bit audio = 96 kB > 50 kB
    assert r.status_code == 413 and r.json()["detail"]["code"] == "upload_too_large"
    assert not list((tmp_path / "runs").glob("job-*")), "rejected uploads leave no run directory"


def test_empty_upload(make_client, tmp_path):
    client = make_client(FakeRunner())
    req = upload()
    req["files"][-1] = ("transcript", ("script.txt", b"", "text/plain"))
    r = client.post("/analyze", **req)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "empty_upload"
    assert "script.txt" in r.json()["detail"]["message"]
    assert not list((tmp_path / "runs").glob("job-*"))


def test_queue_limit(make_client, tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(Path(CONFIG).read_text(encoding="utf-8").replace("  max_queued: 16", "  max_queued: 1"),
                   encoding="utf-8")
    gate = threading.Event()
    client = make_client(FakeRunner(gate=gate), config=cfg)
    first = client.post("/analyze", **upload()).json()["run_id"]
    r = client.post("/analyze", **upload())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "busy"
    gate.set()
    wait(client, first)
    assert client.post("/analyze", **upload()).status_code == 202


def test_unknown_runs(make_client):
    client = make_client(FakeRunner())
    for path in ("/status/job-nope", "/results/job-nope", "/status/..", "/status/Run", "/results/job-nope/audio/x.flac"):
        r = client.get(path)
        assert r.status_code == 404, path


# -------------------------------------------------------------------- errors


@pytest.mark.parametrize("error,http,code", [
    (OffScriptError("talk.wav does not follow the transcript: 35%", stage="align", detail={"wer": 0.35}), 422, "off_script"),
    (ConfigError("alignment.asr_qc is false", stage="align"), 500, "invalid_config"),
    (KeyError("boom"), 500, "internal_error"),
])
def test_failed_jobs_report_the_typed_error(make_client, error, http, code):
    runner = FakeRunner(error=error)
    client = make_client(runner)
    run_id = client.post("/analyze", **upload()).json()["run_id"]
    assert wait(client, run_id)["state"] == "failed"
    st = client.get(f"/status/{run_id}").json()
    assert st["state"] == "failed" and st["error"]["code"] == code and st["results_url"] is None
    r = client.get(f"/results/{run_id}")
    assert r.status_code == http and r.json()["detail"]["code"] == code
    if code == "off_script":
        assert r.json()["detail"]["detail"]["wer"] == 0.35 and r.json()["detail"]["stage"] == "align"
    runner.error = None  # the worker survives a failed job
    nxt = client.post("/analyze", **upload()).json()["run_id"]
    assert wait(client, nxt)["state"] == "succeeded"


# ------------------------------------------------------------- server life


def test_one_server_per_runs_directory(make_client, tmp_path):
    make_client(FakeRunner())
    other = TestClient(create_app(CONFIG, tmp_path / "runs", FakeRunner()))
    with pytest.raises(RuntimeError, match="another RhetorTrace server"):
        other.__enter__()


def test_jobs_of_a_stopped_server_are_marked_interrupted(tmp_path):
    runs = tmp_path / "runs"
    for run_id, state in (("job-a", "queued"), ("job-b", "running"), ("job-c", "succeeded")):
        (runs / run_id).mkdir(parents=True)
        (runs / run_id / ".job.lock").write_text("1")
        (runs / run_id / "job.json").write_text(json.dumps({
            "run_id": run_id, "state": state, "submitted_at": "t", "started_at": None, "finished_at": None,
            "error": None, "result": None}), encoding="utf-8")
    with TestClient(create_app(CONFIG, runs, FakeRunner())) as client:
        for run_id in ("job-a", "job-b"):
            st = client.get(f"/status/{run_id}").json()
            assert st["state"] == "failed" and st["error"]["code"] == "interrupted"
            assert not (runs / run_id / ".job.lock").exists()
        assert client.get("/status/job-c").json()["state"] == "succeeded"


# ------------------------------------------------------ real pipeline (cached)

DATA = Path("dataset/speech_01")
needs_dataset = pytest.mark.skipif(
    not all((DATA / "audio" / f"{t}.wav").exists() for t in ("synth_01", "good_01", "good_03")),
    reason="dataset audio not available")


def dataset_upload(refs=("good_01", "good_03")):
    files = [("audio", ("synth_01.wav", (DATA / "audio" / "synth_01.wav").read_bytes(), "audio/wav")),
             ("transcript", ("transcript.txt", (DATA / "transcript.txt").read_bytes(), "text/plain"))]
    files += [("references", (f"{r}.wav", (DATA / "audio" / f"{r}.wav").read_bytes(), "audio/wav")) for r in refs]
    return {"files": files, "data": {"reference_ids": list(refs), "speech_id": "speech_01", "take_id": "synth_01"}}


@needs_dataset
def test_end_to_end_job_matches_the_cli(make_client, tmp_path):
    from src.analyze import main as cli

    client = make_client(analyze)
    r = client.post("/analyze", **dataset_upload())
    assert r.status_code == 202
    run_id = r.json()["run_id"]
    assert wait(client, run_id)["state"] == "succeeded", client.get(f"/status/{run_id}").json()
    st = client.get(f"/status/{run_id}").json()
    assert [s["state"] for s in st["stages"]] == ["done"] * 7 and st["results_url"] == f"/results/{run_id}"
    res = client.get(f"/results/{run_id}").json()
    assert res["result"]["id"] == "speech_01__synth_01" and res["result"]["n_flaws"] == len(res["document"]["flaws"])
    run = tmp_path / "runs" / run_id
    assert json.loads((run / "run.json").read_text(encoding="utf-8"))["run_id"] == run_id

    # reproducibility: the CLI on the same files gives the same take document and audio
    cli_runs = tmp_path / "cli"
    assert cli(["--audio", str(DATA / "audio" / "synth_01.wav"), "--transcript", str(DATA / "transcript.txt"),
                "--ref", str(DATA / "audio" / "good_01.wav"), "--ref", str(DATA / "audio" / "good_03.wav"),
                "--ref-id", "good_01", "--ref-id", "good_03", "--speech-id", "speech_01", "--take-id", "synth_01",
                "--name", "synth_01.wav", "--runs-dir", str(cli_runs)]) == 0
    cli_run = next(cli_runs.iterdir())
    cli_doc = json.loads((cli_run / "export" / "data" / "speech_01__synth_01.json").read_text(encoding="utf-8"))
    names = {"good_01": "good_01.wav", "good_03": "good_03.wav"}  # CLI: file names; API: uploaded names
    assert cli_doc["display"]["references"] == names == res["document"]["display"]["references"]
    assert res["document"] == cli_doc
    for name, url in res["audio"].items():
        body = client.get(url)
        assert body.status_code == 200 and body.headers["content-type"] == "audio/flac"
        assert body.content == (cli_run / "export" / "audio" / name).read_bytes()


@needs_dataset
@pytest.mark.parametrize("change,code,stage", [
    ({"refs": ("good_01",)}, "invalid_references", "ingest"),
    ({"silent": True}, "invalid_audio", "ingest"),
])
def test_end_to_end_input_failures(make_client, change, code, stage):
    client = make_client(analyze)
    req = dataset_upload(change.get("refs", ("good_01", "good_03")))
    if change.get("silent"):
        buf = io.BytesIO()
        sf.write(buf, np.zeros(16000 * 3), 16000, subtype="PCM_16", format="WAV")
        req["files"][0] = ("audio", ("silent.wav", buf.getvalue(), "audio/wav"))
    run_id = client.post("/analyze", **req).json()["run_id"]
    assert wait(client, run_id)["state"] == "failed"
    err = client.get(f"/status/{run_id}").json()["error"]
    assert (err["code"], err["kind"], err["stage"]) == (code, "input", stage)
    assert client.get(f"/results/{run_id}").status_code == 422
