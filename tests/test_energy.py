"""Frame energy extraction and per-word energy aggregation on synthetic audio."""

import json
from pathlib import Path

import numpy as np
import pytest

from src.features.energy import (
    ENERGY_WORD_FIELDS,
    EnergyConfig,
    extract_energy,
    frame_times,
    noise_floor_db,
    speaker_reference_db,
    word_energy_features,
)
from src.features.pitch import PitchConfig, extract_gated_f0, word_pitch_features
from src.features.pitch import speaker_reference_hz

SR = 16000
CFG = EnergyConfig()
RNG = np.random.default_rng(1337)
NOISE = 1e-3 * RNG.standard_normal(10 * SR)  # quiet background, about -60 dBFS


def tone(f0_hz, seconds, amp=0.3, harmonics=5):
    n = int(seconds * SR)
    phase = 2 * np.pi * f0_hz * np.arange(n) / SR
    sig = sum(np.sin(k * phase) / k for k in range(1, harmonics + 1))
    return amp * sig / np.max(np.abs(sig))


def silence(seconds):
    return np.zeros(int(seconds * SR))


def with_background(audio):
    return audio + NOISE[: len(audio)]


def word(idx, start, end, aligned=True):
    return {"idx": idx, "text": f"w{idx}", "aligned": aligned,
            "start": start if aligned else None, "end": end if aligned else None}


def features(audio, words, voiced_frames=None, cfg=CFG):
    """Full path with trailing background, as in real takes (gives a noise floor)."""
    audio = with_background(np.concatenate([audio, silence(1.0)]))
    times, e = extract_energy(audio, SR, cfg)
    floor = noise_floor_db(e, cfg)
    ref = speaker_reference_db(times, e, words, floor + cfg.active_margin_db)
    return floor, ref, word_energy_features(times, e, words, floor, ref, cfg, voiced_frames)


def test_frame_grid_covers_full_windows_only():
    times = frame_times(SR, SR, CFG)  # 1 s
    assert times[0] == pytest.approx(CFG.window / 2)
    assert np.allclose(np.diff(times), CFG.time_step)
    assert times[-1] + CFG.window / 2 <= 1.0 + 1e-9
    assert len(frame_times(int(0.01 * SR), SR, CFG)) == 0  # shorter than one window


def test_sine_energy_matches_rms():
    amp = 0.5
    _, e = extract_energy(amp * np.sin(2 * np.pi * 200 * np.arange(SR) / SR), SR, CFG)
    assert np.allclose(e, 20 * np.log10(amp / np.sqrt(2)), atol=0.05)  # -9.03 dBFS


def test_gain_change_shows_up_as_relative_db():
    audio = np.concatenate([tone(150, 0.5), silence(0.1), 0.5 * tone(150, 0.5)])  # second word -6.02 dB
    words = [word(0, 0.05, 0.45), word(1, 0.65, 1.05)]
    _, ref, (w0, w1) = features(audio, words)
    assert w1["energy_rel_db"] - w0["energy_rel_db"] == pytest.approx(-6.02, abs=0.1)
    # equal frame counts: the reference (median active frame) sits midway
    assert w0["energy_rel_db"] == pytest.approx(3.01, abs=0.1)
    assert w0["energy_std_db"] < 0.5  # steady tone; 25 ms window = 3.75 periods -> ~0.2 dB ripple
    assert all(tuple(r) == ENERGY_WORD_FIELDS for r in (w0, w1))


def test_speaker_normalization_is_invariant_to_recording_level():
    audio = np.concatenate([tone(150, 0.5), silence(0.1), 0.4 * tone(150, 0.3), silence(0.1), tone(150, 0.5)])
    words = [word(0, 0.05, 0.45), word(1, 0.65, 0.85), word(2, 1.05, 1.45)]
    # same take 10 dB louder (background scaled too, like a hotter mic gain)
    louder = np.concatenate([audio, silence(1.0)]) + NOISE[: len(audio) + SR]
    quieter_recs = features(audio, words)[2]
    times, e = extract_energy(louder * 10 ** (10 / 20), SR, CFG)
    floor = noise_floor_db(e, CFG)
    ref = speaker_reference_db(times, e, words, floor + CFG.active_margin_db)
    louder_recs = word_energy_features(times, e, words, floor, ref, CFG)
    for q, l in zip(quieter_recs, louder_recs):
        assert l["energy_mean_db"] - q["energy_mean_db"] == pytest.approx(10.0, abs=0.05)
        assert l["energy_rel_db"] == pytest.approx(q["energy_rel_db"], abs=0.05)
        assert l["snr_db"] == pytest.approx(q["snr_db"], abs=0.05)


def test_silent_word_is_flagged_but_measured():
    audio = np.concatenate([tone(150, 0.5), silence(0.5), tone(150, 0.5)])
    words = [word(0, 0.05, 0.45), word(1, 0.55, 0.95), word(2, 1.05, 1.45)]
    floor, _, (_, w1, _) = features(audio, words, voiced_frames={0: 40, 1: 0, 2: 40})
    assert w1["energy_status"] == "silent"  # silent takes precedence over unvoiced
    assert w1["n_active"] == 0 and w1["active_ratio"] == 0.0
    assert w1["energy_failure"] is None
    # a real (upper-bound) measurement at the background level, not a 0 placeholder
    assert w1["energy_mean_db"] == pytest.approx(floor, abs=3)
    assert w1["energy_rel_db"] < -30


def test_unvoiced_word_from_real_pitch_pipeline():
    """A noise burst is audible but has no F0: status 'unvoiced', energy still valid."""
    burst = 0.1 * RNG.standard_normal(int(0.4 * SR))
    audio = np.concatenate([tone(150, 0.5), silence(0.1), burst, silence(0.1), tone(150, 0.5)])
    words = [word(0, 0.05, 0.45), word(1, 0.65, 0.95), word(2, 1.15, 1.55)]

    padded = with_background(np.concatenate([audio, silence(1.0)]))
    pcfg = PitchConfig()
    pt, f0, *_ = extract_gated_f0(padded, SR, pcfg)
    pitch = word_pitch_features(pt, f0, words, speaker_reference_hz(pt, f0, words), pcfg)
    voiced = {r["idx"]: r["n_voiced"] for r in pitch}

    _, _, (w0, w1, w2) = features(audio, words, voiced_frames=voiced)
    assert w0["energy_status"] == "voiced" and w2["energy_status"] == "voiced"
    assert w1["energy_status"] == "unvoiced"
    assert w1["active_ratio"] == 1.0 and w1["energy_rel_db"] is not None


def test_voicing_unknown_leaves_status_open():
    _, _, (w0,) = features(tone(150, 0.5), [word(0, 0.05, 0.45)])
    assert w0["energy_status"] is None and w0["energy_rel_db"] is not None


def test_unaligned_and_frameless_words_are_explicit_failures():
    audio = tone(150, 1.0)
    words = [word(0, 0.1, 0.9), word(1, None, None, aligned=False), word(2, 0.5030, 0.5110)]  # between frame centres 0.5025 and 0.5125
    _, _, (_, w1, w2) = features(audio, words)
    assert w1["energy_failure"] == "unaligned"
    assert w2["energy_failure"] == "no_frames" and w2["n_frames"] == 0
    for r in (w1, w2):
        assert all(r[k] is None for k in ("energy_mean_db", "energy_rel_db", "snr_db", "energy_status"))


def test_no_reference_when_take_has_no_audible_speech():
    words = [word(0, 0.1, 0.9)]
    floor, ref, (w0,) = features(silence(1.0), words)
    assert ref is None
    assert w0["energy_failure"] == "no_speaker_reference" and w0["energy_rel_db"] is None
    assert w0["energy_status"] == "silent" and w0["energy_mean_db"] is not None


def test_peak_reflects_loud_onset():
    audio = np.concatenate([tone(150, 0.1), 0.25 * tone(150, 0.4)])  # loud start, -12 dB tail
    _, _, (w0,) = features(audio, [word(0, 0.0, 0.5)])
    assert w0["energy_peak_rel_db"] > w0["energy_rel_db"] + 3
    assert w0["energy_std_db"] > 3


def test_extraction_is_deterministic():
    audio = with_background(np.concatenate([tone(150, 0.5), silence(0.3)]))
    t1, e1 = extract_energy(audio, SR, CFG)
    t2, e2 = extract_energy(audio, SR, CFG)
    assert np.array_equal(t1, t2) and np.array_equal(e1, e2)


CACHED = Path("results/features/speech_01/good_01.energy.json")


@pytest.mark.skipif(not CACHED.exists(), reason="run python -m src.features.energy first")
def test_cached_good_01_energy_matches_alignment():
    doc = json.loads(CACHED.read_text(encoding="utf-8"))
    alignment = json.loads(Path("results/alignments/speech_01/good_01.json").read_text(encoding="utf-8"))
    assert doc["alignment_cache_key"] == alignment["cache_key"]
    assert [(r["idx"], r["text"]) for r in doc["words"]] == [(w["idx"], w["text"]) for w in alignment["words"]]
    for r in doc["words"]:
        assert tuple(r) == ENERGY_WORD_FIELDS
        if r["energy_failure"] is None:
            assert r["energy_status"] in ("voiced", "unvoiced", "silent")
            assert r["energy_mean_db"] < 0 and r["energy_rel_db"] is not None
    assert doc["noise_floor_db"] < doc["speaker_ref_db"] < 0
