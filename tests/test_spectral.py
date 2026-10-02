"""MFCC / spectral features on synthetic audio."""

import json
from pathlib import Path

import numpy as np
import pytest

from src.features.spectral import (
    SPECTRAL_WORD_FIELDS,
    SpectralConfig,
    active_frames,
    extract_spectral,
    region_spectral_features,
    take_reference,
    word_spectral_features,
)

SR = 16000
CFG = SpectralConfig()
RNG = np.random.default_rng(1337)
BACKGROUND = 1e-3 * RNG.standard_normal(20 * SR)


def sine(hz, seconds, amp=0.3):
    return amp * np.sin(2 * np.pi * hz * np.arange(int(seconds * SR)) / SR)


def noise(seconds, amp=0.1):
    return amp * RNG.standard_normal(int(seconds * SR))


def silence(seconds):
    return np.zeros(int(seconds * SR))


def word(idx, start, end, text=None, aligned=True):
    return {"idx": idx, "text": text or f"w{idx}", "aligned": aligned,
            "start": start if aligned else None, "end": end if aligned else None}


def run(audio, words, cfg=CFG, pad=True, gain_db=0.0):
    """Full path; trailing background gives the active-frame gate a noise floor.

    gain_db scales signal and background together, like a microphone gain change.
    """
    if pad:
        audio = np.concatenate([audio, silence(1.0)])
        audio = audio + BACKGROUND[: len(audio)]
    audio = audio * 10 ** (gain_db / 20)
    times, frames = extract_spectral(audio, SR, cfg)
    active, _ = active_frames(frames["energy_db"], cfg)
    cmn, centroid = take_reference(times, frames, active, words)
    return (times, frames, active, cmn, centroid,
            word_spectral_features(times, frames, active, words, cmn, centroid, cfg))


def test_frame_grid_and_shapes():
    times, frames = extract_spectral(sine(440, 1.0), SR, CFG)
    assert times[0] == 0.0 and np.allclose(np.diff(times), CFG.hop)
    assert frames["mfcc"].shape == (len(times), CFG.n_mfcc)
    for k in ("centroid_hz", "bandwidth_hz", "rolloff_hz", "flatness", "energy_db"):
        assert frames[k].shape == (len(times),)


@pytest.mark.parametrize("hz", [500.0, 1000.0, 3000.0])
def test_sine_centroid_and_rolloff(hz):
    _, f = extract_spectral(sine(hz, 1.0), SR, CFG)
    mid = slice(5, -5)  # skip padded edge frames
    assert np.median(f["centroid_hz"][mid]) == pytest.approx(hz, rel=0.02)
    assert np.median(f["rolloff_hz"][mid]) == pytest.approx(hz, abs=2 * SR / CFG.n_fft)
    assert np.median(f["bandwidth_hz"][mid]) < 100


def test_flatness_separates_tone_from_noise():
    _, tone = extract_spectral(sine(1000, 1.0), SR, CFG)
    _, hiss = extract_spectral(noise(1.0), SR, CFG)
    assert np.median(tone["flatness"]) < 1e-3
    assert np.median(hiss["flatness"]) > 0.3
    assert np.median(hiss["centroid_hz"]) == pytest.approx(SR / 4, rel=0.1)  # white noise


def test_word_features_contract_and_timbre_separation():
    audio = np.concatenate([sine(300, 0.4), silence(0.1), noise(0.4), silence(0.1), sine(300, 0.4)])
    words = [word(0, 0.05, 0.35), word(1, 0.55, 0.85), word(2, 1.05, 1.35)]
    *_, recs = run(audio, words)
    assert all(tuple(r) == SPECTRAL_WORD_FIELDS for r in recs)
    assert all(r["spectral_failure"] is None and len(r["mfcc_mean"]) == CFG.n_mfcc for r in recs)
    m = [np.array(r["mfcc_mean"]) for r in recs]
    assert np.linalg.norm(m[0] - m[2]) < 0.2 * np.linalg.norm(m[0] - m[1])  # same timbre vs tone/noise
    assert recs[1]["flatness"] > 100 * recs[0]["flatness"]
    assert recs[1]["centroid_rel_oct"] > recs[0]["centroid_rel_oct"]


def test_cmn_makes_mfcc_invariant_to_gain():
    audio = np.concatenate([sine(300, 0.4), silence(0.1), noise(0.4, amp=0.05)])
    words = [word(0, 0.05, 0.35), word(1, 0.55, 0.85)]
    *_, cmn_a, _, quiet = run(audio, words)
    *_, cmn_b, _, loud = run(audio, words, gain_db=12)
    assert cmn_b[0] > cmn_a[0] + 10  # raw c0 tracks level
    for q, l in zip(quiet, loud):
        assert np.allclose(q["mfcc_mean"], l["mfcc_mean"], atol=0.5)
        assert l["centroid_hz"] == pytest.approx(q["centroid_hz"], rel=0.02)


def test_silent_short_and_unaligned_words_fail_explicitly():
    audio = np.concatenate([sine(300, 0.5), silence(0.5), sine(300, 0.5)])
    words = [word(0, 0.05, 0.45), word(1, 0.6, 0.9), word(2, 1.2, 1.215),
             word(3, None, None, aligned=False)]
    *_, recs = run(audio, words)
    silent, short, unaligned = recs[1], recs[2], recs[3]
    assert silent["spectral_failure"] == "insufficient_active_frames" and silent["n_active"] == 0
    assert short["spectral_failure"] == "insufficient_active_frames" and short["n_frames"] == 2
    assert unaligned["spectral_failure"] == "unaligned" and unaligned["n_frames"] is None
    for r in (silent, short, unaligned):
        assert r["mfcc_mean"] is None and r["centroid_hz"] is None and r["flatness"] is None


def test_hum_frames_are_excluded_from_word_spectrum():
    """A quiet hum under a word's silent tail must not pull its centroid down."""
    t = np.arange(int(3.0 * SR)) / SR
    hum = 0.01 * np.sin(2 * np.pi * 100 * t)  # present throughout, as in the real takes
    audio = hum + np.concatenate([silence(0.5), sine(2000, 0.3), silence(2.2)])
    words = [word(0, 0.4, 1.2)]  # word interval mostly hum, 0.3 s of 2 kHz speech
    *_, (rec,) = run(audio, words, pad=False)
    assert rec["n_active"] < rec["n_frames"]
    assert rec["centroid_hz"] == pytest.approx(2000, rel=0.05)


def test_regions_aggregate_sentences():
    audio = np.concatenate([sine(300, 0.6), silence(0.2), noise(0.6)])
    words = [word(0, 0.05, 0.25, "One"), word(1, 0.3, 0.55, "two."), word(2, 0.85, 1.35, "Three.")]
    times, frames, active, cmn, centroid, _ = run(audio, words)
    r0, r1 = region_spectral_features(times, frames, active, words, cmn, centroid, CFG)
    assert (r0["first_idx"], r0["last_idx"], r1["first_idx"]) == (0, 1, 2)
    assert r0["spectral_failure"] is None and r1["spectral_failure"] is None
    assert r1["flatness"] > 100 * r0["flatness"]


def test_no_reference_without_audible_speech():
    words = [word(0, 0.1, 0.9)]
    *_, cmn, centroid, (rec,) = run(silence(1.0), words)
    assert cmn is None and centroid is None
    assert rec["spectral_failure"] == "insufficient_active_frames"


def test_extraction_is_deterministic():
    audio = np.concatenate([sine(300, 0.3), noise(0.3)])
    t1, f1 = extract_spectral(audio, SR, CFG)
    t2, f2 = extract_spectral(audio, SR, CFG)
    assert np.array_equal(t1, t2) and all(np.array_equal(f1[k], f2[k]) for k in f1)


CACHED = Path("results/features/speech_01/good_01.spectral.json")


@pytest.mark.skipif(not CACHED.exists(), reason="run python -m src.features.spectral first")
def test_cached_good_01_spectral_matches_alignment():
    doc = json.loads(CACHED.read_text(encoding="utf-8"))
    alignment = json.loads(Path("results/alignments/speech_01/good_01.json").read_text(encoding="utf-8"))
    assert doc["alignment_cache_key"] == alignment["cache_key"]
    assert [(r["idx"], r["text"]) for r in doc["words"]] == [(w["idx"], w["text"]) for w in alignment["words"]]
    assert len(doc["cmn_vector"]) == CFG.n_mfcc
    for r in doc["words"]:
        assert tuple(r) == SPECTRAL_WORD_FIELDS
        if r["spectral_failure"] is None:
            assert len(r["mfcc_mean"]) == CFG.n_mfcc and 0 < r["centroid_hz"] < SR / 2
        else:
            assert r["mfcc_mean"] is None
    assert sum(r["n_words"] for r in doc["regions"]) == len(doc["words"])
