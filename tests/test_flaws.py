"""Temporal refinement and severity scoring on synthetic detections."""

import copy
import json
from dataclasses import replace

import pytest

from src.flaws import FlawConfig, refine_span, refine_track, save_flaws, score_detection, severity
from tests.test_detection import AMP_BASELINE, CONTROL, SENT_END, detect, flattened, with_values

CFG = FlawConfig()


def drop(db):
    return dict(energy_rel_db=lambda v: v - db, energy_peak_rel_db=lambda v: v - db)


def flaws_of(take, baseline=None, cfg=CFG):
    doc = detect(take) if baseline is None else detect(take, baseline)
    return score_detection(doc, cfg)


# --------------------------------------------------------------- refinement


def test_refine_span_trims_weak_edges_and_extends_strong_neighbours():
    scores = [0.0, 3.5, 1.0, 4.0, 5.0, 1.5, None, 0.0]
    assert refine_span(scores, 2, 6, CFG) == (3, 4)  # trim 2 (weak) and 5, 6 (weak, missing)
    assert refine_span(scores, 6, 6, CFG) == (6, 6)  # never empty
    assert refine_span(scores, 2, 5, CFG, trim_z=0.0) == (1, 5)  # trimming off (pitch): 2 kept, 1 added
    strong = [0.0, 3.5, 4.0, 5.0, 3.2, 0.0]
    assert refine_span(strong, 2, 3, CFG) == (1, 4)  # strong neighbours added
    # extension uses word-level evidence when given (span evidence excluded)
    assert refine_span(strong, 2, 3, CFG, local=[0.0] * 6) == (2, 3)


def test_word_region_boundaries_and_quality_fields():
    doc = flaws_of(with_values(CONTROL, range(4, 9), **drop(8)))
    (f,) = doc["flaws"]
    words = detect(with_values(CONTROL, range(4, 9), **drop(8)))["words"]
    assert (f["category"], f["direction"]) == ("energy", "quiet")
    assert (f["start_idx"], f["end_idx"], f["n_words"]) == (4, 8, 5)
    assert (f["start"], f["end"]) == (words[4]["start"], words[8]["end"])
    assert f["duration_s"] == pytest.approx(words[8]["end"] - words[4]["start"], abs=1e-3)
    # uncertainty = half the adjacent gap (40 ms gaps -> 20 ms), capped at boundary_refinement_ms
    assert (f["start_uncertainty_s"], f["end_uncertainty_s"]) == (0.02, 0.02)
    assert f["word_coverage"] == 1.0 and f["confidence"] == 1.0 and f["flags"] == []
    ev = f["strongest_evidence"]
    assert ev["feature"] in ("energy_rel_db", "energy_peak_rel_db") and ev["z"] < -3 and 4 <= ev["idx"] <= 8
    assert f["boundary"]["detected_start_idx"] == 4 and f["boundary"]["trimmed_words"] == 0


def test_pause_flaw_is_the_gap_itself():
    take = with_values(CONTROL, [14], pause_after_s=lambda v: 1.2)
    words = detect(take)["words"]
    (f,) = flaws_of(take)["flaws"]
    assert (f["category"], f["direction"]) == ("pause", "long")
    assert (f["start"], f["end"]) == (words[14]["end"], words[15]["start"])
    # injections change feature values, not timestamps: the gap is the aligned one
    assert f["duration_s"] == pytest.approx(words[15]["start"] - words[14]["end"], abs=1e-3)
    assert f["boundary"]["detected_start"] == words[14]["start"]  # the detector reported the word, not the gap
    assert "single_word" not in f["flags"]


def test_uncertainty_is_capped():
    cfg = replace(CFG, boundary_refinement_ms=10)
    (f,) = flaws_of(with_values(CONTROL, range(4, 9), **drop(8)), cfg=cfg)["flaws"]
    assert (f["start_uncertainty_s"], f["end_uncertainty_s"]) == (0.01, 0.01)


def test_category_and_direction_are_preserved():
    take = with_values(CONTROL, range(11, 17), duration_s=lambda v: v * 0.6,
                       local_articulation_rate_wps=lambda v: v / 0.6)
    det = detect(take)
    doc = score_detection(det, CFG)
    for f, r in zip(doc["flaws"], det["regions"]):
        assert (f["category"], f["direction"]) == (r["dominant_category"], r["direction"])


def test_secondary_tracks_are_refined_and_scored():
    take = with_values(CONTROL, range(11, 16), **drop(8))
    take = with_values(take, range(11, 17), duration_s=lambda v: v * 3.0, local_articulation_rate_wps=lambda v: v / 3.0)
    (f,) = flaws_of(take)["flaws"]
    assert f["category"] == "pacing"
    (sec,) = f["secondary"]
    assert sec["category"] == "energy" and sec["severity"]["score"] > 0


# ------------------------------------------------------------------ severity


def test_severity_is_monotone_in_injected_magnitude():
    scores = []
    for db in (4, 6, 8, 12, 20):
        fl = flaws_of(with_values(CONTROL, range(4, 9), **drop(db)))["flaws"]
        scores.append(fl[0]["severity"] if fl else {"score": 0.0, "level": 0})
    assert [s["score"] for s in scores] == sorted(s["score"] for s in scores)
    assert [s["level"] for s in scores] == sorted(s["level"] for s in scores)
    assert scores[-1]["label"] == "severe" and scores[0]["level"] < scores[-1]["level"]

    pitch = [flaws_of(flattened(k), AMP_BASELINE)["flaws"] for k in (0.4, 0.2, 0.0)]
    pitch = [p[0]["severity"]["score"] for p in pitch]
    assert pitch == sorted(pitch) and pitch[0] < pitch[-1]


def test_severity_scale_and_levels():
    assert severity([2.0, 2.0, 2.0], 0, 2, "energy", CFG)["score"] == 0.0  # at z_min
    assert severity([8.0, 8.0, 8.0], 0, 2, "energy", CFG)["score"] == 1.0  # at z_max
    s = severity([5.0, 5.0, 5.0], 0, 2, "energy", CFG)
    assert s["score"] == 0.5 and s["level"] == 3 and s["label"] == "strong"
    # pitch/flatter has its own ceiling, other pitch directions use the default
    assert severity([5.0] * 3, 0, 2, "pitch", CFG, "flatter")["score"] == 1.0
    assert severity([5.0] * 3, 0, 2, "pitch", CFG, "livelier")["score"] == 0.5


def test_single_spike_does_not_drive_severity():
    spike = severity([2.5, 2.5, 30.0, 2.5, 2.5], 0, 4, "energy", CFG)
    assert spike["evidence_z"] == 2.5 and spike["peak_z"] == 30.0
    # but extending a region over weaker edges does not lower the score either
    core = severity([6.0, 6.0, 6.0], 0, 2, "energy", CFG)
    wide = severity([2.5, 6.0, 6.0, 6.0, 2.5], 0, 4, "energy", CFG)
    assert wide["score"] == core["score"]


def test_missing_and_low_confidence_evidence_does_not_inflate():
    full = severity([6.0, 6.0, 6.0], 0, 2, "energy", CFG)
    thin = severity([None, None, 6.0], 0, 2, "energy", CFG)  # 2 of 3 words without usable evidence
    assert thin["n_evidence_words"] == 1 and thin["support"] == pytest.approx(1 / 3, abs=1e-3)
    assert thin["score"] < full["score"]
    empty = severity([None, None, None], 0, 2, "energy", CFG)
    assert empty["score"] == 0.0 and empty["label"] == "negligible"
    # a pause is one boundary: one usable word is full support
    assert severity([6.0], 0, 0, "pause", CFG)["support"] == 1.0


def test_missing_values_inside_a_detected_region_are_flagged():
    det = detect(with_values(CONTROL, range(4, 12), **drop(8)))
    for i in (6, 7, 8, 9, 10):  # most of the region loses its energy evidence
        for name in ("energy_rel_db", "energy_peak_rel_db"):
            det["words"][i]["features"][name].update(z=None, status="low_confidence")
        det["words"][i]["categories"]["energy"] = None
    full = score_detection(detect(with_values(CONTROL, range(4, 12), **drop(8))), CFG)["flaws"][0]
    track = {**det["regions"][0]["tracks"][0], "start_idx": 4, "end_idx": 11}
    f = refine_track(det["words"], track, replace(CFG, trim_z={"default": 0.0}))
    assert f["severity"]["n_evidence_words"] == 3 and f["word_coverage"] == pytest.approx(3 / 8, abs=1e-3)
    assert {"low_coverage", "near_unreliable_evidence"} <= set(f["flags"])
    assert f["confidence"] < 1.0 and f["severity"]["score"] <= full["severity"]["score"]


def test_short_vs_long_regions():
    det = detect(with_values(CONTROL, range(4, 9), **drop(8)))
    words = det["words"]
    track = det["regions"][0]["tracks"][0]
    fixed = replace(CFG, extend_z=99.0)  # keep the given spans
    short = refine_track(words, {**track, "start_idx": 6, "end_idx": 6}, fixed)
    long = refine_track(words, track, fixed)
    assert short["n_words"] == 1 and "single_word" in short["flags"] and "thin_evidence" in short["flags"]
    assert short["severity"]["support"] == pytest.approx(1 / 3, abs=1e-3)
    assert short["severity"]["score"] < long["severity"]["score"]
    assert long["duration_s"] > short["duration_s"]


# ------------------------------------------------------------- determinism


def test_deterministic_output(tmp_path):
    det = detect(with_values(CONTROL, range(4, 9), **drop(8)))
    a, b = score_detection(det, CFG), score_detection(copy.deepcopy(det), CFG)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    cfg = replace(CFG, output_dir=str(tmp_path))
    first = save_flaws(a, cfg).read_bytes()
    assert save_flaws(b, cfg).read_bytes() == first
    assert a["summary"]["n_flaws"] == 1 and a["summary"]["by_level"][a["flaws"][0]["severity"]["label"]] == 1


def test_control_take_has_no_flaws():
    doc = flaws_of(CONTROL)
    assert doc["flaws"] == [] and doc["summary"]["max_score"] == 0.0


def test_config_from_yaml_matches_defaults():
    assert FlawConfig.from_yaml() == CFG


def test_missing_pause_flaw():
    (f,) = flaws_of(with_values(CONTROL, [SENT_END], pause_after_s=lambda v: 0.03))["flaws"]
    assert (f["category"], f["direction"]) == ("pause", "short")
    words = detect(with_values(CONTROL, [SENT_END], pause_after_s=lambda v: 0.03))["words"]
    assert (f["start"], f["end"]) == (words[SENT_END]["end"], words[SENT_END + 1]["start"])
