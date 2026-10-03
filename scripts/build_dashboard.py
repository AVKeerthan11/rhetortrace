"""Export compact, deterministic dashboard data from the pipeline outputs.

Reads only existing outputs (alignments, frame caches, detections, flaws,
baselines, demo manifests, validation reports) and writes:

  web/public/data/index.json              takes, delivery scores, validation summary
  web/public/data/<speech>__<take>.json   one take: words, flaws (+ reference values
                                          for every evidence measurement), contours,
                                          warped reference contours, waveform peaks,
                                          delivery profile and score, ground truth
  web/public/audio/<speech>__<take>.flac  lossless audio of the analysed WAV (exact timing)

These files are the only interface between the Python pipeline and the React
frontend (web/).

The take documents are built by src.export (shared with src.pipeline, which
analyses new recordings); this script is the dataset / demo workflow.

    python scripts/build_dashboard.py
    cd web && npm install && npm run dev
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.alignment import AlignmentConfig  # noqa: E402
from src.baseline import BaselineConfig  # noqa: E402
from src.demo import DEMO_DIR  # noqa: E402
from src.export import (OUT, ExportPaths, demo_manifest_for, export_take, index_entry,  # noqa: E402,F401
                        load_json, write_json)
from src.scoring import ScoringConfig  # noqa: E402

# -------------------------------------------------------------- validation


def validation_summary() -> dict:
    ev = load_json("results/validation/evaluation.json")
    rob = load_json("results/validation/robustness.json")
    syn = ev["synthetic"]
    return {
        "detection": syn["detection"],
        "per_kind": {k: {"n": v["n"], "n_clean": v["n_clean"], "recall": v["recall"],
                         "iou": v["boundary"]["iou"].get("mean"),
                         "start_err": v["boundary"]["start_err_s"].get("mean"),
                         "start_err_p90": v["boundary"]["start_err_s"].get("p90"),
                         "end_err": v["boundary"]["end_err_s"].get("mean"),
                         "end_err_p90": v["boundary"]["end_err_s"].get("p90"),
                         "severity": v["severity_at_strength_1"].get("mean"),
                         "collateral_fp": v["collateral_fp"]} for k, v in syn["per_kind"].items()},
        "controls": syn["controls"],
        "severity": {k: {"strengths": v["strengths"], "detected": v["detected"],
                         "mean_score": [c.get("mean") for c in v["calibration"]],
                         "std": [c.get("std") for c in v["calibration"]],
                         "monotone": [v["monotonicity"]["monotone_sites"], v["monotonicity"]["n_sites"]],
                         "rho": v["monotonicity"]["spearman_rho"]} for k, v in syn["severity"]["per_kind"].items()},
        "severity_pooled": [syn["severity"]["pooled_monotone_sites"], syn["severity"]["pooled_sites"]],
        "reference": ev["reference"],
        "robustness": {c: v["summary"] for c, v in rob["conditions"].items()},
        "metadata": {"config": ev["metadata"]["config"], "code": ev["metadata"]["code"],
                     "n_inputs": len(ev["metadata"]["inputs"]), "libraries": ev["metadata"]["libraries"],
                     "python": ev["metadata"]["python"]},
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Export dashboard data.")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)
    cfgs = {"align": AlignmentConfig.from_yaml(args.config), "base": BaselineConfig.from_yaml(args.config),
            "scoring": ScoringConfig.from_yaml(args.config)}
    takes = sorted((p.parent.name, p.name.removesuffix(".flaws.json")) for p in Path("results/flaws").glob("*/*.flaws.json"))
    takes.sort(key=lambda st: (not (DEMO_DIR / st[0] / f"{st[1]}.json").exists(), st))  # demos first (validated below)
    index = []
    for speech, take in takes:
        doc = export_take(speech, take, cfgs, paths=ExportPaths(out=OUT))
        write_json(OUT / "data" / f"{doc['id']}.json", doc)
        index.append({**index_entry(doc), "_truth": doc["ground_truth"]})
        print(f"{doc['id']}: {doc['kind']}  flaws {len(doc['flaws'])}  score {doc['score']['total']}")
    demo = {t["id"]: t["_truth"] for t in index if t.get("_truth")}
    for t in index:
        t.pop("_truth", None)
    index_doc = {"takes": index, "validation": {**validation_summary(), "demo_injections": demo}}
    write_json(OUT / "data" / "index.json", index_doc)

    return 0


if __name__ == "__main__":
    sys.exit(main())
