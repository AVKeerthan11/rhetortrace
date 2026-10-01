"""Pause extraction from synthetic word alignments."""

import json
from pathlib import Path

import pytest

from src.features.pause import (
    BOUNDARY_FIELDS,
    PAUSE_WORD_FIELDS,
    PauseConfig,
    boundary_pauses,
    region_pause_features,
    trailing_punct,
    word_pause_features,
)

CFG = PauseConfig()


def make_words(spec):
    """spec: list of (text, start, end) with start=None for unaligned words."""
    return [{"idx": i, "text": text, "aligned": start is not None, "start": start, "end": end}
            for i, (text, start, end) in enumerate(spec)]


# "Four score, and seven. Years ago" with known gaps
WORDS = make_words([
    ("Four", 0.50, 0.80),
    ("score,", 0.86, 1.20),   # gap 0.06: not a pause
    ("and", 1.60, 1.70),      # gap 0.40 at a comma: within-sentence pause
    ("seven.", 1.75, 2.10),   # gap 0.05
    ("Years", 3.10, 3.40),    # gap 1.00: sentence-boundary pause
    ("ago", 3.70, 4.00),      # gap 0.30, no punctuation: unpunctuated pause
])


def test_trailing_punct():
    assert trailing_punct("score,") == ","
    assert trailing_punct("seven.") == "."
    assert trailing_punct("July?") == "?"
    assert trailing_punct("quickened;") == ";"
    assert trailing_punct("“six!”") == "!"
    assert trailing_punct("brass-fronted") is None
    assert trailing_punct("ago") is None


def test_boundary_gaps_types_and_threshold():
    b = boundary_pauses(WORDS, CFG)
    assert len(b) == len(WORDS) - 1
    assert all(tuple(r) == BOUNDARY_FIELDS for r in b)
    assert [r["gap_s"] for r in b] == [0.06, 0.4, 0.05, 1.0, 0.3]
    assert [r["is_pause"] for r in b] == [False, True, False, True, True]
    assert [r["boundary_type"] for r in b] == ["within_sentence"] * 3 + ["sentence", "within_sentence"]
    assert [r["punct_after"] for r in b] == [None, ",", None, ".", None]
    assert (b[3]["start"], b[3]["end"]) == (2.10, 3.10)
    assert [r["region_idx"] for r in b] == [0, 0, 0, 0, 1]


def test_threshold_is_configurable():
    b = boundary_pauses(WORDS, PauseConfig(min_pause_s=0.5))
    assert [r["is_pause"] for r in b] == [False, False, False, True, False]


def test_small_overlap_is_clipped_to_zero_gap():
    words = make_words([("a", 0.0, 0.5), ("b", 0.4995, 0.8)])
    (b,) = boundary_pauses(words, CFG)
    assert b["gap_s"] == 0.0 and b["is_pause"] is False


def test_unaligned_word_makes_adjacent_boundaries_unknown():
    words = make_words([("a", 0.0, 0.3), ("b", None, None), ("c", 0.9, 1.2), ("d", 1.25, 1.5)])
    b = boundary_pauses(words, CFG)
    for r in b[:2]:
        assert r["pause_failure"] == "unaligned"
        assert r["gap_s"] is None and r["is_pause"] is None and r["start"] is None
    assert b[2]["pause_failure"] is None and b[2]["gap_s"] == 0.05


def test_word_level_pause_context():
    w = word_pause_features(WORDS, boundary_pauses(WORDS, CFG))
    assert all(tuple(r) == PAUSE_WORD_FIELDS for r in w)
    assert w[0]["before_failure"] == "take_start" and w[0]["pause_before_s"] is None
    assert w[-1]["after_failure"] == "take_end" and w[-1]["pause_after_s"] is None
    assert w[1]["pause_after_s"] == 0.4 and w[1]["is_pause_after"] is True
    assert w[2]["pause_before_s"] == 0.4  # same boundary seen from the next word
    assert w[3]["boundary_after"] == "sentence" and w[3]["pause_after_s"] == 1.0


def test_region_aggregates():
    r0, r1 = region_pause_features(WORDS, boundary_pauses(WORDS, CFG), CFG)
    assert (r0["first_idx"], r0["last_idx"], r1["first_idx"], r1["last_idx"]) == (0, 3, 4, 5)
    # sentence 0: within-sentence boundaries 0.06, 0.40, 0.05 -> one pause
    assert (r0["n_boundaries"], r0["n_measured"], r0["n_pauses"]) == (3, 3, 1)
    assert r0["total_pause_s"] == 0.4 and r0["max_pause_s"] == 0.4
    assert r0["pause_ratio"] == pytest.approx(0.4 / (2.10 - 0.50), abs=1e-3)
    assert (r0["n_punct_boundaries"], r0["n_punct_with_pause"], r0["n_unpunct_pauses"]) == (1, 1, 0)
    assert r0["pause_after_s"] == 1.0 and r0["pause_after_failure"] is None
    # sentence 1: one unpunctuated pause; it is the last sentence
    assert r1["n_pauses"] == 1 and r1["n_unpunct_pauses"] == 1
    assert r1["pause_after_s"] is None and r1["pause_after_failure"] == "take_end"


def test_region_without_pauses_has_null_stats_not_zero_means():
    words = make_words([("a", 0.0, 0.3), ("b", 0.32, 0.6), ("c.", 0.62, 0.9)])
    (r,) = region_pause_features(words, boundary_pauses(words, CFG), CFG)
    assert r["n_pauses"] == 0 and r["total_pause_s"] == 0.0
    assert r["mean_pause_s"] is None and r["median_pause_s"] is None and r["max_pause_s"] is None


def test_lengthened_pause_and_removed_pause_are_visible():
    longer = [dict(w) for w in WORDS]
    for w in longer[2:]:  # stretch the comma pause by 0.6 s
        w["start"] += 0.6
        w["end"] += 0.6
    removed = [dict(w) for w in WORDS]
    for w in removed[2:]:  # close the comma pause completely (gap -> 0.05)
        w["start"] -= 0.35
        w["end"] -= 0.35
    base = region_pause_features(WORDS, boundary_pauses(WORDS, CFG), CFG)[0]
    long_r = region_pause_features(longer, boundary_pauses(longer, CFG), CFG)[0]
    gone_r = region_pause_features(removed, boundary_pauses(removed, CFG), CFG)[0]
    assert long_r["max_pause_s"] == pytest.approx(base["max_pause_s"] + 0.6)
    assert gone_r["n_punct_with_pause"] == 0 and gone_r["n_pauses"] == 0


CACHED = Path("results/features/speech_01/good_01.pause.json")


@pytest.mark.skipif(not CACHED.exists(), reason="run python -m src.features.pause first")
def test_cached_good_01_pauses_match_alignment():
    doc = json.loads(CACHED.read_text(encoding="utf-8"))
    alignment = json.loads(Path("results/alignments/speech_01/good_01.json").read_text(encoding="utf-8"))
    words = alignment["words"]
    assert doc["alignment_cache_key"] == alignment["cache_key"]
    assert [(r["idx"], r["text"]) for r in doc["words"]] == [(w["idx"], w["text"]) for w in words]
    assert len(doc["boundaries"]) == len(words) - 1
    for b, (a, nxt) in zip(doc["boundaries"], zip(words, words[1:])):
        if b["pause_failure"] is None:
            assert b["gap_s"] == pytest.approx(max(0.0, nxt["start"] - a["end"]), abs=1e-3)
            assert b["gap_s"] >= 0
    n_sentence = sum(b["boundary_type"] == "sentence" for b in doc["boundaries"])
    assert n_sentence == len(doc["regions"]) - 1
