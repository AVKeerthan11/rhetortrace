"""Deterministic explanations: every category/direction, evidence fidelity, missing data."""

import copy
import json
import math
from dataclasses import replace

import pytest

from src.detection import SCORED_FEATURES
from src.explain import DISPLAY, explain_track, measurement
from src.flaws import FlawConfig, refine_track, save_flaws, score_detection
from tests.test_detection import AMP_BASELINE, CONTROL, SENT_END, detect, flattened, with_values

CFG = FlawConfig()


def drop(db):
    return dict(energy_rel_db=lambda v: v - db, energy_peak_rel_db=lambda v: v - db)


def run(take, baseline=None):
    det = detect(take) if baseline is None else detect(take, baseline)
    return det, score_detection(det, CFG)


def only_flaw(take, baseline=None):
    det, doc = run(take, baseline)
    (f,) = doc["flaws"]
    return det, f


def spectral_shift(take, idx, octaves):
    take = copy.deepcopy(take)
    for i in idx:
        take["spectral"]["words"][i]["centroid_rel_oct"] += octaves
    return take


def removed_pause():
    take = with_values(CONTROL, [SENT_END], pause_after_s=lambda v: 0.03)
    take["pause"]["words"][SENT_END]["is_pause_after"] = False
    return take


def assert_faithful(m, det):
    """A measurement equals the detection document's stored deviation, in display units."""
    d = det["words"][m["idx"]]["features"][m["feature"]]
    assert m["word"] == det["words"][m["idx"]]["text"]
    assert m["z"] == d["z"] and m["stored"] == {"value": d["value"], "median": d["median"], "scale": d["scale"]}
    _, _, _, how, comparison = DISPLAY[m["feature"]]
    if how == "vector":
        assert m["observed"] is None and m["reference"] is None and m["change"] is None
        return
    show = {"exp": math.exp, "exp10": lambda v: 10 ** v, "identity": float}[how]
    nd = 4 if m["feature"] == "log_flatness" else 3
    assert m["observed"] == round(show(d["value"]), nd)
    assert m["reference"] == round(show(d["median"]), nd)
    expected = show(d["value"]) / show(d["median"]) if comparison == "ratio" else show(d["value"]) - show(d["median"])
    assert m["change"] == round(expected, 2)
    assert f"z = {d['z']:+.2f}" in m["statement"]


def assert_explanation_faithful(flaw, det):
    e = flaw["explanation"]
    assert (e["category"], e["direction"]) == (flaw["category"], flaw["direction"])
    assert e["severity"] == {k: flaw["severity"][k] for k in ("level", "label", "score")}
    assert e["time"] == {"start": flaw["start"], "end": flaw["end"], "duration_s": flaw["duration_s"]}
    assert e["word_range"] == [flaw["start_idx"], flaw["end_idx"]] and e["words"] == flaw["words"]
    assert e["confidence"]["value"] == flaw["confidence"]
    assert [q["flag"] for q in e["quality_flags"]] == flaw["flags"]
    for m in [e["strongest_evidence"], *e["supporting_evidence"]]:
        assert_faithful(m, det)
        assert flaw["start_idx"] <= m["idx"] <= flaw["end_idx"]
    zs = [abs(m["z"]) for m in [e["strongest_evidence"], *e["supporting_evidence"]]]
    assert zs == sorted(zs, reverse=True) and len(e["supporting_evidence"]) <= 3
    # the flaw's strongest evidence and the explanation's agree
    s = flaw["strongest_evidence"]
    assert (s["idx"], s["feature"], s["z"]) == (e["strongest_evidence"]["idx"], e["strongest_evidence"]["feature"],
                                                e["strongest_evidence"]["z"])
    assert e["strongest_evidence"]["statement"] in e["summary"]
    assert f"Severity: {flaw['severity']['label']}" in e["summary"]


# ------------------------------------------------------ every category/direction


@pytest.mark.parametrize("take, baseline, category, direction, headline", [
    (with_values(CONTROL, range(11, 17), duration_s=lambda v: v * 0.6, local_articulation_rate_wps=lambda v: v / 0.6),
     None, "pacing", "fast", "Faster speech rate"),
    (with_values(CONTROL, range(11, 17), duration_s=lambda v: v * 2.0, local_articulation_rate_wps=lambda v: v / 2.0),
     None, "pacing", "slow", "Slower speech rate"),
    (flattened(0.0), AMP_BASELINE, "pitch", "flatter", "Flatter, reduced pitch variation"),
    (with_values(CONTROL, range(10, 18), f0_median_st=lambda v: 3 * v if v else 6.0, f0_range_st=lambda v: 6.0),
     None, "pitch", "livelier", "More pitch variation"),
    (with_values(CONTROL, [14], pause_after_s=lambda v: 1.2), None, "pause", "long", "Excessive pause"),
    (removed_pause(), None, "pause", "short", "Pause removed"),
    (with_values(CONTROL, range(4, 9), **drop(8)), None, "energy", "quiet", "Quieter, lower energy"),
    (with_values(CONTROL, range(4, 9), **drop(-8)), None, "energy", "loud", "Louder, higher energy"),
    (spectral_shift(CONTROL, range(4, 9), 0.6), None, "clarity", None, "Spectral / articulation deviation"),
])
def test_category_explanations(take, baseline, category, direction, headline):
    det, f = only_flaw(take, baseline)
    assert (f["category"], f["direction"]) == (category, direction)
    e = f["explanation"]
    assert e["headline"].startswith(headline) and e["summary"].startswith(headline)
    assert_explanation_faithful(f, det)
    if direction is not None and category != "pitch":
        for m in [e["strongest_evidence"], *e["supporting_evidence"]]:
            _, pos, neg = SCORED_FEATURES[m["feature"]]
            assert (pos if m["z"] > 0 else neg) == direction  # evidence agrees with the flaw's direction


def test_pause_measurement_units_and_note():
    det, f = only_flaw(with_values(CONTROL, [14], pause_after_s=lambda v: 1.2))
    m = f["explanation"]["strongest_evidence"]
    assert (m["feature"], m["unit"], m["observed"]) == ("pause_after_s", "s", 1.2)
    assert m["change"] == round(1.2 - m["reference"], 2) and "clipped" in m["note"]


def test_shortened_but_present_pause_is_not_called_removed():
    det, f = only_flaw(with_values(CONTROL, [SENT_END], pause_after_s=lambda v: 0.2))
    assert f["direction"] == "short"
    assert f["explanation"]["headline"].startswith("Pause shortened")


def test_mfcc_measurement_has_no_invented_values():
    det = detect(spectral_shift(CONTROL, range(4, 9), 0.6))
    word = det["words"][5]
    m = measurement(word, "mfcc")
    assert m["observed"] is None and m["reference"] is None and m["change"] is None
    assert f"RMS z = {word['features']['mfcc']['z']:+.2f}" in m["statement"]


# ------------------------------------------------------- missing / low confidence


def test_unavailable_evidence_is_listed_not_filled():
    det = detect(with_values(CONTROL, range(4, 12), **drop(8)))
    for i in (6, 7, 8):
        for name in ("energy_rel_db", "energy_peak_rel_db"):
            det["words"][i]["features"][name].update(z=None, status="low_confidence", reason="silent")
        det["words"][i]["categories"]["energy"] = None
    track = {**det["regions"][0]["tracks"][0], "start_idx": 4, "end_idx": 11}
    t = refine_track(det["words"], track, replace(CFG, trim_z={"default": 0.0}))
    e = explain_track(t, det["words"])
    assert {u["feature"]: u["reasons"] for u in e["unavailable_evidence"]} == {
        "energy_rel_db": {"low_confidence:silent": 3}, "energy_peak_rel_db": {"low_confidence:silent": 3}}
    assert all(m["idx"] not in (6, 7, 8) for m in [e["strongest_evidence"], *e["supporting_evidence"]])
    assert "near_unreliable_evidence" in [q["flag"] for q in e["quality_flags"]]


def test_no_reliable_evidence_says_so():
    det = detect(with_values(CONTROL, range(4, 9), **drop(8)))
    for w in det["words"][4:9]:
        for name in ("energy_rel_db", "energy_peak_rel_db"):
            w["features"][name].update(z=None, status="missing", reason="unaligned")
        w["categories"]["energy"] = None
    t = refine_track(det["words"], det["regions"][0]["tracks"][0], CFG)
    e = explain_track(t, det["words"])
    assert e["strongest_evidence"] is None and e["supporting_evidence"] == []
    assert "no reliable measurement available" in e["summary"]
    assert e["severity"]["score"] == 0.0 and e["confidence"]["label"] == "low"
    # nothing to anchor on: refinement keeps one word, and that word's values are listed as missing
    assert all(u["reasons"] == {"missing:unaligned": t["n_words"]} for u in e["unavailable_evidence"])
    assert {u["feature"] for u in e["unavailable_evidence"]} == {"energy_rel_db", "energy_peak_rel_db"}


def test_silent_word_level_is_an_upper_bound():
    take = with_values(CONTROL, range(4, 9), **drop(10))
    for w in take["energy"]["words"][4:9]:
        w["energy_status"] = "silent"
    det, f = only_flaw(take)
    m = f["explanation"]["strongest_evidence"]
    assert m["bound"] == "upper" and "at most" in m["statement"]
    assert_faithful(m, det)


# ------------------------------------------------------------- secondary


def test_secondary_categories_are_explained_and_listed():
    take = with_values(CONTROL, range(11, 16), **drop(8))
    take = with_values(take, range(11, 17), duration_s=lambda v: v * 3.0, local_articulation_rate_wps=lambda v: v / 3.0)
    det, f = only_flaw(take)
    assert f["category"] == "pacing"
    (sec,) = f["secondary"]
    assert sec["explanation"]["category"] == "energy" and sec["explanation"]["direction"] == "quiet"
    assert_explanation_faithful(sec, det)
    (co,) = f["explanation"]["co_occurring"]
    assert co["severity"] == sec["explanation"]["severity"] and co["word_range"] == [sec["start_idx"], sec["end_idx"]]
    assert "Overlaps with: quieter, lower energy" in f["explanation"]["summary"]
    assert "co_occurring" not in sec["explanation"]


# ------------------------------------------------------------- determinism


def test_byte_identical_output(tmp_path):
    take = with_values(CONTROL, range(4, 9), **drop(8))
    a = score_detection(detect(take), CFG)
    b = score_detection(detect(copy.deepcopy(take)), CFG)
    cfg = replace(CFG, output_dir=str(tmp_path))
    first = save_flaws(a, cfg).read_bytes()
    assert save_flaws(b, cfg).read_bytes() == first
    assert json.dumps(a["flaws"][0]["explanation"], sort_keys=True) == \
        json.dumps(b["flaws"][0]["explanation"], sort_keys=True)
