"""Run one model step of src.alignment in this (short-lived) process.

    python -m src.model_worker <align|asr> <request.json> <response.json>

Request: {"audio": path, "transcript": path, "cfg": AlignmentConfig fields}. The
response is the step's return value as JSON (the aligner's word dicts / the ASR
text). Used by ``build_alignment_doc(isolate_models=True)``: the same functions on
the same inputs, but the model's memory goes back to the OS when the process exits.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from src.alignment import AlignmentConfig, QCThresholds, load_audio, run_asr, run_forced_alignment
from src.transcript import load_transcript


def _plain(x):
    """numpy scalars -> Python numbers (float32 -> float64 is exact; JSON round-trips float64 exactly)."""
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_plain(v) for v in x]
    if hasattr(x, "item"):
        return x.item()
    return x


def main(argv: list[str]) -> int:
    task, request, response = argv
    req = json.loads(Path(request).read_text(encoding="utf-8"))
    cfg = AlignmentConfig(**{**req["cfg"], "qc": QCThresholds(**req["cfg"]["qc"])})
    audio = load_audio(req["audio"])
    if task == "align":
        out = run_forced_alignment(audio, load_transcript(req["transcript"]), cfg)
    elif task == "asr":
        out = run_asr(audio, cfg)
    else:
        raise SystemExit(f"unknown task {task!r}")
    Path(response).write_text(json.dumps(_plain(out), ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
