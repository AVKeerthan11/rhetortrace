"""Detection sanity check: leave-one-out good-take controls + synthetic injections.

For every reference take, the detector runs against a baseline of the *other*
references (``src.detection.baseline_for``):

  control    the take as recorded; every region is a false positive by
             construction (all takes are good deliveries)
  injection  a known deviation written into the take's cached feature values
             at deterministic positions, then detected again

Injections (feature-level, no audio is touched):
  fast           8 words: duration x 0.67, local rates / 0.67   -> pacing / fast
  slow           8 words: duration x 1.5,  local rates / 1.5    -> pacing / slow
  quiet          8 words: energy and peak -6 dB                 -> energy / quiet
  monotone       8 words: word F0 -> take median, F0 range x 0.3 -> pitch
  monotone_mild  8 words: word F0 halfway to the take median, range x 0.6 -> pitch
  long_pause     one within-sentence non-pause gap -> 1.2 s     -> pause / long
  missing_pause  one sentence-boundary gap -> 0.03 s            -> pause / short
Spans start at 20 / 50 / 80 % of the take (pauses: the boundary nearest).

An injection is ``detected`` when a region track of its category (and
direction, where the category has one) overlaps the injected words;
``attributable`` additionally requires that the control had no such track
there, so a pre-existing false positive does not count as a hit.
``scorable`` is false when none of the injected words has a usable z for the
category (no baseline / low-confidence cells): such sites cannot be detected by
design and are reported apart from misses.

Usage:
  python scripts/eval_detection.py                      # config.yaml settings
  python scripts/eval_detection.py --grid               # z_open x z_close sweep
  python scripts/eval_detection.py --set z_open=2.5 --out report.json
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.alignment import AlignmentConfig  # noqa: E402
from src.baseline import BaselineConfig, load_take, reference_takes  # noqa: E402
from src.detection import DetectionConfig, baseline_for, detect_take  # noqa: E402

SPAN = 8
POSITIONS = (0.2, 0.5, 0.8)
KINDS = {  # kind -> (category, direction)
    "fast": ("pacing", "fast"),
    "slow": ("pacing", "slow"),
    "quiet": ("energy", "quiet"),
    "monotone": ("pitch", None),
    "monotone_mild": ("pitch", None),
    "long_pause": ("pause", "long"),
    "missing_pause": ("pause", "short"),
}
GRID_OPEN = (2.0, 2.5, 3.0, 3.5)
GRID_CLOSE = (1.0, 1.5, 2.0)


def _words(take: dict, source: str) -> dict:
    return {w["idx"]: w for w in take[source]["words"]}


def inject(take: dict, kind: str, a: int, b: int) -> dict:
    """Copy of ``take`` with the deviation written into words a..b."""
    t = copy.deepcopy(take)
    rate, energy, pitch, pause = (_words(t, s) for s in ("rate", "energy", "pitch", "pause"))
    for i in range(a, b + 1):
        if kind in ("fast", "slow"):
            k = 0.67 if kind == "fast" else 1.5
            r = rate[i]
            if r["duration_s"] is not None:
                r["duration_s"] *= k
            for f in ("local_articulation_rate_wps", "local_speech_rate_wps"):
                if r[f] is not None:
                    r[f] /= k
        elif kind == "quiet":
            e = energy[i]
            for f in ("energy_rel_db", "energy_peak_rel_db"):
                if e[f] is not None:
                    e[f] -= 6.0
        elif kind in ("monotone", "monotone_mild"):
            k, kr = (0.0, 0.3) if kind == "monotone" else (0.5, 0.6)
            p = pitch[i]
            if p["f0_median_st"] is not None:
                p["f0_median_st"], p["f0_range_st"] = p["f0_median_st"] * k, p["f0_range_st"] * kr
        elif kind == "long_pause":
            pause[i].update(pause_after_s=1.2, is_pause_after=True)
        elif kind == "missing_pause":
            pause[i].update(pause_after_s=0.03, is_pause_after=False)
    return t


def injection_sites(take: dict, kind: str) -> list[tuple[int, int]]:
    """Deterministic (a, b) word spans for one injection kind."""
    n = len(take["alignment"]["words"])
    if kind not in ("long_pause", "missing_pause"):
        return [(int(f * n), min(n - 1, int(f * n) + SPAN - 1)) for f in POSITIONS]
    words = take["pause"]["words"]
    if kind == "long_pause":
        pool = [w["idx"] for w in words if w["boundary_after"] == "within_sentence" and w["is_pause_after"] is False]
    else:
        pool = [w["idx"] for w in words if w["boundary_after"] == "sentence" and w["is_pause_after"]]
    sites = []
    for f in POSITIONS:
        free = [i for i in pool if (i, i) not in sites]
        if free:
            i = min(free, key=lambda i: (abs(i - f * n), i))
            sites.append((i, i))
    return sites


def _overlapping_tracks(doc: dict, category: str, direction, a: int, b: int) -> list[dict]:
    return [t for r in doc["regions"] for t in r["tracks"]
            if t["category"] == category and (direction is None or t["direction"] == direction)
            and t["start_idx"] <= b and t["end_idx"] >= a]


def load_cases(speeches: list[str] | None = None) -> list[dict]:
    """(take, leave-one-out baseline) for every reference take; loaded once."""
    align_cfg, base_cfg = AlignmentConfig.from_yaml(), BaselineConfig.from_yaml()
    speeches = speeches or sorted(p.name for p in Path(align_cfg.output_dir).iterdir() if p.is_dir())
    cases = []
    for speech_id in speeches:
        for take_id in reference_takes(speech_id, base_cfg, align_cfg):
            baseline, _ = baseline_for(speech_id, take_id, base_cfg, align_cfg)
            cases.append({"speech_id": speech_id, "take_id": take_id,
                          "take": load_take(speech_id, take_id, base_cfg, align_cfg), "baseline": baseline})
    return cases


def control_attribution(doc: dict) -> dict:
    """Which category / direction / feature drives each control region."""
    out = {"dominant": Counter(), "track": Counter(), "feature": Counter()}
    for r in doc["regions"]:
        out["dominant"][f"{r['dominant_category']}/{r['direction']}"] += 1
        for t in r["tracks"]:
            out["track"][f"{t['category']}/{t['direction']}"] += t["end_idx"] - t["start_idx"] + 1
        if r["evidence"]:
            out["feature"][r["evidence"][0]["feature"]] += 1
    return {k: dict(sorted(v.items())) for k, v in out.items()}


def evaluate(cases: list[dict], cfg: DetectionConfig) -> dict:
    per_take, injections = [], []
    for case in cases:
        control = detect_take(case["take"], case["baseline"], cfg)
        covered = {i for r in control["regions"] for i in range(r["start_idx"], r["end_idx"] + 1)}
        n_words = len(control["words"])
        dur_min = (control["words"][-1]["end"] - control["words"][0]["start"]) / 60
        per_take.append({
            "case": f"{case['speech_id']}/{case['take_id']}",
            "n_regions": len(control["regions"]),
            "regions_per_min": round(len(control["regions"]) / dur_min, 2),
            "words_flagged": len(covered), "n_words": n_words,
            "attribution": control_attribution(control),
        })
        for kind, (cat, direction) in KINDS.items():
            for a, b in injection_sites(case["take"], kind):
                doc = detect_take(inject(case["take"], kind, a, b), case["baseline"], cfg)
                hits = _overlapping_tracks(doc, cat, direction, a, b)
                pre = _overlapping_tracks(control, cat, direction, a, b)
                scorable = any(doc["words"][i]["categories"][cat] is not None for i in range(a, b + 1))
                dominant = any(r["dominant_category"] == cat and r["start_idx"] <= b and r["end_idx"] >= a
                               for r in doc["regions"])
                injections.append({"case": f"{case['speech_id']}/{case['take_id']}", "kind": kind,
                                   "span": [a, b], "scorable": scorable, "detected": bool(hits), "dominant": dominant,
                                   "confounded": bool(pre), "attributable": bool(hits) and not pre})
    n_words = sum(t["n_words"] for t in per_take)
    clean = [i for i in injections if not i["confounded"] and i["scorable"]]
    by_kind = {k: {"n": sum(i["kind"] == k for i in injections),
                   "detected": sum(i["detected"] for i in injections if i["kind"] == k),
                   "attributable": sum(i["attributable"] for i in injections if i["kind"] == k),
                   "n_clean": sum(i["kind"] == k for i in clean),
                   "n_unscorable": sum(i["kind"] == k and not i["scorable"] for i in injections)} for k in KINDS}
    return {
        "settings": cfg.settings(),
        "controls": {
            "words_flagged": sum(t["words_flagged"] for t in per_take), "n_words": n_words,
            "fp_word_rate": round(sum(t["words_flagged"] for t in per_take) / n_words, 4),
            "n_regions": sum(t["n_regions"] for t in per_take),
            "per_take": per_take,
        },
        "injections": {
            "n": len(injections),
            "detected": sum(i["detected"] for i in injections),
            "dominant": sum(i["dominant"] for i in injections),
            "n_unscorable": sum(not i["scorable"] for i in injections),
            # recall on scorable sites where the control had no same-category region
            "clean_recall": round(sum(i["attributable"] for i in clean) / len(clean), 4) if clean else None,
            "n_clean": len(clean),
            "by_kind": by_kind,
            "items": injections,
        },
    }


def _line(rep: dict) -> str:
    c, i = rep["controls"], rep["injections"]
    s = rep["settings"]
    kinds = " ".join(f"{k}={v['attributable']}/{v['n_clean']}" for k, v in i["by_kind"].items())
    return (f"z_open={s['z_open']:<4} z_close={s['z_close']:<4} | control FP words {c['fp_word_rate']:6.1%} "
            f"regions {c['n_regions']:3d} | injections detected {i['detected']}/{i['n']} "
            f"(unscorable {i['n_unscorable']}) clean recall {i['clean_recall']:.1%} | {kinds}")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Leave-one-out controls + synthetic injections for detection.")
    parser.add_argument("--grid", action="store_true", help="sweep z_open x z_close")
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                        help="override a numeric detection setting (repeatable)")
    parser.add_argument("--speech", action="append", help="limit to these scripts")
    parser.add_argument("--out", help="write the JSON report here")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    cfg = DetectionConfig.from_yaml(args.config)
    for item in args.set:
        key, value = item.split("=", 1)
        kind = type(getattr(cfg, key))
        cfg = replace(cfg, **{key: value.lower() in ("1", "true", "yes") if kind is bool else kind(value)})
    configs = [replace(cfg, z_open=o, z_close=c) for o in GRID_OPEN for c in GRID_CLOSE if c < o] \
        if args.grid else [cfg]

    cases = load_cases(args.speech)
    reports = []
    for c in configs:
        rep = evaluate(cases, c)
        reports.append(rep)
        print(_line(rep))
    if not args.grid:
        for t in reports[0]["controls"]["per_take"]:
            print(f"  {t['case']}: {t['n_regions']} regions, {t['words_flagged']}/{t['n_words']} words  "
                  f"dominant {t['attribution']['dominant']}")
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(reports if args.grid else reports[0], f, indent=2)
            f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
