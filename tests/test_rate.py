"""Speech-rate features from synthetic word alignments."""

import json
from pathlib import Path

import pytest

from src.features.rate import (
    RATE_WORD_FIELDS,
    RateConfig,
    region_rate_features,
    sentence_ids,
    span_rates,
    word_rate_features,
)

CFG = RateConfig()


def make_words(texts, word_dur=0.3, gap=0.1, start=0.5, scale=1.0, unaligned=()):
    """Evenly spaced aligned words; `scale` stretches all timing (2.0 = half speed)."""
    words, t = [], start
    for i, text in enumerate(texts):
        aligned = i not in unaligned
        words.append({
            "idx": i, "text": text, "aligned": aligned,
            "start": round(t * scale, 6) if aligned else None,
            "end": round((t + word_dur) * scale, 6) if aligned else None,
        })
        t += word_dur + gap
    return words


TEXTS = "Four score and seven years ago. Our fathers brought forth on this continent.".split()


def test_sentence_regions_split_after_terminal_punctuation():
    words = make_words(["One", "two.", "Three", "four?", "Five", "“six!”", "seven"])
    assert sentence_ids(words, CFG.sentence_end) == [0, 0, 1, 1, 2, 2, 3]
    assert sentence_ids(make_words(["a,", "b;", "c"]), CFG.sentence_end) == [0, 0, 0]


def test_span_rates_uniform_timing():
    words = make_words(["a"] * 5, word_dur=0.3, gap=0.1)
    r = span_rates(words)
    assert r["n_aligned"] == 5
    assert r["speech_rate_wps"] == pytest.approx(5 / (5 * 0.3 + 4 * 0.1), abs=1e-3)  # gaps included
    assert r["articulation_rate_wps"] == pytest.approx(5 / (5 * 0.3), abs=1e-3)  # gaps excluded


def test_rates_scale_inversely_with_time_stretch():
    normal = word_rate_features(make_words(TEXTS), CFG)
    slow = word_rate_features(make_words(TEXTS, scale=2.0), CFG)
    for n, s in zip(normal, slow):
        assert s["duration_s"] == pytest.approx(2 * n["duration_s"], abs=1e-3)
        assert s["local_speech_rate_wps"] == pytest.approx(n["local_speech_rate_wps"] / 2, abs=2e-3)
        assert s["local_articulation_rate_wps"] == pytest.approx(n["local_articulation_rate_wps"] / 2, abs=2e-3)


def test_local_window_is_centred_and_clipped_to_sentence():
    recs = word_rate_features(make_words(TEXTS), CFG)
    assert all(tuple(r) == RATE_WORD_FIELDS for r in recs)
    # "Four"(0): window 0..2 (sentence start); "and"(2): full 0..4; "ago."(5): 3..5 (sentence end)
    assert [recs[i]["local_n_words"] for i in (0, 2, 5)] == [3, 5, 3]
    # "Our"(6) starts a new sentence: its window must not reach back into sentence 0
    assert recs[6]["region_idx"] == 1 and recs[6]["local_n_words"] == 3


def test_inter_sentence_pause_does_not_lower_local_rate():
    words = make_words(TEXTS)
    shift = 2.0  # long pause before the second sentence
    for w in words[6:]:
        w["start"] += shift
        w["end"] += shift
    with_pause = word_rate_features(words, CFG)
    without = word_rate_features(make_words(TEXTS), CFG)
    for a, b in zip(with_pause, without):
        assert a["local_speech_rate_wps"] == b["local_speech_rate_wps"]


def test_fast_sentence_shows_in_region_rates():
    words = make_words(TEXTS)
    # compress the second sentence 1.5x around its own start
    t0 = words[6]["start"]
    for w in words[6:]:
        w["start"] = t0 + (w["start"] - t0) / 1.5
        w["end"] = t0 + (w["end"] - t0) / 1.5
    r0, r1 = region_rate_features(words, CFG)
    assert (r0["first_idx"], r0["last_idx"], r1["first_idx"], r1["last_idx"]) == (0, 5, 6, 12)
    assert r1["speech_rate_wps"] / r0["speech_rate_wps"] == pytest.approx(1.5, rel=0.01)
    assert r1["articulation_rate_wps"] / r0["articulation_rate_wps"] == pytest.approx(1.5, rel=0.01)
    assert r0["text"].startswith("Four score") and r0["n_words"] == 6


def test_unaligned_words_are_excluded_and_explicit():
    words = make_words(TEXTS, unaligned={2})
    recs = word_rate_features(words, CFG)
    assert recs[2]["rate_failure"] == "unaligned"
    assert recs[2]["duration_s"] is None and recs[2]["local_speech_rate_wps"] is None
    assert recs[1]["local_n_words"] == 3  # window 0..3 minus the unaligned word
    region = region_rate_features(words, CFG)[0]
    assert region["n_words"] == 6 and region["n_aligned"] == 5


def test_insufficient_context_gives_null_not_zero():
    words = make_words(["Yes.", "No", "way."])  # 1-word sentence, then a 2-word sentence
    recs = word_rate_features(words, CFG)
    for r in recs:
        assert r["rate_failure"] == "insufficient_context"
        assert r["local_speech_rate_wps"] is None and r["duration_s"] is not None


def test_fully_unaligned_region_has_null_rates():
    r = span_rates(make_words(["a", "b"], unaligned={0, 1}))
    assert r == {"n_aligned": 0, "start": None, "end": None,
                 "speech_rate_wps": None, "articulation_rate_wps": None}


CACHED = Path("results/features/speech_01/good_01.rate.json")


@pytest.mark.skipif(not CACHED.exists(), reason="run python -m src.features.rate first")
def test_cached_good_01_rate_matches_alignment():
    doc = json.loads(CACHED.read_text(encoding="utf-8"))
    alignment = json.loads(Path("results/alignments/speech_01/good_01.json").read_text(encoding="utf-8"))
    assert doc["alignment_cache_key"] == alignment["cache_key"] and doc["unit"] == "words_per_second"
    assert [(r["idx"], r["text"]) for r in doc["words"]] == [(w["idx"], w["text"]) for w in alignment["words"]]
    regions = doc["regions"]
    assert regions[0]["first_idx"] == 0 and regions[-1]["last_idx"] == len(doc["words"]) - 1
    assert sum(r["n_words"] for r in regions) == len(doc["words"])
    for r in doc["words"]:
        assert tuple(r) == RATE_WORD_FIELDS
        if r["rate_failure"] is None:
            assert 0.5 < r["local_speech_rate_wps"] <= r["local_articulation_rate_wps"] < 15
