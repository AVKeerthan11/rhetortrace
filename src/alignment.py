"""Forced alignment of a take against its canonical transcript.

WhisperX's wav2vec2 aligner is run on the *canonical* transcript text, so every
take of a script yields the same word sequence (word i in take A is word i in
take B). Whisper ASR is used only as a quality check (WER, skipped words),
never as the source of the word sequence.

Output: results/alignments/<speech>/<take>.json, see ``build_alignment_doc``.
Words that could not be aligned carry ``aligned: false`` and ``None`` for
start / end / alignment_score; timestamps are never filled with 0.
"""

from __future__ import annotations

import argparse
import functools
import gc
import hashlib
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from importlib import metadata
from pathlib import Path

import numpy as np
import soundfile as sf
import yaml

from src.transcript import Token, Transcript, load_transcript, match_reference_words, normalize_word, word_error_rate

SCHEMA_VERSION = 1
SAMPLE_RATE = 16000
WORD_FIELDS = (
    "idx", "text", "norm", "paragraph", "start", "end", "duration",
    "alignment_score", "aligned", "failure", "asr_matched",
)


class AlignmentError(RuntimeError):
    pass


@dataclass(frozen=True)
class QCThresholds:
    min_aligned_ratio: float = 0.95
    low_score_threshold: float = 0.3
    max_low_score_ratio: float = 0.15
    min_word_duration: float = 0.03
    max_word_duration: float = 2.0
    max_asr_wer: float = 0.20


@dataclass(frozen=True)
class AlignmentConfig:
    asr_model: str = "small"
    align_model: str | None = None  # None = WhisperX default for the language
    language: str = "en"
    device: str = "cpu"
    compute_type: str = "int8"
    batch_size: int = 8
    asr_qc: bool = True
    dataset_dir: str = "dataset"
    output_dir: str = "results/alignments"
    qc: QCThresholds = field(default_factory=QCThresholds)

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "AlignmentConfig":
        with open(path, encoding="utf-8") as f:
            section = dict((yaml.safe_load(f) or {}).get("alignment") or {})
        qc = QCThresholds(**(section.pop("qc", None) or {}))
        return cls(**section, qc=qc)

    def model_settings(self) -> dict:
        """Settings that change the aligned words (part of the cache key).

        QC thresholds are excluded: quality is cheap to recompute from cache.
        """
        settings = asdict(self)
        for key in ("dataset_dir", "output_dir", "batch_size", "qc"):
            settings.pop(key)
        return settings


# --------------------------------------------------------------------------- io


def take_paths(cfg: AlignmentConfig, speech_id: str, take_id: str) -> tuple[Path, Path, Path]:
    speech_dir = Path(cfg.dataset_dir) / speech_id
    return (
        speech_dir / "audio" / f"{take_id}.wav",
        speech_dir / "transcript.txt",
        Path(cfg.output_dir) / speech_id / f"{take_id}.json",
    )


def load_audio(path: str | Path) -> np.ndarray:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    if sample_rate != SAMPLE_RATE:
        raise AlignmentError(f"{path}: expected {SAMPLE_RATE} Hz audio, got {sample_rate} Hz")
    return audio.mean(axis=1) if audio.shape[1] > 1 else audio[:, 0]


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def save_alignment(doc: dict, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


def load_alignment(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------------ whisperx

# Models are loaded once per process and reused across takes. maxsize=1 keeps
# at most one instance of each, so changing settings replaces, not accumulates.


@functools.lru_cache(maxsize=1)
def _align_model(language: str, device: str, model_name: str | None):
    import whisperx

    return whisperx.load_align_model(language_code=language, device=device, model_name=model_name)


@functools.lru_cache(maxsize=1)
def _asr_model(model_name: str, device: str, compute_type: str, language: str):
    import whisperx

    return whisperx.load_model(model_name, device=device, compute_type=compute_type, language=language)


def run_forced_alignment(audio: np.ndarray, transcript: Transcript, cfg: AlignmentConfig) -> list[dict]:
    """Align the canonical transcript to the audio; returns WhisperX word dicts.

    The whole take is aligned as one segment so the CTC path is solved globally.
    The normalized text is used because WhisperX maps characters outside the
    model dictionary (punctuation) to wildcard tokens that consume frames.
    """
    import whisperx

    model, model_meta = _align_model(cfg.language, cfg.device, cfg.align_model)
    segment = {"text": transcript.alignment_text, "start": 0.0, "end": len(audio) / SAMPLE_RATE}
    result = whisperx.align([segment], model, model_meta, audio, cfg.device, return_char_alignments=False)
    return result["word_segments"]


def run_asr(audio: np.ndarray, cfg: AlignmentConfig) -> str:
    model = _asr_model(cfg.asr_model, cfg.device, cfg.compute_type, cfg.language)
    result = model.transcribe(audio, batch_size=cfg.batch_size, language=cfg.language)
    return " ".join(seg["text"].strip() for seg in result["segments"]).strip()


# ------------------------------------------------------- mapping & quality


def _finite(value) -> float | None:
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def build_word_records(tokens: tuple[Token, ...] | list[Token], raw_words: list[dict]) -> list[dict]:
    """Map WhisperX word dicts 1:1 onto canonical tokens.

    A word counts as aligned only if WhisperX produced start, end and score
    from its own characters. WhisperX interpolates timestamps for words without
    alignable characters but gives them no score; those are reported as failed.
    """
    if len(raw_words) != len(tokens):
        raise AlignmentError(f"Aligner returned {len(raw_words)} words for {len(tokens)} transcript tokens")

    records = []
    for token, raw in zip(tokens, raw_words):
        if normalize_word(raw.get("word", "")) != token.norm:
            raise AlignmentError(f"Word {token.idx}: aligner returned {raw.get('word')!r}, expected {token.norm!r}")

        start, end, score = _finite(raw.get("start")), _finite(raw.get("end")), _finite(raw.get("score"))
        if start is None or end is None:
            failure = "missing_timestamps"
        elif score is None:
            failure = "interpolated_timestamps"
        elif end <= start:
            failure = "invalid_interval"
        else:
            failure = None

        aligned = failure is None
        records.append({
            "idx": token.idx,
            "text": token.text,
            "norm": token.norm,
            "paragraph": token.paragraph,
            "start": round(start, 3) if aligned else None,
            "end": round(end, 3) if aligned else None,
            "duration": round(end - start, 3) if aligned else None,
            "alignment_score": round(score, 3) if aligned else None,
            "aligned": aligned,
            "failure": failure,
            "asr_matched": None,
        })
    return records


def quality_checks(
    words: list[dict],
    transcript: Transcript,
    audio_duration: float,
    qc: QCThresholds,
    asr_text: str | None = None,
) -> dict:
    """Summarize alignment quality; status is "pass", "warn" or "fail"."""
    errors, warnings = [], []
    n = len(words)
    aligned = [w for w in words if w["aligned"]]
    scores = [w["alignment_score"] for w in aligned]

    sequence_matches = [w["norm"] for w in words] == transcript.norms
    if not sequence_matches:
        errors.append("word sequence differs from transcript")

    aligned_ratio = len(aligned) / n if n else 0.0
    if aligned_ratio < qc.min_aligned_ratio:
        errors.append(f"aligned ratio {aligned_ratio:.3f} < {qc.min_aligned_ratio}")

    overlaps = [b["idx"] for a, b in zip(aligned, aligned[1:]) if b["start"] < a["end"] - 1e-3]
    out_of_bounds = [w["idx"] for w in aligned if w["start"] < 0 or w["end"] > audio_duration + 1e-3]
    if overlaps:
        errors.append(f"{len(overlaps)} non-monotonic word(s): {overlaps[:10]}")
    if out_of_bounds:
        errors.append(f"{len(out_of_bounds)} word(s) outside audio bounds: {out_of_bounds[:10]}")

    low_score = [w["idx"] for w in aligned if w["alignment_score"] < qc.low_score_threshold]
    too_short = [w["idx"] for w in aligned if w["duration"] < qc.min_word_duration]
    too_long = [w["idx"] for w in aligned if w["duration"] > qc.max_word_duration]
    low_score_ratio = len(low_score) / n if n else 0.0
    if low_score_ratio > qc.max_low_score_ratio:
        warnings.append(f"low-score ratio {low_score_ratio:.3f} > {qc.max_low_score_ratio}")
    if too_short:
        warnings.append(f"{len(too_short)} word(s) shorter than {qc.min_word_duration}s: {too_short[:10]}")
    if too_long:
        warnings.append(f"{len(too_long)} word(s) longer than {qc.max_word_duration}s: {too_long[:10]}")
    unaligned = [w["idx"] for w in words if not w["aligned"]]
    if unaligned and aligned_ratio >= qc.min_aligned_ratio:
        warnings.append(f"{len(unaligned)} unaligned word(s): {unaligned[:10]}")

    asr = None
    if asr_text is not None:
        hyp = [t for t in (normalize_word(w) for w in asr_text.split()) if t]
        wer = word_error_rate(transcript.norms, hyp)
        asr_matched = match_reference_words(transcript.norms, hyp)
        for w, m in zip(words, asr_matched):
            w["asr_matched"] = m
        unmatched = [i for i, m in enumerate(asr_matched) if not m]
        asr = {"text": asr_text, "wer": round(wer, 4), "n_unmatched": len(unmatched), "unmatched_idx": unmatched}
        if wer > qc.max_asr_wer:
            warnings.append(f"ASR WER {wer:.3f} > {qc.max_asr_wer}: take may not follow the script")

    return {
        "status": "fail" if errors else "warn" if warnings else "pass",
        "errors": errors,
        "warnings": warnings,
        "n_words": n,
        "n_aligned": len(aligned),
        "aligned_ratio": round(aligned_ratio, 4),
        "sequence_matches_transcript": sequence_matches,
        "mean_alignment_score": round(float(np.mean(scores)), 4) if scores else None,
        "min_alignment_score": round(float(np.min(scores)), 4) if scores else None,
        "n_low_score": len(low_score),
        "n_non_monotonic": len(overlaps),
        "n_out_of_bounds": len(out_of_bounds),
        "n_too_short": len(too_short),
        "n_too_long": len(too_long),
        "unaligned_idx": unaligned,
        "low_score_idx": low_score,
        "too_short_idx": too_short,
        "too_long_idx": too_long,
        "leading_silence": round(aligned[0]["start"], 3) if aligned else None,
        "trailing_silence": round(audio_duration - aligned[-1]["end"], 3) if aligned else None,
        "asr": asr,
    }


def validate_alignment_doc(doc: dict, transcript: Transcript) -> list[str]:
    """Check an alignment document against the data contract; returns violations."""
    problems = []
    if doc.get("schema_version") != SCHEMA_VERSION:
        problems.append(f"schema_version {doc.get('schema_version')!r} != {SCHEMA_VERSION}")
    words = doc.get("words")
    if not isinstance(words, list):
        return problems + ["missing 'words' list"]
    if len(words) != len(transcript.tokens):
        problems.append(f"{len(words)} words but transcript has {len(transcript.tokens)} tokens")
    duration = doc.get("audio", {}).get("duration")

    prev_end = None
    for i, (w, tok) in enumerate(zip(words, transcript.tokens)):
        missing = [k for k in WORD_FIELDS if k not in w]
        if missing:
            problems.append(f"word {i}: missing fields {missing}")
            continue
        if w["idx"] != i:
            problems.append(f"word {i}: idx is {w['idx']}")
        if w["text"] != tok.text or w["norm"] != tok.norm:
            problems.append(f"word {i}: {w['text']!r} does not match transcript token {tok.text!r}")
        timing = (w["start"], w["end"], w["alignment_score"])
        if w["aligned"]:
            if any(not isinstance(v, (int, float)) for v in timing):
                problems.append(f"word {i}: aligned but has non-numeric timing {timing}")
                continue
            if not 0 <= w["start"] < w["end"]:
                problems.append(f"word {i}: invalid interval [{w['start']}, {w['end']}]")
            if duration is not None and w["end"] > duration + 1e-3:
                problems.append(f"word {i}: ends after audio ({w['end']} > {duration})")
            if prev_end is not None and w["start"] < prev_end - 1e-3:
                problems.append(f"word {i}: starts before previous word ends")
            if w["failure"] is not None:
                problems.append(f"word {i}: aligned but failure={w['failure']!r}")
            prev_end = w["end"]
        else:
            if any(v is not None for v in timing):
                problems.append(f"word {i}: unaligned but has timing {timing} (must be null)")
            if not w["failure"]:
                problems.append(f"word {i}: unaligned without failure reason")
    return problems


# ---------------------------------------------------------------- pipeline


def build_alignment_doc(speech_id: str, take_id: str, cfg: AlignmentConfig, force: bool = False) -> dict:
    """Align one take (or return the cached result if inputs are unchanged)."""
    audio_path, transcript_path, out_path = take_paths(cfg, speech_id, take_id)
    transcript = load_transcript(transcript_path)
    audio_sha = sha256_file(audio_path)

    whisperx_version = metadata.version("whisperx")
    cache_key = hashlib.sha256(json.dumps({
        "schema_version": SCHEMA_VERSION,
        "audio_sha256": audio_sha,
        "transcript_sha256": transcript.sha256,
        "settings": cfg.model_settings(),
        "whisperx": whisperx_version,
    }, sort_keys=True).encode()).hexdigest()

    cached = load_alignment(out_path) if out_path.exists() and not force else None
    if cached is not None and cached.get("cache_key") == cache_key:
        # Reuse the expensive model outputs; re-run only the quality checks.
        words = cached["words"]
        duration = cached["audio"]["duration"]
        asr_text = (cached["quality"].get("asr") or {}).get("text")
    else:
        audio = load_audio(audio_path)
        duration = round(len(audio) / SAMPLE_RATE, 3)
        words = build_word_records(transcript.tokens, run_forced_alignment(audio, transcript, cfg))
        asr_text = run_asr(audio, cfg) if cfg.asr_qc else None
    quality = quality_checks(words, transcript, duration, cfg.qc, asr_text)

    doc = {
        "schema_version": SCHEMA_VERSION,
        "cache_key": cache_key,
        "speech_id": speech_id,
        "take_id": take_id,
        "audio": {"path": audio_path.as_posix(), "sha256": audio_sha,
                  "sample_rate": SAMPLE_RATE, "duration": duration},
        "transcript": {"path": transcript_path.as_posix(), "sha256": transcript.sha256,
                       "n_words": len(transcript.tokens)},
        "settings": {**cfg.model_settings(), "whisperx": whisperx_version, "qc": asdict(cfg.qc)},
        "quality": quality,
        "words": words,
    }
    problems = validate_alignment_doc(doc, transcript)
    if problems:
        raise AlignmentError("Alignment violates data contract:\n  " + "\n  ".join(problems))
    if doc != cached:
        save_alignment(doc, out_path)
    return doc


def _print_doc(doc: dict, show_words: bool) -> None:
    q = doc["quality"]
    print(f"\n{doc['speech_id']}/{doc['take_id']}: {q['status'].upper()}  "
          f"aligned {q['n_aligned']}/{q['n_words']}  mean score {q['mean_alignment_score']}  "
          f"ASR WER {q['asr']['wer'] if q['asr'] else 'n/a'}")
    for msg in q["errors"]:
        print(f"  ERROR: {msg}")
    for msg in q["warnings"]:
        print(f"  WARN:  {msg}")
    if show_words:
        for w in doc["words"]:
            if w["aligned"]:
                print(f"  {w['idx']:4d} {w['text']:20s} {w['start']:7.3f} -> {w['end']:7.3f}  score {w['alignment_score']:.3f}")
            else:
                print(f"  {w['idx']:4d} {w['text']:20s}    UNALIGNED ({w['failure']})")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Force-align takes against their canonical transcript.")
    parser.add_argument("--speech", default="speech_01")
    parser.add_argument("--take", default="good_01")
    parser.add_argument("--all", action="store_true", help="align every take of every speech in the dataset")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--force", action="store_true", help="ignore cached alignments")
    parser.add_argument("--no-asr-qc", action="store_true", help="skip the Whisper ASR quality check")
    parser.add_argument("--quiet", action="store_true", help="do not print the word table")
    args = parser.parse_args(argv)

    cfg = AlignmentConfig.from_yaml(args.config)
    if args.no_asr_qc:
        cfg = AlignmentConfig(**{**asdict(cfg), "asr_qc": False, "qc": cfg.qc})

    if args.all:
        jobs = [(p.parent.parent.name, p.stem) for p in sorted(Path(cfg.dataset_dir).glob("*/audio/*.wav"))]
    else:
        jobs = [(args.speech, args.take)]

    failed = 0
    for speech_id, take_id in jobs:
        doc = build_alignment_doc(speech_id, take_id, cfg, force=args.force)
        _print_doc(doc, show_words=not args.quiet)
        failed += doc["quality"]["status"] == "fail"
        gc.collect()  # release per-take audio/emission tensors before the next take
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
