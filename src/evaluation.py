"""Evaluation metrics and report helpers (pure functions, deterministic).

Units of prediction are refined flaw tracks (``src.flaws``: every flaw and its
secondary tracks), each with category, direction and word span.

Synthetic protocol (``scripts/evaluate.py``). The evaluation set is the clean
control takes plus, per control take, injected variants (one known flaw each):
  control tracks    every track of a clean take is a false positive, counted
                    once per take (all takes are good deliveries)
  changed tracks    in an injected variant only tracks that differ from the
                    control's (category, direction, start, end) are new
                    predictions; the rest are the control's own tracks again
  true positive     a changed track of the injected category (and direction,
                    where the category has one) overlapping the injected words;
                    at most one per injection, further matches are duplicates
  collateral FP     any other changed track (wrong category / place) or
                    duplicate
  false negative    a clean injection (scorable, and the control had no
                    same-category track there) without a true positive
Injections without usable measurements (unscorable) or on top of an existing
same-category control track (confounded) are reported but excluded from
recall, so pre-existing false positives never count as hits.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.stats import spearmanr

CATEGORIES = ("pacing", "pitch", "pause", "energy", "clarity")


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


# ----------------------------------------------------------- track matching


def track_key(t: dict) -> tuple:
    return (t["category"], t["direction"], t["start_idx"], t["end_idx"])


def matches(t: dict, category: str, direction, a: int, b: int) -> bool:
    return (t["category"] == category and (direction is None or t["direction"] == direction)
            and t["start_idx"] <= b and t["end_idx"] >= a)


def classify_injection(tracks: list[dict], control: list[dict], category: str, direction,
                       a: int, b: int) -> dict:
    """True positive / collateral tracks of one injected variant."""
    control_keys = {track_key(t) for t in control}
    changed = sorted((t for t in tracks if track_key(t) not in control_keys),
                     key=lambda t: (t["start_idx"], t["end_idx"], t["category"], str(t["direction"])))
    hits = [t for t in changed if matches(t, category, direction, a, b)]
    overlap = lambda t: min(b, t["end_idx"]) - max(a, t["start_idx"]) + 1  # noqa: E731
    tp = max(hits, key=lambda t: (overlap(t), -t["start_idx"])) if hits else None
    collateral = [t for t in changed if t is not tp]
    return {"tp": tp, "collateral": collateral,
            "confounded": any(matches(t, category, direction, a, b) for t in control)}


def prf(tp: int, fp: int, fn: int) -> dict:
    """Precision / recall / F1; None where undefined (no predictions / no positives)."""
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = None if p is None or r is None else (2 * p * r / (p + r) if p + r > 0 else 0.0)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": _r(p), "recall": _r(r), "f1": _r(f1)}


def detection_metrics(controls: list[list[dict]], injections: list[dict], kind_category: dict) -> dict:
    """Overall and per-category P/R/F1.

    controls     tracks of each clean control take
    injections   [{"kind", "scorable", "confounded", "tp", "collateral"}] (classify_injection + kind)
    """
    tp, fp, fn = Counter(), Counter(), Counter()
    for tracks in controls:
        for t in tracks:
            fp[t["category"]] += 1
    excluded = Counter()
    for inj in injections:
        cat = kind_category[inj["kind"]]
        for t in inj["collateral"]:
            fp[t["category"]] += 1
        if not inj["scorable"]:
            excluded["unscorable"] += 1
            continue
        if inj["confounded"]:
            excluded["confounded"] += 1
            continue
        if inj["tp"] is not None:
            tp[cat] += 1
        else:
            fn[cat] += 1
    per = {c: prf(tp[c], fp[c], fn[c]) for c in CATEGORIES}
    control_fp = Counter(t["category"] for tracks in controls for t in tracks)
    for c in CATEGORIES:
        per[c]["control_fp"] = control_fp[c]
        per[c]["collateral_fp"] = fp[c] - control_fp[c]
    overall = prf(sum(tp.values()), sum(fp.values()), sum(fn.values()))
    overall.update(control_fp=sum(control_fp.values()), collateral_fp=sum(fp.values()) - sum(control_fp.values()))
    return {"overall": overall, "per_category": per, "excluded": dict(sorted(excluded.items()))}


# ------------------------------------------------------------- boundaries


def boundary_errors(track: dict, truth: tuple[float, float], a: int, b: int) -> dict:
    ts, te = truth
    s, e = track["start"], track["end"]
    union = max(e, te) - min(s, ts)
    wa, wb = track["start_idx"], track["end_idx"]
    return {"start_err_s": _r(abs(s - ts), 3), "end_err_s": _r(abs(e - te), 3),
            "iou": _r(max(0.0, min(e, te) - max(s, ts)) / union, 3) if union > 0 else 0.0,
            "word_iou": _r(max(0, min(b, wb) - max(a, wa) + 1) / (max(b, wb) - min(a, wa) + 1), 3)}


def summarize(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    v = np.asarray(values, dtype=np.float64)
    return {"n": int(len(v)), "mean": _r(v.mean()), "median": _r(np.median(v)),
            "p90": _r(np.percentile(v, 90)), "max": _r(v.max())}


def boundary_summary(errors: list[dict]) -> dict:
    return {k: summarize([e[k] for e in errors]) for k in ("start_err_s", "end_err_s", "iou", "word_iou")}


# --------------------------------------------------------------- severity


def monotonicity(strengths: list[float], site_scores: list[list[float]]) -> dict:
    """Per-site non-decreasing fraction and pooled Spearman rho of strength vs score."""
    xs = [s for scores in site_scores for s in strengths]
    ys = [y for scores in site_scores for y in scores]
    rho = spearmanr(xs, ys).statistic if len(set(ys)) > 1 else None
    mono = sum(all(a <= b + 1e-9 for a, b in zip(sc, sc[1:])) for sc in site_scores)
    return {"n_sites": len(site_scores), "monotone_sites": mono,
            "monotone_fraction": _r(mono / len(site_scores)) if site_scores else None,
            "spearman_rho": _r(rho) if rho is not None and not math.isnan(rho) else None}


def calibration(scores: list[float], levels: list[int], labels: list[str]) -> dict:
    """Consistency of severity for one flaw kind at one strength."""
    if not scores:
        return {"n": 0}
    s = np.asarray(scores, dtype=np.float64)
    counts = Counter(levels)
    modal = max(sorted(counts), key=lambda k: counts[k])
    return {"n": int(len(s)), "mean": _r(s.mean()), "std": _r(s.std()),
            "iqr": _r(np.percentile(s, 75) - np.percentile(s, 25)),
            "levels": {labels[k]: counts.get(k, 0) for k in range(len(labels))},
            "modal_level": labels[modal], "modal_agreement": _r(counts[modal] / len(s))}


# ----------------------------------------------------------- reproducibility


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_hashes(paths: list[str | Path], root: str | Path = ".") -> dict:
    """sha256 of files by root-relative POSIX path (missing files -> None)."""
    root = Path(root)
    out = {}
    for p in sorted({Path(p).as_posix() for p in paths}):
        f = root / p
        out[p] = sha256_bytes(f.read_bytes().replace(b"\r\n", b"\n")) if f.exists() else None
    return out


def dumps(doc) -> str:
    """Canonical JSON text: sorted keys, fixed separators, trailing newline."""
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write_text(path: str | Path, text: str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def fmt(x, pct=False, nd=3) -> str:
    if x is None:
        return "n/a"
    return f"{100 * x:.1f}%" if pct else f"{x:.{nd}f}"
