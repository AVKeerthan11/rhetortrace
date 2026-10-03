"""Golden-path regression: the pipeline reproduces the stored artifacts byte for byte.

Legacy path (dataset + demo workflow): baselines, detections, flaws and the dashboard
export are recomputed from the cached alignments / features and must equal the files
in results/ and web/public/ exactly.

These tests read the cached pipeline outputs; the export also needs the frame caches
(*.npz) and the dataset audio, which are git-ignored, so those tests skip without them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.alignment import AlignmentConfig
from src.baseline import BaselineConfig, build_baseline, load_take, reference_takes
from src.detection import DetectionConfig, baseline_for, detect_take
from src.flaws import FlawConfig, score_detection

CONFIG = "config.yaml"
SPEECHES = ("speech_01", "speech_02")
TAKES = [(s, p.name.split(".")[0]) for s in SPEECHES for p in sorted(Path(f"results/flaws/{s}").glob("*.flaws.json"))]


def pretty(doc: dict) -> str:
    """Serialization of results/{baselines,detections,flaws} (indent 2, trailing newline)."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def compact(doc: dict) -> str:
    """Serialization of web/public/data (scripts/build_dashboard.py write_json)."""
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"


@pytest.fixture(scope="module")
def cfgs():
    return {c.__name__: c.from_yaml(CONFIG) for c in (AlignmentConfig, BaselineConfig, DetectionConfig, FlawConfig)}


def have_frame_caches(speech: str, take: str) -> bool:
    feats = Path("results/features") / speech
    return all((feats / f"{take}.{k}.npz").exists() for k in ("pitch", "energy"))


def have_audio(speech: str, take: str) -> bool:
    return (Path("dataset") / speech / "audio" / f"{take}.wav").exists()


def test_takes_present():
    assert len(TAKES) == 8, TAKES


@pytest.mark.parametrize("speech", SPEECHES)
def test_baseline_reproduces(speech, cfgs):
    a, b, d = cfgs["AlignmentConfig"], cfgs["BaselineConfig"], cfgs["DetectionConfig"]
    takes = [load_take(speech, t, b, a) for t in reference_takes(speech, b, a)]
    doc = build_baseline(speech, takes, b, d.z_open)  # z_flag as python -m src.baseline
    assert pretty(doc) == Path(f"results/baselines/{speech}.baseline.json").read_text(encoding="utf-8")


@pytest.mark.parametrize("speech,take", TAKES)
def test_detection_and_flaws_reproduce(speech, take, cfgs):
    a, b, d, f = (cfgs[k] for k in ("AlignmentConfig", "BaselineConfig", "DetectionConfig", "FlawConfig"))
    baseline, source = baseline_for(speech, take, b, a)
    det = detect_take(load_take(speech, take, b, a), baseline, d, source)
    assert pretty(det) == Path(f"results/detections/{speech}/{take}.detection.json").read_text(encoding="utf-8")
    flaws = score_detection(det, f)
    assert pretty(flaws) == Path(f"results/flaws/{speech}/{take}.flaws.json").read_text(encoding="utf-8")


@pytest.mark.parametrize("speech,take", TAKES)
def test_dashboard_export_reproduces(speech, take, tmp_path):
    if not (have_frame_caches(speech, take) and have_audio(speech, take)):
        pytest.skip("frame caches / dataset audio not available")
    from src.export import ExportPaths, export_cfgs, export_take

    paths = ExportPaths(out=tmp_path)
    doc = export_take(speech, take, export_cfgs(CONFIG), paths=paths)
    key = f"{speech}__{take}"
    assert compact(doc) == Path(f"web/public/data/{key}.json").read_text(encoding="utf-8")
    published = Path(f"web/public/audio/{key}.flac")
    if published.exists():
        assert (tmp_path / "audio" / f"{key}.flac").read_bytes() == published.read_bytes()


def test_dashboard_index_reproduces(tmp_path, monkeypatch):
    if not all(have_frame_caches(s, t) and have_audio(s, t) for s, t in TAKES):
        pytest.skip("frame caches / dataset audio not available")
    import scripts.build_dashboard as bd

    monkeypatch.setattr(bd, "OUT", tmp_path)
    assert bd.main([]) == 0
    for p in sorted(Path("web/public/data").glob("*.json")):
        assert (tmp_path / "data" / p.name).read_bytes() == p.read_bytes(), p.name


# ------------------------------------------------- new-recording path (src.pipeline)
# The demo recordings, given to the new path as if uploaded (with the references the dataset
# workflow scores them against: the clean takes other than the demo's source), must give the
# same analysis. Only provenance and the take's role may differ.

DEMOS = {"speech_01": ("good_02", ["good_01", "good_03"]), "speech_02": ("good_03", ["good_01", "good_02"])}
PROVENANCE = {"baseline"}  # detection / flaws: label of the baseline ("leave-one-out:..." vs "references:...")
ROLE = {"kind", "label", "source_take", "ground_truth", "edits", "display", "baseline"}  # take document


def without(doc: dict, keys: set) -> dict:
    return {k: v for k, v in doc.items() if k not in keys}


@pytest.mark.parametrize("speech", sorted(DEMOS))
def test_new_path_reproduces_demo_analysis(speech, tmp_path):
    source, refs = DEMOS[speech]
    data = Path("dataset") / speech
    if not all((data / "audio" / f"{t}.wav").exists() for t in ["synth_01", *refs]):
        pytest.skip("dataset audio not available")
    from src.pipeline import analyze

    res = analyze(data / "audio" / "synth_01.wav", data / "transcript.txt",
                  [data / "audio" / f"{t}.wav" for t in refs], reference_ids=refs, speech_id=speech,
                  take_id="synth_01", runs_dir=tmp_path, config=CONFIG)
    run = Path(res["run_dir"])
    status = json.loads((run / "status.json").read_text(encoding="utf-8"))
    assert status["state"] == "succeeded"
    align = next(s for s in status["stages"] if s["name"] == "align")
    assert set(align["reused"]) == {"synth_01", *refs}, "alignments must come from the cache (no aligner run)"
    from src.pipeline import versions
    assert json.loads((run / "run.json").read_text(encoding="utf-8"))["versions"] == versions()

    def stored(folder: str, kind: str) -> dict:
        return json.loads(Path(f"results/{folder}/{speech}/synth_01.{kind}.json").read_text(encoding="utf-8"))

    new_det = json.loads((run / "detections" / speech / "synth_01.detection.json").read_text(encoding="utf-8"))
    new_flaws = json.loads((run / "flaws" / speech / "synth_01.flaws.json").read_text(encoding="utf-8"))
    for new, old in ((new_det, stored("detections", "detection")), (new_flaws, stored("flaws", "flaws"))):
        assert without(new, PROVENANCE) == without(old, PROVENANCE)
        assert new["baseline"]["path"] == "references:" + ",".join(refs)
        assert old["baseline"]["path"] == f"leave-one-out:{source}"
        assert new["baseline"]["references"] == old["baseline"]["references"] == refs

    key = f"{speech}__synth_01"
    new_doc = json.loads(Path(res["artifact"]).read_text(encoding="utf-8"))
    old_doc = json.loads(Path(f"web/public/data/{key}.json").read_text(encoding="utf-8"))
    qc_extra = {"asr_wer", "unaligned_idx"}
    assert without(new_doc, ROLE | {"qc"}) == without(old_doc, ROLE | {"qc"})
    assert without(new_doc["qc"], qc_extra) == old_doc["qc"]
    assert new_doc["kind"] == "user" and new_doc["ground_truth"] is None
    assert new_doc["baseline"]["references"] == old_doc["baseline"]["references"]
    for t in [key, *(f"{speech}__{r}" for r in refs)]:  # recording and reference audio, as published
        published = Path(f"web/public/audio/{t}.flac")
        if published.exists():
            assert (run / "export" / "audio" / f"{t}.flac").read_bytes() == published.read_bytes()
    index = json.loads((run / "export" / "data" / "index.json").read_text(encoding="utf-8"))
    assert [t["id"] for t in index["takes"]] == [key] and index["validation"] is None
