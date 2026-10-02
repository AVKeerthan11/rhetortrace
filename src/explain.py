"""Deterministic, evidence-only explanations of refined flaws (no LLM).

Every number in an explanation is a value already in the detection document
(``words[i]["features"][name]``: value, median, scale, z, status) or in the
refined flaw (times, words, severity, confidence, flags). The only
transformations are fixed unit conversions of the stored representation:

  feature                       stored              shown
  log_duration                  ln s                word duration, s (ratio)
  log_local_articulation_rate   ln words/s          local articulation rate, words/s (ratio)
  f0_median_st                  st re speaker F0    word pitch, st re speaker median (difference)
  f0_range_st                   st                  word pitch range, st (difference)
  log_f0_span_std               ln st               pitch variation over the span, st std (ratio)
  pause_after_s                 s                   pause after the word, s (difference)
  energy_rel_db / _peak_rel_db  dB re speaker       word level / peak level, dB re speaker (difference)
  centroid_rel_oct              oct re take median  spectral centroid, octaves re take median (difference)
  log_flatness                  log10               spectral flatness (ratio)
  mfcc                          13-dim vector       MFCC profile: no scalar value, RMS z only

``reference`` is always the baseline median of the same word. A silent word's
level is an upper bound and is shown as such. Measurements count as evidence
only when the cell has a z and its direction agrees with the flaw; cells
without a usable value are listed under ``unavailable_evidence`` with their
status and reason, never filled in.
"""

from __future__ import annotations

import math

from src.detection import SCORED_FEATURES

# feature -> (label, unit, short unit for differences, how the stored value is shown, comparison)
DISPLAY = {
    "log_duration": ("word duration", "s", "s", "exp", "ratio"),
    "log_local_articulation_rate": ("local articulation rate", "words/s", "words/s", "exp", "ratio"),
    "f0_median_st": ("word pitch", "st re speaker median", "st", "identity", "difference"),
    "f0_range_st": ("word pitch range", "st", "st", "identity", "difference"),
    "log_f0_span_std": ("pitch variation over the span", "st (std)", "st", "exp", "ratio"),
    "pause_after_s": ("pause after the word", "s", "s", "identity", "difference"),
    "energy_rel_db": ("word level", "dB re speaker level", "dB", "identity", "difference"),
    "energy_peak_rel_db": ("word peak level", "dB re speaker level", "dB", "identity", "difference"),
    "centroid_rel_oct": ("spectral centroid", "octaves re take median", "oct", "identity", "difference"),
    "log_flatness": ("spectral flatness", "", "", "exp10", "ratio"),
    "mfcc": ("MFCC profile", "", "", "vector", None),
}
HEADLINES = {
    ("pacing", "fast"): "Faster speech rate than the reference deliveries",
    ("pacing", "slow"): "Slower speech rate than the reference deliveries",
    ("pitch", "flatter"): "Flatter, reduced pitch variation compared with the references",
    ("pitch", "livelier"): "More pitch variation than the references",
    ("pitch", None): "Pitch deviates from the references",
    ("pause", "long"): "Excessive pause compared with the references",
    ("pause", "short"): "Pause shortened compared with the references",
    ("energy", "quiet"): "Quieter, lower energy than the references",
    ("energy", "loud"): "Louder, higher energy than the references",
    ("clarity", None): "Spectral / articulation deviation from the references",
}
FLAG_NOTES = {
    "low_coverage": "fewer than half of the words have a usable measurement for this category",
    "thin_evidence": "fewer usable words than the category's minimum; severity was scaled down",
    "single_word": "the flaw rests on a single word",
    "take_edge": "the flaw touches the start or end of the take",
    "near_unreliable_evidence": "a measurement in or next to the flaw is missing or low-confidence",
}
MAX_SUPPORTING = 3


def _f(x, nd=3):
    return None if x is None else round(float(x), nd)


def feature_direction(name: str, d: dict) -> str | None:
    """Direction of one feature deviation, as the detector labels it."""
    _, pos, neg = SCORED_FEATURES[name]
    if name == "f0_median_st" and d.get("median") is not None:
        return "livelier" if abs(d["value"]) > abs(d["median"]) else "flatter"
    if name == "f0_range_st":
        return "livelier" if d["z"] >= 0 else "flatter"
    return pos if d["z"] >= 0 else neg


def _show(x, how):
    if x is None:
        return None
    return {"exp": math.exp, "exp10": lambda v: 10 ** v, "identity": float}[how](x)


def measurement(word: dict, name: str) -> dict:
    """One feature deviation of one word, in display units, plus the stored values."""
    d = word["features"][name]
    label, unit, short, how, comparison = DISPLAY[name]
    out = {"idx": word["idx"], "word": word["text"], "feature": name, "label": label, "unit": unit,
           "observed": None, "reference": None, "comparison": comparison, "change": None,
           "z": d["z"], "stored": {"value": d["value"], "median": d["median"], "scale": d["scale"]}}
    if d.get("bound"):
        out["bound"] = d["bound"]
    if name == "pause_after_s":
        out["note"] = "z compares both gaps clipped up to the pause threshold (shorter gaps count as no pause)"
    if how == "vector":
        out["statement"] = f"{label}, \"{word['text']}\": differs from the references (RMS z = {d['z']:+.2f})"
        return out
    obs, ref = _show(d["value"], how), _show(d["median"], how)
    nd = 4 if name == "log_flatness" else 3
    out["observed"], out["reference"] = _f(obs, nd), _f(ref, nd)
    if obs is not None and ref is not None:
        out["change"] = _f(obs / ref, 2) if comparison == "ratio" and ref else _f(obs - ref, 2)
    at_most = "at most " if d.get("bound") == "upper" else ""
    change = (f"{out['change']:.2f}x the reference" if comparison == "ratio"
              else f"{out['change']:+.2f} {short}") if out["change"] is not None else "no reference value"
    unit_txt = f" {unit}" if unit else ""
    out["statement"] = (f"{label}, \"{word['text']}\": {at_most}{out['observed']}{unit_txt} vs reference "
                        f"{out['reference']}{unit_txt} ({change}; z = {d['z']:+.2f})")
    return out


def ranked_measurements(words: list[dict], a: int, b: int, category: str, direction) -> list[dict]:
    """Reliable measurements of the category in words a..b agreeing with the direction, strongest first."""
    found = []
    for w in words[a:b + 1]:
        for name, (cat, _, _) in SCORED_FEATURES.items():
            d = w["features"][name]
            if cat != category or d["z"] is None or d["z"] == 0:
                continue
            if direction is not None and feature_direction(name, d) != direction:
                continue
            found.append((-abs(d["z"]), w["idx"], name, w))
    return [measurement(w, name) for _, _, name, w in sorted(found, key=lambda t: t[:3])]


def unavailable(words: list[dict], a: int, b: int, category: str) -> list[dict]:
    """Category features without a usable value in words a..b, by status / reason."""
    out = []
    for name, (cat, _, _) in SCORED_FEATURES.items():
        if cat != category:
            continue
        reasons = {}
        for w in words[a:b + 1]:
            d = w["features"][name]
            if d["z"] is None:
                key = f"{d['status']}:{d['reason']}" if d.get("reason") else d["status"]
                reasons[key] = reasons.get(key, 0) + 1
        if reasons:
            out.append({"feature": name, "label": DISPLAY[name][0], "n_words": sum(reasons.values()),
                        "reasons": dict(sorted(reasons.items()))})
    return out


def _confidence_label(c: float) -> str:
    return "high" if c >= 0.8 else "medium" if c >= 0.5 else "low"


def _quote(ws: list[str], limit: int = 8) -> str:
    return " ".join(ws) if len(ws) <= limit else " ".join(ws[:limit]) + " ..."


def explain_track(track: dict, words: list[dict]) -> dict:
    """Explanation of one refined track (a flaw or a secondary track)."""
    cat, direction = track["category"], track["direction"]
    a, b = track["start_idx"], track["end_idx"]
    ranked = ranked_measurements(words, a, b, cat, direction)
    strongest = ranked[0] if ranked else None
    sev = track["severity"]
    headline = HEADLINES.get((cat, direction), f"{cat} deviation ({direction}) from the references")
    if cat == "pause" and direction == "short":
        ctx = words[b]["features"].get("is_pause_after", {})
        if ctx.get("value") == 0.0 and (ctx.get("p_ref") or 0) >= 0.5:
            headline = "Pause removed: the references pause here, this take does not"
    where = f"{track['start']:.2f}-{track['end']:.2f} s, \"{_quote(track['words'])}\""
    evidence = strongest["statement"] if strongest else "no reliable measurement available"
    summary = f"{headline} ({where}): {evidence}. Severity: {sev['label']} ({sev['score']:.2f})."
    return {
        "summary": summary,
        "headline": headline,
        "category": cat,
        "direction": direction,
        "severity": {"level": sev["level"], "label": sev["label"], "score": sev["score"]},
        "time": {"start": track["start"], "end": track["end"], "duration_s": track["duration_s"]},
        "word_range": [a, b],
        "words": track["words"],
        "strongest_evidence": strongest,
        "supporting_evidence": ranked[1:1 + MAX_SUPPORTING],
        "unavailable_evidence": unavailable(words, a, b, cat),
        "confidence": {"value": track["confidence"], "label": _confidence_label(track["confidence"])},
        "quality_flags": [{"flag": f, "note": FLAG_NOTES.get(f, f)} for f in track["flags"]],
    }


def explain_flaw(flaw: dict, words: list[dict]) -> dict:
    """Explanation of a flaw, with its overlapping secondary categories."""
    exp = explain_track(flaw, words)
    exp["co_occurring"] = [
        {"category": s["category"], "direction": s["direction"],
         "headline": s["explanation"]["headline"], "severity": s["explanation"]["severity"],
         "time": s["explanation"]["time"], "word_range": s["explanation"]["word_range"]}
        for s in flaw["secondary"]]
    if exp["co_occurring"]:
        also = "; ".join(f"{c['headline'].lower()} ({c['severity']['label']})" for c in exp["co_occurring"])
        exp["summary"] += f" Overlaps with: {also}."
    return exp
