"""Typed errors of the analysis pipeline.

Every error a caller can act on carries a stable machine-readable ``code``, the
pipeline ``stage`` it came from, a human-readable ``message`` and optional
``detail`` (JSON-serializable). ``to_dict()`` is what the CLI prints and what a
service returns. Codes are grouped by who must act:

  input        the request is unusable (fix the files / ids and resubmit)
  refused      the inputs are valid files but the analysis would be misleading
               (alignment failed, recording does not follow the transcript)
  stale        cached artifacts no longer match their inputs or were written by
               another schema version (re-run a stage)
  config       the server / CLI configuration is inconsistent (fix config.yaml)
  internal     anything unexpected (a bug, a missing dependency, a model process
               that crashed or ran out of memory)
"""

from __future__ import annotations


class RhetorTraceError(Exception):
    code = "error"
    kind = "internal"

    def __init__(self, message: str, *, stage: str | None = None, detail: dict | None = None):
        super().__init__(message)
        self.message = message
        self.stage = stage
        self.detail = detail or {}

    def to_dict(self) -> dict:
        return {"code": self.code, "kind": self.kind, "stage": self.stage, "message": self.message,
                "detail": self.detail}


# --------------------------------------------------------------------- input


class InputError(RhetorTraceError):
    code = "invalid_input"
    kind = "input"


class AudioError(InputError):
    code = "invalid_audio"


class TranscriptError(InputError):
    code = "invalid_transcript"


class ReferencesError(InputError):
    code = "invalid_references"


# ------------------------------------------------------------------- refused


class AlignmentQCError(RhetorTraceError):
    code = "alignment_failed"
    kind = "refused"


class OffScriptError(RhetorTraceError):
    code = "off_script"
    kind = "refused"


# --------------------------------------------------------------------- stale


class StaleArtifactError(RhetorTraceError, RuntimeError):
    """Also a RuntimeError: the feature extractors already raise RuntimeError for stale caches."""

    code = "stale_artifact"
    kind = "stale"


def require_schema(doc: dict, version: int, what: str, stage: str | None = None) -> dict:
    """Raise StaleArtifactError unless a cached ``doc`` has the current ``schema_version``."""
    found = doc.get("schema_version")
    if found != version:
        raise StaleArtifactError(f"{what} was written with schema version {found!r}, this code reads version "
                                 f"{version}; re-run that stage", stage=stage,
                                 detail={"artifact": what, "found": found, "expected": version})
    return doc


# -------------------------------------------------------------------- config


class ConfigError(RhetorTraceError):
    code = "invalid_config"
    kind = "config"


# ------------------------------------------------------------------ internal


class PipelineError(RhetorTraceError):
    code = "internal_error"
    kind = "internal"


class ModelWorkerError(PipelineError, RuntimeError):
    """A model process (src.model_worker) failed: crash, missing model, out of memory."""

    code = "model_failed"
