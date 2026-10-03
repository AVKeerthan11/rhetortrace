"""Analysis artifact export: the JSON (and audio) the React frontend reads.

One take document per analysed recording (words, flaws with reference values for
every evidence measurement, pitch / energy contours with warped reference contours,
waveform peaks, delivery profile and score, ground truth for demo takes) and one
index entry per take. Used by scripts/build_dashboard.py (the dataset / demo
workflow, whose output must stay byte-identical: tests/test_golden_path.py) and by
src.pipeline (arbitrary new recordings, ``kind="user"``).

Reference contours are mapped onto the take's timeline word by word: within
each word (and each gap) reference time is mapped linearly onto the take's
time, so a reference band means "how good deliveries sounded on these words".
"""

from __future__ import annotations

import json
import math
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from src.alignment import SAMPLE_RATE, AlignmentConfig, load_alignment, load_audio
from src.baseline import BaselineConfig, build_baseline, check_baseline_fresh, load_take
from src.demo import DEMO_DIR, ManifestError, load_manifest
from src.detection import SCHEMA_VERSION as DETECTION_SCHEMA
from src.detection import SCORED_FEATURES
from src.errors import StaleArtifactError, require_schema
from src.flaws import SCHEMA_VERSION as FLAWS_SCHEMA
from src.evaluation import boundary_errors, matches
from src.explain import DISPLAY, measurement
from src.scoring import ScoringConfig, delivery_score

OUT = Path("web/public")  # served by the React app (web/) as /data and /audio
STEP = 0.02  # contour grid (s)
PEAK_BINS = 2400
CATEGORIES = ("pacing", "pitch", "pause", "energy", "clarity")
PROFILE = {  # category -> take-level context feature shown in the delivery profile
    "pacing": ("log_articulation_rate", "articulation rate", "words/s", "exp"),
    "pitch": ("f0_word_std_st", "pitch variation across words", "st", "identity"),
    "pause": ("pause_ratio", "within-sentence pause time", "share", "identity"),
    "energy": ("energy_rel_db", "median word level", "dB re speaker", "identity"),
    "clarity": (None, "spectral shape", "", None),
}


def r(x, nd=3):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    return round(float(x), nd)


def show(x, how):
    if x is None:
        return None
    return {"exp": math.exp, "exp10": lambda v: 10 ** v, "identity": float}[how](x)


# ------------------------------------------------------------------ inputs


def load_json(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def baseline_of(detection: dict, base_cfg: BaselineConfig, align_cfg: AlignmentConfig) -> dict:
    """The baseline the detection was run against (cached or rebuilt leave-one-out).

    The cached baseline is checked against the current reference alignments first."""
    path, speech = detection["baseline"]["path"], detection["speech_id"]
    if path and path.startswith("leave-one-out:"):
        left = path.split(":", 1)[1]
        full = check_baseline_fresh(load_json(Path(base_cfg.output_dir) / f"{speech}.baseline.json"), align_cfg)
        rest = [load_take(speech, ref["take_id"], base_cfg, align_cfg) for ref in full["references"]
                if ref["take_id"] != left]
        return build_baseline(speech, rest, base_cfg)
    return check_baseline_fresh(load_json(path), align_cfg)


# ---------------------------------------------------------------- contours


def frame_contours(speech: str, take: str, feats: Path) -> dict:
    """Pitch (st re speaker F0) and energy (dB re speaker level) on frame times."""
    p, e = np.load(feats / speech / f"{take}.pitch.npz"), np.load(feats / speech / f"{take}.energy.npz")
    ref_hz = load_json(feats / speech / f"{take}.pitch.json")["speaker_ref_hz"]
    ref_db = load_json(feats / speech / f"{take}.energy.json")["speaker_ref_db"]
    return {"pitch": (p["times"], 12 * np.log2(p["f0_hz"] / ref_hz)), "energy": (e["times"], e["energy_db"] - ref_db)}


def sample(times: np.ndarray, values: np.ndarray, at: np.ndarray) -> np.ndarray:
    """Nearest-frame values at ``at`` (NaN outside the frame range)."""
    step = times[1] - times[0]
    out = np.full(len(at), np.nan)
    finite = ~np.isnan(at)
    idx = np.round((at[finite] - times[0]) / step).astype(int)
    ok = (idx >= 0) & (idx < len(values))
    out[np.flatnonzero(finite)[ok]] = values[idx[ok]]
    return out


def warp_knots(test_words: list[dict], ref_words: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """Monotone (test time, reference time) pairs at the boundaries of words aligned in both."""
    tk, rk = [], []
    for t, q in zip(test_words, ref_words):
        if not (t["aligned"] and q["aligned"]):
            continue
        for a, b in ((t["start"], q["start"]), (t["end"], q["end"])):
            if not tk or (a > tk[-1] and b > rk[-1]):
                tk.append(a)
                rk.append(b)
    return np.asarray(tk), np.asarray(rk)


def contours(speech: str, take: str, words: list[dict], refs: list[str], feats: Path, align_dir: Path,
             duration: float) -> dict:
    grid = np.arange(0.0, duration, STEP)
    own = frame_contours(speech, take, feats)
    out = {"step": STEP, "t0": 0.0, "n": int(len(grid)), "pitch": {}, "energy": {}}
    for name in ("pitch", "energy"):
        out[name]["take"] = [r(v, 2) for v in sample(*own[name], grid)]
    for ref in refs:
        ref_words = load_alignment(align_dir / speech / f"{ref}.json")["words"]
        tk, rk = warp_knots(words, ref_words)
        inside = (grid >= tk[0]) & (grid <= tk[-1])
        at = np.where(inside, np.interp(grid, tk, rk), np.nan)
        theirs = frame_contours(speech, ref, feats)
        for name in ("pitch", "energy"):
            out[name][ref] = [r(v, 2) for v in sample(*theirs[name], at)]
    for name in ("pitch", "energy"):
        stack = np.array([[np.nan if v is None else v for v in out[name][ref]] for ref in refs], dtype=float)
        with warnings.catch_warnings():  # all-NaN columns (unvoiced everywhere) stay NaN
            warnings.simplefilter("ignore", RuntimeWarning)
            lo, hi = np.nanmin(stack, axis=0), np.nanmax(stack, axis=0)
            med = np.nanmedian(stack, axis=0)
        out[name]["band"] = {"lo": [r(v, 2) for v in lo], "hi": [r(v, 2) for v in hi],
                             "median": [r(v, 2) for v in med]}
    if np.isnan(np.array([np.nan if v is None else v for v in out["energy"]["take"]], dtype=float)).all():
        raise ValueError("empty energy contour")
    return out


def peaks(audio: np.ndarray, bins: int = PEAK_BINS) -> dict:
    edges = np.linspace(0, len(audio), bins + 1).astype(int)
    mins = [r(audio[a:b].min(), 3) if b > a else 0.0 for a, b in zip(edges, edges[1:])]
    maxs = [r(audio[a:b].max(), 3) if b > a else 0.0 for a, b in zip(edges, edges[1:])]
    return {"bins": bins, "min": mins, "max": maxs}


# -------------------------------------------------------------------- takes


def reference_points(baseline: dict, idx: int, name: str) -> list[dict]:
    """Each reference take's own value of a word feature, in display units."""
    cell = baseline["words"][idx]["features"][name]
    how = DISPLAY[name][3]
    refs = [x["take_id"] for x in baseline["references"]]
    out = []
    for take, v in zip(refs, cell.get("values") or []):
        out.append({"take": take, "value": None if v is None or how == "vector" else r(show(v, how), 4),
                    "excluded": cell.get("excluded", {}).get(take)})
    return out


def with_reference_points(track: dict, baseline: dict) -> dict:
    exp = track["explanation"]
    for m in [exp["strongest_evidence"], *exp["supporting_evidence"]]:
        if m is not None:
            m["reference_points"] = reference_points(baseline, m["idx"], m["feature"])
            cell = baseline["words"][m["idx"]]["features"][m["feature"]]
            how = DISPLAY[m["feature"]][3]
            if how != "vector" and cell.get("median") is not None and cell.get("scale") is not None:
                lo, hi = cell["median"] - cell["scale"], cell["median"] + cell["scale"]
                m["reference_band"] = [r(show(lo, how), 4), r(show(hi, how), 4)]
    return track


def word_records(detection: dict, alignment: dict, rate_doc: dict) -> list[dict]:
    low = set(alignment["quality"]["low_score_idx"]) | set(alignment["quality"]["too_short_idx"])
    sentence = {w["idx"]: w["region_idx"] for w in rate_doc["words"]}
    out = []
    for w, a in zip(detection["words"], alignment["words"]):
        feats = []
        for name in SCORED_FEATURES:
            d = w["features"][name]
            if d["z"] is not None:
                m = measurement(w, name)
                feats.append({"feature": name, "label": m["label"], "unit": m["unit"], "observed": m["observed"],
                              "reference": m["reference"], "z": r(m["z"], 2), "bound": m.get("bound")})
            else:
                feats.append({"feature": name, "label": DISPLAY[name][0], "status": d["status"],
                              "reason": d.get("reason")})
        cats = {}
        for c in CATEGORIES:
            s = w["categories"][c]
            cats[c] = None if s is None else {"score": r(s["score"], 2), "direction": s["direction"],
                                              "feature": s["feature"]}
        out.append({"idx": w["idx"], "text": w["text"], "start": w["start"], "end": w["end"],
                    "sentence": sentence.get(w["idx"]), "low_confidence": w["idx"] in low,
                    "alignment_score": a.get("alignment_score"), "categories": cats, "features": feats})
    return out


def profile(detection: dict, flaws: dict, n_words: int) -> dict:
    tracks = [t for f in flaws["flaws"] for t in (f, *f["secondary"])]
    out = {}
    for cat in CATEGORIES:
        name, label, unit, how = PROFILE[cat]
        mine = [t for t in tracks if t["category"] == cat]
        words = {i for t in mine for i in range(t["start_idx"], t["end_idx"] + 1)}
        row = {"label": label, "unit": unit, "n_tracks": len(mine),
               "worst": max((t["severity"]["level"] for t in mine), default=None),
               "seconds": r(sum(t["duration_s"] or 0 for t in mine), 2), "word_share": r(len(words) / n_words, 3),
               "take_z": None}
        if name:
            d = detection["take_context"][name]
            row.update(take_z=r(d["z"], 2), observed=r(show(d["value"], how), 3), reference=r(show(d["median"], how), 3))
        out[cat] = row
    return out


def ground_truth_check(flaws: dict, truth: list[dict]) -> list[dict]:
    tracks = [t for f in flaws["flaws"] for t in (f, *f["secondary"])]
    out = []
    for g in truth:
        hits = [t for t in tracks if matches(t, g["category"], g["direction"], g["start_idx"], g["end_idx"])]
        rec = {**g, "detected": bool(hits)}
        if hits:
            best = max(hits, key=lambda t: (min(g["end_idx"], t["end_idx"]) - max(g["start_idx"], t["start_idx"]),
                                            -t["start_idx"]))
            rec.update(boundary_errors(best, (g["start"], g["end"]), g["start_idx"], g["end_idx"]),
                       detected_span=[best["start_idx"], best["end_idx"]], severity=best["severity"]["label"])
        out.append(rec)
    return out


def demo_manifest_for(speech: str, take: str, references: list[str], root: str | Path = DEMO_DIR) -> dict | None:
    """None for a reference (control) take; the validated manifest for any other take.

    A non-reference take without a valid manifest is an error, never a silent "control".
    """
    manifest = load_manifest(speech, take, root)  # raises ManifestError if incomplete
    if take in references:
        if manifest is not None:
            raise ManifestError(f"{speech}/{take} is a reference take but has a demo manifest")
        return None
    if manifest is None:
        raise ManifestError(f"{speech}/{take} is not a reference take and has no demo manifest; "
                            "run python scripts/build_demo.py")
    return manifest


@dataclass(frozen=True)
class ExportPaths:
    """Where an export reads pipeline outputs and writes frontend files.

    Defaults are the dataset workflow (results/... -> web/public)."""

    out: Path = OUT
    detections: Path = Path("results/detections")
    flaws: Path = Path("results/flaws")
    demo: Path = DEMO_DIR


def export_cfgs(config: str | Path = "config.yaml") -> dict:
    return {"align": AlignmentConfig.from_yaml(config), "base": BaselineConfig.from_yaml(config),
            "scoring": ScoringConfig.from_yaml(config)}


def write_json(path: Path, doc) -> None:
    """Compact, key-sorted, LF-terminated: the byte format of web/public/data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        f.write("\n")


def write_flac(audio: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio, SAMPLE_RATE, subtype="PCM_16")


def export_take(speech: str, take: str, cfgs: dict, *, paths: ExportPaths = ExportPaths(),
                baseline: dict | None = None, kind: str | None = None, label: str | None = None,
                display: dict | None = None, export_reference_audio: bool = False) -> dict:
    """Build one take document and write its audio (FLAC) under ``paths.out / "audio"``.

    Dataset workflow (all keyword arguments default): the baseline is resolved from
    the detection's provenance and ``kind`` is "demo" (validated manifest) or
    "control" (a reference take). For a new recording (``kind="user"``) the caller
    passes the baseline it detected against; there is no manifest or ground truth,
    ``display`` (names chosen by the user) is added, and with
    ``export_reference_audio`` the reference recordings' audio is written too, since
    they are not exported as takes of their own. The document is returned, not written.
    """
    align_cfg, base_cfg, scoring = cfgs["align"], cfgs["base"], cfgs["scoring"]
    feats = Path(base_cfg.features_dir)
    alignment = load_alignment(Path(align_cfg.output_dir) / speech / f"{take}.json")
    detection = require_schema(load_json(Path(paths.detections) / speech / f"{take}.detection.json"),
                               DETECTION_SCHEMA, f"{speech}/{take} detection", "export")
    flaws = require_schema(load_json(Path(paths.flaws) / speech / f"{take}.flaws.json"), FLAWS_SCHEMA,
                           f"{speech}/{take} flaws", "export")
    if detection["alignment_cache_key"] != alignment["cache_key"] or flaws["alignment_cache_key"] != alignment["cache_key"]:
        raise StaleArtifactError(f"{speech}/{take}: detection / flaws are stale for the current alignment; "
                                 "re-run detection", stage="export")
    if baseline is None:
        baseline = baseline_of(detection, base_cfg, align_cfg)
    if kind == "user":
        manifest = None
    elif kind is None:
        manifest = demo_manifest_for(speech, take, [r["take_id"] for r in
                                                    load_json(Path(base_cfg.output_dir) / f"{speech}.baseline.json")["references"]],
                                     paths.demo)
    else:
        raise ValueError(f"unknown export kind {kind!r}")
    refs = [x["take_id"] for x in baseline["references"]]

    audio = load_audio(alignment["audio"]["path"])
    duration = len(audio) / SAMPLE_RATE
    key = f"{speech}__{take}"
    write_flac(audio, Path(paths.out) / "audio" / f"{key}.flac")
    ref_alignments = {ref: load_alignment(Path(align_cfg.output_dir) / speech / f"{ref}.json") for ref in refs}
    if export_reference_audio:
        for ref, ra in ref_alignments.items():
            write_flac(load_audio(ra["audio"]["path"]), Path(paths.out) / "audio" / f"{speech}__{ref}.flac")

    for f in flaws["flaws"]:
        with_reference_points(f, baseline)
        for s in f["secondary"]:
            with_reference_points(s, baseline)
    words = word_records(detection, alignment, load_json(feats / speech / f"{take}.rate.json"))
    score = delivery_score(flaws, scoring)
    if kind == "user":
        doc_kind, doc_label = "user", label or "uploaded recording"
    else:
        doc_kind = "demo" if manifest else "control"
        doc_label = manifest["label"] if manifest else "clean good take (control)"
    qc = {k: alignment["quality"][k] for k in ("status", "warnings", "low_score_idx", "too_short_idx",
                                               "aligned_ratio", "mean_alignment_score")}
    if kind == "user":  # surfaced to the person who uploaded it; dataset docs keep their exact bytes
        qc["asr_wer"] = (alignment["quality"].get("asr") or {}).get("wer")
        qc["unaligned_idx"] = alignment["quality"]["unaligned_idx"]
    doc = {
        "id": key, "speech_id": speech, "take_id": take,
        "kind": doc_kind,
        "label": doc_label,
        "source_take": manifest["source_take"] if manifest else None,
        "duration": r(duration, 3), "audio": f"audio/{key}.flac", "audio_sha256": alignment["audio"]["sha256"],
        "transcript": " ".join(w["text"] for w in alignment["words"]),
        "qc": qc,
        "baseline": {"source": detection["baseline"]["path"], "references": refs,
                     "in_sample": detection["baseline"]["in_sample"]},
        "references": [{"take_id": ref, "audio": f"audio/{speech}__{ref}.flac",
                        "words": [[w["start"], w["end"]] for w in ref_alignments[ref]["words"]]}
                       for ref in refs],
        "severity_settings": {k: flaws["settings"][k] for k in ("level_thresholds", "labels", "z_min", "z_max")},
        "detection_settings": {k: detection["settings"][k] for k in ("z_open", "z_close")},
        "summary": flaws["summary"],
        "profile": profile(detection, flaws, len(words)),
        "score": score,
        "flaws": flaws["flaws"],
        "words": words,
        "contours": contours(speech, take, alignment["words"], refs, feats, Path(align_cfg.output_dir), duration),
        "peaks": peaks(audio),
        "ground_truth": ground_truth_check(flaws, manifest["ground_truth"]) if manifest else None,
        "edits": manifest["edits"] if manifest else None,
    }
    if display:
        doc["display"] = display
    return doc


# --------------------------------------------------------------------- index


def index_entry(doc: dict) -> dict:
    """The take's row in index.json (take lists, thumbnails)."""
    entry = {"id": doc["id"], "speech_id": doc["speech_id"], "take_id": doc["take_id"], "kind": doc["kind"],
             "label": doc["label"], "source_take": doc["source_take"], "duration": doc["duration"],
             "n_flaws": len(doc["flaws"]), "score": doc["score"]["total"],
             "opening": " ".join(doc["transcript"].split()[:7]) + " ...",
             "ground_truth": None if doc["ground_truth"] is None else
             [sum(g["detected"] for g in doc["ground_truth"]), len(doc["ground_truth"])],
             # [start, end, category, severity level] per finding, for take-list thumbnails
             "marks": [[f["start"], f["end"], f["category"], f["severity"]["level"]] for f in doc["flaws"]]}
    if "display" in doc:
        entry["display"] = doc["display"]
    return entry


KIND_ORDER = {"demo": 0, "user": 1, "control": 2}


def upsert_index(path: Path, entry: dict) -> dict:
    """Add or replace one take in an index.json, keeping the other takes and any validation data."""
    path = Path(path)
    index = load_json(path) if path.exists() else {"takes": [], "validation": None}
    takes = [t for t in index["takes"] if t["id"] != entry["id"]] + [entry]
    index["takes"] = sorted(takes, key=lambda t: (KIND_ORDER.get(t["kind"], 9), t["speech_id"], t["take_id"]))
    write_json(path, index)
    return index
