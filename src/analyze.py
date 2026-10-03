"""Analyse a new recording from the command line (src.pipeline.analyze).

    python -m src.analyze --audio talk.wav --transcript script.txt --ref good1.wav --ref good2.wav
    python -m src.analyze --audio talk.mp3 --references-from speech_01
    python -m src.analyze ... --json        # one JSON object: the result, or the error

Exit codes: 0 analysed; 2 invalid input (files, ids, transcript, references);
3 refused (alignment failed, or the recording does not follow the transcript);
4 stale cached artifacts (or written by another schema version); 5 inconsistent
config.yaml; 1 internal error (including a model process that crashed or ran
out of memory: error code ``model_failed``).
"""

from __future__ import annotations

import argparse
import json
import sys

from src.errors import RhetorTraceError
from src.pipeline import analyze

EXIT = {"input": 2, "refused": 3, "stale": 4, "config": 5, "internal": 1}


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    p = argparse.ArgumentParser(prog="python -m src.analyze", description=__doc__.split("\n\n")[0])
    p.add_argument("--audio", required=True, help="the recording to analyse")
    p.add_argument("--transcript", help="UTF-8 text the recording follows (default with --references-from: the script's)")
    p.add_argument("--ref", action="append", default=[], metavar="AUDIO",
                   help="a good reference recording of the same transcript (repeat; at least 2)")
    p.add_argument("--ref-id", action="append", default=None, metavar="ID", help="id per --ref (default ref_01, ...)")
    p.add_argument("--references-from", metavar="SCRIPT", help="use a dataset script's good takes as references")
    p.add_argument("--speech-id", help="script id (default: --references-from, else 'script')")
    p.add_argument("--take-id", default="recording", help="recording id (default 'recording')")
    p.add_argument("--name", help="display name of the recording (default: file name)")
    p.add_argument("--run-id", help="run folder name (default: derived from the inputs)")
    p.add_argument("--runs-dir", help="where run folders go (default: analysis.runs_dir)")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--allow-off-script", action="store_true",
                   help="do not stop when the ASR word error rate exceeds alignment.qc.max_asr_wer (experiments only)")
    p.add_argument("--json", action="store_true", help="print the result or error as JSON")
    a = p.parse_args(argv)

    try:
        result = analyze(a.audio, a.transcript, a.ref, references_from=a.references_from, speech_id=a.speech_id,
                         take_id=a.take_id, reference_ids=a.ref_id, name=a.name, run_id=a.run_id,
                         runs_dir=a.runs_dir, config=a.config,
                         fail_on_off_script=False if a.allow_off_script else None)
    except RhetorTraceError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": e.to_dict()}, ensure_ascii=False))
        else:
            print(f"error [{e.code}] at {e.stage or 'request'}: {e.message}", file=sys.stderr)
        return EXIT.get(e.kind, 1)

    if a.json:
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    else:
        print(f"{result['id']}: {result['n_flaws']} findings, delivery score {result['score']}")
        print(f"  artifact {result['artifact']}")
        for w in result["warnings"]:
            print(f"  warning: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
