"""New-recording orchestration (src/pipeline.py, src/analyze.py): request validation, gates,
error reporting, explicit references and baseline staleness. No aligner runs here; the
end-to-end path is covered by tests/test_golden_path.py."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from src.alignment import AlignmentConfig
from src.analyze import main as cli
from src.baseline import BaselineConfig, check_baseline_fresh
from src.detection import baseline_for
from src.errors import (AlignmentQCError, ConfigError, InputError, ModelWorkerError, OffScriptError,
                        ReferencesError, StaleArtifactError, TranscriptError, require_schema)
from src.export import upsert_index
from src.pipeline import Recording, alignment_gate, analyze, check_id, default_run_id, versions

CONFIG = "config.yaml"
ALIGN = AlignmentConfig.from_yaml(CONFIG)
REC = Recording("recording", Path("talk.wav"), "talk.wav", "recording")


def wav(path: Path, freq: float = 220.0, seconds: float = 3.0) -> Path:
    t = np.arange(int(seconds * 16000)) / 16000
    sf.write(path, 0.3 * np.sin(2 * np.pi * freq * t), 16000, subtype="PCM_16")
    return path


@pytest.fixture
def inputs(tmp_path):
    text = tmp_path / "script.txt"
    text.write_text("Four score and seven years ago our fathers brought forth.", encoding="utf-8")
    return {"rec": wav(tmp_path / "talk.wav", 220), "refs": [wav(tmp_path / "r1.wav", 330), wav(tmp_path / "r2.wav", 440)],
            "text": text, "runs": tmp_path / "runs"}


# ---------------------------------------------------------------------- ids


@pytest.mark.parametrize("ok", ["recording", "ref_01", "speech_01", "a", "my-talk-2"])
def test_valid_ids(ok):
    assert check_id(ok, "id") == ok


@pytest.mark.parametrize("bad", ["", "Talk", "a__b", "x/y", "../up", "_lead", "a b", "x" * 49])
def test_invalid_ids(bad):
    with pytest.raises(InputError, match="not a valid id"):
        check_id(bad, "id")


def test_run_id_is_a_function_of_the_inputs():
    parts = {"recording": ["recording", "a" * 64], "config": "c"}
    assert default_run_id(parts) == default_run_id(dict(reversed(list(parts.items()))))
    assert default_run_id(parts) != default_run_id({**parts, "config": "d"})


# -------------------------------------------------------------------- gates


def quality(status="pass", wer=0.05, errors=(), warnings=()):
    return {"quality": {"status": status, "errors": list(errors), "warnings": list(warnings), "aligned_ratio": 0.9,
                        "asr": None if wer is None else {"wer": wer, "n_unmatched": 3, "unmatched_idx": [0, 2]}},
            "words": [{"text": "Four"}, {"text": "score"}, {"text": "and"}]}


def test_failed_alignment_stops():
    with pytest.raises(AlignmentQCError) as e:
        alignment_gate(quality("fail", errors=["aligned ratio 0.6 < 0.95"]), REC, ALIGN, True)
    assert e.value.code == "alignment_failed" and e.value.kind == "refused"
    assert e.value.detail["errors"] == ["aligned ratio 0.6 < 0.95"]


def test_off_script_recording_stops_by_default():
    with pytest.raises(OffScriptError, match="does not follow the transcript: 35%") as e:
        alignment_gate(quality(wer=0.35), REC, ALIGN, True)
    assert e.value.code == "off_script" and e.value.detail["max_wer"] == ALIGN.qc.max_asr_wer == 0.20
    assert e.value.detail["unmatched_words"] == ["Four", "and"]


def test_wer_at_the_limit_continues():
    assert alignment_gate(quality(wer=0.20), REC, ALIGN, True) == []


def test_off_script_gate_is_configurable():
    assert alignment_gate(quality(wer=0.35, warnings=["ASR WER 0.350 > 0.2"]), REC, ALIGN, False) == \
        ["talk.wav: ASR WER 0.350 > 0.2"]


def test_missing_asr_result_cannot_bypass_the_off_script_stop():
    with pytest.raises(ConfigError, match="off-script check cannot run") as e:
        alignment_gate(quality(wer=None), REC, ALIGN, True)
    assert e.value.kind == "config"
    assert "off-script check skipped" in alignment_gate(quality(wer=None), REC, ALIGN, False)[0]


def test_disabled_asr_check_with_the_stop_on_is_refused_before_a_run(inputs, tmp_path, capsys):
    raw = Path(CONFIG).read_text(encoding="utf-8")
    assert "  asr_qc: true" in raw
    cfg = tmp_path / "config.yaml"
    cfg.write_text(raw.replace("  asr_qc: true", "  asr_qc: false"), encoding="utf-8")
    with pytest.raises(ConfigError, match="alignment.asr_qc is false"):
        analyze(inputs["rec"], inputs["text"], inputs["refs"], runs_dir=inputs["runs"], config=cfg)
    assert not inputs["runs"].exists()
    code = cli(["--audio", str(inputs["rec"]), "--transcript", str(inputs["text"]), "--ref", str(inputs["refs"][0]),
                "--ref", str(inputs["refs"][1]), "--runs-dir", str(inputs["runs"]), "--config", str(cfg), "--json"])
    assert code == 5 and json.loads(capsys.readouterr().out)["error"]["code"] == "invalid_config"


# --------------------------------------------------------- request checks


def test_too_few_references(inputs):
    with pytest.raises(ReferencesError, match="at least 2"):
        analyze(inputs["rec"], inputs["text"], inputs["refs"][:1], runs_dir=inputs["runs"], config=CONFIG)
    assert not inputs["runs"].exists()  # rejected before a run folder is created


def test_references_and_references_from_are_exclusive(inputs):
    with pytest.raises(InputError, match="either"):
        analyze(inputs["rec"], inputs["text"], inputs["refs"], references_from="speech_01", config=CONFIG)


def test_missing_files_and_duplicate_ids(inputs):
    with pytest.raises(InputError, match="not found"):
        analyze(inputs["rec"].with_name("nope.wav"), inputs["text"], inputs["refs"], config=CONFIG)
    with pytest.raises(InputError, match="different"):
        analyze(inputs["rec"], inputs["text"], inputs["refs"], reference_ids=["recording", "ref_02"], config=CONFIG)
    with pytest.raises(TranscriptError, match="required"):
        analyze(inputs["rec"], None, inputs["refs"], config=CONFIG)


def test_identical_audio_is_rejected_and_reported_in_status(inputs):
    with pytest.raises(ReferencesError, match="same audio") as e:
        analyze(inputs["rec"], inputs["text"], [inputs["rec"], inputs["refs"][0]], runs_dir=inputs["runs"],
                run_id="dup", config=CONFIG)
    status = json.loads((inputs["runs"] / "dup" / "status.json").read_text(encoding="utf-8"))
    assert status["state"] == "failed" and status["error"]["code"] == "invalid_references"
    assert status["error"]["stage"] == "ingest" == e.value.stage
    assert [s["state"] for s in status["stages"]][:2] == ["failed", "pending"]


def test_silent_reference_is_rejected_at_ingest(inputs, tmp_path):
    silent = tmp_path / "silent.wav"
    sf.write(silent, np.zeros(16000 * 3), 16000, subtype="PCM_16")
    with pytest.raises(InputError, match="silent"):
        analyze(inputs["rec"], inputs["text"], [inputs["refs"][0], silent], runs_dir=inputs["runs"], config=CONFIG)


@pytest.mark.skipif(not Path("dataset/speech_01/transcript.txt").exists(), reason="dataset not available")
def test_transcript_must_match_the_reference_script(inputs):
    with pytest.raises(TranscriptError, match=r"differs from speech_01's script in length \(10 words") as e:
        analyze(inputs["rec"], inputs["text"], references_from="speech_01", runs_dir=inputs["runs"], config=CONFIG)
    assert e.value.detail["script"][:2] == ["on", "this"]
    inputs["text"].write_text("Four score and twenty years ago our fathers brought forth.", encoding="utf-8")
    with pytest.raises(TranscriptError, match="at word 4") as e:
        analyze(inputs["rec"], inputs["text"], references_from="speech_01", runs_dir=inputs["runs"], config=CONFIG)
    assert e.value.detail["given"][0] == "twenty" and e.value.detail["script"][0] == "seven"


# ------------------------------------------------------ explicit references


@pytest.fixture(scope="module")
def dataset_cfgs():
    if not Path("results/baselines/speech_01.baseline.json").exists():
        pytest.skip("cached results not available")
    return BaselineConfig.from_yaml(CONFIG), ALIGN


def test_explicit_references_equal_the_demo_leave_one_out_baseline(dataset_cfgs):
    base, align = dataset_cfgs
    legacy, src = baseline_for("speech_01", "synth_01", base, align)
    explicit, label = baseline_for("speech_01", "synth_01", base, align, references=["good_03", "good_01"])
    assert src == "leave-one-out:good_02" and label == "references:good_01,good_03"
    assert explicit == legacy


def test_explicit_reference_errors(dataset_cfgs):
    base, align = dataset_cfgs
    with pytest.raises(ReferencesError, match="its own reference"):
        baseline_for("speech_01", "good_01", base, align, references=["good_01", "good_02", "good_03"])
    with pytest.raises(ReferencesError, match="need at least 2"):
        baseline_for("speech_01", "synth_01", base, align, references=["good_01", "good_03"], exclude=("good_03",))
    with pytest.raises(ReferencesError, match="no alignment"):
        baseline_for("speech_01", "synth_01", base, align, references=["good_01", "nope_01"])
    with pytest.raises(ReferencesError, match="duplicate"):
        baseline_for("speech_01", "synth_01", base, align, references=["good_01", "good_01"])


# ----------------------------------------------------------------- staleness


def test_stale_baseline_is_detected(dataset_cfgs, tmp_path):
    base, align = dataset_cfgs
    doc = json.loads(Path("results/baselines/speech_01.baseline.json").read_text(encoding="utf-8"))
    assert check_baseline_fresh(doc, align) is doc
    stale = {**doc, "references": [{**doc["references"][0], "alignment_cache_key": "0" * 64}, *doc["references"][1:]]}
    with pytest.raises(StaleArtifactError, match="good_01 was re-aligned") as e:
        check_baseline_fresh(stale, align)
    assert isinstance(e.value, RuntimeError) and e.value.code == "stale_artifact"
    (tmp_path / "speech_01.baseline.json").write_text(json.dumps(stale), encoding="utf-8")
    with pytest.raises(StaleArtifactError):  # the dataset workflow refuses a stale cached baseline
        baseline_for("speech_01", "synth_01", replace(base, output_dir=str(tmp_path)), align)


def test_schema_versions_are_checked():
    doc = {"schema_version": 1}
    assert require_schema(doc, 1, "x") is doc
    with pytest.raises(StaleArtifactError, match="schema version 0") as e:
        require_schema({"schema_version": 0}, 1, "x", "export")
    assert e.value.detail == {"artifact": "x", "found": 0, "expected": 1} and e.value.stage == "export"


def test_cached_feature_of_another_schema_or_alignment_is_stale(dataset_cfgs, tmp_path):
    base, align = dataset_cfgs
    from src.baseline import SOURCES, load_take
    src_dir, dst = Path(base.features_dir) / "speech_01", tmp_path / "speech_01"
    dst.mkdir()
    for source in SOURCES:
        (dst / f"good_01.{source}.json").write_bytes((src_dir / f"good_01.{source}.json").read_bytes())
    cfg = replace(base, features_dir=str(tmp_path))
    assert load_take("speech_01", "good_01", cfg, align)["take_id"] == "good_01"
    path = dst / "good_01.rate.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**doc, "alignment_cache_key": "0" * 64}), encoding="utf-8")
    with pytest.raises(StaleArtifactError, match="stale for the current alignment"):
        load_take("speech_01", "good_01", cfg, align)
    path.write_text(json.dumps({**doc, "schema_version": 0}), encoding="utf-8")
    with pytest.raises(StaleArtifactError, match="schema version 0"):
        load_take("speech_01", "good_01", cfg, align)
    bdoc = json.loads(Path("results/baselines/speech_01.baseline.json").read_text(encoding="utf-8"))
    with pytest.raises(StaleArtifactError, match="schema version"):
        check_baseline_fresh({**bdoc, "schema_version": 99}, align)


def test_versions_cover_every_stage():
    v = versions()
    assert set(v) == {"pipeline", "alignment", "features", "baseline", "detection", "flaws", "whisperx"}
    assert set(v["features"]) == {"pitch", "energy", "rate", "pause", "spectral"}


# ------------------------------------------------------------- model worker


@pytest.mark.parametrize("returncode,stderr,oom", [
    (1, "Traceback ...\nRuntimeError: [enforce fail at alloc_cpu.cpp] DefaultCPUAllocator: not enough memory: "
        "you tried to allocate 1 bytes. out of memory", True),
    (0xC0000017, "", True),
    (1, "Traceback ...\nFileNotFoundError: model", False),
])
def test_model_worker_failure_is_typed(monkeypatch, tmp_path, returncode, stderr, oom):
    import subprocess

    from src import alignment

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, returncode, "", stderr))
    with pytest.raises(ModelWorkerError) as e:
        alignment._isolated("asr", tmp_path / "a.wav", tmp_path / "t.txt", ALIGN)
    assert e.value.code == "model_failed" and e.value.stage == "align" and e.value.detail["task"] == "asr"
    assert e.value.detail["out_of_memory"] is oom and ("out of memory" in e.value.message) is oom


# --------------------------------------------------------------------- index


def test_upsert_index_adds_replaces_and_keeps_validation(tmp_path):
    path = tmp_path / "index.json"
    path.write_text(json.dumps({"takes": [{"id": "s__good_01", "kind": "control", "speech_id": "s", "take_id": "good_01"}],
                                "validation": {"x": 1}}), encoding="utf-8")
    entry = {"id": "s__recording", "kind": "user", "speech_id": "s", "take_id": "recording", "score": 1}
    upsert_index(path, entry)
    idx = upsert_index(path, {**entry, "score": 2})
    assert [t["id"] for t in idx["takes"]] == ["s__recording", "s__good_01"]
    assert idx["takes"][0]["score"] == 2 and idx["validation"] == {"x": 1}


# ----------------------------------------------------------------------- CLI


def test_cli_reports_errors_as_json_with_exit_codes(inputs, capsys):
    code = cli(["--audio", str(inputs["rec"]), "--transcript", str(inputs["text"]), "--ref", str(inputs["refs"][0]),
                "--runs-dir", str(inputs["runs"]), "--json"])
    out = json.loads(capsys.readouterr().out)
    assert code == 2 and out["ok"] is False and out["error"]["code"] == "invalid_references"
    code = cli(["--audio", str(inputs["rec"]), "--transcript", str(inputs["text"]), "--ref", str(inputs["rec"]),
                "--ref", str(inputs["refs"][0]), "--runs-dir", str(inputs["runs"])])
    assert code == 2 and "same audio" in capsys.readouterr().err
