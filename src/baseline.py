"""Reference baseline from the good takes of a script.

Reads only cached outputs (alignment + pitch/energy/rate/pause/spectral JSON);
nothing is re-extracted from audio. Every take of a script has the same
canonical word sequence, so word ``idx`` and sentence ``region_idx`` are shared
across takes and features can be compared position by position.

Normalization (speaker / take comparability):
  pitch     semitones re the take's median in-word F0 (from pitch features)
  energy    dB re the take's median active in-word level (from energy features)
  spectral  CMN'd MFCC, centroid in octaves re the take median, log10 flatness
  rate      log words/s; ``duration_rel`` = log(word duration x take
            articulation rate), i.e. stretch relative to the take's own tempo
  pause     seconds (gaps can be 0, so no log); pause probability per boundary
  span F0   ``log_f0_span_std``: ln of the std of word median F0 (st) over a
            centred window of ``pitch_span_words`` words, clipped to the
            sentence, from at least ``pitch_span_min_words`` voiced words;
            floored at ``pitch_span_floor_st`` (pitch resolution) so an
            already-flat span cannot become "flatter". Words without pitch
            are skipped, not zero-filled

Robust statistics per word / sentence / take and feature, over the reference
takes with a usable value:
  median    location
  mad       1.4826 x b_n x median absolute deviation: consistent with sigma,
            with the Croux-Rousseeuw small-sample factor b_n (MAD of 3 values
            is strongly biased low)
  scale     moderated spread: sqrt((prior_df x pooled^2 + (n-1) x mad^2) /
            (prior_df + n-1)), floored at the feature's measurement resolution.
            ``pooled`` is the feature's typical across-take spread in the
            script: median pairwise |difference| between references over all
            items / 0.9539 (sigma-consistent; unlike a median of per-item MADs
            it does not collapse to 0 on 20 ms-quantized durations / gaps).
            With 3 references a per-word MAD alone can collapse to ~0
Missing values (feature failures) and low-confidence values are excluded and
recorded per take with a reason; items with fewer than ``min_refs`` usable
values get ``status: "insufficient"`` and no statistics. Low confidence:
  low_alignment_confidence  word in the alignment's low-score / too-short lists
                            (boundary features: either neighbouring word)
  silent                    energy indistinguishable from the noise floor
References whose robust z exceeds ``outlier_z`` are listed (not removed: the
median / MAD are already robust to one outlier in three).

Validation: leave-one-out robust z of each reference against the baseline of
the others, plus pairwise correlation of per-word profiles between takes.

Output: results/baselines/<speech>.baseline.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass
from itertools import combinations
from pathlib import Path

import numpy as np
import yaml

from src.alignment import AlignmentConfig, load_alignment
from src.features.rate import sentence_ids

SCHEMA_VERSION = 1
MAD_K = 1.4826
# Croux & Rousseeuw (1992) small-sample correction of the MAD; n > 9: n / (n - 0.8)
MAD_BN = {2: 1.196, 3: 1.495, 4: 1.363, 5: 1.206, 6: 1.200, 7: 1.140, 8: 1.129, 9: 1.107}
SOURCES = ("pitch", "energy", "rate", "pause", "spectral")


@dataclass(frozen=True)
class Feature:
    kind: str  # scalar | bool | vector
    resolution: float  # smallest meaningful difference; floor for the scale
    description: str


WORD_FEATURES = {
    "f0_median_st": Feature("scalar", 0.25, "word median F0, semitones re take speaker F0"),
    "f0_range_st": Feature("scalar", 0.25, "word F0 p90-p10 range, semitones"),
    "energy_rel_db": Feature("scalar", 0.5, "word power-mean level, dB re take speaker level"),
    "energy_peak_rel_db": Feature("scalar", 0.5, "word p95 frame level, dB re take speaker level"),
    "log_duration": Feature("scalar", 0.05, "ln word duration (s)"),
    "duration_rel": Feature("scalar", 0.05, "ln(word duration x take articulation rate)"),
    "log_local_articulation_rate": Feature("scalar", 0.05, "ln local articulation rate (words/s)"),
    "pause_after_s": Feature("scalar", 0.02, "gap to the next word (s); 0.02 = alignment frame"),
    "is_pause_after": Feature("bool", 0.0, "gap to the next word >= min_pause_s"),
    "centroid_rel_oct": Feature("scalar", 0.05, "spectral centroid, octaves re take median"),
    "log_flatness": Feature("scalar", 0.05, "log10 spectral flatness"),
    "mfcc": Feature("vector", 0.5, "CMN'd MFCC mean (13 coefficients)"),
    "log_f0_span_std": Feature("scalar", 0.05, "ln std of word median F0 over a centred word span (st)"),
}
REGION_FEATURES = {
    "log_speech_rate": Feature("scalar", 0.02, "ln speech rate incl. pauses (words/s)"),
    "log_articulation_rate": Feature("scalar", 0.02, "ln articulation rate (words/s)"),
    "f0_word_std_st": Feature("scalar", 0.25, "std of word median F0 across the span (intonation)"),
    "f0_word_range_st": Feature("scalar", 0.25, "max-min of word median F0 across the span"),
    "energy_rel_db": Feature("scalar", 0.5, "median word level, dB re take speaker level"),
    "n_pauses": Feature("scalar", 1.0, "within-sentence pauses"),
    "pause_ratio": Feature("scalar", 0.01, "within-sentence pause time / span"),
    "pause_after_s": Feature("scalar", 0.02, "pause after the sentence (s)"),
    "centroid_rel_oct": Feature("scalar", 0.05, "spectral centroid, octaves re take median"),
}


@dataclass(frozen=True)
class BaselineConfig:
    reference_prefix: str = "good_"  # takes whose id starts with this are references
    min_refs: int = 2  # fewer usable values -> no statistics
    prior_df: float = 2.0  # weight of the pooled MAD in the moderated scale
    outlier_z: float = 3.5
    pitch_span_words: int = 5  # centred window (odd) for the span F0 variation
    pitch_span_min_words: int = 3  # fewer voiced words in the window -> None
    pitch_span_floor_st: float = 0.25  # std floor (pitch resolution) before the log
    features_dir: str = "results/features"
    output_dir: str = "results/baselines"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "BaselineConfig":
        with open(path, encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        section = dict(raw.get("baseline") or {})
        section.setdefault("features_dir", (raw.get("features") or {}).get("output_dir", cls.features_dir))
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        for key in ("features_dir", "output_dir"):
            settings.pop(key)
        return settings


def _r(x, nd=4):
    if x is None:
        return None
    if isinstance(x, (list, tuple, np.ndarray)):
        return [_r(v, nd) for v in x]
    return round(float(x), nd)


def _log(x, base=math.e):
    return None if x is None or x <= 0 else math.log(x) / math.log(base)


# ------------------------------------------------------------------- inputs


def load_take(speech_id: str, take_id: str, cfg: BaselineConfig, align_cfg: AlignmentConfig) -> dict:
    """Alignment + all feature docs of a take, checked against the alignment."""
    alignment = load_alignment(Path(align_cfg.output_dir) / speech_id / f"{take_id}.json")
    take = {"take_id": take_id, "alignment": alignment}
    for source in SOURCES:
        path = Path(cfg.features_dir) / speech_id / f"{take_id}.{source}.json"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing; run python -m src.features.{source} --all first")
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc["alignment_cache_key"] != alignment["cache_key"]:
            raise RuntimeError(f"{path} is stale for the current alignment; re-run {source} extraction")
        take[source] = doc
    return take


def _value(raw, failure, transform=None):
    """(value, reason): reason is the feature failure when the value is missing."""
    if raw is None:
        return None, failure or "missing"
    value = transform(raw) if transform else raw
    return (None, "invalid") if value is None else (value, None)


def word_values(take: dict) -> list[dict]:
    """Per word: {feature: (value, reason)} with the normalizations above."""
    q = take["alignment"]["quality"]
    low = set(q["low_score_idx"]) | set(q["too_short_idx"])
    art_rate = take["rate"]["take"]["articulation_rate_wps"]
    rows = []
    for p, e, r, pa, s in zip(*(take[src]["words"] for src in SOURCES)):
        dur_rel = None if r["duration_s"] is None or not art_rate else _log(r["duration_s"] * art_rate)
        row = {
            "f0_median_st": _value(p["f0_median_st"], p["pitch_failure"]),
            "f0_range_st": _value(p["f0_range_st"], p["pitch_failure"]),
            "energy_rel_db": _value(e["energy_rel_db"], e["energy_failure"]),
            "energy_peak_rel_db": _value(e["energy_peak_rel_db"], e["energy_failure"]),
            "log_duration": _value(r["duration_s"], r["rate_failure"], _log),
            "duration_rel": _value(dur_rel, r["rate_failure"]),
            "log_local_articulation_rate": _value(r["local_articulation_rate_wps"], r["rate_failure"], _log),
            "pause_after_s": _value(pa["pause_after_s"], pa["after_failure"]),
            "is_pause_after": _value(pa["is_pause_after"], pa["after_failure"], float),
            "centroid_rel_oct": _value(s["centroid_rel_oct"], s["spectral_failure"]),
            "log_flatness": _value(s["flatness"], s["spectral_failure"], lambda x: _log(x, 10)),
            "mfcc": _value(s["mfcc_mean"], s["spectral_failure"]),
        }
        if e["energy_status"] == "silent":
            for name in ("energy_rel_db", "energy_peak_rel_db"):
                row[name] = (None, "silent")
        boundary = ("pause_after_s", "is_pause_after")
        for name in row:
            neighbours = {r["idx"], r["idx"] + 1} if name in boundary else {r["idx"]}
            if neighbours & low and row[name][0] is not None:
                row[name] = (None, "low_alignment_confidence")
        rows.append(row)
    return rows


def _span_values(word_rows: list[dict], rate: dict, pause: dict | None, spectral: dict | None) -> dict:
    f0 = [v for v, _ in (w["f0_median_st"] for w in word_rows) if v is not None]
    energy = [v for v, _ in (w["energy_rel_db"] for w in word_rows) if v is not None]
    short = "insufficient_words"
    return {
        "log_speech_rate": _value(rate["speech_rate_wps"], "unaligned", _log),
        "log_articulation_rate": _value(rate["articulation_rate_wps"], "unaligned", _log),
        "f0_word_std_st": _value(float(np.std(f0)) if len(f0) >= 3 else None, short),
        "f0_word_range_st": _value(float(np.ptp(f0)) if len(f0) >= 3 else None, short),
        "energy_rel_db": _value(float(np.median(energy)) if energy else None, short),
        "n_pauses": _value(pause and pause["n_pauses"], "missing", float),
        "pause_ratio": _value(pause and pause["pause_ratio"], "missing"),
        "pause_after_s": _value(pause and pause["pause_after_s"], pause and pause["pause_after_failure"]),
        "centroid_rel_oct": _value(spectral and spectral.get("centroid_rel_oct"),
                                   spectral and spectral.get("spectral_failure")),
    }


def region_values(take: dict, word_rows: list[dict]) -> list[dict]:
    regions = sentence_ids(take["alignment"]["words"], take["pause"]["settings"]["sentence_end"])
    out = []
    for rate, pause, spectral in zip(take["rate"]["regions"], take["pause"]["regions"], take["spectral"]["regions"]):
        members = [w for w, reg in zip(word_rows, regions) if reg == rate["region_idx"]]
        out.append(_span_values(members, rate, pause, spectral))
    return out


def take_values(take: dict, word_rows: list[dict]) -> dict:
    s = take["pause"]["summary"]["within_sentence"]
    t = take["rate"]["take"]
    span = t["end"] - t["start"] if t["start"] is not None else None
    pause = {"n_pauses": s["n_pauses"], "pause_ratio": _r(s["total_pause_s"] / span) if span else None,
             "pause_after_s": None, "pause_after_failure": "take_end"}
    values = _span_values(word_rows, t, pause, {"centroid_rel_oct": 0.0})
    values.pop("pause_after_s")
    values.pop("centroid_rel_oct")  # 0 by definition at take level
    return values


# --------------------------------------------------------------- statistics


def robust_stats(values) -> tuple[np.ndarray | float, np.ndarray | float]:
    """Median and scaled MAD (elementwise for vectors)."""
    x = np.asarray(values, dtype=np.float64)
    med = np.median(x, axis=0)
    n = len(x)
    b_n = MAD_BN.get(n, n / (n - 0.8)) if n > 1 else 0.0
    return med, MAD_K * b_n * np.median(np.abs(x - med), axis=0)


def item_stats(take_ids: list[str], cells: list[tuple], feature: Feature, min_refs: int) -> dict:
    """Location / spread of one feature at one word or region across references."""
    usable = [(t, v) for t, (v, _) in zip(take_ids, cells) if v is not None]
    rec = {
        "status": "ok" if len(usable) >= min_refs else "insufficient",
        "n": len(usable),
        "values": [_r(v) for v, _ in cells],
        "excluded": {t: reason for t, (v, reason) in zip(take_ids, cells) if v is None},
    }
    if rec["status"] == "ok":
        vals = [v for _, v in usable]
        if feature.kind == "bool":
            rec["p"] = _r(np.mean(vals))
        else:
            med, mad = robust_stats(vals)
            rec["median"], rec["mad"] = _r(med), _r(mad)
    return rec


PAIR_K = 0.6745 * math.sqrt(2)  # median |x_i - x_j| of two N(0, sigma) draws, in sigma


def pooled_scales(items: list[dict], features: dict[str, Feature]) -> dict:
    """Per feature: median pairwise |difference| between references / PAIR_K."""
    pooled = {}
    for name in features:
        diffs = [np.abs(np.asarray(a) - np.asarray(b)) for it in items if it[name].get("mad") is not None
                 for a, b in combinations([v for v in it[name]["values"] if v is not None], 2)]
        pooled[name] = _r(np.median(np.asarray(diffs), axis=0) / PAIR_K) if diffs else None
    return pooled


def finalize(items: list[dict], take_ids: list[str], features: dict[str, Feature],
             pooled: dict, cfg: BaselineConfig) -> None:
    """Add the moderated scale and reference outliers in place."""
    for it in items:
        for name, feature in features.items():
            rec = it[name]
            if rec.get("mad") is None:
                continue
            prior = np.asarray(pooled[name] or 0.0) ** 2
            df = rec["n"] - 1
            moderated = np.sqrt((cfg.prior_df * prior + df * np.asarray(rec["mad"]) ** 2) / (cfg.prior_df + df))
            scale = np.maximum(moderated, feature.resolution)
            rec["scale"] = _r(scale)
            outliers = []
            rec["outliers"] = [t for t, v in zip(take_ids, rec["values"])
                               if v is not None and robust_z(v, rec) > cfg.outlier_z]


def _build(take_ids: list[str], tables: list[dict], cfg: BaselineConfig) -> dict:
    """Word, region and take baselines from per-take value tables."""
    def items(level, features):
        n_items = len(tables[0][level])
        return [{name: item_stats(take_ids, [tab[level][i][name] for tab in tables], f, cfg.min_refs)
                 for name, f in features.items()} for i in range(n_items)]

    words, regions = items("words", WORD_FEATURES), items("regions", REGION_FEATURES)
    take = {name: item_stats(take_ids, [tab["take"][name] for tab in tables], REGION_FEATURES[name], cfg.min_refs)
            for name in tables[0]["take"]}
    pooled = {"words": pooled_scales(words, WORD_FEATURES), "regions": pooled_scales(regions, REGION_FEATURES)}
    finalize(words, take_ids, WORD_FEATURES, pooled["words"], cfg)
    finalize(regions, take_ids, REGION_FEATURES, pooled["regions"], cfg)
    finalize([take], take_ids, {k: REGION_FEATURES[k] for k in take}, pooled["regions"], cfg)
    return {"words": words, "regions": regions, "take": take, "pooled_scale": pooled}


def pitch_span_windows(take: dict, cfg: "BaselineConfig") -> list[list[int]]:
    """Word positions of each word's centred span window, clipped to its sentence."""
    regions = sentence_ids(take["alignment"]["words"], take["pause"]["settings"]["sentence_end"])
    half, n = cfg.pitch_span_words // 2, len(regions)
    return [[j for j in range(max(0, i - half), min(n, i + half + 1)) if regions[j] == regions[i]] for i in range(n)]


def pitch_span_values(take: dict, word_rows: list[dict], cfg: "BaselineConfig") -> list[tuple]:
    """(ln std of word median F0 over a centred, sentence-clipped window, reason) per word."""
    out = []
    for window in pitch_span_windows(take, cfg):
        voiced = [word_rows[j]["f0_median_st"][0] for j in window if word_rows[j]["f0_median_st"][0] is not None]
        if len(voiced) < cfg.pitch_span_min_words:
            out.append((None, "insufficient_span_pitch"))
        else:
            out.append((math.log(max(float(np.std(voiced)), cfg.pitch_span_floor_st)), None))
    return out


def value_table(take: dict, cfg: "BaselineConfig | None" = None) -> dict:
    """Per-word / sentence / take values; ``cfg`` supplies the span settings."""
    words = word_values(take)
    for row, span in zip(words, pitch_span_values(take, words, cfg or BaselineConfig())):
        row["log_f0_span_std"] = span
    return {"words": words, "regions": region_values(take, words), "take": take_values(take, words)}


# --------------------------------------------------------------- validation


def robust_z(value, stats: dict) -> float | None:
    """|value - median| / scale; RMS over dimensions for vectors (MFCC)."""
    if value is None or stats.get("scale") is None:
        return None
    z = (np.asarray(value) - np.asarray(stats["median"])) / np.asarray(stats["scale"])
    return float(np.sqrt(np.mean(z ** 2)))


def leave_one_out(take_ids: list[str], tables: list[dict], cfg: BaselineConfig, z_flag: float) -> dict:
    """Each reference scored against the baseline of the others."""
    out = {}
    for i, held in enumerate(take_ids):
        rest_ids = take_ids[:i] + take_ids[i + 1:]
        base = _build(rest_ids, tables[:i] + tables[i + 1:], cfg)
        per_feature = {}
        for name, feature in WORD_FEATURES.items():
            if feature.kind == "bool":
                cells = [(row[name][0], b[name]) for row, b in zip(tables[i]["words"], base["words"])]
                scored = [(v, b["p"]) for v, b in cells if v is not None and b.get("p") is not None]
                agree = [v == round(p) for v, p in scored if p != 0.5]
                per_feature[name] = {"n": len(agree), "agreement": _r(np.mean(agree)) if agree else None}
                continue
            z = [robust_z(row[name][0], b[name]) for row, b in zip(tables[i]["words"], base["words"])]
            z = np.array([v for v in z if v is not None])
            per_feature[name] = {
                "n": int(len(z)),
                "median_abs_z": _r(np.median(z)) if len(z) else None,
                "frac_over": _r(np.mean(z > z_flag)) if len(z) else None,
            }
        all_z = [robust_z(row[n][0], b[n]) for row, b in zip(tables[i]["words"], base["words"])
                 for n, f in WORD_FEATURES.items() if f.kind == "scalar"]
        all_z = np.array([v for v in all_z if v is not None])
        out[held] = {"median_abs_z": _r(np.median(all_z)), "frac_over": _r(np.mean(all_z > z_flag)),
                     "features": per_feature}
    return out


def profile_correlations(take_ids: list[str], tables: list[dict]) -> dict:
    """Pearson r of per-word profiles between each pair of references."""
    out = {}
    for name, feature in WORD_FEATURES.items():
        if feature.kind != "scalar":
            continue
        pairs = {}
        for (i, a), (j, b) in combinations(enumerate(take_ids), 2):
            xy = [(ra[name][0], rb[name][0]) for ra, rb in zip(tables[i]["words"], tables[j]["words"])
                  if ra[name][0] is not None and rb[name][0] is not None]
            x, y = np.array(xy).T if len(xy) >= 3 else (None, None)
            pairs[f"{a}~{b}"] = _r(np.corrcoef(x, y)[0, 1], 3) if x is not None and np.std(x) and np.std(y) else None
        out[name] = pairs
    return out


# ----------------------------------------------------------------- pipeline


def reference_takes(speech_id: str, cfg: BaselineConfig, align_cfg: AlignmentConfig) -> list[str]:
    return sorted(p.stem for p in (Path(align_cfg.output_dir) / speech_id).glob("*.json")
                  if p.stem.startswith(cfg.reference_prefix))


def build_baseline(speech_id: str, takes: list[dict], cfg: BaselineConfig, z_flag: float = 2.0) -> dict:
    takes = sorted(takes, key=lambda t: t["take_id"])  # order-independent output
    if len(takes) < cfg.min_refs:
        raise ValueError(f"{speech_id}: {len(takes)} reference take(s), need at least {cfg.min_refs}")
    words = takes[0]["alignment"]["words"]
    for t in takes[1:]:
        if [w["norm"] for w in t["alignment"]["words"]] != [w["norm"] for w in words]:
            raise ValueError(f"{speech_id}/{t['take_id']}: word sequence differs from {takes[0]['take_id']}")

    take_ids = [t["take_id"] for t in takes]
    tables = [value_table(t, cfg) for t in takes]
    base = _build(take_ids, tables, cfg)
    regions = sentence_ids(words, takes[0]["pause"]["settings"]["sentence_end"])
    spans = takes[0]["rate"]["regions"]

    def summarize(items):
        cells = [rec for it in items for rec in it.values()]
        return {"n_items": len(items), "n_cells": len(cells),
                "n_insufficient": sum(c["status"] == "insufficient" for c in cells),
                "n_with_outlier": sum(bool(c.get("outliers")) for c in cells)}

    excluded = {}
    for it in base["words"]:
        for rec in it.values():
            for reason in rec["excluded"].values():
                excluded[reason] = excluded.get(reason, 0) + 1

    return {
        "schema_version": SCHEMA_VERSION,
        "speech_id": speech_id,
        "settings": cfg.settings(),
        "references": [{"take_id": t["take_id"], "audio_sha256": t["alignment"]["audio"]["sha256"],
                        "alignment_cache_key": t["alignment"]["cache_key"]} for t in takes],
        "feature_definitions": {
            level: {n: asdict(f) for n, f in feats.items()}
            for level, feats in (("words", WORD_FEATURES), ("regions", REGION_FEATURES))
        },
        "pooled_scale": base["pooled_scale"],
        "summary": {"words": summarize(base["words"]), "regions": summarize(base["regions"]),
                    "excluded_word_values": dict(sorted(excluded.items()))},
        "take": base["take"],
        "regions": [{"region_idx": s["region_idx"], "first_idx": s["first_idx"], "last_idx": s["last_idx"],
                     "features": f} for s, f in zip(spans, base["regions"])],
        "words": [{"idx": w["idx"], "text": w["text"], "norm": w["norm"], "region_idx": reg, "features": f}
                  for w, reg, f in zip(words, regions, base["words"])],
        "validation": {
            "z_flag": z_flag,
            "leave_one_out": leave_one_out(take_ids, tables, cfg, z_flag) if len(takes) > cfg.min_refs else None,
            "profile_correlation": profile_correlations(take_ids, tables),
        },
    }


def save_baseline(doc: dict, cfg: BaselineConfig) -> Path:
    path = Path(cfg.output_dir) / f"{doc['speech_id']}.baseline.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return path


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Build the reference baseline of a script from its good takes.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--all", action="store_true", help="every script with cached alignments")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    cfg = BaselineConfig.from_yaml(args.config)
    with open(args.config, encoding="utf-8") as f:
        z_flag = ((yaml.safe_load(f) or {}).get("detection") or {}).get("z_open", 2.0)
    speeches = sorted(p.name for p in Path(align_cfg.output_dir).iterdir() if p.is_dir()) if args.all else [args.speech]

    for speech_id in speeches:
        takes = [load_take(speech_id, t, cfg, align_cfg) for t in reference_takes(speech_id, cfg, align_cfg)]
        doc = build_baseline(speech_id, takes, cfg, z_flag)
        path = save_baseline(doc, cfg)
        s, v = doc["summary"], doc["validation"]
        print(f"{speech_id}: {len(takes)} refs -> {path.as_posix()}")
        print(f"  words {s['words']}  regions {s['regions']}")
        print(f"  excluded word values {s['excluded_word_values']}")
        for take_id, loo in (v["leave_one_out"] or {}).items():
            print(f"  LOO {take_id}: median |z| {loo['median_abs_z']}  |z|>{z_flag} {loo['frac_over']:.1%}")
        for name in ("f0_median_st", "energy_rel_db", "duration_rel", "pause_after_s"):
            print(f"  r({name}) {v['profile_correlation'][name]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
