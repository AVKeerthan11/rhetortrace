"""Ingestion of new recordings and transcripts (src/ingest.py)."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from src.errors import AudioError, InputError, TranscriptError
from src.ingest import IngestConfig, ingest_audio, ingest_transcript

CFG = IngestConfig()


def tone(seconds=3.0, sr=16000, amp=0.3, channels=1):
    t = np.arange(int(seconds * sr)) / sr
    x = amp * np.sin(2 * np.pi * 220 * t)
    return np.stack([x] * channels, axis=1) if channels > 1 else x


def test_pipeline_format_is_copied_byte_for_byte(tmp_path):
    src = tmp_path / "in.wav"
    sf.write(src, tone(), 16000, subtype="PCM_16")
    info = ingest_audio(src, tmp_path / "out" / "take.wav", CFG)
    assert (tmp_path / "out" / "take.wav").read_bytes() == src.read_bytes()
    assert not info["converted"] and info["sha256"] == info["source_sha256"]
    assert info["duration_s"] == 3.0 and info["warnings"] == []


def test_other_formats_become_16k_mono_pcm16_deterministically(tmp_path):
    src = tmp_path / "in.flac"
    sf.write(src, tone(sr=44100, channels=2), 44100)
    a = ingest_audio(src, tmp_path / "a.wav", CFG)
    b = ingest_audio(src, tmp_path / "b.wav", CFG)
    out = sf.info(tmp_path / "a.wav")
    assert (out.samplerate, out.channels, out.subtype, out.format) == (16000, 1, "PCM_16", "WAV")
    assert a["converted"] and abs(a["duration_s"] - 3.0) < 1e-3
    assert a["source"] == {"format": "FLAC", "subtype": "PCM_16", "sample_rate": 44100, "channels": 2}
    assert (tmp_path / "a.wav").read_bytes() == (tmp_path / "b.wav").read_bytes()
    y, _ = sf.read(tmp_path / "a.wav")
    assert abs(np.max(np.abs(y)) - 0.3) < 0.01  # level preserved by the resampler


def test_16k_float_wav_is_converted_not_copied(tmp_path):
    src = tmp_path / "in.wav"
    sf.write(src, tone(), 16000, subtype="FLOAT")
    assert ingest_audio(src, tmp_path / "o.wav", CFG)["converted"]


@pytest.mark.parametrize("audio,cfg,match", [
    (tone(seconds=1.0), CFG, "too short"),
    (tone(seconds=3.0), IngestConfig(max_duration_s=2.0), "too long"),
    (np.zeros(16000 * 3), CFG, "silent"),
    (tone(amp=0.001), CFG, "silent"),  # -60 dBFS peak
])
def test_unusable_audio_is_rejected(tmp_path, audio, cfg, match):
    src = tmp_path / "in.wav"
    sf.write(src, audio, 16000, subtype="PCM_16")
    with pytest.raises(AudioError, match=match) as e:
        ingest_audio(src, tmp_path / "o.wav", cfg)
    assert e.value.code == "invalid_audio" and e.value.stage == "ingest" and isinstance(e.value, InputError)
    assert not (tmp_path / "o.wav").exists()


def test_clipping_is_a_warning(tmp_path):
    src = tmp_path / "in.wav"
    sf.write(src, np.clip(tone(amp=2.0), -1, 1), 16000, subtype="PCM_16")
    info = ingest_audio(src, tmp_path / "o.wav", CFG, name="talk")
    assert len(info["warnings"]) == 1 and "clipped" in info["warnings"][0] and info["warnings"][0].startswith("talk")


def test_unreadable_and_unsupported_files(tmp_path):
    bad = tmp_path / "notes.wav"
    bad.write_text("not audio")
    with pytest.raises(AudioError, match="not a readable audio file"):
        ingest_audio(bad, tmp_path / "o.wav", CFG)
    m4a = tmp_path / "talk.m4a"
    m4a.write_bytes(b"\x00\x00\x00\x20ftypM4A ")
    with pytest.raises(AudioError, match="convert to WAV, FLAC or MP3"):
        ingest_audio(m4a, tmp_path / "o.wav", CFG)
    with pytest.raises(AudioError, match="not found"):
        ingest_audio(tmp_path / "missing.wav", tmp_path / "o.wav", CFG)


def test_transcript_is_copied_verbatim(tmp_path):
    src = tmp_path / "t.txt"
    src.write_bytes("Four score and seven years ago,\r\nour fathers.\n".encode("utf-8-sig"))
    t = ingest_transcript(src, tmp_path / "x" / "transcript.txt", CFG)
    assert (tmp_path / "x" / "transcript.txt").read_bytes() == src.read_bytes()
    assert t.norms[:3] == ["four", "score", "and"] and len(t.tokens) == 8


@pytest.mark.parametrize("raw,match", [
    ("—  …  !".encode("utf-8"), "no words"),
    (b"one two three", "at least 5"),
    ("caf\xe9 au lait".encode("latin-1"), "not UTF-8"),
])
def test_unusable_transcripts(tmp_path, raw, match):
    src = tmp_path / "t.txt"
    src.write_bytes(raw)
    with pytest.raises(TranscriptError, match=match):
        ingest_transcript(src, tmp_path / "o.txt", CFG)
