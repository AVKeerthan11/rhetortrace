"""HTTP job server around src.pipeline.analyze (FastAPI).

    python -m src.server [--host 127.0.0.1] [--port 8000] [--config config.yaml]

    POST /analyze                 multipart upload -> 202 {"run_id", ...} immediately
         audio=<file>             the recording
         transcript=<file>        UTF-8 text it follows (optional with references_from)
         references=<file>        a good reference recording of the same text (repeat; at least 2)
         references_from=<id>     or: a dataset script's good takes as references
         reference_ids, speech_id, take_id, name   optional, as python -m src.analyze
    GET  /status/{run_id}         job state, queue position, pipeline stages, warnings, error
    GET  /results/{run_id}        the result summary and the exported take document
    GET  /results/{run_id}/audio/{file}   exported FLAC (recording and references)

Every job is ``analyze()`` with its own run id; the server adds no analysis. The
CLI stays the reproducible path: a job's run.json records the request and input
hashes, and the same files given to python -m src.analyze give the same artifacts.

Memory: jobs run one at a time on a single worker thread, and within a job the
aligner and Whisper already run one after the other in short-lived processes
(analysis.low_memory), so at most one ML model process exists at a time. One
server owns a runs directory (an OS-level lock, released if the process dies);
run it with one uvicorn worker (``main`` does). The off-script stop is the
config's (analysis.fail_on_off_script); a request cannot turn it off.

Each job gets a unique run directory ``<runs_dir>/<run_id>/`` holding
  upload/      the files as uploaded
  job.json     job state: queued | running | succeeded | failed, times, error
  .job.lock    exclusive while the job is queued or running
plus everything ``analyze()`` writes (run.json, status.json, input/, ..., export/).
Jobs that were queued or running when a server stopped are marked failed
(code ``interrupted``) when the next server starts.

HTTP status of errors: request problems 400 / 413 / 422, unknown run 404, result
of an unfinished job 409, result of a failed job 422 (input / refused) or 500
(stale / config / internal); the body is always ``{"detail": {...}}`` with the
typed error's ``to_dict()`` fields (code, kind, stage, message, detail).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import secrets
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import yaml
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from src.errors import InputError, PipelineError, RhetorTraceError
from src.pipeline import AnalysisConfig, analyze, check_id, replace_file

SCHEMA_VERSION = 1
HTTP_FOR_KIND = {"input": 422, "refused": 422, "stale": 500, "config": 500, "internal": 500}
SUFFIX_RE = re.compile(r"^\.[a-z0-9]{1,8}$")
CHUNK = 1 << 20


@dataclass(frozen=True)
class ServerConfig:
    max_upload_mb: float = 200.0  # per file
    max_queued: int = 16          # jobs waiting or running; more -> 503

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "ServerConfig":
        with open(path, encoding="utf-8") as f:
            return cls(**((yaml.safe_load(f) or {}).get("server") or {}))


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_run_id() -> str:
    """Unique, sortable, and a valid pipeline id."""
    return f"job-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{secrets.token_hex(4)}"


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json_atomic(path: Path, doc: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    replace_file(tmp, path)


def error_body(err: RhetorTraceError) -> dict:
    return {"detail": err.to_dict()}


# ------------------------------------------------------------------- locking


class DirectoryLock:
    """Exclusive OS-level lock on ``<dir>/.server.lock``; the OS releases it if the process dies."""

    def __init__(self, directory: Path):
        self.path = Path(directory) / ".server.lock"
        self._f = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        f = open(self.path, "a+b")
        try:
            f.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            f.close()
            raise RuntimeError(f"another RhetorTrace server is using {self.path.parent}; "
                               "one server (one worker) per runs directory") from e
        self._f = f

    def release(self) -> None:
        if self._f is None:
            return
        try:
            self._f.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self._f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._f.fileno(), fcntl.LOCK_UN)
        finally:
            self._f.close()
            self._f = None


# ---------------------------------------------------------------------- jobs


class JobQueue:
    """FIFO of analysis jobs executed one at a time by a single worker thread."""

    def __init__(self, runs_dir: Path, config: str | Path, runner: Callable[..., dict]):
        self.runs_dir, self.config, self.runner = Path(runs_dir), config, runner
        self._q: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._pending: list[str] = []  # queued, in order
        self._running: str | None = None
        self._thread: threading.Thread | None = None

    # -- job files
    def run_dir(self, run_id: str) -> Path:
        return self.runs_dir / run_id

    def job(self, run_id: str) -> dict | None:
        return read_json(self.run_dir(run_id) / "job.json")

    def _update(self, run_id: str, /, **fields) -> dict:
        path = self.run_dir(run_id) / "job.json"
        doc = {**(read_json(path) or {}), **fields}
        write_json_atomic(path, doc)
        return doc

    def create(self) -> tuple[str, Path]:
        """A new run directory, locked for its job (fails rather than reuse a directory)."""
        for _ in range(5):
            run_id = new_run_id()
            run = self.run_dir(run_id)
            try:
                run.mkdir(parents=True)
            except FileExistsError:
                continue
            fd = os.open(run / ".job.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return run_id, run
        raise PipelineError("could not allocate a unique run directory", stage="submit")

    def _unlock(self, run_id: str) -> None:
        try:
            (self.run_dir(run_id) / ".job.lock").unlink()
        except FileNotFoundError:
            pass

    def discard(self, run_id: str) -> None:
        """Remove a run directory whose request was rejected before it was queued."""
        import shutil
        shutil.rmtree(self.run_dir(run_id), ignore_errors=True)

    # -- queue
    def depth(self) -> int:
        with self._lock:
            return len(self._pending) + (self._running is not None)

    def position(self, run_id: str) -> int | None:
        """0 = running, 1 = next, ...; None when not waiting or running."""
        with self._lock:
            if self._running == run_id:
                return 0
            return self._pending.index(run_id) + 1 if run_id in self._pending else None

    def submit(self, run_id: str, request: dict, kwargs: dict) -> dict:
        doc = self._update(run_id, schema_version=SCHEMA_VERSION, run_id=run_id, state="queued",
                           submitted_at=now(), started_at=None, finished_at=None, request=request, error=None,
                           result=None)
        with self._lock:
            self._pending.append(run_id)
        self._q.put((run_id, kwargs))
        return doc

    def _execute(self, run_id: str, kwargs: dict) -> None:
        with self._lock:
            self._pending.remove(run_id)
            self._running = run_id
        self._update(run_id, state="running", started_at=now())
        try:
            result = self.runner(**kwargs, run_id=run_id, runs_dir=self.runs_dir, config=self.config)
            self._update(run_id, state="succeeded", finished_at=now(), result=result)
        except RhetorTraceError as e:
            self._update(run_id, state="failed", finished_at=now(), error=e.to_dict())
        except Exception as e:  # noqa: BLE001 -- the worker must survive any job
            err = PipelineError(f"{type(e).__name__}: {e}", detail={"type": type(e).__name__})
            self._update(run_id, state="failed", finished_at=now(), error=err.to_dict())
        finally:
            self._unlock(run_id)
            with self._lock:
                self._running = None

    def _work(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            self._execute(*item)

    # -- lifecycle
    def recover(self) -> list[str]:
        """Mark jobs left queued / running by a stopped server as failed (``interrupted``)."""
        lost = []
        for path in sorted(self.runs_dir.glob("*/job.json")):
            doc = read_json(path)
            if doc and doc.get("state") in ("queued", "running"):
                run_id = path.parent.name
                self._update(run_id, state="failed", finished_at=now(), error={
                    "code": "interrupted", "kind": "internal", "stage": doc["state"],
                    "message": "the server stopped before this job finished; submit it again", "detail": {}})
                self._unlock(run_id)
                lost.append(run_id)
        return lost

    def start(self) -> None:
        self._thread = threading.Thread(target=self._work, name="rhetortrace-jobs", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = None) -> None:
        """Finish the running job (a model process cannot be interrupted safely), then stop.
        Jobs still waiting stay "queued"; the next server's recover() marks them interrupted."""
        self._q.put(None)
        if self._thread is not None:
            self._thread.join(timeout)

    def wait(self, run_id: str, timeout: float = 60.0) -> dict:
        """Block until a job is finished (tests, scripts)."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            doc = self.job(run_id)
            if doc and doc["state"] in ("succeeded", "failed"):
                return doc
            time.sleep(0.05)
        raise TimeoutError(run_id)


# ----------------------------------------------------------------------- app


async def save_upload(upload: UploadFile, dst: Path, max_bytes: int) -> int:
    dst.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(dst, "wb") as f:
        while chunk := await upload.read(CHUNK):
            n += len(chunk)
            if n > max_bytes:
                raise HTTPException(413, {"code": "upload_too_large", "kind": "input", "stage": "submit",
                                          "message": f"{upload.filename}: larger than {max_bytes / 2**20:g} MB",
                                          "detail": {"max_bytes": max_bytes}})
            f.write(chunk)
    if n == 0:
        raise HTTPException(400, {"code": "empty_upload", "kind": "input", "stage": "submit",
                                  "message": f"{upload.filename or 'upload'}: the file is empty", "detail": {}})
    return n


def upload_name(upload: UploadFile, fallback: str) -> tuple[str, str]:
    """(display name, safe file suffix) of an upload; the client's path is never used on disk."""
    name = Path((upload.filename or fallback).replace("\\", "/")).name or fallback
    suffix = Path(name).suffix.lower()
    return name, suffix if SUFFIX_RE.match(suffix) else ""


def create_app(config: str | Path = "config.yaml", runs_dir: str | Path | None = None,
               runner: Callable[..., dict] = analyze) -> FastAPI:
    """The API; ``runner`` is ``src.pipeline.analyze`` (replaceable in tests)."""
    runs = Path(runs_dir or AnalysisConfig.from_yaml(config).runs_dir)
    scfg = ServerConfig.from_yaml(config)
    jobs = JobQueue(runs, config, runner)
    dir_lock = DirectoryLock(runs)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        dir_lock.acquire()
        try:
            jobs.recover()
            jobs.start()
            yield
            jobs.stop()
        finally:
            dir_lock.release()

    app = FastAPI(title="RhetorTrace", version=str(SCHEMA_VERSION), lifespan=lifespan)
    app.state.jobs = jobs

    @app.exception_handler(RhetorTraceError)
    async def typed_error(_, err: RhetorTraceError):
        return JSONResponse(error_body(err), status_code=400 if err.kind == "input" else 500)

    def known(run_id: str) -> dict:
        doc = jobs.job(run_id) if valid_run_id(run_id) else None
        if doc is None:
            raise HTTPException(404, {"code": "unknown_run", "kind": "input", "stage": None,
                                      "message": f"no analysis job {run_id!r}", "detail": {}})
        return doc

    @app.post("/analyze", status_code=202)
    async def submit(audio: UploadFile = File(...), transcript: UploadFile | None = File(None),
                     references: list[UploadFile] = File([]), references_from: str | None = Form(None),
                     reference_ids: list[str] | None = Form(None), speech_id: str | None = Form(None),
                     take_id: str = Form("recording"), name: str | None = Form(None)):
        # request shape only; everything about the content is checked by analyze()
        if bool(references) == bool(references_from):
            raise InputError("give reference recordings (references) or references_from, exactly one",
                             stage="submit")
        if transcript is None and not references_from:
            raise InputError("a transcript file is required", stage="submit")
        if jobs.depth() >= scfg.max_queued:
            raise HTTPException(503, {"code": "busy", "kind": "internal", "stage": "submit",
                                      "message": f"{scfg.max_queued} analyses are queued; try again later",
                                      "detail": {"max_queued": scfg.max_queued}})
        max_bytes = int(scfg.max_upload_mb * 2**20)
        run_id, run = jobs.create()
        try:
            up = run / "upload"
            rec_name, suffix = upload_name(audio, "recording")
            rec_path = up / f"recording{suffix}"
            sizes = {"recording": await save_upload(audio, rec_path, max_bytes)}
            ref_paths, ref_names = [], []
            for i, ref in enumerate(references):
                n, s = upload_name(ref, f"reference {i + 1}")
                ref_paths.append(up / f"reference_{i + 1:02d}{s}")
                ref_names.append(n)
                sizes[f"reference_{i + 1:02d}"] = await save_upload(ref, ref_paths[-1], max_bytes)
            text_path = None
            if transcript is not None:
                text_path = up / "transcript.txt"
                sizes["transcript"] = await save_upload(transcript, text_path, max_bytes)
        except BaseException:
            jobs.discard(run_id)
            raise
        kwargs = {"audio": rec_path, "transcript": text_path, "references": ref_paths,
                  "references_from": references_from, "speech_id": speech_id, "take_id": take_id,
                  "reference_ids": reference_ids or None, "name": name or rec_name,
                  "reference_names": ref_names or None}
        request = {"recording": rec_name, "references": ref_names, "references_from": references_from,
                   "reference_ids": reference_ids or None, "speech_id": speech_id, "take_id": take_id,
                   "transcript": transcript.filename if transcript else None, "bytes": sizes}
        doc = jobs.submit(run_id, request, kwargs)
        return {"run_id": run_id, "state": doc["state"], "queue_position": jobs.position(run_id),
                "status_url": f"/status/{run_id}", "results_url": f"/results/{run_id}"}

    @app.get("/status/{run_id}")
    def status(run_id: str):
        job = known(run_id)
        pipe = read_json(jobs.run_dir(run_id) / "status.json") or {}
        return {"run_id": run_id, "state": job["state"], "queue_position": jobs.position(run_id),
                "submitted_at": job["submitted_at"], "started_at": job["started_at"],
                "finished_at": job["finished_at"], "stage": pipe.get("stage"), "stages": pipe.get("stages"),
                "warnings": pipe.get("warnings", []), "error": job["error"],
                "results_url": f"/results/{run_id}" if job["state"] == "succeeded" else None}

    @app.get("/results/{run_id}")
    def results(run_id: str):
        job = known(run_id)
        if job["state"] == "failed":
            err = job["error"]
            raise HTTPException(HTTP_FOR_KIND.get(err["kind"], 500), err)
        if job["state"] != "succeeded":
            raise HTTPException(409, {"code": "not_finished", "kind": "input", "stage": None,
                                      "message": f"the analysis is {job['state']}", "detail": {"state": job["state"]}})
        res = job["result"]
        document = read_json(Path(res["artifact"]))
        if document is None:
            raise HTTPException(500, {"code": "missing_artifact", "kind": "internal", "stage": "export",
                                      "message": "the exported document is missing", "detail": {}})
        audio = sorted(p.name for p in (jobs.run_dir(run_id) / "export" / "audio").glob("*.flac"))
        return {"run_id": run_id, "result": {k: v for k, v in res.items() if k not in ("run_dir", "artifact", "index")},
                "document": document, "audio": {n: f"/results/{run_id}/audio/{n}" for n in audio}}

    @app.get("/results/{run_id}/audio/{file}")
    def audio_file(run_id: str, file: str):
        job = known(run_id)
        path = jobs.run_dir(run_id) / "export" / "audio" / file
        if job["state"] != "succeeded" or not re.fullmatch(r"[a-z0-9_-]+\.flac", file) or not path.is_file():
            raise HTTPException(404, {"code": "unknown_file", "kind": "input", "stage": None,
                                      "message": f"no exported audio {file!r}", "detail": {}})
        return FileResponse(path, media_type="audio/flac")

    return app


def valid_run_id(run_id: str) -> bool:
    try:
        check_id(run_id, "run id")
        return True
    except InputError:
        return False


def main(argv: list[str] | None = None) -> int:
    import uvicorn

    p = argparse.ArgumentParser(prog="python -m src.server", description=__doc__.split("\n\n")[0])
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--runs-dir", help="default: analysis.runs_dir")
    a = p.parse_args(argv)
    uvicorn.run(create_app(a.config, a.runs_dir), host=a.host, port=a.port, workers=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
