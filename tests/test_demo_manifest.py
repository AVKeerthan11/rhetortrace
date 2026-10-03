"""Demo-take manifest schema: one canonical, complete manifest (regression: KeyError 'ground_truth')."""

import json
from pathlib import Path

import pytest

from scripts.build_dashboard import demo_manifest_for
from scripts.build_demo import ground_truth
from src.demo import DEMO_DIR, REQUIRED, ManifestError, load_manifest, manifest_path, validate, write_manifest

EDIT = {"kind": "long_pause", "word_range": [1, 1], "original": [0.5, 0.6], "params": {"inserted_s": 1.0}}
TRUTH = {"kind": "long_pause", "category": "pause", "direction": "long", "start_idx": 1, "end_idx": 1,
         "start": 0.5, "end": 1.6}


def manifest(**over):
    doc = {"schema_version": 1, "speech_id": "s", "take_id": "synth_01", "label": "synthetic audio injection",
           "source_take": "good_02", "source_audio_sha256": "a" * 64, "audio_sha256": "b" * 64,
           "edits": [EDIT], "ground_truth": [TRUTH]}
    doc.update(over)
    return doc


def test_partial_manifest_without_ground_truth_is_a_clear_error(tmp_path):
    # the exact failure: a manifest persisted before ground truth existed
    partial = manifest()
    del partial["ground_truth"]
    path = manifest_path("s", "synth_01", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(partial), encoding="utf-8")
    with pytest.raises(ManifestError, match="ground_truth"):
        load_manifest("s", "synth_01", tmp_path)
    with pytest.raises(ManifestError, match="ground_truth"):  # the exporter does not swallow it
        demo_manifest_for("s", "synth_01", ["good_01", "good_02", "good_03"], tmp_path)


def test_writer_refuses_incomplete_manifests_and_writes_atomically(tmp_path):
    partial = manifest()
    del partial["ground_truth"]
    with pytest.raises(ManifestError):
        write_manifest(partial, tmp_path)
    assert not manifest_path("s", "synth_01", tmp_path).exists()
    path = write_manifest(manifest(), tmp_path)
    assert load_manifest("s", "synth_01", tmp_path) == manifest()
    assert not list(path.parent.glob("*.tmp"))


@pytest.mark.parametrize("bad, msg", [
    (manifest(ground_truth=[]), "1 edits but 0"),
    (manifest(ground_truth=[{k: v for k, v in TRUTH.items() if k != "start"}]), "lacks \\['start'\\]"),
    (manifest(edits=[{k: v for k, v in EDIT.items() if k != "word_range"}]), "lacks \\['word_range'\\]"),
    (manifest(schema_version=99), "schema_version"),
])
def test_validation_rejects_malformed_entries(bad, msg):
    with pytest.raises(ManifestError, match=msg):
        validate(bad)


def test_exporter_classifies_control_and_demo_takes(tmp_path):
    refs = ["good_01", "good_02", "good_03"]
    write_manifest(manifest(), tmp_path)
    assert demo_manifest_for("s", "good_01", refs, tmp_path) is None  # control
    demo = demo_manifest_for("s", "synth_01", refs, tmp_path)
    assert demo["ground_truth"] == [TRUTH] and demo["edits"] == [EDIT]
    with pytest.raises(ManifestError, match="no demo manifest"):  # never silently a "control"
        demo_manifest_for("s", "synth_02", refs, tmp_path)
    write_manifest(manifest(take_id="good_03"), tmp_path)
    with pytest.raises(ManifestError, match="reference take"):
        demo_manifest_for("s", "good_03", refs, tmp_path)


def test_ground_truth_uses_the_edited_alignment():
    words = [{"start": 0.0, "end": 0.4}, {"start": 0.5, "end": 0.9}, {"start": 1.9, "end": 2.2},
             {"start": 2.3, "end": 2.6}]
    recs = [{"kind": "long_pause", "word_range": [1, 1]}, {"kind": "fast", "word_range": [2, 3]}]
    gt = ground_truth(recs, words)
    assert (gt[0]["start"], gt[0]["end"], gt[0]["category"], gt[0]["direction"]) == (0.9, 1.9, "pause", "long")
    assert (gt[1]["start"], gt[1]["end"], gt[1]["category"], gt[1]["direction"]) == (1.9, 2.6, "pacing", "fast")
    assert set(gt[0]) == set(TRUTH)


def test_manifests_on_disk_are_complete():
    paths = sorted(Path(DEMO_DIR).glob("*/*.json"))
    if not paths:
        pytest.skip("no demo manifests built")
    for p in paths:
        doc = validate(json.loads(p.read_text(encoding="utf-8")), p.as_posix())
        assert set(REQUIRED) <= set(doc) and doc["ground_truth"]


def test_demo_audio_edits_are_deterministic():
    # regression: Praat's overlap-add lengthening used an unseeded random generator, so every
    # build_demo run produced different audio (and different alignments / flaws)
    import numpy as np
    from scripts.build_demo import flatten_pitch, lengthen
    t = np.arange(16000) / 16000
    x = 0.1 * np.sin(2 * np.pi * (120 + 20 * t) * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))
    for f in (0.67, 1.5):
        a, b = lengthen(x, f), lengthen(x, f)
        assert np.array_equal(a, b) and abs(len(a) / 16000 - f) < 0.01
    assert np.array_equal(flatten_pitch(x), flatten_pitch(x))
