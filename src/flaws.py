"""Temporal refinement and severity scoring of detected regions.

Works on a detection document (``src.detection``) alone: per-word category
scores, directions and feature deviations are already there, nothing is
recomputed. Category and direction of every region are kept as detected.

Refinement, per detected track (category, direction, words a..b):
  raw score   the word's unsmoothed category score when its direction matches
              the track, else 0 (missing / low-confidence evidence is 0)
  trim        edge words with raw score < ``trim_z[category]`` are dropped
              (smoothing and hysteresis can carry a region onto neighbours
              with weak or no evidence of its own); at least one word is kept.
              Off for pitch (0): flatter evidence is mostly the windowed span
              feature, not a word-local test, and in the injection runs pitch
              tracks were already slightly short - trimming made them worse
  extend      outside neighbours with word-level score >= ``extend_z`` are
              added (smoothing can cut a strong edge word). Span-level evidence
              (``log_f0_span_std``) is excluded here: it covers a window around
              each word and would pull the boundary past the flattened words
  time        start of the first / end of the last word; a pause flaw is the
              gap itself: end of its word to start of the next
  uncertainty per side, half the adjacent inter-word gap (where the true
              boundary may lie), capped at ``boundary_refinement_ms``

Severity, per refined track, from reliable evidence only:
  usable      words with a category score (some feature of the category had a
              z: missing / no-baseline / low-confidence cells never count)
  evidence    median of the top-k usable raw scores, k = max(min_evidence_words,
              ceil(top_fraction x n_usable)): the strongest part of the region,
              never a single word (a lone spike does not move it); a region is not
              penalised for extending over its weaker edges (a median was: a
              stronger injection detected over its full extent scored lower
              than a weaker one detected only at its core)
  support     min(1, n_usable / min_evidence_words[category]): thin evidence
              shrinks the score instead of inflating it
  score       clip((evidence x support - z_min) / (z_max - z_min), 0, 1);
              z_max is looked up as "category/direction", then category, then
              default. pitch/flatter has a lower ceiling: its span evidence is
              bounded by the std floor, so complete flattening reaches only
              z ~ 4.5 (injection runs) where other categories go past 8
  level       number of ``level_thresholds`` the score reaches (0..4), with
              ``labels``; 0 = negligible after the support penalty

Each candidate region of the detector becomes one flaw: the dominant track
gives category, direction, boundaries and severity; other overlapping tracks
are listed as ``secondary`` with their own refinement and severity.

Every flaw and secondary track carries a deterministic ``explanation``
(``src.explain``) built only from these measurements.

Output: results/flaws/<speech>/<take>.flaws.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import yaml

from src.detection import SCORED_FEATURES
from src.explain import explain_flaw, explain_track, feature_direction, ranked_measurements

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class FlawConfig:
    trim_z: dict = field(default_factory=lambda: {"default": 2.0, "pitch": 0.0})  # edge words below are trimmed
    extend_z: float = 3.0  # neighbours at or above it are added
    boundary_refinement_ms: float = 150.0  # cap on per-side boundary uncertainty
    top_fraction: float = 0.5  # evidence = mean of the top max(min_evidence_words, ceil(fraction x n)) scores
    min_evidence_words: dict = field(default_factory=lambda: {"default": 3, "pause": 1})
    z_min: float = 2.0  # evidence at or below -> score 0
    z_max: dict = field(default_factory=lambda: {"default": 8.0, "pitch/flatter": 5.0})  # evidence -> score 1
    level_thresholds: tuple = (0.05, 0.2, 0.45, 0.7)  # score cut-offs for levels 1..4
    labels: tuple = ("negligible", "mild", "noticeable", "strong", "severe")
    low_coverage: float = 0.5  # flag regions with less usable evidence than this
    output_dir: str = "results/flaws"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "FlawConfig":
        with open(path, encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        section = {k: v for k, v in (raw.get("severity") or {}).items() if k not in ("min", "max")}
        for key in ("level_thresholds", "labels"):
            if key in section:
                section[key] = tuple(section[key])
        if "boundary_refinement_ms" in (raw.get("detection") or {}):
            section.setdefault("boundary_refinement_ms", raw["detection"]["boundary_refinement_ms"])
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        settings["level_thresholds"], settings["labels"] = list(self.level_thresholds), list(self.labels)
        return settings

    def min_evidence(self, category: str) -> int:
        return self.min_evidence_words.get(category, self.min_evidence_words["default"])

    def trim(self, category: str) -> float:
        return self.trim_z.get(category, self.trim_z["default"])

    def zmax(self, category: str, direction=None) -> float:
        return self.z_max.get(f"{category}/{direction}", self.z_max.get(category, self.z_max["default"]))


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


# --------------------------------------------------------------- refinement


SPAN_FEATURES = ("log_f0_span_std",)


def raw_scores(words: list[dict], category: str, direction) -> list[float | None]:
    """Unsmoothed track score per word; None where the category has no usable evidence."""
    out = []
    for w in words:
        s = w["categories"][category]
        out.append(None if s is None else s["score"] if direction is None or s["direction"] == direction else 0.0)
    return out


def word_level_scores(words: list[dict], category: str, direction) -> list[float]:
    """Like raw_scores but from word-level features only (span-level evidence excluded)."""
    out = []
    for w in words:
        zs = [abs(d["z"]) for name, (cat, _, _) in SCORED_FEATURES.items()
              if cat == category and name not in SPAN_FEATURES and (d := w["features"][name])["z"] is not None
              and (direction is None or feature_direction(name, d) == direction)]
        out.append(max(zs, default=0.0))
    return out


def refine_span(scores: list[float | None], a: int, b: int, cfg: FlawConfig,
                local: list[float] | None = None, trim_z: float | None = None) -> tuple[int, int]:
    """Trim weak edge words, then extend over neighbours with strong word-level evidence.

    ``local`` are word-level scores (span evidence excluded), default ``scores``.
    """
    local = local if local is not None else [s or 0.0 for s in scores]
    trim_z = cfg.trim_z["default"] if trim_z is None else trim_z

    def val(i):
        return scores[i] or 0.0
    while a < b and val(a) < trim_z:
        a += 1
    while b > a and val(b) < trim_z:
        b -= 1
    while a > 0 and local[a - 1] >= cfg.extend_z:
        a -= 1
    while b + 1 < len(scores) and local[b + 1] >= cfg.extend_z:
        b += 1
    return a, b


def span_times(words: list[dict], a: int, b: int, category: str, cfg: FlawConfig) -> dict:
    """Start/end in seconds plus per-side uncertainty from the adjacent gaps."""
    cap = cfg.boundary_refinement_ms / 1000.0

    def half_gap(left: int, right: int):
        if left < 0 or right >= len(words) or words[left]["end"] is None or words[right]["start"] is None:
            return _r(cap)
        return _r(min(max(words[right]["start"] - words[left]["end"], 0.0) / 2, cap))

    if category == "pause" and b + 1 < len(words) and words[b]["end"] is not None \
            and words[b + 1]["start"] is not None:
        start, end = words[b]["end"], words[b + 1]["start"]
        unc = (_r(min(cap, 0.02)), _r(min(cap, 0.02)))  # gap edges are word boundaries: one alignment frame
    else:
        starts = [w["start"] for w in words[a:b + 1] if w["start"] is not None]
        ends = [w["end"] for w in words[a:b + 1] if w["end"] is not None]
        start, end = (min(starts) if starts else None), (max(ends) if ends else None)
        unc = (half_gap(a - 1, a), half_gap(b, b + 1))
    return {"start": start, "end": end,
            "duration_s": _r(end - start) if start is not None and end is not None else None,
            "start_uncertainty_s": unc[0], "end_uncertainty_s": unc[1]}


# ----------------------------------------------------------------- severity


def severity(scores: list[float | None], a: int, b: int, category: str, cfg: FlawConfig,
             direction=None) -> dict:
    span = scores[a:b + 1]
    usable = [s for s in span if s is not None]
    n_words, n_usable = len(span), len(usable)
    k = max(cfg.min_evidence(category), math.ceil(cfg.top_fraction * n_usable))
    top = sorted(usable, reverse=True)[:k]
    evidence = float(np.median(top)) if top else 0.0
    median = float(np.median(usable)) if usable else 0.0
    peak = max(usable, default=0.0)
    support = min(1.0, n_usable / cfg.min_evidence(category))
    effective = evidence * support
    score = float(np.clip((effective - cfg.z_min) / (cfg.zmax(category, direction) - cfg.z_min), 0.0, 1.0))
    level = sum(score >= t for t in cfg.level_thresholds)
    return {
        "score": _r(score), "level": int(level), "label": cfg.labels[level],
        "evidence_z": _r(evidence), "effective_z": _r(effective), "median_z": _r(median), "peak_z": _r(peak),
        "n_evidence_words": n_usable, "n_top": len(top), "support": _r(support),
    }


def strongest_evidence(words: list[dict], a: int, b: int, category: str, direction) -> dict | None:
    """Largest reliable feature deviation of the category inside the span whose own
    direction agrees with the track (the explanation's strongest evidence)."""
    ranked = ranked_measurements(words, a, b, category, direction)
    if not ranked:
        return None
    m = ranked[0]
    return {"idx": m["idx"], "text": m["word"], "feature": m["feature"], **m["stored"], "z": m["z"]}


def refine_track(words: list[dict], track: dict, cfg: FlawConfig) -> dict:
    cat, direction = track["category"], track["direction"]
    scores = raw_scores(words, cat, direction)
    a0, b0 = track["start_idx"], track["end_idx"]
    a, b = refine_span(scores, a0, b0, cfg, word_level_scores(words, cat, direction), cfg.trim(cat))
    sev = severity(scores, a, b, cat, cfg, direction)
    times = span_times(words, a, b, cat, cfg)
    n_words = b - a + 1
    flags = []
    if sev["n_evidence_words"] / n_words < cfg.low_coverage:
        flags.append("low_coverage")
    if sev["support"] < 1.0:
        flags.append("thin_evidence")
    if n_words == 1 and cat != "pause":
        flags.append("single_word")
    if a == 0 or b == len(words) - 1:
        flags.append("take_edge")
    nearby = words[max(0, a - 1):b + 2]
    if any(w["features"][n]["status"] in ("low_confidence", "missing")
           for w in nearby for n, (c, _, _) in SCORED_FEATURES.items() if c == cat):
        flags.append("near_unreliable_evidence")
    return {
        "category": cat, "direction": direction,
        "start_idx": words[a]["idx"], "end_idx": words[b]["idx"], **times,
        "words": [w["text"] for w in words[a:b + 1]], "n_words": n_words,
        "word_coverage": _r(sev["n_evidence_words"] / n_words),
        "severity": sev,
        "confidence": _r(sev["support"] * min(1.0, sev["n_evidence_words"] / n_words / cfg.low_coverage)),
        "flags": flags,
        "strongest_evidence": strongest_evidence(words, a, b, cat, direction),
        "boundary": {"detected_start_idx": a0, "detected_end_idx": b0,
                     "detected_start": track["start"], "detected_end": track["end"],
                     "trimmed_words": max(0, a - a0) + max(0, b0 - b),
                     "extended_words": max(0, a0 - a) + max(0, b - b0)},
    }


# ----------------------------------------------------------------- pipeline


def score_detection(detection: dict, cfg: FlawConfig) -> dict:
    words = detection["words"]
    assert all(w["idx"] == i for i, w in enumerate(words)), "word idx must equal position"
    flaws = []
    for region in detection["regions"]:
        tracks = [refine_track(words, t, cfg) for t in region["tracks"]]
        dom = next(i for i, t in enumerate(region["tracks"])
                   if t["category"] == region["dominant_category"] and t["direction"] == region["direction"])
        secondary = [{**t, "explanation": explain_track(t, words)} for i, t in enumerate(tracks) if i != dom]
        flaw = {"flaw_id": len(flaws), "region_id": region["region_id"], **tracks[dom], "secondary": secondary}
        flaw["explanation"] = explain_flaw(flaw, words)
        flaws.append(flaw)
    levels = [f["severity"]["level"] for f in flaws]
    return {
        "schema_version": SCHEMA_VERSION,
        "speech_id": detection["speech_id"],
        "take_id": detection["take_id"],
        "audio_sha256": detection["audio_sha256"],
        "alignment_cache_key": detection["alignment_cache_key"],
        "baseline": detection["baseline"],
        "detection_settings": detection["settings"],
        "settings": cfg.settings(),
        "summary": {
            "n_flaws": len(flaws),
            "by_level": {cfg.labels[k]: levels.count(k) for k in range(len(cfg.labels))},
            "by_category": {c: sum(f["category"] == c for f in flaws)
                            for c in sorted({f["category"] for f in flaws})},
            "max_score": max((f["severity"]["score"] for f in flaws), default=0.0),
        },
        "flaws": flaws,
    }


def save_flaws(doc: dict, cfg: FlawConfig) -> Path:
    path = Path(cfg.output_dir) / doc["speech_id"] / f"{doc['take_id']}.flaws.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return path


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Refine detected regions and score their severity.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every cached detection")
    parser.add_argument("--detections", default="results/detections")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    cfg = FlawConfig.from_yaml(args.config)
    root = Path(args.detections)
    paths = sorted(root.glob("*/*.detection.json")) if args.all \
        else [root / args.speech / f"{args.take}.detection.json"]
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"{path} missing; run python -m src.detection first")
        doc = score_detection(json.loads(path.read_text(encoding="utf-8")), cfg)
        save_flaws(doc, cfg)
        print(f"{doc['speech_id']}/{doc['take_id']}: {doc['summary']['n_flaws']} flaws  {doc['summary']['by_level']}")
        for f in doc["flaws"]:
            s = f["severity"]
            print(f"  {f['start']:.2f}-{f['end']:.2f}s  w{f['start_idx']}-{f['end_idx']}  {f['category']}/{f['direction']}"
                  f"  score {s['score']} ({s['label']})  conf {f['confidence']}  {f['flags']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
