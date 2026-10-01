"""F0 extraction and per-word pitch aggregation on synthetic audio."""

import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from src.features.pitch import (
    PITCH_WORD_FIELDS,
    PitchConfig,
    apply_energy_gate,
    extract_f0,
    extract_gated_f0,
    frame_energy_db,
    in_word_gate_check,
    hz_to_semitones,
    speaker_reference_hz,
    word_pitch_features,
)

SR = 16000
CFG = PitchConfig()


def tone(f0_hz, seconds, harmonics=5):
    """Voice-like harmonic complex; f0_hz may be a scalar or a per-sample array."""
    n = int(seconds * SR)
    f0 = np.broadcast_to(np.asarray(f0_hz, dtype=float), (n,))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    sig = sum(np.sin(k * phase) / k for k in range(1, harmonics + 1))
    return 0.3 * sig / np.max(np.abs(sig))


def silence(seconds):
    return np.zeros(int(seconds * SR))


def word(idx, start, end, aligned=True):
    return {"idx": idx, "text": f"w{idx}", "aligned": aligned,
            "start": start if aligned else None, "end": end if aligned else None}


def features(audio, words, cfg=CFG):
    """Full gated path; trailing silence (as in real takes) gives the gate a noise floor."""
    audio = np.concatenate([audio, silence(0.5)])
    times, f0, _, _, _ = extract_gated_f0(audio, SR, cfg)
    ref = speaker_reference_hz(times, f0, words)
    return ref, word_pitch_features(times, f0, words, ref, cfg)


def test_hz_to_semitones():
    assert hz_to_semitones(400.0, 200.0) == pytest.approx(12.0)
    assert hz_to_semitones(100.0, 200.0) == pytest.approx(-12.0)
    assert np.isnan(hz_to_semitones(np.nan, 200.0))


@pytest.mark.parametrize("f0_hz", [110.0, 200.0, 320.0])
def test_constant_tone_frame_f0(f0_hz):
    times, f0 = extract_f0(tone(f0_hz, 1.0), SR, CFG)
    assert np.allclose(np.diff(times), CFG.time_step)
    voiced = f0[~np.isnan(f0)]
    assert len(voiced) / len(f0) > 0.95
    assert np.median(voiced) == pytest.approx(f0_hz, rel=0.01)


def test_silence_is_unvoiced_not_zero():
    _, f0 = extract_f0(silence(1.0), SR, CFG)
    assert np.isnan(f0).all()


def test_word_aggregation_tone_silence_tone():
    audio = np.concatenate([tone(200, 1.0), silence(1.0), tone(300, 1.0)])
    words = [word(0, 0.1, 0.9), word(1, 1.1, 1.9), word(2, 2.1, 2.5), word(3, None, None, aligned=False)]
    ref, recs = features(audio, words)

    assert ref == pytest.approx(200, rel=0.01)  # 200 Hz frames are the majority
    assert all(tuple(r) == PITCH_WORD_FIELDS for r in recs)

    w0, w1, w2, w3 = recs
    assert w0["pitch_failure"] is None and w0["voiced_ratio"] == 1.0
    assert w0["f0_median_hz"] == pytest.approx(200, rel=0.01)
    assert abs(w0["f0_median_st"]) < 0.1 and w0["f0_std_st"] < 0.1 and w0["f0_range_st"] < 0.1

    assert w2["f0_median_hz"] == pytest.approx(300, rel=0.01)
    assert w2["f0_median_st"] == pytest.approx(12 * np.log2(300 / 200), abs=0.15)

    # silent word: voicing measured, pitch statistics explicitly missing (not 0)
    assert w1["voiced_ratio"] == 0.0 and w1["pitch_failure"] == "insufficient_voicing"
    assert w1["f0_median_hz"] is None and w1["f0_median_st"] is None and w1["f0_std_st"] is None

    # unaligned word: nothing measured
    assert w3["pitch_failure"] == "unaligned"
    assert all(w3[k] is None for k in ("n_frames", "voiced_ratio", "f0_median_hz", "f0_range_st"))


def test_partially_voiced_word_ratio():
    audio = np.concatenate([silence(0.5), tone(180, 0.5)])
    _, (rec,) = features(audio, [word(0, 0.0, 1.0)])
    assert rec["voiced_ratio"] == pytest.approx(0.5, abs=0.06)
    assert rec["f0_median_hz"] == pytest.approx(180, rel=0.01)


def test_word_shorter_than_min_voiced_frames():
    audio = tone(200, 1.0)
    _, (rec,) = features(audio, [word(0, 0.500, 0.520)])  # two 10 ms frames
    assert rec["n_frames"] == 2 and rec["pitch_failure"] == "insufficient_voicing"
    assert rec["f0_median_hz"] is None


def test_glide_range_and_std_in_semitones():
    # exponential glide 150 -> 300 Hz is linear in semitones (0 -> 12 st over 1 s)
    t = np.arange(int(1.0 * SR)) / SR
    audio = tone(150 * 2 ** t, 1.0)
    _, (rec,) = features(audio, [word(0, 0.1, 0.9)])
    # frames span 0.1-0.9 s -> 9.6 st; p10-p90 covers 80% of that
    assert rec["f0_range_st"] == pytest.approx(0.8 * 9.6, abs=0.5)
    assert rec["f0_std_st"] == pytest.approx(9.6 / np.sqrt(12), abs=0.3)
    flat = features(tone(150, 1.0), [word(0, 0.1, 0.9)])[1][0]
    assert flat["f0_range_st"] < 0.1 < rec["f0_range_st"]  # monotone vs. intonated


def test_speaker_normalization_is_invariant_to_register():
    """The same melody an octave higher gives identical semitone features."""
    # Short pauses between "words": an abrupt, unbroken 1.5x jump makes Praat's
    # path finder pick the subharmonic (octave-jump cost), which real speech
    # with voicing breaks between words does not provoke.
    def utterance(base_hz):
        return np.concatenate([tone(base_hz, 0.6), silence(0.1), tone(base_hz * 1.5, 0.3),
                               silence(0.1), tone(base_hz * 0.8, 0.6)])

    words = [word(0, 0.05, 0.55), word(1, 0.75, 0.95), word(2, 1.15, 1.65)]
    ref_lo, low = features(utterance(120), words)
    ref_hi, high = features(utterance(240), words)

    assert ref_hi / ref_lo == pytest.approx(2.0, rel=0.01)
    for a, b in zip(low, high):
        assert b["f0_median_hz"] / a["f0_median_hz"] == pytest.approx(2.0, rel=0.01)
        assert b["f0_median_st"] == pytest.approx(a["f0_median_st"], abs=0.1)
        assert b["f0_range_st"] == pytest.approx(a["f0_range_st"], abs=0.1)


def test_frame_energy_db_of_sine_and_silence():
    t = np.arange(SR) / SR
    audio = np.concatenate([0.5 * np.sin(2 * np.pi * 200 * t), silence(1.0)])
    times = np.array([0.5, 1.5])
    e = frame_energy_db(audio, SR, times, 0.04)
    assert e[0] == pytest.approx(20 * np.log10(0.5 / np.sqrt(2)), abs=0.1)  # -9.03 dBFS
    assert e[1] < -100


def hum_scene():
    """3 s of low-level 100 Hz hum with a loud 150 Hz 'voice' from 1.0 to 2.0 s."""
    t = np.arange(3 * SR) / SR
    hum = 0.02 * np.sin(2 * np.pi * 100 * t)
    voice = np.concatenate([silence(1.0), tone(150, 1.0), silence(1.0)])
    return hum + voice


def test_energy_gate_removes_hum_but_keeps_voice():
    times, f0, f0_raw, energy, gate = extract_gated_f0(hum_scene(), SR, CFG)
    hum_only = (times < 0.9) | (times > 2.1)
    voice = (times > 1.1) & (times < 1.9)

    # without gating the tracker reports the hum as ~100 Hz "voicing"
    assert np.mean(~np.isnan(f0_raw[hum_only])) > 0.8
    assert np.nanmedian(f0_raw[hum_only]) == pytest.approx(100, rel=0.02)
    # with gating the hum is unvoiced, the voice is untouched
    assert np.isnan(f0[hum_only]).all()
    assert np.array_equal(f0[voice], f0_raw[voice], equal_nan=True)
    assert np.nanmedian(f0[voice]) == pytest.approx(150, rel=0.01)
    assert gate["threshold_db"] == pytest.approx(gate["noise_floor_db"] + CFG.gate_margin_db)

    words = [word(0, 0.2, 0.8), word(1, 1.2, 1.8)]
    ref = speaker_reference_hz(times, f0, words)
    hum_word, voice_word = word_pitch_features(times, f0, words, ref, CFG)
    assert hum_word["pitch_failure"] == "insufficient_voicing" and hum_word["f0_median_hz"] is None
    assert voice_word["f0_median_hz"] == pytest.approx(150, rel=0.01)


def test_energy_gate_disabled_keeps_raw_f0():
    cfg = replace(CFG, energy_gate=False)
    _, f0, f0_raw, _, gate = extract_gated_f0(hum_scene(), SR, cfg)
    assert np.array_equal(f0, f0_raw, equal_nan=True)
    assert gate["enabled"] is False and gate["removed_voiced_frames"] == 0


def test_energy_gate_warns_when_take_has_no_silence():
    f0 = np.full(100, 200.0)
    energy = np.full(100, -20.0)  # constant level: the "floor" is the speech itself
    gated, _ = apply_energy_gate(f0, energy, CFG)
    check = in_word_gate_check(f0, gated, np.ones(100, dtype=bool))
    assert np.isnan(gated).all()
    assert check["in_word_removed_ratio"] == 1.0 and check["warning"] is not None


def test_gate_removing_only_hum_does_not_warn():
    times, f0, f0_raw, _, _ = extract_gated_f0(hum_scene(), SR, CFG)
    check = in_word_gate_check(f0_raw, f0, (times > 1.1) & (times < 1.9))
    assert check["in_word_removed_ratio"] == 0.0 and check["warning"] is None


def test_extraction_is_deterministic():
    audio = np.concatenate([tone(200, 0.5), silence(0.2), tone(260, 0.5)])
    t1, f1 = extract_f0(audio, SR, CFG)
    t2, f2 = extract_f0(audio, SR, CFG)
    assert np.array_equal(t1, t2) and np.array_equal(f1, f2, equal_nan=True)


CACHED = Path("results/features/speech_01/good_01.pitch.json")


@pytest.mark.skipif(not CACHED.exists(), reason="run python -m src.features.pitch first")
def test_cached_good_01_pitch_matches_alignment():
    doc = json.loads(CACHED.read_text(encoding="utf-8"))
    alignment = json.loads(Path("results/alignments/speech_01/good_01.json").read_text(encoding="utf-8"))
    assert doc["alignment_cache_key"] == alignment["cache_key"]
    assert [(r["idx"], r["text"]) for r in doc["words"]] == [(w["idx"], w["text"]) for w in alignment["words"]]
    for r in doc["words"]:
        assert tuple(r) == PITCH_WORD_FIELDS
        if r["pitch_failure"] is None:
            assert CFG.floor_hz <= r["f0_median_hz"] <= CFG.ceiling_hz
            assert r["n_voiced"] >= CFG.min_voiced_frames
        else:
            assert r["f0_median_hz"] is None and r["f0_median_st"] is None
    assert 70 < doc["speaker_ref_hz"] < 400
    assert doc["energy_gate"]["enabled"] and doc["energy_gate"]["warning"] is None
    assert doc["summary"]["pause_voiced_ratio"] <= doc["summary"]["pause_voiced_ratio_raw"]
