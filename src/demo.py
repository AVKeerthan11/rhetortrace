"""Canonical schema of synthetic demo-take manifests (results/demo/<speech>/<take>.json).

Written once, complete, by scripts/build_demo.py; read by src.detection
(``source_take``: left out of the baseline) and scripts/build_dashboard.py
(label, edits, ground truth). Reads and writes are validated, and writes are
atomic, so a consumer never sees a partial manifest.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEMO_DIR = Path("results/demo")
SCHEMA_VERSION = 1
REQUIRED = ("schema_version", "speech_id", "take_id", "label", "source_take", "source_audio_sha256",
            "audio_sha256", "edits", "ground_truth")
EDIT_KEYS = ("kind", "word_range", "original", "params")
TRUTH_KEYS = ("kind", "category", "direction", "start_idx", "end_idx", "start", "end")


class ManifestError(ValueError):
    pass


def manifest_path(speech_id: str, take_id: str, root: str | Path = DEMO_DIR) -> Path:
    return Path(root) / speech_id / f"{take_id}.json"


def validate(doc: dict, where: str = "manifest") -> dict:
    missing = [k for k in REQUIRED if k not in doc]
    if missing:
        raise ManifestError(f"{where}: missing {missing}; rebuild it with python scripts/build_demo.py")
    if doc["schema_version"] != SCHEMA_VERSION:
        raise ManifestError(f"{where}: schema_version {doc['schema_version']} != {SCHEMA_VERSION}")
    for i, e in enumerate(doc["edits"]):
        if any(k not in e for k in EDIT_KEYS):
            raise ManifestError(f"{where}: edit {i} lacks {[k for k in EDIT_KEYS if k not in e]}")
    for i, g in enumerate(doc["ground_truth"]):
        if any(k not in g for k in TRUTH_KEYS):
            raise ManifestError(f"{where}: ground_truth {i} lacks {[k for k in TRUTH_KEYS if k not in g]}")
    if len(doc["ground_truth"]) != len(doc["edits"]):
        raise ManifestError(f"{where}: {len(doc['edits'])} edits but {len(doc['ground_truth'])} ground-truth spans")
    return doc


def load_manifest(speech_id: str, take_id: str, root: str | Path = DEMO_DIR) -> dict | None:
    """The validated manifest of a demo take, or None if the take has none."""
    path = manifest_path(speech_id, take_id, root)
    if not path.exists():
        return None
    return validate(json.loads(path.read_text(encoding="utf-8")), path.as_posix())


def write_manifest(doc: dict, root: str | Path = DEMO_DIR) -> Path:
    """Validate, then write atomically (temp file + replace)."""
    path = manifest_path(doc["speech_id"], doc["take_id"], root)
    validate(doc, path.as_posix())
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
    return path


def remove_manifest(speech_id: str, take_id: str, root: str | Path = DEMO_DIR) -> None:
    manifest_path(speech_id, take_id, root).unlink(missing_ok=True)
