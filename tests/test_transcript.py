from src.transcript import (
    load_transcript,
    match_reference_words,
    normalize_word,
    tokenize,
    word_error_rate,
)


def test_normalize_word_strips_punctuation_and_case():
    assert normalize_word("Liberty,") == "liberty"
    assert normalize_word("equal.") == "equal"
    assert normalize_word("“What,") == "what"
    assert normalize_word("brass-fronted") == "brassfronted"
    assert normalize_word("nation’s") == "nation's"
    assert normalize_word("fathers'") == "fathers"
    assert normalize_word("—") == ""


def test_tokenize_keeps_original_text_and_offsets():
    text = "Four score, and seven.\n\nNow we"
    tokens = tokenize(text)
    assert [t.text for t in tokens] == ["Four", "score,", "and", "seven.", "Now", "we"]
    assert [t.norm for t in tokens] == ["four", "score", "and", "seven", "now", "we"]
    assert [t.idx for t in tokens] == list(range(6))
    assert [t.paragraph for t in tokens] == [0, 0, 0, 0, 1, 1]
    for t in tokens:
        assert text[t.char_start:t.char_end] == t.text


def test_tokenize_folds_standalone_punctuation_into_neighbour():
    tokens = tokenize("— Hello — world &")
    assert [t.norm for t in tokens] == ["hello", "world"]
    assert [t.text for t in tokens] == ["— Hello —", "world &"]


def test_canonical_transcripts_tokenize_cleanly():
    for speech in ("speech_01", "speech_02"):
        t = load_transcript(f"dataset/{speech}/transcript.txt")
        assert t.tokens, speech
        assert all(tok.norm for tok in t.tokens)
        assert all(" " not in tok.norm for tok in t.tokens)
        # whitespace splitting of the aligner text must reproduce the tokens 1:1
        assert t.alignment_text.split(" ") == t.norms
        assert " ".join(tok.text for tok in t.tokens) == " ".join(t.text.split())


def test_word_error_rate():
    ref = "a b c d".split()
    assert word_error_rate(ref, ref) == 0.0
    assert word_error_rate(ref, "a x c d".split()) == 0.25
    assert word_error_rate(ref, "a c d".split()) == 0.25
    assert word_error_rate(ref, "a b c d e".split()) == 0.25


def test_match_reference_words_marks_skipped_and_substituted_words():
    ref = "on this continent a new nation".split()
    hyp = "upon this continent new nation".split()
    assert match_reference_words(ref, hyp) == [False, True, True, False, True, True]
