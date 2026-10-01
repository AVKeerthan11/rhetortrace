"""Speech rate from cached word alignments, in words per second (wps).

Unit choice: no pronunciation dictionary is available offline, so rates are
words/second, not syllables/second. For contrastive analysis this loses
nothing: every take of a script has the same word sequence, so the syllable
count of any word span is identical across takes and rate ratios against the
reference are the same in either unit.

Two rates, over aligned words only:
  speech rate        n_words / (last end - first start)   (includes gaps)
  articulation rate  n_words / sum(word durations)        (speaking time only)

Per word: duration plus local rates over a centred window of ``window_words``
words, clipped to the word's sentence so inter-sentence pauses don't leak in.
Per region: rates per sentence (split after . ? !) and for the whole take.

Output: results/features/<speech>/<take>.rate.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

from src.alignment import AlignmentConfig, load_alignment

SCHEMA_VERSION = 1
UNIT = "words_per_second"
RATE_WORD_FIELDS = (
    "idx", "text", "aligned", "region_idx", "duration_s", "local_n_words",
    "local_speech_rate_wps", "local_articulation_rate_wps", "rate_failure",
)


@dataclass(frozen=True)
class RateConfig:
    window_words: int = 5  # centred local window (odd)
    min_window_words: int = 3  # fewer aligned words in the window -> None
    sentence_end: str = ".?!"
    output_dir: str = "results/features"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "RateConfig":
        with open(path, encoding="utf-8") as f:
            features = (yaml.safe_load(f) or {}).get("features") or {}
        section = dict(features.get("rate") or {})
        if "output_dir" in features:
            section["output_dir"] = features["output_dir"]
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        return settings


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


def sentence_ids(words: list[dict], sentence_end: str) -> list[int]:
    """Region index per word; a region ends after a word ending in . ? !"""
    ids, region = [], 0
    for w in words:
        ids.append(region)
        if w["text"].rstrip("\"')]”’").endswith(tuple(sentence_end)):
            region += 1
    return ids


def span_rates(words: list[dict]) -> dict:
    """Speech and articulation rate over the aligned words of a span."""
    aligned = [w for w in words if w["aligned"]]
    if not aligned:
        return {"n_aligned": 0, "start": None, "end": None, "speech_rate_wps": None, "articulation_rate_wps": None}
    span = aligned[-1]["end"] - aligned[0]["start"]
    speaking = sum(w["end"] - w["start"] for w in aligned)
    return {
        "n_aligned": len(aligned),
        "start": aligned[0]["start"],
        "end": aligned[-1]["end"],
        "speech_rate_wps": _r(len(aligned) / span) if span > 0 else None,
        "articulation_rate_wps": _r(len(aligned) / speaking) if speaking > 0 else None,
    }


def word_rate_features(words: list[dict], cfg: RateConfig) -> list[dict]:
    regions = sentence_ids(words, cfg.sentence_end)
    half = cfg.window_words // 2
    records = []
    for i, w in enumerate(words):
        rec = {k: None for k in RATE_WORD_FIELDS}
        rec.update(idx=w["idx"], text=w["text"], aligned=w["aligned"], region_idx=regions[i])
        if not w["aligned"]:
            rec["rate_failure"] = "unaligned"
            records.append(rec)
            continue
        rec["duration_s"] = _r(w["end"] - w["start"])
        window = [words[j] for j in range(max(0, i - half), min(len(words), i + half + 1))
                  if regions[j] == regions[i]]
        rates = span_rates(window)
        rec["local_n_words"] = rates["n_aligned"]
        if rates["n_aligned"] < cfg.min_window_words:
            rec["rate_failure"] = "insufficient_context"
        else:
            rec["local_speech_rate_wps"] = rates["speech_rate_wps"]
            rec["local_articulation_rate_wps"] = rates["articulation_rate_wps"]
        records.append(rec)
    return records


def region_rate_features(words: list[dict], cfg: RateConfig) -> list[dict]:
    regions = sentence_ids(words, cfg.sentence_end)
    out = []
    for region in sorted(set(regions)):
        members = [w for w, r in zip(words, regions) if r == region]
        out.append({
            "region_idx": region,
            "first_idx": members[0]["idx"],
            "last_idx": members[-1]["idx"],
            "text": " ".join(w["text"] for w in members),
            "n_words": len(members),
            **span_rates(members),
        })
    return out


def extract_take(speech_id: str, take_id: str, rate_cfg: RateConfig, align_cfg: AlignmentConfig) -> dict:
    alignment_path = Path(align_cfg.output_dir) / speech_id / f"{take_id}.json"
    if not alignment_path.exists():
        raise FileNotFoundError(f"{alignment_path} missing; run scripts/align_one.py first")
    alignment = load_alignment(alignment_path)
    words = alignment["words"]

    word_records = word_rate_features(words, rate_cfg)
    doc = {
        "schema_version": SCHEMA_VERSION,
        "speech_id": speech_id,
        "take_id": take_id,
        "audio_sha256": alignment["audio"]["sha256"],
        "alignment_cache_key": alignment["cache_key"],
        "unit": UNIT,
        "settings": rate_cfg.settings(),
        "take": span_rates(words),
        "regions": region_rate_features(words, rate_cfg),
        "summary": {
            "n_words": len(word_records),
            "failures": {
                reason: sum(r["rate_failure"] == reason for r in word_records)
                for reason in sorted({r["rate_failure"] for r in word_records if r["rate_failure"]})
            },
        },
        "words": word_records,
    }

    out_path = Path(rate_cfg.output_dir) / speech_id / f"{take_id}.rate.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return doc


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Compute word- and sentence-level speech rate from alignments.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every take with a cached alignment")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    rate_cfg = RateConfig.from_yaml(args.config)
    if args.all:
        jobs = [(p.parent.name, p.stem) for p in sorted(Path(align_cfg.output_dir).glob("*/*.json"))]
    else:
        jobs = [(args.speech, args.take)]

    for speech_id, take_id in jobs:
        doc = extract_take(speech_id, take_id, rate_cfg, align_cfg)
        t = doc["take"]
        print(f"{speech_id}/{take_id}: speech {t['speech_rate_wps']} wps  articulation {t['articulation_rate_wps']} wps  "
              f"regions {len(doc['regions'])}  failures {doc['summary']['failures']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
