"""Pause analysis from cached word alignments.

Every boundary between consecutive canonical words i and i+1 gets a gap
(start = end of word i, end = start of word i+1). A gap counts as a pause when
it is at least ``min_pause_s``; shorter gaps are alignment granularity / normal
coarticulation (wav2vec2 boundaries are on a 20 ms grid, so gaps are never 0).

Boundaries are typed:
  sentence         word i ends a sentence (. ? !)
  within_sentence  any other boundary; ``punct_after`` records , ; : etc. so
                   later stages can tell punctuated from unpunctuated pauses
A boundary next to an unaligned word has unknown timing: gap fields are None
with ``pause_failure: "unaligned"`` (never 0).

Output: results/features/<speech>/<take>.pause.json with per-boundary pauses,
per-word pause context, per-sentence aggregates and a take summary.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

from src.alignment import AlignmentConfig, load_alignment
from src.features.rate import sentence_ids

SCHEMA_VERSION = 1
BOUNDARY_FIELDS = (
    "boundary_idx", "after_idx", "before_idx", "region_idx", "boundary_type", "punct_after",
    "start", "end", "gap_s", "is_pause", "pause_failure",
)
PAUSE_WORD_FIELDS = (
    "idx", "text", "aligned", "pause_before_s", "pause_after_s", "is_pause_after",
    "boundary_after", "before_failure", "after_failure",
)


@dataclass(frozen=True)
class PauseConfig:
    min_pause_s: float = 0.15  # shorter gaps are not pauses
    sentence_end: str = ".?!"
    output_dir: str = "results/features"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "PauseConfig":
        with open(path, encoding="utf-8") as f:
            features = (yaml.safe_load(f) or {}).get("features") or {}
        section = dict(features.get("pause") or {})
        if "output_dir" in features:
            section["output_dir"] = features["output_dir"]
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        return settings


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


def trailing_punct(text: str) -> str | None:
    tail = text[len(text.rstrip("\"')]”’.,;:?!—-")):]
    punct = "".join(c for c in tail if c in ".,;:?!—-")
    return punct or None


def boundary_pauses(words: list[dict], cfg: PauseConfig) -> list[dict]:
    """One record per boundary between word i and word i+1."""
    regions = sentence_ids(words, cfg.sentence_end)
    out = []
    for i, (a, b) in enumerate(zip(words, words[1:])):
        rec = {k: None for k in BOUNDARY_FIELDS}
        rec.update(
            boundary_idx=i, after_idx=a["idx"], before_idx=b["idx"], region_idx=regions[i],
            boundary_type="sentence" if regions[i + 1] != regions[i] else "within_sentence",
            punct_after=trailing_punct(a["text"]),
        )
        if not (a["aligned"] and b["aligned"]):
            rec["pause_failure"] = "unaligned"
        else:
            # the alignment contract allows 1 ms of overlap; that is no gap
            gap = max(0.0, b["start"] - a["end"])
            rec.update(start=a["end"], end=b["start"], gap_s=_r(gap), is_pause=gap >= cfg.min_pause_s)
        out.append(rec)
    return out


def word_pause_features(words: list[dict], boundaries: list[dict]) -> list[dict]:
    records = []
    for i, w in enumerate(words):
        rec = {k: None for k in PAUSE_WORD_FIELDS}
        rec.update(idx=w["idx"], text=w["text"], aligned=w["aligned"])
        if i == 0:
            rec["before_failure"] = "take_start"
        else:
            before = boundaries[i - 1]
            rec["pause_before_s"], rec["before_failure"] = before["gap_s"], before["pause_failure"]
        if i == len(words) - 1:
            rec["after_failure"] = "take_end"
        else:
            after = boundaries[i]
            rec.update(pause_after_s=after["gap_s"], is_pause_after=after["is_pause"],
                       boundary_after=after["boundary_type"], after_failure=after["pause_failure"])
        records.append(rec)
    return records


def _pause_stats(boundaries: list[dict]) -> dict:
    measured = [b for b in boundaries if b["gap_s"] is not None]
    pauses = [b["gap_s"] for b in measured if b["is_pause"]]
    return {
        "n_boundaries": len(boundaries),
        "n_measured": len(measured),
        "n_pauses": len(pauses),
        "total_pause_s": _r(sum(pauses)),
        "mean_pause_s": _r(statistics.fmean(pauses)) if pauses else None,
        "median_pause_s": _r(statistics.median(pauses)) if pauses else None,
        "max_pause_s": _r(max(pauses)) if pauses else None,
    }


def region_pause_features(words: list[dict], boundaries: list[dict], cfg: PauseConfig) -> list[dict]:
    """Per sentence: pauses inside it, punctuation agreement, and the pause after it."""
    regions = sentence_ids(words, cfg.sentence_end)
    out = []
    for region in sorted(set(regions)):
        members = [w for w, r in zip(words, regions) if r == region]
        inner = [b for b in boundaries if b["region_idx"] == region and b["boundary_type"] == "within_sentence"]
        after = [b for b in boundaries if b["region_idx"] == region and b["boundary_type"] == "sentence"]
        aligned = [w for w in members if w["aligned"]]
        span = aligned[-1]["end"] - aligned[0]["start"] if aligned else None
        stats = _pause_stats(inner)
        punctuated = [b for b in inner if b["punct_after"] and b["gap_s"] is not None]
        unpunctuated = [b for b in inner if not b["punct_after"] and b["gap_s"] is not None]
        out.append({
            "region_idx": region,
            "first_idx": members[0]["idx"],
            "last_idx": members[-1]["idx"],
            "n_words": len(members),
            **stats,
            "pause_ratio": _r(stats["total_pause_s"] / span) if span else None,
            # missing pauses: punctuation without a pause; misplaced: pause without punctuation
            "n_punct_boundaries": len(punctuated),
            "n_punct_with_pause": sum(b["is_pause"] for b in punctuated),
            "n_unpunct_pauses": sum(b["is_pause"] for b in unpunctuated),
            "pause_after_s": after[0]["gap_s"] if after else None,
            "pause_after_failure": (after[0]["pause_failure"] if after else "take_end"),
        })
    return out


def extract_take(speech_id: str, take_id: str, pause_cfg: PauseConfig, align_cfg: AlignmentConfig) -> dict:
    alignment_path = Path(align_cfg.output_dir) / speech_id / f"{take_id}.json"
    if not alignment_path.exists():
        raise FileNotFoundError(f"{alignment_path} missing; run scripts/align_one.py first")
    alignment = load_alignment(alignment_path)
    words = alignment["words"]

    boundaries = boundary_pauses(words, pause_cfg)
    within = [b for b in boundaries if b["boundary_type"] == "within_sentence"]
    sentence = [b for b in boundaries if b["boundary_type"] == "sentence"]
    doc = {
        "schema_version": SCHEMA_VERSION,
        "speech_id": speech_id,
        "take_id": take_id,
        "audio_sha256": alignment["audio"]["sha256"],
        "alignment_cache_key": alignment["cache_key"],
        "settings": pause_cfg.settings(),
        "summary": {
            "within_sentence": _pause_stats(within),
            "sentence_boundary": _pause_stats(sentence),
            "leading_silence_s": alignment["quality"]["leading_silence"],
            "trailing_silence_s": alignment["quality"]["trailing_silence"],
            "n_failed_boundaries": sum(b["pause_failure"] is not None for b in boundaries),
        },
        "regions": region_pause_features(words, boundaries, pause_cfg),
        "boundaries": boundaries,
        "words": word_pause_features(words, boundaries),
    }

    out_path = Path(pause_cfg.output_dir) / speech_id / f"{take_id}.pause.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return doc


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Extract pauses between aligned words.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every take with a cached alignment")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    pause_cfg = PauseConfig.from_yaml(args.config)
    if args.all:
        jobs = [(p.parent.name, p.stem) for p in sorted(Path(align_cfg.output_dir).glob("*/*.json"))]
    else:
        jobs = [(args.speech, args.take)]

    for speech_id, take_id in jobs:
        s = extract_take(speech_id, take_id, pause_cfg, align_cfg)["summary"]
        w, b = s["within_sentence"], s["sentence_boundary"]
        print(f"{speech_id}/{take_id}: within-sentence {w['n_pauses']}/{w['n_measured']} pauses "
              f"(median {w['median_pause_s']} s)  sentence-boundary {b['n_pauses']}/{b['n_measured']} "
              f"(median {b['median_pause_s']} s)  failed boundaries {s['n_failed_boundaries']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
