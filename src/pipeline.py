"""End-to-end analysis of a new recording against reference recordings of the same transcript.

    analyze(audio, transcript, references=[ref1, ref2])      # uploaded references
    analyze(audio, references_from="speech_01")              # a dataset script's good takes

Composes the existing stage functions; it adds no analysis of its own. The
detection methodology, thresholds and stage outputs are those of the dataset
workflow (tests/test_golden_path.py checks that this path reproduces the demo
analysis exactly). Stages, in order:

  ingest     audio -> 16 kHz mono WAV, transcript copied (src.ingest); ids,
             duplicate and reference-count checks
  align      forced alignment of every recording (src.alignment). Alignments
             with the same cache key (audio bytes, transcript bytes, model
             settings, WhisperX version) are reused from ``alignment_cache_dirs``.
             Gates: alignment QC status "fail" -> AlignmentQCError; ASR WER above
             alignment.qc.max_asr_wer -> OffScriptError (analysis.fail_on_off_script).
             The WER stop cannot be bypassed by turning the ASR check off: with
             fail_on_off_script and alignment.asr_qc false the request is refused
             (ConfigError) before anything runs.
  features   pitch, energy (needs pitch), rate, pause, spectral (src.features)
  baseline   from exactly the given references (src.detection.baseline_for)
  detection  src.detection.detect_take
  flaws      refinement, severity, explanations (src.flaws.score_detection)
  export     take document + index entry + audio for the frontend (src.export)

Every analysis is one self-contained folder ``<runs_dir>/<run_id>/`` with the
dataset layout inside (input/, alignments/, features/, baselines/, detections/,
flaws/, export/), plus
  run.json     request, input provenance and code / schema versions (deterministic)
  status.json  state, current stage, per-stage timings, warnings, error
The default run id is derived from the input hashes, ids and config, so the same
request maps to the same folder and produces identical artifacts.
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field, replace
from importlib import metadata
from pathlib import Path

import yaml

from src import alignment as alignment_mod
from src import baseline as baseline_mod
from src import detection as detection_mod
from src import flaws as flaws_mod
from src.alignment import (AlignmentConfig, AlignmentError, alignment_cache_key, build_alignment_doc,
                           load_alignment, sha256_file, take_paths)
from src.baseline import BaselineConfig, load_take, reference_takes, save_baseline
from src.detection import DetectionConfig, baseline_for, detect_take, save_detection
from src.errors import (AlignmentQCError, ConfigError, InputError, OffScriptError, PipelineError,
                        ReferencesError, RhetorTraceError, TranscriptError)
from src.export import ExportPaths, export_take, index_entry, upsert_index, write_json
from src.features import energy, pause, pitch, rate, spectral
from src.flaws import FlawConfig, save_flaws, score_detection
from src.ingest import IngestConfig, ingest_audio, ingest_transcript, sha256_bytes
from src.scoring import ScoringConfig
from src.transcript import load_transcript

SCHEMA_VERSION = 1
STAGES = ("ingest", "align", "features", "baseline", "detection", "flaws", "export")
ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,47}$")  # file names and "<speech>__<take>" keys
FEATURE_STAGES = ((pitch, pitch.PitchConfig), (energy, energy.EnergyConfig), (rate, rate.RateConfig),
                  (pause, pause.PauseConfig), (spectral, spectral.SpectralConfig))


@dataclass(frozen=True)
class AnalysisConfig:
    runs_dir: str = "runs"
    fail_on_off_script: bool = True
    alignment_cache_dirs: tuple[str, ...] = ("results/alignments",)
    low_memory: bool = True  # aligner and Whisper each in a short-lived process (src.alignment isolate_models)

    @classmethod
    def from_yaml(cls, path: str | Path = "config.yaml") -> "AnalysisConfig":
        with open(path, encoding="utf-8") as f:
            section = dict((yaml.safe_load(f) or {}).get("analysis") or {})
        if "alignment_cache_dirs" in section:
            section["alignment_cache_dirs"] = tuple(section["alignment_cache_dirs"] or ())
        return cls(**section)


@dataclass(frozen=True)
class Recording:
    id: str
    path: Path
    name: str
    role: str  # "recording" | "reference"


# ------------------------------------------------------------------- status


@dataclass
class RunStatus:
    """status.json, rewritten atomically after every change (a reader never sees half a file)."""

    path: Path
    doc: dict = field(default_factory=dict)
    _t0: float = 0.0

    def __post_init__(self):
        self.doc = {"schema_version": SCHEMA_VERSION, "run_id": self.path.parent.name, "state": "running",
                    "stage": None, "stages": [{"name": s, "state": "pending", "seconds": None} for s in STAGES],
                    "warnings": [], "error": None, "result": None}
        self._write()

    def _write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    def _stage(self, name):
        return next(s for s in self.doc["stages"] if s["name"] == name)

    def start(self, name: str):
        self.doc["stage"] = name
        self._stage(name)["state"] = "running"
        self._t0 = time.perf_counter()
        self._write()

    def done(self, name: str, **info):
        s = self._stage(name)
        s.update(state="done", seconds=round(time.perf_counter() - self._t0, 2), **info)
        self._write()

    def warn(self, messages: list[str]):
        self.doc["warnings"].extend(m for m in messages if m not in self.doc["warnings"])
        self._write()

    def fail(self, err: RhetorTraceError):
        if self.doc["stage"]:
            self._stage(self.doc["stage"])["state"] = "failed"
        self.doc.update(state="failed", error=err.to_dict())
        self._write()

    def succeed(self, result: dict):
        self.doc.update(state="succeeded", stage=None, result=result)
        self._write()


# ------------------------------------------------------------------ helpers


def check_id(value: str, what: str) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise InputError(f"{what} {value!r} is not a valid id: use 1-48 lowercase letters, digits, '-' or '_' "
                         "(no '__')", stage="ingest")
    return value


def versions() -> dict:
    """Schema version of every stage's artifacts and the aligner version (run.json provenance)."""
    return {"pipeline": SCHEMA_VERSION, "alignment": alignment_mod.SCHEMA_VERSION,
            "features": {m.__name__.rsplit(".", 1)[1]: m.SCHEMA_VERSION for m, _ in FEATURE_STAGES},
            "baseline": baseline_mod.SCHEMA_VERSION, "detection": detection_mod.SCHEMA_VERSION,
            "flaws": flaws_mod.SCHEMA_VERSION, "whisperx": metadata.version("whisperx")}


def check_off_script_config(align_cfg: AlignmentConfig, fail_on_off_script: bool) -> None:
    """The off-script stop needs the ASR check; refuse rather than silently skip it."""
    if fail_on_off_script and not align_cfg.asr_qc:
        raise ConfigError("the off-script stop (analysis.fail_on_off_script) needs the ASR quality check, but "
                          "alignment.asr_qc is false; enable it, or disable the stop explicitly",
                          stage="align", detail={"asr_qc": False, "fail_on_off_script": True})


def default_run_id(parts: dict) -> str:
    return "run-" + hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]


def alignment_gate(doc: dict, rec: Recording, align_cfg: AlignmentConfig, fail_on_off_script: bool) -> list[str]:
    """Stop on an unusable alignment or an off-script reading; returns warnings to surface."""
    q = doc["quality"]
    if q["status"] == "fail":
        raise AlignmentQCError(f"{rec.name}: the transcript could not be aligned to this recording "
                               f"({'; '.join(q['errors'])})", stage="align",
                               detail={"input": rec.id, "role": rec.role, "errors": q["errors"],
                                       "aligned_ratio": q["aligned_ratio"]})
    warnings = [f"{rec.name}: {w}" for w in q["warnings"]]
    asr = q.get("asr")
    if asr is None:
        if fail_on_off_script:
            raise ConfigError(f"{rec.name}: the alignment has no ASR result, so the off-script check cannot run; "
                              "enable alignment.asr_qc", stage="align", detail={"input": rec.id, "role": rec.role})
        warnings.append(f"{rec.name}: off-script check skipped (ASR quality check is disabled)")
    elif asr["wer"] > align_cfg.qc.max_asr_wer and fail_on_off_script:
        words = [doc["words"][i]["text"] for i in asr["unmatched_idx"][:12]]
        raise OffScriptError(
            f"{rec.name} does not follow the transcript: {asr['wer']:.0%} of the words differ from what was "
            f"heard (limit {align_cfg.qc.max_asr_wer:.0%}). Check that the transcript matches the recording.",
            stage="align", detail={"input": rec.id, "role": rec.role, "wer": asr["wer"],
                                   "max_wer": align_cfg.qc.max_asr_wer, "n_unmatched": asr["n_unmatched"],
                                   "unmatched_words": words})
    return warnings


def seed_alignment(align_cfg: AlignmentConfig, speech_id: str, take_id: str, cache_dirs) -> str | None:
    """Copy a cached alignment with this take's exact cache key into the run (skips the aligner).

    Returns where it came from, or None when the take has to be aligned."""
    audio_path, transcript_path, out_path = take_paths(align_cfg, speech_id, take_id)
    key = alignment_cache_key(sha256_file(audio_path), load_transcript(transcript_path), align_cfg)
    if out_path.exists() and load_alignment(out_path).get("cache_key") == key:
        return "run"
    for d in cache_dirs:
        for p in sorted(Path(d).glob("*/*.json")):
            try:
                hit = load_alignment(p).get("cache_key") == key
            except (OSError, ValueError):
                continue
            if hit:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, out_path)
                return p.as_posix()
    return None


def dataset_references(speech_id: str, config: str | Path) -> tuple[list[Recording], Path]:
    """The good takes of a dataset script (its cached baseline's convention) and its transcript."""
    align_cfg, base_cfg = AlignmentConfig.from_yaml(config), BaselineConfig.from_yaml(config)
    speech_dir = Path(align_cfg.dataset_dir) / speech_id
    if not (speech_dir / "transcript.txt").exists():
        raise ReferencesError(f"unknown script {speech_id!r}: {speech_dir.as_posix()}/transcript.txt not found",
                              stage="ingest")
    takes = reference_takes(speech_id, base_cfg, align_cfg)
    recs = [Recording(t, speech_dir / "audio" / f"{t}.wav", f"{speech_id} {t.replace('_', ' ')}", "reference")
            for t in takes]
    missing = [r.path.as_posix() for r in recs if not r.path.exists()]
    if missing or not recs:
        raise ReferencesError(f"{speech_id}: reference audio not available", stage="ingest",
                              detail={"missing": missing})
    return recs, speech_dir / "transcript.txt"


# ----------------------------------------------------------------- pipeline


def analyze(audio: str | Path, transcript: str | Path | None = None, references=(), *,
            references_from: str | None = None, speech_id: str | None = None, take_id: str = "recording",
            reference_ids: list[str] | None = None, name: str | None = None,
            reference_names: list[str] | None = None, run_id: str | None = None,
            runs_dir: str | Path | None = None, config: str | Path = "config.yaml",
            fail_on_off_script: bool | None = None) -> dict:
    """Analyse one recording; returns the result summary (also in status.json).

    Raises a RhetorTraceError subclass (see src.errors) on failure, after recording
    it in status.json when the run folder exists."""
    acfg = AnalysisConfig.from_yaml(config)
    off_script_stops = acfg.fail_on_off_script if fail_on_off_script is None else fail_on_off_script
    audio = Path(audio)

    # ---------------------------------------------------- request -> recordings
    if references_from and references:
        raise InputError("give either reference recordings or references_from, not both", stage="ingest")
    canonical = None
    if references_from:
        speech_id = check_id(speech_id or references_from, "script id")
        refs, canonical = dataset_references(references_from, config)
        if transcript is None:
            transcript = canonical
    else:
        speech_id = check_id(speech_id or "script", "script id")
        ids = reference_ids or [f"ref_{i + 1:02d}" for i in range(len(references))]
        names = reference_names or [Path(p).name for p in references]
        if len(ids) != len(references) or len(names) != len(references):
            raise InputError("one id and one name per reference recording", stage="ingest")
        refs = [Recording(check_id(i, "reference id"), Path(p), n, "reference") for i, p, n in zip(ids, references, names)]
    if transcript is None:
        raise TranscriptError("a transcript is required", stage="ingest")
    rec = Recording(check_id(take_id, "recording id"), audio, name or audio.name, "recording")
    if rec.id in {r.id for r in refs} or len({r.id for r in refs}) != len(refs):
        raise InputError("recording and reference ids must all be different", stage="ingest")
    check_off_script_config(AlignmentConfig.from_yaml(config), off_script_stops)
    base_cfg = BaselineConfig.from_yaml(config)
    if len(refs) < base_cfg.min_refs:
        raise ReferencesError(f"{len(refs)} reference recording(s) given; at least {base_cfg.min_refs} are needed",
                              stage="ingest", detail={"min_refs": base_cfg.min_refs})
    for r in [rec, *refs]:
        if not r.path.is_file():
            raise InputError(f"{r.name}: file not found", stage="ingest", detail={"path": r.path.as_posix()})
    if not Path(transcript).is_file():
        raise TranscriptError(f"{Path(transcript).name}: transcript file not found", stage="ingest")

    config_sha = sha256_bytes(config)
    run_id = check_id(run_id, "run id") if run_id else default_run_id({
        "recording": [rec.id, sha256_bytes(rec.path)], "speech_id": speech_id,
        "references": [[r.id, sha256_bytes(r.path)] for r in refs], "transcript": sha256_bytes(transcript),
        "references_from": references_from, "config": config_sha, "fail_on_off_script": off_script_stops})
    run = Path(runs_dir or acfg.runs_dir) / run_id
    status = RunStatus(run / "status.json")

    stage = "ingest"
    try:
        # ------------------------------------------------------------- ingest
        status.start(stage)
        icfg = IngestConfig.from_yaml(config)
        inp = run / "input" / speech_id
        if canonical is not None and Path(transcript).resolve() != canonical.resolve():
            given = load_transcript(transcript)  # must be the script's words; the canonical file is used
            script = load_transcript(canonical)
            if given.norms != script.norms:
                k = next((i for i, (a, b) in enumerate(zip(given.norms, script.norms)) if a != b), None)
                where = (f"at word {k + 1}" if k is not None else
                         f"in length ({len(given.norms)} words, the script has {len(script.norms)})")
                k = min(len(given.norms), len(script.norms)) if k is None else k
                raise TranscriptError(f"the transcript differs from {references_from}'s script {where}",
                                      stage="ingest", detail={"word": k, "given": given.norms[k:k + 5],
                                                              "script": script.norms[k:k + 5]})
            transcript = canonical
        script = ingest_transcript(transcript, inp / "transcript.txt", icfg)
        info = {r.id: ingest_audio(r.path, inp / "audio" / f"{r.id}.wav", icfg, r.name) for r in [rec, *refs]}
        by_sha = {}
        for r in [rec, *refs]:
            if info[r.id]["sha256"] in by_sha:
                other = by_sha[info[r.id]["sha256"]]
                raise ReferencesError(f"{r.name} is the same audio as {other.name}", stage="ingest",
                                      detail={"inputs": [other.id, r.id]})
            by_sha[info[r.id]["sha256"]] = r
        status.warn([w for i in info.values() for w in i["warnings"]])
        write_json(run / "run.json", {
            "schema_version": SCHEMA_VERSION, "run_id": run_id, "speech_id": speech_id, "take_id": rec.id,
            "name": rec.name, "references": [{"id": r.id, "name": r.name} for r in refs],
            "references_from": references_from, "transcript_sha256": script.sha256, "n_words": len(script.tokens),
            "inputs": info, "config_sha256": config_sha, "fail_on_off_script": off_script_stops,
            "versions": versions()})
        status.done(stage, converted=[k for k, v in info.items() if v["converted"]])

        # -------------------------------------------------------------- align
        stage = "align"
        status.start(stage)
        align_cfg = replace(AlignmentConfig.from_yaml(config), dataset_dir=str(run / "input"),
                            output_dir=str(run / "alignments"))
        reused = {}
        for r in [rec, *refs]:
            reused[r.id] = seed_alignment(align_cfg, speech_id, r.id, acfg.alignment_cache_dirs)
            try:
                doc = build_alignment_doc(speech_id, r.id, align_cfg, isolate_models=acfg.low_memory)
            except AlignmentError as e:
                raise AlignmentQCError(f"{r.name}: alignment failed ({e})", stage=stage,
                                       detail={"input": r.id, "role": r.role}) from e
            status.warn(alignment_gate(doc, r, align_cfg, off_script_stops))
            gc.collect()  # release per-take audio / emission tensors before the next take (as src.alignment --all)
        status.done(stage, reused={k: v for k, v in reused.items() if v})

        # ----------------------------------------------------------- features
        stage = "features"
        status.start(stage)
        feats = run / "features"
        for r in [rec, *refs]:
            for module, cfg_cls in FEATURE_STAGES:
                module.extract_take(speech_id, r.id, replace(cfg_cls.from_yaml(config), output_dir=str(feats)), align_cfg)
        status.done(stage)

        # ----------------------------------------------------------- baseline
        stage = "baseline"
        status.start(stage)
        bcfg = replace(base_cfg, features_dir=str(feats), output_dir=str(run / "baselines"))
        baseline, source = baseline_for(speech_id, rec.id, bcfg, align_cfg, references=[r.id for r in refs])
        save_baseline(baseline, bcfg)
        status.done(stage, references=[x["take_id"] for x in baseline["references"]])

        # ---------------------------------------------------------- detection
        stage = "detection"
        status.start(stage)
        dcfg = replace(DetectionConfig.from_yaml(config), output_dir=str(run / "detections"))
        detection = detect_take(load_take(speech_id, rec.id, bcfg, align_cfg), baseline, dcfg, source)
        save_detection(detection, dcfg)
        status.done(stage, n_regions=detection["summary"]["n_regions"])

        # -------------------------------------------------------------- flaws
        stage = "flaws"
        status.start(stage)
        fcfg = replace(FlawConfig.from_yaml(config), output_dir=str(run / "flaws"))
        flaws = score_detection(detection, fcfg)
        save_flaws(flaws, fcfg)
        status.done(stage, n_flaws=flaws["summary"]["n_flaws"])

        # ------------------------------------------------------------- export
        stage = "export"
        status.start(stage)
        out = run / "export"
        cfgs = {"align": align_cfg, "base": bcfg, "scoring": ScoringConfig.from_yaml(config)}
        display = {"recording": rec.name, "references": {r.id: r.name for r in refs}}
        doc = export_take(speech_id, rec.id, cfgs, kind="user", label=rec.name, display=display,
                          baseline=baseline, export_reference_audio=True,
                          paths=ExportPaths(out=out, detections=run / "detections", flaws=run / "flaws"))
        artifact = out / "data" / f"{doc['id']}.json"
        write_json(artifact, doc)
        upsert_index(out / "data" / "index.json", index_entry(doc))
        status.done(stage)
    except RhetorTraceError as e:
        e.stage = e.stage or stage
        status.fail(e)
        raise
    except Exception as e:  # unexpected: keep the cause, report it in the same shape
        err = PipelineError(f"{type(e).__name__}: {e}", stage=stage, detail={"type": type(e).__name__})
        status.fail(err)
        raise err from e

    result = {"run_id": run_id, "run_dir": run.as_posix(), "id": doc["id"], "artifact": artifact.as_posix(),
              "index": (out / "data" / "index.json").as_posix(), "n_flaws": len(doc["flaws"]),
              "score": doc["score"]["total"], "warnings": status.doc["warnings"]}
    status.succeed(result)
    return result
