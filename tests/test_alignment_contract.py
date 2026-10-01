"""Data-contract tests for word alignments.

The unit tests use synthetic WhisperX outputs so they run without models.
The integration test validates the cached alignment of speech_01/good_01
(produced by `python scripts/align_one.py`) and is skipped if it is absent.
"""

from pathlib import Path

import pytest

from src.alignment import (
    SCHEMA_VERSION,
    WORD_FIELDS,
    AlignmentConfig,
    AlignmentError,
    QCThresholds,
    build_word_records,
    load_alignment,
    quality_checks,
    validate_alignment_doc,
)
from src.transcript import Transcript, load_transcript, tokenize

QC = QCThresholds()


def make_transcript(text: str) -> Transcript:
    return Transcript(path="<test>", text=text, sha256="0", tokens=tuple(tokenize(text)))


def make_doc(words, duration=10.0):
    return {"schema_version": SCHEMA_VERSION, "audio": {"duration": duration}, "words": words}


TRANSCRIPT = make_transcript("Four score, and seven years.")
RAW_OK = [
    {"word": "four", "start": 0.50, "end": 0.80, "score": 0.9},
    {"word": "score", "start": 0.85, "end": 1.20, "score": 0.8},
    {"word": "and", "start": 1.40, "end": 1.50, "score": 0.7},
    {"word": "seven", "start": 1.55, "end": 1.90, "score": 0.95},
    {"word": "years", "start": 1.95, "end": 2.30, "score": 0.85},
]


def test_records_have_required_fields_and_preserve_display_text():
    words = build_word_records(TRANSCRIPT.tokens, RAW_OK)
    assert [tuple(w) for w in words] == [WORD_FIELDS] * len(words)
    assert [w["idx"] for w in words] == list(range(5))
    assert [w["text"] for w in words] == ["Four", "score,", "and", "seven", "years."]
    assert all(w["aligned"] and w["failure"] is None for w in words)
    assert words[1]["start"] == 0.85 and words[1]["end"] == 1.2 and words[1]["alignment_score"] == 0.8
    assert validate_alignment_doc(make_doc(words), TRANSCRIPT) == []


@pytest.mark.parametrize(
    "raw_word, failure",
    [
        ({"word": "and"}, "missing_timestamps"),
        ({"word": "and", "start": 1.4}, "missing_timestamps"),
        ({"word": "and", "start": float("nan"), "end": 1.5, "score": 0.7}, "missing_timestamps"),
        # WhisperX interpolates timestamps for unalignable words but gives no score
        ({"word": "and", "start": 1.4, "end": 1.5}, "interpolated_timestamps"),
        ({"word": "and", "start": 1.5, "end": 1.5, "score": 0.7}, "invalid_interval"),
    ],
)
def test_alignment_failures_are_explicit_never_zero(raw_word, failure):
    raw = list(RAW_OK)
    raw[2] = raw_word
    words = build_word_records(TRANSCRIPT.tokens, raw)
    w = words[2]
    assert w["aligned"] is False
    assert w["failure"] == failure
    assert w["start"] is None and w["end"] is None
    assert w["duration"] is None and w["alignment_score"] is None
    assert validate_alignment_doc(make_doc(words), TRANSCRIPT) == []


def test_word_count_mismatch_raises():
    with pytest.raises(AlignmentError, match="4 words for 5"):
        build_word_records(TRANSCRIPT.tokens, RAW_OK[:4])


def test_word_text_mismatch_raises():
    raw = list(RAW_OK)
    raw[1] = {**raw[1], "word": "scores"}
    with pytest.raises(AlignmentError, match="expected 'score'"):
        build_word_records(TRANSCRIPT.tokens, raw)


def test_validator_rejects_zero_filled_unaligned_word():
    words = build_word_records(TRANSCRIPT.tokens, RAW_OK)
    words[2].update(aligned=False, failure="missing_timestamps", start=0, end=0, alignment_score=None)
    assert any("must be null" in p for p in validate_alignment_doc(make_doc(words), TRANSCRIPT))


def test_validator_rejects_overlap_out_of_bounds_and_wrong_text():
    words = build_word_records(TRANSCRIPT.tokens, RAW_OK)
    words[3]["start"] = 1.0  # starts before "and" ends
    words[4]["end"] = 99.0
    words[0]["text"] = "Five"
    problems = validate_alignment_doc(make_doc(words, duration=10.0), TRANSCRIPT)
    assert any("before previous word" in p for p in problems)
    assert any("ends after audio" in p for p in problems)
    assert any("does not match transcript" in p for p in problems)


def test_validator_rejects_missing_field_and_length_mismatch():
    words = build_word_records(TRANSCRIPT.tokens, RAW_OK)
    del words[0]["alignment_score"]
    problems = validate_alignment_doc(make_doc(words[:4]), TRANSCRIPT)
    assert any("4 words" in p for p in problems)
    assert any("missing fields" in p for p in problems)


def test_quality_pass_on_clean_alignment():
    words = build_word_records(TRANSCRIPT.tokens, RAW_OK)
    q = quality_checks(words, TRANSCRIPT, 3.0, QC, asr_text="Four score and seven years.")
    assert q["status"] == "pass", q
    assert q["aligned_ratio"] == 1.0 and q["sequence_matches_transcript"]
    assert q["leading_silence"] == 0.5 and q["trailing_silence"] == 0.7
    assert q["asr"]["wer"] == 0.0 and all(w["asr_matched"] for w in words)


def test_quality_fails_when_too_many_words_unaligned():
    raw = [{"word": r["word"]} if i % 2 else r for i, r in enumerate(RAW_OK)]
    q = quality_checks(build_word_records(TRANSCRIPT.tokens, raw), TRANSCRIPT, 3.0, QC)
    assert q["status"] == "fail"
    assert q["unaligned_idx"] == [1, 3]


def test_quality_warns_on_low_score_short_words_and_script_deviation():
    raw = list(RAW_OK)
    raw[2] = {"word": "and", "start": 1.40, "end": 1.42, "score": 0.0}  # one-frame placement
    words = build_word_records(TRANSCRIPT.tokens, raw)
    q = quality_checks(words, TRANSCRIPT, 3.0, QC, asr_text="four score of seven tears")
    assert q["status"] == "warn"
    assert q["low_score_idx"] == [2] and q["too_short_idx"] == [2]
    assert q["asr"]["unmatched_idx"] == [2, 4]
    assert [w["asr_matched"] for w in words] == [True, True, False, True, False]


def test_config_section_loads():
    cfg = AlignmentConfig.from_yaml("config.yaml")
    assert cfg.language == "en"
    assert 0 < cfg.qc.min_aligned_ratio <= 1
    assert "qc" not in cfg.model_settings()  # QC thresholds must not invalidate the cache


def test_models_are_loaded_once_per_process(monkeypatch):
    """Aligning several takes must reuse models, not accumulate them (OOM with --all)."""
    import sys
    import types

    import numpy as np

    from src import alignment

    loads = {"align": 0, "asr": 0}

    class FakeASR:
        def transcribe(self, audio, batch_size=None, language=None):
            return {"segments": [{"text": " four score"}]}

    def load_align_model(language_code, device, model_name=None):
        loads["align"] += 1
        return object(), {}

    def load_model(*args, **kwargs):
        loads["asr"] += 1
        return FakeASR()

    fake = types.SimpleNamespace(
        load_align_model=load_align_model,
        load_model=load_model,
        align=lambda segments, *a, **k: {"word_segments": [{"word": w} for w in segments[0]["text"].split()]},
    )
    monkeypatch.setitem(sys.modules, "whisperx", fake)
    alignment._align_model.cache_clear()
    alignment._asr_model.cache_clear()
    try:
        cfg = AlignmentConfig()
        audio = np.zeros(16000, dtype="float32")
        for _ in range(6):
            alignment.run_forced_alignment(audio, TRANSCRIPT, cfg)
            assert alignment.run_asr(audio, cfg) == "four score"
        assert loads == {"align": 1, "asr": 1}
    finally:
        alignment._align_model.cache_clear()
        alignment._asr_model.cache_clear()


CACHED = Path("results/alignments/speech_01/good_01.json")


@pytest.mark.skipif(not CACHED.exists(), reason="run scripts/align_one.py first")
def test_cached_good_01_alignment_matches_transcript():
    doc = load_alignment(CACHED)
    transcript = load_transcript("dataset/speech_01/transcript.txt")
    assert validate_alignment_doc(doc, transcript) == []
    assert [w["text"] for w in doc["words"]] == [t.text for t in transcript.tokens]
    assert doc["transcript"]["sha256"] == transcript.sha256
    assert doc["quality"]["sequence_matches_transcript"]
    assert doc["quality"]["status"] != "fail"
