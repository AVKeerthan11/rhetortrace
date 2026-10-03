"""Frame-level RMS energy and per-word aggregation.

Frame energy is RMS in dBFS over a short window on a fixed grid. Each aligned
word gets energy statistics from the frames whose centre lies in [start, end).
Speaker normalization expresses levels in dB relative to the take's reference
level: the median frame energy over *active* in-word frames, i.e. frames more
than ``active_margin_db`` above the take's noise floor (a low percentile of all
frame energies; the recordings carry a steady background hum).

Every measurable word gets an ``energy_status``:
  voiced    audible, with voiced F0 frames (from the take's pitch features)
  unvoiced  audible, but no voiced F0 frames (e.g. fricatives, whispered words)
  silent    no frame above the active threshold: the word is indistinguishable
            from background, so its level is an upper bound, not a measurement
Unaligned words, or words without frames, get ``None`` values and an
``energy_failure`` reason (never 0).

Outputs, next to each other in results/features/<speech>/:
  <take>.energy.npz   frame-level: times (s), energy_db (dBFS)
  <take>.energy.json  per-word energy features + extraction metadata
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import yaml

from src.alignment import SAMPLE_RATE, AlignmentConfig, load_alignment, load_audio, sha256_file
from src.errors import StaleArtifactError
from src.features.pitch import frame_energy_db, in_word_mask, long_pause_mask, word_frame_mask

SCHEMA_VERSION = 1
ENERGY_WORD_FIELDS = (
    "idx", "text", "aligned", "n_frames", "n_active", "active_ratio",
    "energy_mean_db", "energy_rel_db", "energy_peak_rel_db", "energy_std_db", "snr_db",
    "energy_status", "energy_failure",
)


@dataclass(frozen=True)
class EnergyConfig:
    time_step: float = 0.01  # s between frames
    window: float = 0.025  # s, RMS window
    noise_floor_percentile: float = 10.0  # of all frame energies in the take
    active_margin_db: float = 6.0  # frame is "active" above floor + margin
    peak_percentile: float = 95.0  # robust per-word peak
    output_dir: str = "results/features"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "EnergyConfig":
        with open(path, encoding="utf-8") as f:
            features = (yaml.safe_load(f) or {}).get("features") or {}
        section = dict(features.get("energy") or {})
        if "output_dir" in features:
            section["output_dir"] = features["output_dir"]
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        return settings


# ------------------------------------------------------------------ frames


def frame_times(n_samples: int, sample_rate: int, cfg: EnergyConfig) -> np.ndarray:
    """Centres of all full windows on a time_step grid."""
    duration = n_samples / sample_rate
    n = int(np.floor((duration - cfg.window) / cfg.time_step + 1e-9)) + 1
    return cfg.window / 2 + cfg.time_step * np.arange(max(n, 0))


def extract_energy(audio: np.ndarray, sample_rate: int, cfg: EnergyConfig) -> tuple[np.ndarray, np.ndarray]:
    """Frame-level energy. Returns (times in s, RMS energy in dBFS)."""
    times = frame_times(len(audio), sample_rate, cfg)
    return times, frame_energy_db(audio, sample_rate, times, cfg.window)


def noise_floor_db(energy_db: np.ndarray, cfg: EnergyConfig) -> float:
    return float(np.percentile(energy_db, cfg.noise_floor_percentile))


def speaker_reference_db(
    times: np.ndarray, energy_db: np.ndarray, words: list[dict], threshold_db: float
) -> float | None:
    """Median energy of active frames inside aligned words."""
    active = energy_db[in_word_mask(times, words) & (energy_db > threshold_db)]
    return float(np.median(active)) if len(active) else None


# ------------------------------------------------------------------- words


def _r(x, nd=2):
    return None if x is None else round(float(x), nd)


def word_energy_features(
    times: np.ndarray,
    energy_db: np.ndarray,
    words: list[dict],
    floor_db: float,
    ref_db: float | None,
    cfg: EnergyConfig,
    voiced_frames: dict[int, int | None] | None = None,
) -> list[dict]:
    """Per-word energy statistics.

    voiced_frames maps word idx -> number of voiced F0 frames (None if unknown);
    without it, audible words get status "voiced" only if marked so by the map,
    otherwise None.
    """
    threshold_db = floor_db + cfg.active_margin_db
    records = []
    for w in words:
        rec = {k: None for k in ENERGY_WORD_FIELDS}
        rec.update(idx=w["idx"], text=w["text"], aligned=w["aligned"])
        if not w["aligned"]:
            rec["energy_failure"] = "unaligned"
            records.append(rec)
            continue

        e = energy_db[word_frame_mask(times, w["start"], w["end"])]
        rec["n_frames"] = int(len(e))
        if len(e) == 0:
            rec["energy_failure"] = "no_frames"
            records.append(rec)
            continue

        n_active = int(np.sum(e > threshold_db))
        mean_db = 10.0 * np.log10(np.mean(10.0 ** (e / 10.0)))  # power mean
        rec.update(
            n_active=n_active,
            active_ratio=_r(n_active / len(e), 3),
            energy_mean_db=_r(mean_db),
            energy_std_db=_r(np.std(e)),
            snr_db=_r(mean_db - floor_db),
        )
        if ref_db is not None:
            rec["energy_rel_db"] = _r(mean_db - ref_db)
            rec["energy_peak_rel_db"] = _r(np.percentile(e, cfg.peak_percentile) - ref_db)
        else:
            rec["energy_failure"] = "no_speaker_reference"

        n_voiced = (voiced_frames or {}).get(w["idx"])
        if n_active == 0:
            rec["energy_status"] = "silent"
        elif n_voiced is not None:
            rec["energy_status"] = "voiced" if n_voiced > 0 else "unvoiced"
        records.append(rec)
    return records


# ---------------------------------------------------------------- pipeline


def feature_paths(cfg: EnergyConfig, speech_id: str, take_id: str) -> tuple[Path, Path]:
    base = Path(cfg.output_dir) / speech_id
    return base / f"{take_id}.energy.npz", base / f"{take_id}.energy.json"


def load_voiced_frames(pitch_path: Path, alignment: dict) -> dict[int, int | None]:
    """Per-word voiced F0 frame counts from the take's pitch features."""
    if not pitch_path.exists():
        raise FileNotFoundError(f"{pitch_path} missing; run python -m src.features.pitch first")
    pitch = json.loads(pitch_path.read_text(encoding="utf-8"))
    if pitch["alignment_cache_key"] != alignment["cache_key"] or pitch["audio_sha256"] != alignment["audio"]["sha256"]:
        raise StaleArtifactError(f"{pitch_path} is stale for the current alignment; re-run pitch extraction",
                                 stage="features")
    return {r["idx"]: r["n_voiced"] for r in pitch["words"]}


def extract_take(speech_id: str, take_id: str, energy_cfg: EnergyConfig, align_cfg: AlignmentConfig) -> dict:
    alignment_path = Path(align_cfg.output_dir) / speech_id / f"{take_id}.json"
    if not alignment_path.exists():
        raise FileNotFoundError(f"{alignment_path} missing; run scripts/align_one.py first")
    alignment = load_alignment(alignment_path)

    audio_path = Path(alignment["audio"]["path"])
    audio_sha = sha256_file(audio_path)
    if audio_sha != alignment["audio"]["sha256"]:
        raise StaleArtifactError(f"{audio_path} changed since it was aligned; re-run alignment", stage="features")

    pitch_path = Path(energy_cfg.output_dir) / speech_id / f"{take_id}.pitch.json"
    voiced_frames = load_voiced_frames(pitch_path, alignment)

    times, energy_db = extract_energy(load_audio(audio_path), SAMPLE_RATE, energy_cfg)
    words = alignment["words"]
    floor_db = noise_floor_db(energy_db, energy_cfg)
    threshold_db = floor_db + energy_cfg.active_margin_db
    ref_db = speaker_reference_db(times, energy_db, words, threshold_db)
    word_records = word_energy_features(times, energy_db, words, floor_db, ref_db, energy_cfg, voiced_frames)

    pause = long_pause_mask(times, words)
    statuses = [r["energy_status"] for r in word_records if r["energy_status"]]
    doc = {
        "schema_version": SCHEMA_VERSION,
        "speech_id": speech_id,
        "take_id": take_id,
        "audio_sha256": audio_sha,
        "alignment_cache_key": alignment["cache_key"],
        "voicing_source": pitch_path.as_posix(),
        "settings": energy_cfg.settings(),
        "noise_floor_db": _r(floor_db),
        "active_threshold_db": _r(threshold_db),
        "speaker_ref_db": _r(ref_db),
        "summary": {
            "n_frames": int(len(energy_db)),
            # speech level above background: low values mean noisy recordings
            "speech_snr_db": _r(ref_db - floor_db) if ref_db is not None else None,
            # long pauses should be inactive; a high ratio means the floor is wrong
            "pause_active_ratio": _r(np.mean(energy_db[pause] > threshold_db), 3) if pause.any() else None,
            "n_words": len(word_records),
            "status": {s: statuses.count(s) for s in ("voiced", "unvoiced", "silent")},
            "failures": {
                reason: sum(r["energy_failure"] == reason for r in word_records)
                for reason in sorted({r["energy_failure"] for r in word_records if r["energy_failure"]})
            },
        },
        "words": word_records,
    }

    npz_path, json_path = feature_paths(energy_cfg, speech_id, take_id)
    npz_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(npz_path, times=times, energy_db=energy_db)
    with open(json_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return doc


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Extract frame- and word-level energy for aligned takes.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every take with a cached alignment")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    energy_cfg = EnergyConfig.from_yaml(args.config)
    if args.all:
        jobs = [(p.parent.name, p.stem) for p in sorted(Path(align_cfg.output_dir).glob("*/*.json"))]
    else:
        jobs = [(args.speech, args.take)]

    for speech_id, take_id in jobs:
        doc = extract_take(speech_id, take_id, energy_cfg, align_cfg)
        s = doc["summary"]
        print(f"{speech_id}/{take_id}: floor {doc['noise_floor_db']} dB  ref {doc['speaker_ref_db']} dB  "
              f"speech SNR {s['speech_snr_db']} dB  pause active {s['pause_active_ratio']}  "
              f"status {s['status']}  failures {s['failures']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
