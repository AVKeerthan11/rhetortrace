"""Full-pipeline evaluation on the cached data: synthetic injections, clean
controls, reference robustness and reproducibility metadata.

Everything runs on cached alignments / features / baselines (no audio, no
models); see ``src.evaluation`` for the matching protocol and
``scripts/eval_detection.py`` for the injections (kinds, sites, strengths).

  synthetic   every good take is a clean control, scored against the baseline
              of the other references (leave-one-out); injected variants of it
              carry one known flaw each (strength 1 for P/R/F1 and boundaries,
              the strength ladder for severity)
  reference   (a) influence of each reference: how much the baseline moves when
              it is left out; (b) in-sample vs leave-one-out: each take scored
              against all three references (its own clean recording included:
              an optimistic bound) and against the other two
  metadata    sha256 of config, code, transcripts and every cached input, plus
              library versions; no timestamps, so identical inputs give
              byte-identical reports

Outputs: results/validation/evaluation.json, results/validation/EVALUATION.md

    python scripts/evaluate.py
"""

from __future__ import annotations

import argparse
import importlib.metadata as md
import json
import platform
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.eval_detection import (  # noqa: E402
    KINDS, LADDER, best_track, flaw_tracks, inject, injection_sites, load_cases, truth_span,
)
from src.baseline import WORD_FEATURES, BaselineConfig, build_baseline, load_take  # noqa: E402
from src.detection import SCORED_FEATURES, DetectionConfig, detect_take  # noqa: E402
from src.evaluation import (  # noqa: E402
    CATEGORIES, boundary_errors, boundary_summary, calibration, classify_injection, detection_metrics,
    dumps, file_hashes, fmt, monotonicity, summarize, write_text,
)
from src.flaws import FlawConfig, score_detection  # noqa: E402

KIND_CATEGORY = {k: c for k, (c, _) in KINDS.items()}
CODE_FILES = ["src/alignment.py", "src/transcript.py", "src/features/pitch.py", "src/features/energy.py",
              "src/features/rate.py", "src/features/pause.py", "src/features/spectral.py", "src/baseline.py",
              "src/detection.py", "src/flaws.py", "src/explain.py", "src/evaluation.py",
              "scripts/eval_detection.py", "scripts/evaluate.py"]
LIBRARIES = ("numpy", "scipy", "librosa", "praat-parselmouth", "whisperx", "soundfile", "PyYAML")


# ---------------------------------------------------------------- synthetic


def run_case(case: dict, baseline: dict, dcfg: DetectionConfig, fcfg: FlawConfig, ladder: bool) -> dict:
    """Control + injections (+ strength ladder) of one take against one baseline."""
    control_det = detect_take(case["take"], baseline, dcfg)
    control = flaw_tracks(score_detection(control_det, fcfg))
    words = control_det["words"]
    covered = {i for t in control for i in range(t["start_idx"], t["end_idx"] + 1)}
    minutes = (words[-1]["end"] - words[0]["start"]) / 60
    name = f"{case['speech_id']}/{case['take_id']}"
    out = {"case": name, "control": control,
           "control_stats": {"case": name, "n_tracks": len(control), "n_words": len(words),
                             "words_flagged": len(covered), "tracks_per_min": round(len(control) / minutes, 3),
                             "tracks": dict(sorted(Counter(f"{t['category']}/{t['direction']}"
                                                           for t in control).items()))},
           "injections": [], "ladder": {}}
    for kind, (cat, direction) in KINDS.items():
        for a, b in injection_sites(case["take"], kind):
            det = detect_take(inject(case["take"], kind, a, b), baseline, dcfg)
            tracks = flaw_tracks(score_detection(det, fcfg))
            res = classify_injection(tracks, control, cat, direction, a, b)
            res.update(kind=kind, span=[a, b], case=name,
                       scorable=any(det["words"][i]["categories"][cat] is not None for i in range(a, b + 1)))
            if res["tp"] is not None:
                res["boundary"] = boundary_errors(res["tp"], truth_span(det["words"], kind, a, b), a, b)
                res["severity"] = res["tp"]["severity"]["score"]
                res["level"] = res["tp"]["severity"]["level"]
            out["injections"].append(res)
    if ladder:
        for kind, strengths in LADDER.items():
            cat, direction = KINDS[kind]
            for a, b in injection_sites(case["take"], kind):
                site = []
                for s in strengths:
                    det = detect_take(inject(case["take"], kind, a, b, s), baseline, dcfg)
                    t = best_track(flaw_tracks(score_detection(det, fcfg)), cat, direction, a, b)
                    site.append((t["severity"]["score"], t["severity"]["level"]) if t else (0.0, 0))
                out["ladder"].setdefault(kind, []).append(site)
    return out


def _slim(inj: dict) -> dict:
    keep = ("case", "kind", "span", "scorable", "confounded", "boundary", "severity", "level")
    return {**{k: inj[k] for k in keep if k in inj}, "detected": inj["tp"] is not None,
            "n_collateral": len(inj["collateral"])}


def synthetic_report(runs: list[dict], fcfg: FlawConfig) -> dict:
    injections = [i for r in runs for i in r["injections"]]
    metrics = detection_metrics([r["control"] for r in runs], injections, KIND_CATEGORY)
    def block(items):
        tps = [i for i in items if i["tp"] is not None]
        cl = [i for i in items if i["scorable"] and not i["confounded"]]
        return {"n": len(items), "n_unscorable": sum(not i["scorable"] for i in items),
                "n_confounded": sum(i["scorable"] and i["confounded"] for i in items),
                "n_clean": len(cl), "detected_clean": sum(i["tp"] is not None for i in cl),
                "recall": round(sum(i["tp"] is not None for i in cl) / len(cl), 4) if cl else None,
                "collateral_fp": sum(len(i["collateral"]) for i in items),
                "boundary": boundary_summary([i["boundary"] for i in tps]),
                "severity_at_strength_1": summarize([i["severity"] for i in tps])}

    per_kind = {k: block([i for i in injections if i["kind"] == k]) for k in KINDS}
    per_cat = {c: block([i for i in injections if KIND_CATEGORY[i["kind"]] == c]) for c in CATEGORIES}

    severity = {}
    for kind, strengths in LADDER.items():
        sites = [site for r in runs for site in r["ladder"].get(kind, [])]
        severity[kind] = {
            "strengths": list(strengths),
            "monotonicity": monotonicity(list(strengths), [[s for s, _ in site] for site in sites]),
            "detected": [sum(site[j][0] > 0 for site in sites) for j in range(len(strengths))],
            # consistency of the score among detected sites at each strength
            "calibration": [calibration([site[j][0] for site in sites if site[j][0] > 0],
                                        [site[j][1] for site in sites if site[j][0] > 0], list(fcfg.labels))
                            for j in range(len(strengths))],
        }
    pooled = [[s for s, _ in site] for kind in LADDER for r in runs for site in r["ladder"].get(kind, [])]
    stats = [r["control_stats"] for r in runs]
    n_words = sum(s["words_flagged"] for s in stats), sum(s["n_words"] for s in stats)
    return {
        "detection": metrics,
        "per_kind": per_kind,
        "per_category": per_cat,
        "overall": block(injections),
        "controls": {"per_take": stats, "words_flagged": n_words[0], "n_words": n_words[1],
                     "fp_word_rate": round(n_words[0] / n_words[1], 4),
                     "n_tracks": sum(s["n_tracks"] for s in stats),
                     "tracks_per_min": round(sum(s["tracks_per_min"] for s in stats) / len(stats), 3)},
        "severity": {"per_kind": severity,
                     "pooled_monotone_sites": sum(all(a <= b + 1e-9 for a, b in zip(s, s[1:])) for s in pooled),
                     "pooled_sites": len(pooled)},
        "injections": [_slim(i) for i in injections],
    }


# ---------------------------------------------------------------- reference


def reference_influence(speech_id: str, full: dict, takes: list[dict], cfg: BaselineConfig) -> dict:
    """How far the word baseline moves when one reference is left out (in full-baseline scales)."""
    out = {}
    for left_out in sorted(t["take_id"] for t in takes):
        rest = [t for t in takes if t["take_id"] != left_out]
        part = build_baseline(speech_id, rest, cfg)
        per_cat, lost = {c: [] for c in CATEGORIES}, Counter()
        for wf, wp in zip(full["words"], part["words"]):
            for name, (cat, _, _) in SCORED_FEATURES.items():
                cf, cp = wf["features"][name], wp["features"][name]
                if cf.get("scale") is None or WORD_FEATURES[name].kind != "scalar":
                    continue
                if cp.get("median") is None:
                    lost[cat] += 1
                    continue
                per_cat[cat].append(abs(cp["median"] - cf["median"]) / cf["scale"])
        out[left_out] = {c: {**summarize(v), "cells_lost": lost[c]} for c, v in per_cat.items()}
    return out


def in_sample_vs_loo(runs_loo: list[dict], runs_in: list[dict]) -> dict:
    out = {}
    for lo, ins in zip(runs_loo, runs_in):
        def rec(run):
            cl = [i for i in run["injections"] if i["scorable"] and not i["confounded"]]
            return {"control_tracks": run["control_stats"]["n_tracks"],
                    "words_flagged": run["control_stats"]["words_flagged"],
                    "clean_recall": round(sum(i["tp"] is not None for i in cl) / len(cl), 4) if cl else None,
                    "n_clean": len(cl)}
        out[lo["case"]] = {"leave_one_out": rec(lo), "in_sample": rec(ins)}
    return out


# ----------------------------------------------------------------- metadata


def metadata(cases: list[dict], config_path: str) -> dict:
    inputs = []
    for c in cases:
        s, t = c["speech_id"], c["take_id"]
        inputs += [f"results/alignments/{s}/{t}.json", f"dataset/{s}/transcript.txt",
                   *(f"results/features/{s}/{t}.{src}.json" for src in ("pitch", "energy", "rate", "pause", "spectral"))]
        inputs.append(f"results/baselines/{s}.baseline.json")
    versions = {}
    for lib in LIBRARIES:
        try:
            versions[lib] = md.version(lib)
        except md.PackageNotFoundError:
            versions[lib] = None
    return {
        "config": file_hashes([config_path]),
        "code": file_hashes(CODE_FILES),
        "inputs": file_hashes(inputs),
        "audio_sha256": {f"{c['speech_id']}/{c['take_id']}": c["take"]["alignment"]["audio"]["sha256"] for c in cases},
        "python": platform.python_version(),
        "libraries": versions,
    }


# ------------------------------------------------------------------- report


def render(rep: dict) -> str:
    syn, ref = rep["synthetic"], rep["reference"]
    d = syn["detection"]
    L = ["# RhetorTrace evaluation (synthetic injections + clean controls)", "",
         "Generated by `python scripts/evaluate.py` from cached data; see `evaluation.json` for every number.",
         "Controls are the six good takes, each scored against the other two references (leave-one-out).",
         "Injected flaws are synthetic feature-level edits of those takes; there are no real flawed recordings yet.",
         "", "## Detection (strength-1 injections, refined flaw tracks)", "",
         "| category | TP | FP (control) | FP (collateral) | FN | precision | recall | F1 |",
         "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for c in (*CATEGORIES, "overall"):
        m = d["overall"] if c == "overall" else d["per_category"][c]
        L.append(f"| {c} | {m['tp']} | {m['control_fp']} | {m['collateral_fp']} | {m['fn']} | "
                 f"{fmt(m['precision'])} | {fmt(m['recall'])} | {fmt(m['f1'])} |")
    L += ["", f"Excluded from recall: {d['excluded'] or 'none'} (unscorable = no usable measurement at the site; "
          "confounded = the control already had a same-category track there).", "",
          "## Per injected flaw kind", "",
          "| kind | clean / n | recall | IoU (mean) | start err s (mean / p90) | end err s (mean / p90) | "
          "severity @1 (mean) | collateral FP |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for k, v in syn["per_kind"].items():
        b, s = v["boundary"], v["severity_at_strength_1"]
        L.append(f"| {k} | {v['n_clean']} / {v['n']} | {fmt(v['recall'], pct=True)} | "
                 f"{fmt(b['iou'].get('mean'))} | {fmt(b['start_err_s'].get('mean'))} / {fmt(b['start_err_s'].get('p90'))} | "
                 f"{fmt(b['end_err_s'].get('mean'))} / {fmt(b['end_err_s'].get('p90'))} | {fmt(s.get('mean'))} | "
                 f"{v['collateral_fp']} |")
    c = syn["controls"]
    L += ["", "## Clean controls (false positives)", "",
          f"Overall: {c['n_tracks']} flaw tracks, {fmt(c['fp_word_rate'], pct=True)} of words inside a track, "
          f"{c['tracks_per_min']} tracks/min (mean over takes).", "",
          "| take | tracks | words flagged | tracks/min | tracks by category/direction |", "|---|---:|---:|---:|---|"]
    for t in c["per_take"]:
        L.append(f"| {t['case']} | {t['n_tracks']} | {t['words_flagged']}/{t['n_words']} | {t['tracks_per_min']} | "
                 f"{', '.join(f'{k} {v}' for k, v in t['tracks'].items()) or '-'} |")
    L += ["", "## Severity vs injection strength", "",
          f"Monotone sites (score non-decreasing with strength, undetected = 0): "
          f"{syn['severity']['pooled_monotone_sites']}/{syn['severity']['pooled_sites']}.", "",
          "| kind | strengths | detected per strength | mean score of detected | std | modal level (agreement) | "
          "Spearman rho |", "|---|---|---|---|---|---|---:|"]
    for k, v in syn["severity"]["per_kind"].items():
        cal = v["calibration"]
        modal = ", ".join(f"{x['modal_level']} ({x['modal_agreement']})" if x["n"] else "-" for x in cal)
        L.append(f"| {k} | {v['strengths']} | {v['detected']} | {[x.get('mean') for x in cal]} | "
                 f"{[x.get('std') for x in cal]} | {modal} | {fmt(v['monotonicity']['spearman_rho'])} |")
    L += ["", "## Reference robustness", "",
          "In-sample = scored against all three references, including the take's own clean recording "
          "(optimistic bound); leave-one-out = against the other two (used everywhere above).", "",
          "| take | control tracks LOO / in-sample | words flagged LOO / in-sample | clean recall LOO / in-sample |",
          "|---|---|---|---|"]
    for case, v in ref["in_sample_vs_loo"].items():
        lo, ins = v["leave_one_out"], v["in_sample"]
        L.append(f"| {case} | {lo['control_tracks']} / {ins['control_tracks']} | {lo['words_flagged']} / "
                 f"{ins['words_flagged']} | {fmt(lo['clean_recall'], pct=True)} / {fmt(ins['clean_recall'], pct=True)} |")
    L += ["", "Baseline shift when one reference is left out (median |median shift| / full-baseline scale over word "
          "cells; cells lost = cells that drop below min_refs):", "",
          "| script | left out | " + " | ".join(CATEGORIES) + " |", "|---|---|" + "---|" * len(CATEGORIES)]
    for speech, per in ref["influence"].items():
        for left, cats in per.items():
            L.append(f"| {speech} | {left} | " + " | ".join(
                f"{fmt(cats[cat].get('median'), nd=2)} ({cats[cat]['cells_lost']})" for cat in CATEGORIES) + " |")
    meta = rep["metadata"]
    if meta:
        L += ["", "## Reproducibility", "",
              f"Config sha256 {list(meta['config'].values())[0][:16]}..., {len(meta['code'])} code files and "
              f"{len(meta['inputs'])} cached inputs hashed in `evaluation.json`. No timestamps: identical inputs "
              "and code give byte-identical reports.", ""]
    return "\n".join(L)


def evaluate(cases: list[dict], dcfg: DetectionConfig, fcfg: FlawConfig, base_cfg: BaselineConfig,
             full_baselines: dict, takes_by_speech: dict, config_path: str | None = "config.yaml") -> dict:
    runs = [run_case(c, c["baseline"], dcfg, fcfg, ladder=True) for c in cases]
    runs_in = [run_case(c, full_baselines[c["speech_id"]], dcfg, fcfg, ladder=False) for c in cases]
    return {
        "settings": {"detection": dcfg.settings(), "flaws": fcfg.settings(), "baseline": base_cfg.settings()},
        "synthetic": synthetic_report(runs, fcfg),
        "reference": {
            "in_sample_vs_loo": in_sample_vs_loo(runs, runs_in),
            "influence": {s: reference_influence(s, full_baselines[s], takes_by_speech[s], base_cfg)
                          for s in sorted(takes_by_speech)},
        },
        "metadata": metadata(cases, config_path) if config_path else {},
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Synthetic + reference evaluation of the full pipeline.")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--out", default="results/validation")
    args = parser.parse_args(argv)

    dcfg, fcfg = DetectionConfig.from_yaml(args.config), FlawConfig.from_yaml(args.config)
    base_cfg = BaselineConfig.from_yaml(args.config)
    cases = load_cases()
    speeches = sorted({c["speech_id"] for c in cases})
    full = {s: json.loads(Path(base_cfg.output_dir, f"{s}.baseline.json").read_text(encoding="utf-8"))
            for s in speeches}
    from src.alignment import AlignmentConfig
    align_cfg = AlignmentConfig.from_yaml(args.config)
    takes = {s: [load_take(s, r["take_id"], base_cfg, align_cfg) for r in full[s]["references"]] for s in speeches}
    rep = evaluate(cases, dcfg, fcfg, base_cfg, full, takes, args.config)
    write_text(Path(args.out) / "evaluation.json", dumps(rep))
    write_text(Path(args.out) / "EVALUATION.md", render(rep))
    print(render(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
