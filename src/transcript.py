"""Canonical transcript loading, tokenization and word-sequence matching.

The canonical transcript (dataset/<speech>/transcript.txt) defines the word
sequence for every take of a script. Each token keeps its original surface
form for display and a normalized form used for alignment and matching.
"""

from __future__ import annotations

import difflib
import hashlib
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})
_NON_WORD_CHARS = re.compile(r"[^a-z0-9']+")
_PARAGRAPH_BREAK = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Token:
    idx: int
    text: str  # original surface form incl. punctuation, for display
    norm: str  # lowercase [a-z0-9'] form used for alignment and matching
    paragraph: int
    char_start: int  # offsets into Transcript.text
    char_end: int


@dataclass(frozen=True)
class Transcript:
    path: str
    text: str
    sha256: str
    tokens: tuple[Token, ...]

    @property
    def norms(self) -> list[str]:
        return [t.norm for t in self.tokens]

    @property
    def alignment_text(self) -> str:
        """Space-joined normalized words, the text handed to the forced aligner."""
        return " ".join(self.norms)


def normalize_word(word: str) -> str:
    """Lowercase, unify apostrophes and drop everything except [a-z0-9'].

    Hyphenated words collapse into one token ("brass-fronted" -> "brassfronted")
    so that whitespace splitting stays the single source of word boundaries.
    """
    w = unicodedata.normalize("NFKC", word).translate(_APOSTROPHES).lower()
    return _NON_WORD_CHARS.sub("", w).strip("'")


def tokenize(text: str) -> list[Token]:
    """Split text into tokens on whitespace.

    Pieces that normalize to nothing (a free-standing dash, "&", ...) are not
    words: they are folded into the display text of the neighbouring token.
    """
    tokens: list[Token] = []
    pending_start: int | None = None  # punctuation seen before the first word

    paragraph_starts = [0] + [m.end() for m in _PARAGRAPH_BREAK.finditer(text)]

    def paragraph_of(offset: int) -> int:
        return sum(1 for p in paragraph_starts if p <= offset) - 1

    for match in re.finditer(r"\S+", text):
        start, end = match.span()
        norm = normalize_word(match.group())
        if not norm:
            if tokens:
                prev = tokens[-1]
                tokens[-1] = Token(
                    prev.idx, text[prev.char_start:end], prev.norm,
                    prev.paragraph, prev.char_start, end,
                )
            elif pending_start is None:
                pending_start = start
            continue
        if pending_start is not None:
            start, pending_start = pending_start, None
        tokens.append(Token(len(tokens), text[start:end], norm, paragraph_of(match.start()), start, end))
    return tokens


def load_transcript(path: str | Path) -> Transcript:
    path = Path(path)
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n").strip()
    tokens = tokenize(text)
    if not tokens:
        raise ValueError(f"Transcript {path} contains no words")
    return Transcript(
        path=path.as_posix(),
        text=text,
        sha256=hashlib.sha256(raw).hexdigest(),
        tokens=tuple(tokens),
    )


def word_error_rate(reference: list[str], hypothesis: list[str]) -> float:
    """Word-level Levenshtein distance divided by the reference length."""
    if not reference:
        return 0.0 if not hypothesis else 1.0
    prev = list(range(len(hypothesis) + 1))
    for i, ref_word in enumerate(reference, 1):
        curr = [i] + [0] * len(hypothesis)
        for j, hyp_word in enumerate(hypothesis, 1):
            curr[j] = min(
                prev[j] + 1,  # deletion
                curr[j - 1] + 1,  # insertion
                prev[j - 1] + (ref_word != hyp_word),  # substitution
            )
        prev = curr
    return prev[-1] / len(reference)


def match_reference_words(reference: list[str], hypothesis: list[str]) -> list[bool]:
    """For each reference word, whether it appears in the hypothesis in order."""
    matched = [False] * len(reference)
    matcher = difflib.SequenceMatcher(None, reference, hypothesis, autojunk=False)
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            matched[block.a + k] = True
    return matched
