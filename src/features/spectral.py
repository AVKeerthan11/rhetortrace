"""MFCC and spectral-shape features per word, sentence and take.

One STFT per take (librosa, frames centred at k * hop) feeds 13 MFCCs and four
spectral descriptors: centroid, bandwidth, 85% rolloff (Hz) and flatness.

Only *active* frames are aggregated: frame energy more than ``active_margin_db``
above the take's noise floor (a low percentile of frame energy), as in the
energy features. Otherwise the steady ~100 Hz background hum would define the
spectrum of quiet words.

Normalization (speaker / channel):
  MFCC      cepstral mean normalization: the take's mean MFCC over active
            in-word frames (stored as ``cmn_vector``) is subtracted
  centroid  also given as octaves relative to the take median

Words, sentences or takes with fewer than ``min_active_frames`` active frames
get ``None`` values and a ``spectral_failure`` reason (never 0).

Outputs, next to each other in results/features/<speech>/:
  <take>.spectral.npz   frame-level: times, mfcc (T x n_mfcc), centroid_hz,
                        bandwidth_hz, rolloff_hz, flatness, energy_db, active
  <take>.spectral.json  per-word / per-sentence / take aggregates + metadata
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import librosa
import numpy as np
import yaml

from src.alignment import SAMPLE_RATE, AlignmentConfig, load_alignment, load_audio, sha256_file
from src.features.pitch import frame_energy_db, in_word_mask, word_frame_mask
from src.features.rate import sentence_ids

SCHEMA_VERSION = 1
DESCRIPTORS = ("centroid_hz", "bandwidth_hz", "rolloff_hz", "flatness")
SPECTRAL_WORD_FIELDS = (
    "idx", "text", "aligned", "n_frames", "n_active",
    "mfcc_mean", "mfcc_std", *DESCRIPTORS, "centroid_rel_oct", "spectral_failure",
)


@dataclass(frozen=True)
class SpectralConfig:
    n_mfcc: int = 13
    n_mels: int = 40
    n_fft: int = 512
    win_length: float = 0.025  # s
    hop: float = 0.01  # s
    fmin: float = 0.0
    fmax: float = 8000.0
    rolloff_percent: float = 0.85
    noise_floor_percentile: float = 10.0
    active_margin_db: float = 6.0
    min_active_frames: int = 3
    sentence_end: str = ".?!"
    output_dir: str = "results/features"

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "SpectralConfig":
        with open(path, encoding="utf-8") as f:
            features = (yaml.safe_load(f) or {}).get("features") or {}
        section = dict(features.get("spectral") or {})
        if "output_dir" in features:
            section["output_dir"] = features["output_dir"]
        return cls(**section)

    def settings(self) -> dict:
        settings = asdict(self)
        settings.pop("output_dir")
        return settings


# ------------------------------------------------------------------ frames


def extract_spectral(audio: np.ndarray, sample_rate: int, cfg: SpectralConfig) -> tuple[np.ndarray, dict]:
    """Frame-level features. Returns (times, {name: array}); mfcc is (T, n_mfcc)."""
    y = np.asarray(audio, dtype=np.float32)
    hop = int(round(cfg.hop * sample_rate))
    win = int(round(cfg.win_length * sample_rate))
    mag = np.abs(librosa.stft(y, n_fft=cfg.n_fft, hop_length=hop, win_length=win, center=True))
    mel = librosa.feature.melspectrogram(S=mag ** 2, sr=sample_rate, n_mels=cfg.n_mels, fmin=cfg.fmin, fmax=cfg.fmax)
    # top_db=None: no clipping relative to the take maximum, so a gain change is a pure c0 shift
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel, top_db=None), n_mfcc=cfg.n_mfcc)
    times = librosa.frames_to_time(np.arange(mag.shape[1]), sr=sample_rate, hop_length=hop)
    frames = {
        "mfcc": mfcc.T,
        "centroid_hz": librosa.feature.spectral_centroid(S=mag, sr=sample_rate, n_fft=cfg.n_fft)[0],
        "bandwidth_hz": librosa.feature.spectral_bandwidth(S=mag, sr=sample_rate, n_fft=cfg.n_fft)[0],
        "rolloff_hz": librosa.feature.spectral_rolloff(
            S=mag, sr=sample_rate, n_fft=cfg.n_fft, roll_percent=cfg.rolloff_percent)[0],
        "flatness": librosa.feature.spectral_flatness(S=mag)[0],
        "energy_db": frame_energy_db(y, sample_rate, times, cfg.win_length),
    }
    return times, frames


def active_frames(energy_db: np.ndarray, cfg: SpectralConfig) -> tuple[np.ndarray, float]:
    floor_db = float(np.percentile(energy_db, cfg.noise_floor_percentile))
    return energy_db > floor_db + cfg.active_margin_db, floor_db


# --------------------------------------------------------------- aggregates


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


def _vec(v, nd=3):
    return [round(float(x), nd) for x in v]


def aggregate(frames: dict, mask: np.ndarray, cmn: np.ndarray | None, take_centroid: float | None) -> dict:
    """MFCC (CMN applied) and median spectral descriptors over the masked frames."""
    mfcc = frames["mfcc"][mask] - cmn
    centroid = float(np.median(frames["centroid_hz"][mask]))
    return {
        "mfcc_mean": _vec(mfcc.mean(axis=0)),
        "mfcc_std": _vec(mfcc.std(axis=0)),
        **{d: _r(np.median(frames[d][mask]), 4 if d == "flatness" else 1) for d in DESCRIPTORS},
        "centroid_rel_oct": _r(np.log2(centroid / take_centroid)) if take_centroid else None,
    }


def take_reference(times: np.ndarray, frames: dict, active: np.ndarray, words: list[dict]):
    """CMN vector and median centroid over active in-word frames (None if none)."""
    speech = in_word_mask(times, words) & active
    if not speech.any():
        return None, None
    return frames["mfcc"][speech].mean(axis=0), float(np.median(frames["centroid_hz"][speech]))


def word_spectral_features(
    times: np.ndarray, frames: dict, active: np.ndarray, words: list[dict],
    cmn: np.ndarray | None, take_centroid: float | None, cfg: SpectralConfig,
) -> list[dict]:
    records = []
    for w in words:
        rec = {k: None for k in SPECTRAL_WORD_FIELDS}
        rec.update(idx=w["idx"], text=w["text"], aligned=w["aligned"])
        if not w["aligned"]:
            rec["spectral_failure"] = "unaligned"
            records.append(rec)
            continue
        in_word = word_frame_mask(times, w["start"], w["end"])
        mask = in_word & active
        rec["n_frames"], rec["n_active"] = int(in_word.sum()), int(mask.sum())
        if rec["n_active"] < cfg.min_active_frames:
            rec["spectral_failure"] = "insufficient_active_frames"
        elif cmn is None:
            rec["spectral_failure"] = "no_speaker_reference"
        else:
            rec.update(aggregate(frames, mask, cmn, take_centroid))
        records.append(rec)
    return records


def region_spectral_features(
    times: np.ndarray, frames: dict, active: np.ndarray, words: list[dict],
    cmn: np.ndarray | None, take_centroid: float | None, cfg: SpectralConfig,
) -> list[dict]:
    regions = sentence_ids(words, cfg.sentence_end)
    out = []
    for region in sorted(set(regions)):
        members = [w for w, r in zip(words, regions) if r == region]
        mask = in_word_mask(times, members) & active
        rec = {"region_idx": region, "first_idx": members[0]["idx"], "last_idx": members[-1]["idx"],
               "n_words": len(members), "n_active": int(mask.sum()), "spectral_failure": None}
        if rec["n_active"] < cfg.min_active_frames:
            rec["spectral_failure"] = "insufficient_active_frames"
        elif cmn is None:
            rec["spectral_failure"] = "no_speaker_reference"
        else:
            rec.update(aggregate(frames, mask, cmn, take_centroid))
        out.append(rec)
    return out


# ---------------------------------------------------------------- pipeline


def extract_take(speech_id: str, take_id: str, spectral_cfg: SpectralConfig, align_cfg: AlignmentConfig) -> dict:
    alignment_path = Path(align_cfg.output_dir) / speech_id / f"{take_id}.json"
    if not alignment_path.exists():
        raise FileNotFoundError(f"{alignment_path} missing; run scripts/align_one.py first")
    alignment = load_alignment(alignment_path)

    audio_path = Path(alignment["audio"]["path"])
    audio_sha = sha256_file(audio_path)
    if audio_sha != alignment["audio"]["sha256"]:
        raise RuntimeError(f"{audio_path} changed since it was aligned; re-run alignment")

    times, frames = extract_spectral(load_audio(audio_path), SAMPLE_RATE, spectral_cfg)
    words = alignment["words"]
    active, floor_db = active_frames(frames["energy_db"], spectral_cfg)
    cmn, take_centroid = take_reference(times, frames, active, words)
    word_records = word_spectral_features(times, frames, active, words, cmn, take_centroid, spectral_cfg)

    speech = in_word_mask(times, words) & active
    doc = {
        "schema_version": SCHEMA_VERSION,
        "speech_id": speech_id,
        "take_id": take_id,
        "audio_sha256": audio_sha,
        "alignment_cache_key": alignment["cache_key"],
        "settings": {**spectral_cfg.settings(), "librosa": librosa.__version__},
        "noise_floor_db": _r(floor_db, 2),
        "cmn_vector": _vec(cmn) if cmn is not None else None,
        "take": {
            "n_frames": int(len(times)),
            "n_active_speech_frames": int(speech.sum()),
            **({d: _r(np.median(frames[d][speech]), 4 if d == "flatness" else 1) for d in DESCRIPTORS}
               if speech.any() else {d: None for d in DESCRIPTORS}),
        },
        "summary": {
            "n_words": len(word_records),
            "n_words_with_features": sum(r["spectral_failure"] is None for r in word_records),
            "failures": {
                reason: sum(r["spectral_failure"] == reason for r in word_records)
                for reason in sorted({r["spectral_failure"] for r in word_records if r["spectral_failure"]})
            },
        },
        "regions": region_spectral_features(times, frames, active, words, cmn, take_centroid, spectral_cfg),
        "words": word_records,
    }

    base = Path(spectral_cfg.output_dir) / speech_id
    base.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(base / f"{take_id}.spectral.npz", times=times, active=active, **frames)
    with open(base / f"{take_id}.spectral.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return doc


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Extract MFCC and spectral features for aligned takes.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="every take with a cached alignment")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)

    align_cfg = AlignmentConfig.from_yaml(args.config)
    spectral_cfg = SpectralConfig.from_yaml(args.config)
    if args.all:
        jobs = [(p.parent.name, p.stem) for p in sorted(Path(align_cfg.output_dir).glob("*/*.json"))]
    else:
        jobs = [(args.speech, args.take)]

    for speech_id, take_id in jobs:
        doc = extract_take(speech_id, take_id, spectral_cfg, align_cfg)
        t, s = doc["take"], doc["summary"]
        print(f"{speech_id}/{take_id}: words with features {s['n_words_with_features']}/{s['n_words']}  "
              f"failures {s['failures']}  centroid {t['centroid_hz']} Hz  flatness {t['flatness']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
