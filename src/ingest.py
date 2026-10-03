"""Ingestion of a new recording and its transcript into the pipeline's input format.

Audio: anything libsndfile decodes (WAV, FLAC, OGG/Vorbis, Opus, MP3, AIFF, ...)
becomes 16 kHz mono PCM-16 WAV, the format of dataset/ (src.alignment.load_audio
accepts nothing else). Channels are averaged; other sample rates are converted
with a polyphase filter (scipy ``resample_poly``, deterministic). A file that is
already 16 kHz mono PCM-16 WAV is copied byte for byte, so its sha256, and with
it every cache keyed on it (alignment), is unchanged. Containers libsndfile
cannot read (MP4 / M4A / video) are rejected with a hint to convert them.

Checks (``ingest`` section of config.yaml; input validation, not analysis
settings): duration within [min_duration_s, max_duration_s]; not silent (peak
above ``silence_peak_dbfs``); clipping above ``max_clipped_ratio`` is a warning.

Transcript: UTF-8 text, copied byte for byte (same sha256 as the canonical
transcript it came from), with at least ``min_transcript_words`` words.
"""

from __future__ import annotations

import hashlib
import math
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import yaml
from scipy.signal import resample_poly

from src.alignment import SAMPLE_RATE
from src.errors import AudioError, TranscriptError
from src.transcript import Transcript, load_transcript

UNSUPPORTED_HINT = {".mp4": "video/AAC", ".m4a": "AAC", ".aac": "AAC", ".mov": "video", ".webm": "WebM",
                    ".wma": "WMA", ".mkv": "video"}


@dataclass(frozen=True)
class IngestConfig:
    min_duration_s: float = 2.0
    max_duration_s: float = 900.0
    silence_peak_dbfs: float = -50.0
    max_clipped_ratio: float = 0.01
    min_transcript_words: int = 5

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "IngestConfig":
        with open(path, encoding="utf-8") as f:
            return cls(**((yaml.safe_load(f) or {}).get("ingest") or {}))


def sha256_bytes(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _info(src: Path) -> sf._SoundFileInfo:
    if not src.is_file():
        raise AudioError(f"{src.name}: file not found", stage="ingest", detail={"path": src.as_posix()})
    try:
        return sf.info(src)
    except Exception as e:  # libsndfile: unknown / corrupt format
        hint = UNSUPPORTED_HINT.get(src.suffix.lower())
        msg = (f"{src.name}: {hint} files are not supported; convert to WAV, FLAC or MP3 first" if hint
               else f"{src.name}: not a readable audio file (WAV, FLAC, OGG, MP3 are supported)")
        raise AudioError(msg, stage="ingest", detail={"path": src.as_posix(), "reason": str(e)}) from e


def to_pipeline_audio(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """(frames, channels) float -> mono float at SAMPLE_RATE in [-1, 1]."""
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    if sample_rate != SAMPLE_RATE:
        g = math.gcd(int(sample_rate), SAMPLE_RATE)
        mono = resample_poly(mono, SAMPLE_RATE // g, int(sample_rate) // g)
    return np.clip(mono, -1.0, 1.0)


def check_audio(audio: np.ndarray, name: str, cfg: IngestConfig) -> list[str]:
    """Raise AudioError for unusable audio; returns warnings."""
    duration = len(audio) / SAMPLE_RATE
    detail = {"duration_s": round(duration, 3)}
    if duration < cfg.min_duration_s:
        raise AudioError(f"{name}: {duration:.1f} s is too short (minimum {cfg.min_duration_s:g} s)",
                         stage="ingest", detail=detail)
    if duration > cfg.max_duration_s:
        raise AudioError(f"{name}: {duration:.0f} s is too long (maximum {cfg.max_duration_s:g} s)",
                         stage="ingest", detail=detail)
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    peak_dbfs = 20 * math.log10(peak) if peak > 0 else -math.inf
    if peak_dbfs < cfg.silence_peak_dbfs:
        raise AudioError(f"{name}: the recording is silent (peak {peak_dbfs:.0f} dBFS)", stage="ingest",
                         detail={**detail, "peak_dbfs": None if peak == 0 else round(peak_dbfs, 1)})
    warnings = []
    clipped = float(np.mean(np.abs(audio) >= 0.999))
    if clipped > cfg.max_clipped_ratio:
        warnings.append(f"{name}: {clipped:.1%} of samples are clipped; loud passages may be distorted")
    return warnings


def ingest_audio(src: str | Path, dst: str | Path, cfg: IngestConfig, name: str | None = None) -> dict:
    """Write ``src`` as pipeline audio to ``dst`` (a .wav path); returns provenance and warnings."""
    src, dst = Path(src), Path(dst)
    name = name or src.name
    info = _info(src)
    passthrough = (info.format == "WAV" and info.subtype == "PCM_16" and info.samplerate == SAMPLE_RATE
                   and info.channels == 1)
    try:
        raw, sr = sf.read(src, dtype="float64", always_2d=True)
    except Exception as e:
        raise AudioError(f"{name}: the audio could not be decoded", stage="ingest",
                         detail={"reason": str(e)}) from e
    audio = to_pipeline_audio(raw, sr)
    warnings = check_audio(audio, name, cfg)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if passthrough:
        shutil.copyfile(src, dst)
    else:
        sf.write(dst, audio, SAMPLE_RATE, subtype="PCM_16")
    return {"name": name, "source_sha256": sha256_bytes(src), "sha256": sha256_bytes(dst),
            "source": {"format": info.format, "subtype": info.subtype, "sample_rate": info.samplerate,
                       "channels": info.channels},
            "converted": not passthrough, "duration_s": round(len(audio) / SAMPLE_RATE, 3), "warnings": warnings}


def ingest_transcript(src: str | Path, dst: str | Path, cfg: IngestConfig) -> Transcript:
    """Copy a UTF-8 transcript verbatim to ``dst`` and return it parsed."""
    src, dst = Path(src), Path(dst)
    if not src.is_file():
        raise TranscriptError(f"{src.name}: transcript file not found", stage="ingest")
    raw = src.read_bytes()
    try:
        raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise TranscriptError(f"{src.name}: the transcript is not UTF-8 text", stage="ingest") from e
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(raw)
    try:
        transcript = load_transcript(dst)
    except ValueError as e:
        raise TranscriptError(f"{src.name}: the transcript contains no words", stage="ingest") from e
    if len(transcript.tokens) < cfg.min_transcript_words:
        raise TranscriptError(f"{src.name}: {len(transcript.tokens)} words; at least {cfg.min_transcript_words} "
                              "are needed", stage="ingest")
    return transcript


def settings(cfg: IngestConfig) -> dict:
    return asdict(cfg)
