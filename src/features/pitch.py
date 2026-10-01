"""F0 / pitch extraction and per-word aggregation.

Frame-level F0 comes from Praat's autocorrelation pitch tracker (Parselmouth).
Each aligned word gets pitch statistics from the frames whose centre lies in
[start, end). Speaker normalization expresses F0 in semitones relative to the
take's reference F0: the median of all voiced frames inside aligned words.

Energy gating: the recordings carry a steady ~100 Hz background hum that the
tracker reports as "voiced" in pauses, right in the speaker's F0 range. Frames
whose energy is not at least ``gate_margin_db`` above the take's noise floor
(a low percentile of frame energy) are treated as unvoiced.

Outputs, next to each other in results/features/<speech>/:
  <take>.pitch.npz   frame-level: times (s), f0_hz (gated, NaN where unvoiced),
                     f0_raw_hz (before gating), energy_db (gate input)
  <take>.pitch.json  per-word pitch features + extraction metadata

Words that are unaligned, or have too few voiced frames, get ``None`` for the
pitch statistics (never 0); ``pitch_failure`` says why.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import parselmouth
import yaml

from src.alignment import SAMPLE_RATE, AlignmentConfig, load_alignment, load_audio, sha256_file

SCHEMA_VERSION = 1
PITCH_WORD_FIELDS = (
    "idx", "text", "aligned", "n_frames", "n_voiced", "voiced_ratio",
    "f0_median_hz", "f0_median_st", "f0_std_st", "f0_range_st", "pitch_failure",
)


@dataclass(frozen=True)
class PitchConfig:
    time_step: float = 0.01  # s between frames
    floor_hz: float = 75.0
    ceiling_hz: float = 500.0
    voicing_threshold: float = 0.45  # Praat defaults below
    silence_threshold: float = 0.03
    octave_cost: float = 0.01
    octave_jump_cost: float = 0.35
    voiced_unvoiced_cost: float = 0.14
    min_voiced_frames: int = 3  # per word, below -> pitch stats are None
    range_percentiles: tuple[float, float] = (10.0, 90.0)  # robust to octave errors
    energy_gate: bool = True
    gate_window: float = 0.04  # s, RMS window centred on each F0 frame
    noise_floor_percentile: float = 10.0  # of all frame energies in the take
    gate_margin_db: float = 6.0  # keep F0 only if energy > floor + margin
    output_dir: str = "results/features"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "PitchConfig":
        with open(path, encoding="utf-8") as f:
            features = (yaml.safe_load(f) or {}).get("features") or {}
        section = dict(features.get("pitch") or {})
        if "range_percentiles" in section:
            section["range_percentiles"] = tuple(section["range_percentiles"])
        if "output_dir" in features:
            section["output_dir"] = features["output_dir"]
        return cls(**section)

    def tracker_settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        settings["range_percentiles"] = list(self.range_percentiles)
        return settings


# ------------------------------------------------------------------ frames


def extract_f0(audio: np.ndarray, sample_rate: int, cfg: PitchConfig) -> tuple[np.ndarray, np.ndarray]:
    """Frame-level F0. Returns (times in s, f0 in Hz with NaN for unvoiced frames)."""
    sound = parselmouth.Sound(np.asarray(audio, dtype=np.float64), sampling_frequency=sample_rate)
    pitch = sound.to_pitch_ac(
        time_step=cfg.time_step,
        pitch_floor=cfg.floor_hz,
        pitch_ceiling=cfg.ceiling_hz,
        voicing_threshold=cfg.voicing_threshold,
        silence_threshold=cfg.silence_threshold,
        octave_cost=cfg.octave_cost,
        octave_jump_cost=cfg.octave_jump_cost,
        voiced_unvoiced_cost=cfg.voiced_unvoiced_cost,
    )
    times = np.asarray(pitch.xs(), dtype=np.float64)
    f0 = np.asarray(pitch.selected_array["frequency"], dtype=np.float64)
    f0[f0 <= 0] = np.nan
    return times, f0


def frame_energy_db(audio: np.ndarray, sample_rate: int, times: np.ndarray, window: float) -> np.ndarray:
    """RMS energy in dBFS of a rectangular window centred on each frame time."""
    audio = np.asarray(audio, dtype=np.float64)
    cumsum = np.concatenate([[0.0], np.cumsum(audio ** 2)])
    half = int(round(window * sample_rate / 2))
    centres = np.round(np.asarray(times) * sample_rate).astype(int)
    lo = np.clip(centres - half, 0, len(audio))
    hi = np.clip(centres + half, 0, len(audio))
    mean_sq = (cumsum[hi] - cumsum[lo]) / np.maximum(hi - lo, 1)
    return 10.0 * np.log10(mean_sq + 1e-12)


def apply_energy_gate(f0: np.ndarray, energy_db: np.ndarray, cfg: PitchConfig) -> tuple[np.ndarray, dict]:
    """Set F0 to NaN where frame energy is within gate_margin_db of the noise floor."""
    floor_db = float(np.percentile(energy_db, cfg.noise_floor_percentile))
    threshold_db = floor_db + cfg.gate_margin_db
    gated = f0.copy()
    if cfg.energy_gate:
        gated[energy_db <= threshold_db] = np.nan
    raw_voiced = int(np.sum(~np.isnan(f0)))
    removed = raw_voiced - int(np.sum(~np.isnan(gated)))
    info = {
        "enabled": cfg.energy_gate,
        "noise_floor_db": round(floor_db, 2),
        "threshold_db": round(threshold_db, 2),
        "removed_voiced_frames": removed,
        "removed_voiced_ratio": round(removed / raw_voiced, 4) if raw_voiced else None,
    }
    return gated, info


MAX_IN_WORD_GATE_LOSS = 0.5


def in_word_gate_check(f0_raw: np.ndarray, f0: np.ndarray, in_words: np.ndarray) -> dict:
    """How much voicing inside aligned words the gate removed.

    The floor percentile assumes the take contains silence; without it the
    "floor" lands on speech and the gate removes real voicing inside words.
    """
    raw = int(np.sum(~np.isnan(f0_raw[in_words])))
    kept = int(np.sum(~np.isnan(f0[in_words])))
    ratio = (raw - kept) / raw if raw else None
    warning = None
    if ratio is not None and ratio > MAX_IN_WORD_GATE_LOSS:
        warning = f"gate removed {ratio:.0%} of in-word voicing; noise floor estimate may sit on speech"
    return {"in_word_removed_ratio": None if ratio is None else round(ratio, 4), "warning": warning}


def extract_gated_f0(audio: np.ndarray, sample_rate: int, cfg: PitchConfig):
    """Returns (times, gated f0, raw f0, frame energy dB, gate info)."""
    times, f0_raw = extract_f0(audio, sample_rate, cfg)
    energy_db = frame_energy_db(audio, sample_rate, times, cfg.gate_window)
    f0, gate = apply_energy_gate(f0_raw, energy_db, cfg)
    return times, f0, f0_raw, energy_db, gate


def long_pause_mask(times: np.ndarray, words: list[dict], min_gap: float = 0.3, trim: float = 0.06) -> np.ndarray:
    """Frames well inside inter-word gaps of at least min_gap seconds (QC only)."""
    aligned = [w for w in words if w["aligned"]]
    mask = np.zeros(len(times), dtype=bool)
    for a, b in zip(aligned, aligned[1:]):
        if b["start"] - a["end"] >= min_gap:
            mask |= word_frame_mask(times, a["end"] + trim, b["start"] - trim)
    return mask


def hz_to_semitones(f0_hz, ref_hz: float):
    """Semitones relative to ref_hz (NaN stays NaN)."""
    return 12.0 * np.log2(np.asarray(f0_hz, dtype=np.float64) / ref_hz)


def word_frame_mask(times: np.ndarray, start: float, end: float) -> np.ndarray:
    return (times >= start) & (times < end)


def in_word_mask(times: np.ndarray, words: list[dict]) -> np.ndarray:
    """Frames inside any aligned word."""
    mask = np.zeros(len(times), dtype=bool)
    for w in words:
        if w["aligned"]:
            mask |= word_frame_mask(times, w["start"], w["end"])
    return mask


def speaker_reference_hz(times: np.ndarray, f0: np.ndarray, words: list[dict]) -> float | None:
    """Median F0 of voiced frames inside aligned words (excludes non-speech)."""
    voiced = f0[in_word_mask(times, words) & ~np.isnan(f0)]
    return float(np.median(voiced)) if len(voiced) else None


# ------------------------------------------------------------------- words


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


def word_pitch_features(
    times: np.ndarray, f0: np.ndarray, words: list[dict], ref_hz: float | None, cfg: PitchConfig
) -> list[dict]:
    lo, hi = cfg.range_percentiles
    records = []
    for w in words:
        rec = {k: None for k in PITCH_WORD_FIELDS}
        rec.update(idx=w["idx"], text=w["text"], aligned=w["aligned"])
        if not w["aligned"]:
            rec["pitch_failure"] = "unaligned"
            records.append(rec)
            continue

        word_f0 = f0[word_frame_mask(times, w["start"], w["end"])]
        voiced = word_f0[~np.isnan(word_f0)]
        rec["n_frames"], rec["n_voiced"] = int(len(word_f0)), int(len(voiced))
        if len(word_f0) == 0:
            rec["pitch_failure"] = "no_frames"
        else:
            rec["voiced_ratio"] = _r(len(voiced) / len(word_f0))
            if len(voiced) < cfg.min_voiced_frames:
                rec["pitch_failure"] = "insufficient_voicing"
            elif ref_hz is None:
                rec["pitch_failure"] = "no_speaker_reference"
            else:
                st = hz_to_semitones(voiced, ref_hz)
                p_lo, p_hi = np.percentile(st, [lo, hi])
                rec.update(
                    f0_median_hz=_r(np.median(voiced), 2),
                    f0_median_st=_r(np.median(st)),
                    f0_std_st=_r(np.std(st)),
                    f0_range_st=_r(p_hi - p_lo),
                )
        records.append(rec)
    return records


# ---------------------------------------------------------------- pipeline


def feature_paths(cfg: PitchConfig, speech_id: str, take_id: str) -> tuple[Path, Path]:
    base = Path(cfg.output_dir) / speech_id
    return base / f"{take_id}.pitch.npz", base / f"{take_id}.pitch.json"


def extract_take(speech_id: str, take_id: str, pitch_cfg: PitchConfig, align_cfg: AlignmentConfig) -> dict:
    alignment_path = Path(align_cfg.output_dir) / speech_id / f"{take_id}.json"
    if not alignment_path.exists():
        raise FileNotFoundError(f"{alignment_path} missing; run scripts/align_one.py first")
    alignment = load_alignment(alignment_path)

    audio_path = Path(alignment["audio"]["path"])
    audio_sha = sha256_file(audio_path)
    if audio_sha != alignment["audio"]["sha256"]:
        raise RuntimeError(f"{audio_path} changed since it was aligned; re-run alignment")

    times, f0, f0_raw, energy_db, gate = extract_gated_f0(load_audio(audio_path), SAMPLE_RATE, pitch_cfg)
    words = alignment["words"]
    pause = long_pause_mask(times, words)
    gate.update(in_word_gate_check(f0_raw, f0, in_word_mask(times, words)))
    ref_hz = speaker_reference_hz(times, f0, words)
    word_records = word_pitch_features(times, f0, words, ref_hz, pitch_cfg)

    usable = [r for r in word_records if r["f0_median_hz"] is not None]
    voiced_all = f0[~np.isnan(f0)]
    doc = {
        "schema_version": SCHEMA_VERSION,
        "speech_id": speech_id,
        "take_id": take_id,
        "audio_sha256": audio_sha,
        "alignment_cache_key": alignment["cache_key"],
        "settings": {**pitch_cfg.tracker_settings(), "parselmouth": parselmouth.__version__},
        "speaker_ref_hz": _r(ref_hz, 2),
        "energy_gate": gate,
        "summary": {
            "n_frames": int(len(f0)),
            "voiced_frame_ratio": _r(len(voiced_all) / len(f0)) if len(f0) else None,
            # voicing inside long pauses should be ~0; raw vs gated shows the hum
            "pause_voiced_ratio_raw": _r(np.mean(~np.isnan(f0_raw[pause]))) if pause.any() else None,
            "pause_voiced_ratio": _r(np.mean(~np.isnan(f0[pause]))) if pause.any() else None,
            "n_words": len(word_records),
            "n_words_with_pitch": len(usable),
            "failures": {
                reason: sum(r["pitch_failure"] == reason for r in word_records)
                for reason in sorted({r["pitch_failure"] for r in word_records if r["pitch_failure"]})
            },
            # share of voiced frames an octave or more away from the reference:
            # a cheap indicator of pitch-tracking (octave) errors
            "octave_outlier_ratio": _r(np.mean(np.abs(hz_to_semitones(voiced_all, ref_hz)) >= 12))
            if ref_hz and len(voiced_all) else None,
        },
        "words": word_records,
    }

    npz_path, json_path = feature_paths(pitch_cfg, speech_id, take_id)
    npz_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(npz_path, times=times, f0_hz=f0, f0_raw_hz=f0_raw, energy_db=energy_db)
    with open(json_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return doc


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Extract frame- and word-level F0 for aligned takes.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every take with a cached alignment")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    pitch_cfg = PitchConfig.from_yaml(args.config)
    if args.all:
        jobs = [(p.parent.name, p.stem) for p in sorted(Path(align_cfg.output_dir).glob("*/*.json"))]
    else:
        jobs = [(args.speech, args.take)]

    for speech_id, take_id in jobs:
        doc = extract_take(speech_id, take_id, pitch_cfg, align_cfg)
        s = doc["summary"]
        g = doc["energy_gate"]
        print(f"{speech_id}/{take_id}: ref {doc['speaker_ref_hz']} Hz  floor {g['noise_floor_db']} dB  "
              f"gated out {g['removed_voiced_ratio']}  pause voiced {s['pause_voiced_ratio_raw']} -> "
              f"{s['pause_voiced_ratio']}  words with pitch {s['n_words_with_pitch']}/{s['n_words']}  "
              f"failures {s['failures']}  octave outliers {s['octave_outlier_ratio']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
