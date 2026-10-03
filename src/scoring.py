"""Deterministic weighted delivery score from refined flaws (config ``scoring``).

Per category c (pacing, pitch, pauses, energy, clarity):

    penalty_c = sum of severity scores (0..1) of the category's flaw tracks
                (dominant flaws and secondary tracks)
    score_c   = 100 x max(0, 1 - penalty_c / flaws_to_zero)

so one severe flaw costs 100 / flaws_to_zero points of that category,
independent of its length. The delivery score is sum_c weight_c x score_c;
every category's weighted contribution and lost points are reported with it,
because the total alone hides where the problems are. It is a secondary
summary: the evidence is in the flaws.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

import yaml

CATEGORY_KEYS = {"pacing": "pacing", "pitch": "pitch", "pause": "pauses", "energy": "energy", "clarity": "clarity"}


@dataclass(frozen=True)
class ScoringConfig:
    weights: dict = field(default_factory=lambda: {"pacing": 0.25, "pitch": 0.25, "pauses": 0.20,
                                                   "energy": 0.15, "clarity": 0.15})
    flaws_to_zero: float = 3.0  # summed severity at which a category scores 0

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "ScoringConfig":
        with open(path, encoding="utf-8") as f:
            section = dict((yaml.safe_load(f) or {}).get("scoring") or {})
        flaws_to_zero = section.pop("flaws_to_zero", cls.flaws_to_zero)
        return cls(weights=section or cls().weights, flaws_to_zero=flaws_to_zero)


def delivery_score(flaws_doc: dict, cfg: ScoringConfig) -> dict:
    total_weight = sum(cfg.weights.values())
    tracks = [t for f in flaws_doc["flaws"] for t in (f, *f["secondary"])]
    rows = {}
    for cat, key in CATEGORY_KEYS.items():
        mine = [t for t in tracks if t["category"] == cat]
        penalty = sum(t["severity"]["score"] for t in mine)
        score = 100.0 * max(0.0, 1.0 - penalty / cfg.flaws_to_zero)
        w = cfg.weights[key] / total_weight
        rows[cat] = {"weight": round(w, 4), "n_tracks": len(mine), "penalty": round(penalty, 4),
                     "score": round(score, 2), "contribution": round(w * score, 2),
                     "lost": round(w * (100.0 - score), 2)}
    return {"total": round(sum(r["contribution"] for r in rows.values()), 2), "categories": rows,
            "settings": asdict(cfg)}
