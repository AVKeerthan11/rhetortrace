"""Contrastive candidate-flaw detection against the reference baseline.

A test take is reduced to the same per-word value table as the references
(``src.baseline.value_table``: same normalizations, same exclusions), and each
value gets a signed robust deviation against the matching baseline cell:

    z = (value - median) / max(scale, min_scale[feature])

(RMS over dimensions for MFCC, so it is unsigned). Cells are explicit about why
no z exists: ``no_baseline`` (fewer than min_refs usable references),
``missing`` / ``low_confidence`` (test value failed or is unreliable; reason
kept). A silent test word keeps its energy as an upper bound: it only counts as
evidence of a drop (negative z), never of a rise.

Pauses: gaps shorter than the pause threshold are alignment granularity, so
both value and median are clipped up to ``min_pause_s`` before the z; a missing
pause and an inserted pause then deviate, 20 vs 40 ms gaps do not.

Per word and category (pacing, pitch, pause, energy, clarity) the category
score is the largest |z| of its features; its direction comes from that
feature (pacing slow/fast, energy loud/quiet, pause long/short, pitch
flatter/livelier with ``pitch_directional``; clarity is undirected). Each
(category, direction) track is smoothed with a centred running median of
``smooth_words`` words (per-category override; pause deviations are single
boundaries and are not smoothed): with only a few references single-word |z|
has heavy tails, a sustained deviation does not. Regions then use hysteresis
on the smoothed track: open at ``z_open``, extend over neighbours at
``z_close``. Regions shorter than the category's minimum length
(``min_words``) are dropped. Same-track regions closer than
``merge_gap_seconds`` merge; overlapping regions of different tracks form one
candidate whose dominant category has the strongest evidence (mean category
score over its own region, tie-break peak |z|).

Monotone spans: ``log_f0_span_std`` (baseline: ln std of word median F0 over
a short centred span) is one-sided pitch evidence. Only a span flatter than
its reference counts (z clipped to <= 0, direction "flatter"); a livelier span
adds nothing here. Where the reference span itself varies less than
``monotone_min_ref_std_st`` there is nothing to flatten, so the cell is
``not_applicable`` instead of a deviation. The span value of the test take is
computed with the baseline's own span settings. If a window word that has a
reference F0 is missing in the test take, the test span would be measured on
fewer words than the reference (dropping a word can shrink the std), so the
cell is low-confidence (``incomplete_span``).

Sentence- and take-level deviations (rates, intonation, pause ratio) are
reported as context, not as regions.

Safeguards (each explicit in the config; 0 / false disables it), chosen from
the leave-one-out controls (scripts/eval_detection.py):
  duration_frame_s         word boundaries sit on the alignment frame grid, so
                           ln(duration) carries a measurement error of about
                           frame / duration; it is added in quadrature to the
                           log_duration scale (short words had 3x the |z| > 3
                           rate of longer ones)
  pitch_directional        pitch tracks are split into "flatter" (word F0
                           closer to the speaker median than the reference,
                           or a narrower range) and "livelier"; monotone
                           delivery is a flatter run, and accent placement
                           differences no longer chain into one region
  min_clarity_active_frames  spectral descriptors of words with fewer active
                           frames are low-confidence (|z| > 3 rate fell from
                           ~8 % to ~2 % above 15 frames)
  min_alignment_score      words below it are low-confidence for every
                           feature (and the gap before them)

Output: results/detections/<speech>/<take>.detection.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import yaml

from src.alignment import AlignmentConfig
from src.baseline import (BaselineConfig, build_baseline, load_take, pitch_span_windows, reference_takes,
                          value_table)
from src.demo import load_manifest

SCHEMA_VERSION = 1
CATEGORIES = ("pacing", "pitch", "pause", "energy", "clarity")
# feature -> (category, direction if z > 0, direction if z < 0); None = undirected
SCORED_FEATURES = {
    "log_duration": ("pacing", "slow", "fast"),
    "log_local_articulation_rate": ("pacing", "fast", "slow"),
    "f0_median_st": ("pitch", None, None),
    "f0_range_st": ("pitch", None, None),
    "log_f0_span_std": ("pitch", None, "flatter"),  # one-sided: only flattening scores
    "pause_after_s": ("pause", "long", "short"),
    "energy_rel_db": ("energy", "loud", "quiet"),
    "energy_peak_rel_db": ("energy", "loud", "quiet"),
    "centroid_rel_oct": ("clarity", None, None),
    "log_flatness": ("clarity", None, None),
    "mfcc": ("clarity", None, None),
}
CONTEXT_FEATURES = ("duration_rel", "is_pause_after")  # reported, not scored
LOW_CONFIDENCE = ("low_alignment_confidence", "silent", "low_alignment_score", "few_active_frames",
                  "incomplete_span")
CLARITY_FEATURES = ("centroid_rel_oct", "log_flatness", "mfcc")


@dataclass(frozen=True)
class DetectionConfig:
    z_open: float = 3.0  # a word opens a region at this smoothed |z|
    z_close: float = 2.0  # neighbours extend it down to this smoothed |z|
    min_consecutive_words: int = 3  # default minimum region length
    min_words: dict = field(default_factory=lambda: {"pause": 1})  # per-category override
    smooth_words: int = 3  # running-median window over each track (odd)
    smooth_override: dict = field(default_factory=lambda: {"pause": 1})
    merge_gap_seconds: float = 0.5  # same-track regions closer than this merge
    min_scale: dict = field(default_factory=lambda: {"pause_after_s": 0.1})  # detection-side scale floors
    max_evidence: int = 5  # strongest feature deviations listed per region
    duration_frame_s: float = 0.02  # alignment frame; ln-duration measurement error = frame / duration
    pitch_directional: bool = True  # split pitch tracks into flatter / livelier
    min_clarity_active_frames: int = 0  # fewer active spectral frames -> clarity low-confidence
    min_alignment_score: float = 0.0  # words below it -> low-confidence for every feature
    monotone_min_ref_std_st: float = 0.75  # reference span F0 std below this -> no flattening evidence
    output_dir: str = "results/detections"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "DetectionConfig":
        with open(path, encoding="utf-8") as f:
            section = dict((yaml.safe_load(f) or {}).get("detection") or {})
        section.pop("boundary_refinement_ms", None)  # used by a later refinement stage
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        return settings

    def min_len(self, category: str) -> int:
        return self.min_words.get(category, self.min_consecutive_words)

    def window(self, category: str) -> int:
        return self.smooth_override.get(category, self.smooth_words)


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


# --------------------------------------------------------------- deviations


def deviation(value, reason, cell: dict, feature: str, cfg: DetectionConfig, min_pause_s: float,
              raw=None, meas_sigma: float = 0.0) -> dict:
    """Signed robust z of one test value against one baseline cell.

    ``meas_sigma`` is a known measurement error of the test value, added to the
    reference scale in quadrature.
    """
    out = {"value": _r(value, 4) if not isinstance(value, list) else [_r(v, 4) for v in value],
           "median": cell.get("median"), "scale": None, "z": None, "status": "ok"}
    bound = None
    if value is None and reason == "silent" and raw is not None:
        value, bound = raw, "upper"  # level of a silent word is an upper bound
        out["value"] = _r(raw, 4)
    if cell["status"] != "ok" or cell.get("scale") is None:
        out["status"] = "no_baseline"
        return out
    if value is None:
        out["status"] = "low_confidence" if reason in LOW_CONFIDENCE else "missing"
        out["reason"] = reason
        return out
    median = np.asarray(cell["median"], dtype=np.float64)
    x = np.asarray(value, dtype=np.float64)
    if feature == "pause_after_s":
        x, median = np.maximum(x, min_pause_s), np.maximum(median, min_pause_s)
    scale = np.maximum(np.asarray(cell["scale"]), cfg.min_scale.get(feature, 0.0))
    scale = np.sqrt(scale ** 2 + meas_sigma ** 2)
    z = (x - median) / scale
    z = float(np.sqrt(np.mean(z ** 2))) if z.ndim else float(z)
    if feature == "log_f0_span_std":
        if float(np.exp(median)) < cfg.monotone_min_ref_std_st:
            out.update(status="not_applicable", reason="reference_low_variation")
            return out
        out["one_sided"] = "flatter"
        z = min(z, 0.0)  # a livelier span is not monotone evidence
    if bound:
        out["bound"] = bound
        z = min(z, 0.0)  # only evidence of a drop
    out["scale"], out["z"] = _r(np.max(scale)) if scale.ndim else _r(scale), _r(z)
    return out


def _span_cfg(baseline: dict) -> BaselineConfig:
    """Span settings the baseline was built with (defaults for older artifacts)."""
    keys = ("pitch_span_words", "pitch_span_min_words", "pitch_span_floor_st")
    return BaselineConfig(**{k: baseline["settings"][k] for k in keys if k in baseline["settings"]})


def apply_confidence_gates(rows: list[dict], take: dict, cfg: DetectionConfig) -> list[dict]:
    """Mark values low-confidence by alignment score / spectral support (copies rows)."""
    rows = [dict(r) for r in rows]
    words, spectral = take["alignment"]["words"], take["spectral"]["words"]
    for i, (aw, sw) in enumerate(zip(words, spectral)):
        if (sw["n_active"] or 0) < cfg.min_clarity_active_frames:
            for name in CLARITY_FEATURES:
                if rows[i][name][0] is not None:
                    rows[i][name] = (None, "few_active_frames")
        score = aw.get("alignment_score")
        if score is not None and score < cfg.min_alignment_score:
            for name, (value, _) in rows[i].items():
                if value is not None:
                    rows[i][name] = (None, "low_alignment_score")
            if i > 0:  # the gap before this word has an unreliable end
                for name in ("pause_after_s", "is_pause_after"):
                    if rows[i - 1][name][0] is not None:
                        rows[i - 1][name] = (None, "low_alignment_score")
    return rows


def _direction(name: str, dev: dict, cfg: DetectionConfig):
    if name == "log_f0_span_std":
        return "flatter" if cfg.pitch_directional else None
    if cfg.pitch_directional and name == "f0_median_st":
        return "livelier" if abs(dev["value"]) > abs(dev["median"]) else "flatter"
    if cfg.pitch_directional and name == "f0_range_st":
        return "livelier" if dev["z"] >= 0 else "flatter"
    _, pos, neg = SCORED_FEATURES[name]
    return pos if dev["z"] >= 0 else neg


def mark_incomplete_spans(rows: list[dict], take: dict, baseline: dict) -> list[dict]:
    """Span F0 is low-confidence where a window word has reference F0 but no test F0."""
    rows = [dict(r) for r in rows]
    has_ref = [w["features"]["f0_median_st"].get("median") is not None for w in baseline["words"]]
    for i, window in enumerate(pitch_span_windows(take, _span_cfg(baseline))):
        if rows[i]["log_f0_span_std"][0] is not None and any(
                has_ref[j] and rows[j]["f0_median_st"][0] is None for j in window):
            rows[i]["log_f0_span_std"] = (None, "incomplete_span")
    return rows


def word_deviations(take: dict, baseline: dict, cfg: DetectionConfig) -> list[dict]:
    rows = apply_confidence_gates(value_table(take, _span_cfg(baseline))["words"], take, cfg)
    rows = mark_incomplete_spans(rows, take, baseline)
    min_pause_s = take["pause"]["settings"]["min_pause_s"]
    raw_energy = {w["idx"]: w for w in take["energy"]["words"]}
    out = []
    for row, base, aw in zip(rows, baseline["words"], take["alignment"]["words"]):
        feats = {}
        for name in (*SCORED_FEATURES, *CONTEXT_FEATURES):
            value, reason = row[name]
            cell = base["features"][name]
            if name == "is_pause_after":
                feats[name] = {"value": value, "p_ref": cell.get("p"), "status": cell["status"]}
                continue
            raw = raw_energy[aw["idx"]].get(name) if name.startswith("energy") else None
            meas = 0.0
            if name == "log_duration" and cfg.duration_frame_s and value is not None and cell.get("median") is not None:
                meas = cfg.duration_frame_s / min(np.exp(value), np.exp(cell["median"]))
            feats[name] = deviation(value, reason, cell, name, cfg, min_pause_s, raw, meas)
        scores = {}
        for cat in CATEGORIES:
            cands = [(abs(feats[n]["z"]), n) for n, (c, _, _) in SCORED_FEATURES.items()
                     if c == cat and feats[n]["z"] is not None]
            if not cands:
                scores[cat] = None
                continue
            score, name = max(cands)
            scores[cat] = {"score": _r(score), "feature": name, "direction": _direction(name, feats[name], cfg)}
        out.append({"idx": aw["idx"], "text": aw["text"], "start": aw["start"], "end": aw["end"],
                    "categories": scores, "features": feats})
    return out


def span_deviations(take_items: list[dict], base_items: list[dict], cfg: DetectionConfig) -> list[dict]:
    """z for sentence/take-level features (context)."""
    return [{name: deviation(v, reason, base[name], name, cfg, 0.0) for name, (v, reason) in item.items()}
            for item, base in zip(take_items, base_items)]


# ------------------------------------------------------------------ regions


def _track_scores(words: list[dict], category: str, direction) -> list[float]:
    """Per word |z| for a (category, direction) track; 0 when absent or other direction."""
    out = []
    for w in words:
        s = w["categories"][category]
        out.append(s["score"] if s and (direction is None or s["direction"] == direction) else 0.0)
    return out


def running_median(x: list[float], window: int) -> list[float]:
    """Centred running median; the window shrinks at the edges."""
    half = window // 2
    return [float(np.median(x[max(0, i - half):i + half + 1])) for i in range(len(x))]


def hysteresis_spans(scores: list[float], z_open: float, z_close: float) -> list[tuple[int, int]]:
    """Maximal runs of scores >= z_close that contain at least one score >= z_open."""
    spans, i = [], 0
    while i < len(scores):
        if scores[i] < z_close:
            i += 1
            continue
        j = i
        while j + 1 < len(scores) and scores[j + 1] >= z_close:
            j += 1
        if max(scores[i:j + 1]) >= z_open:
            spans.append((i, j))
        i = j + 1
    return spans


def _span_time(words: list[dict], a: int, b: int, category: str) -> tuple[float | None, float | None]:
    starts = [w["start"] for w in words[a:b + 1] if w["start"] is not None]
    ends = [w["end"] for w in words[a:b + 1] if w["end"] is not None]
    end = max(ends) if ends else None
    if category == "pause" and b + 1 < len(words) and words[b + 1]["start"] is not None:
        end = words[b + 1]["start"]  # the deviation is the gap after the last word
    return (min(starts) if starts else None), end


def track_regions(words: list[dict], cfg: DetectionConfig) -> list[dict]:
    regions = []
    for cat in CATEGORIES:
        directions = {s["direction"] for w in words if (s := w["categories"][cat])}
        for direction in sorted(directions, key=str):
            scores = _track_scores(words, cat, direction)
            smooth = running_median(scores, cfg.window(cat))
            spans = []
            for a, b in hysteresis_spans(smooth, cfg.z_open, cfg.z_close):
                start, end = _span_time(words, a, b, cat)
                if spans and start is not None and spans[-1][3] is not None \
                        and start - spans[-1][3] <= cfg.merge_gap_seconds:
                    spans[-1] = (spans[-1][0], b, spans[-1][2], end)
                else:
                    spans.append((a, b, start, end))
            for a, b, start, end in spans:
                vals = scores[a:b + 1]
                if b - a + 1 < cfg.min_len(cat):
                    continue
                regions.append({"category": cat, "direction": direction, "start_idx": words[a]["idx"],
                                "end_idx": words[b]["idx"], "start": start, "end": end,
                                "peak_z": _r(max(vals)), "strength": _r(np.mean(vals))})
    return regions


def _evidence(words: list[dict], members: list[dict], cfg: DetectionConfig) -> list[dict]:
    """Strongest feature deviations inside the candidate's track regions."""
    ev = []
    for r in members:
        for w in words:
            if r["start_idx"] <= w["idx"] <= r["end_idx"]:
                for name, (cat, _, _) in SCORED_FEATURES.items():
                    d = w["features"][name]
                    if cat == r["category"] and d["z"] is not None and abs(d["z"]) >= cfg.z_close:
                        ev.append({"idx": w["idx"], "text": w["text"], "feature": name, "category": cat,
                                   "value": d["value"], "median": d["median"], "scale": d["scale"], "z": d["z"]})
    ev.sort(key=lambda e: (-abs(e["z"]), e["idx"], e["feature"]))
    return ev[:cfg.max_evidence]


def candidates(words: list[dict], regions: list[dict], cfg: DetectionConfig) -> list[dict]:
    """Group overlapping track regions; dominant category = strongest evidence."""
    groups = []
    for r in sorted(regions, key=lambda r: (r["start_idx"], r["end_idx"], r["category"], str(r["direction"]))):
        if groups and r["start_idx"] <= groups[-1]["end_idx"]:
            groups[-1]["members"].append(r)
            groups[-1]["end_idx"] = max(groups[-1]["end_idx"], r["end_idx"])
        else:
            groups.append({"start_idx": r["start_idx"], "end_idx": r["end_idx"], "members": [r]})
    by_idx = {w["idx"]: w for w in words}
    out = []
    for k, g in enumerate(groups):
        members = g["members"]
        dom = max(members, key=lambda r: (r["strength"], r["peak_z"], -CATEGORIES.index(r["category"])))
        span = [by_idx[i] for i in range(g["start_idx"], g["end_idx"] + 1)]
        coverage = {c: sum(w["categories"][c] is not None for w in span) / len(span) for c in CATEGORIES}
        out.append({
            "region_id": k,
            "start_idx": g["start_idx"], "end_idx": g["end_idx"],
            "start": min(r["start"] for r in members if r["start"] is not None),
            "end": max(r["end"] for r in members if r["end"] is not None),
            "words": [w["text"] for w in span],
            "dominant_category": dom["category"], "direction": dom["direction"],
            "categories": sorted({r["category"] for r in members}, key=CATEGORIES.index),
            "tracks": members,
            "coverage": {c: _r(v) for c, v in coverage.items()},
            "evidence": _evidence(words, members, cfg),
        })
    return out


# ----------------------------------------------------------------- pipeline


def detect_take(take: dict, baseline: dict, cfg: DetectionConfig, baseline_path: str | None = None) -> dict:
    if [w["norm"] for w in take["alignment"]["words"]] != [w["norm"] for w in baseline["words"]]:
        raise ValueError(f"{take['take_id']}: word sequence differs from the {baseline['speech_id']} baseline")
    words = word_deviations(take, baseline, cfg)
    regions = candidates(words, track_regions(words, cfg), cfg)
    table = value_table(take, _span_cfg(baseline))

    status = {}
    for w in words:
        for name in SCORED_FEATURES:
            s = w["features"][name]["status"]
            status[s] = status.get(s, 0) + 1
    flagged = {w["idx"] for w in words if any(c and c["score"] >= cfg.z_open for c in w["categories"].values())}
    refs = [r["take_id"] for r in baseline["references"]]
    return {
        "schema_version": SCHEMA_VERSION,
        "speech_id": baseline["speech_id"],
        "take_id": take["take_id"],
        "audio_sha256": take["alignment"]["audio"]["sha256"],
        "alignment_cache_key": take["alignment"]["cache_key"],
        "baseline": {"path": baseline_path, "references": refs, "in_sample": take["take_id"] in refs},
        "settings": cfg.settings(),
        "summary": {
            "n_words": len(words),
            "n_words_over_z_open": len(flagged),
            "n_regions": len(regions),
            "by_dominant_category": {c: sum(r["dominant_category"] == c for r in regions) for c in CATEGORIES},
            "feature_cells": dict(sorted(status.items())),
        },
        "take_context": span_deviations([table["take"]], [baseline["take"]], cfg)[0],
        "sentence_context": span_deviations(table["regions"], [r["features"] for r in baseline["regions"]], cfg),
        "regions": regions,
        "words": words,
    }


def save_detection(doc: dict, cfg: DetectionConfig) -> Path:
    path = Path(cfg.output_dir) / doc["speech_id"] / f"{doc['take_id']}.detection.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return path


def baseline_for(speech_id: str, take_id: str, base_cfg: BaselineConfig, align_cfg: AlignmentConfig):
    """The cached baseline; for a reference take, a leave-one-out baseline of the others.

    A synthetic demo take (manifest in results/demo/<speech>/<take>.json, see
    scripts/build_demo.py) is an edited copy of a reference take, so its source
    take is left out as well: otherwise its unedited parts would match a
    reference exactly.
    """
    path = Path(base_cfg.output_dir) / f"{speech_id}.baseline.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing; run python -m src.baseline --all first")
    baseline = json.loads(path.read_text(encoding="utf-8"))
    refs = [r["take_id"] for r in baseline["references"]]
    manifest = load_manifest(speech_id, take_id)
    left_out = manifest["source_take"] if manifest else take_id
    if left_out not in refs:
        return baseline, path.as_posix()
    others = [load_take(speech_id, t, base_cfg, align_cfg) for t in refs if t != left_out]
    return build_baseline(speech_id, others, base_cfg), f"leave-one-out:{left_out}"


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Detect candidate flaw regions against the reference baseline.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every take with a cached alignment")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    base_cfg = BaselineConfig.from_yaml(args.config)
    cfg = DetectionConfig.from_yaml(args.config)
    if args.all:
        jobs = [(p.parent.name, p.stem) for p in sorted(Path(align_cfg.output_dir).glob("*/*.json"))]
    else:
        jobs = [(args.speech, args.take)]

    for speech_id, take_id in jobs:
        baseline, source = baseline_for(speech_id, take_id, base_cfg, align_cfg)
        doc = detect_take(load_take(speech_id, take_id, base_cfg, align_cfg), baseline, cfg, source)
        save_detection(doc, cfg)
        s = doc["summary"]
        print(f"{speech_id}/{take_id} [{source}]: {s['n_regions']} regions "
              f"{ {k: v for k, v in s['by_dominant_category'].items() if v} }  "
              f"words over z_open {s['n_words_over_z_open']}/{s['n_words']}")
        for r in doc["regions"]:
            print(f"  {r['start']:.2f}-{r['end']:.2f}s  w{r['start_idx']}-{r['end_idx']}  "
                  f"{r['dominant_category']}/{r['direction']}  {r['categories']}  \"{' '.join(r['words'])}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
