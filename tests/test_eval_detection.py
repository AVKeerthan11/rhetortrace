"""The injection / control evaluation script on synthetic references."""

import copy
import json

import pytest

from scripts.eval_detection import KINDS, evaluate, inject, injection_sites
from src.detection import DetectionConfig
from tests.test_detection import BASELINE, CONTROL, SENT_END


def test_injection_sites_are_deterministic_and_valid():
    for kind in KINDS:
        sites = injection_sites(CONTROL, kind)
        assert sites == injection_sites(copy.deepcopy(CONTROL), kind)
        assert all(0 <= a <= b < len(CONTROL["alignment"]["words"]) for a, b in sites)
    assert injection_sites(CONTROL, "missing_pause") == [(SENT_END, SENT_END)]  # the only sentence pause
    assert all(a == b and a != SENT_END for a, b in injection_sites(CONTROL, "long_pause"))


def test_inject_changes_only_the_span():
    out = inject(CONTROL, "quiet", 4, 6)
    before = [w["energy_rel_db"] for w in CONTROL["energy"]["words"]]
    after = [w["energy_rel_db"] for w in out["energy"]["words"]]
    assert [round(a - b, 6) for a, b in zip(after, before)] == [0] * 4 + [-6.0] * 3 + [0] * 13
    assert CONTROL["energy"]["words"][4]["energy_rel_db"] == before[4]  # input untouched


def test_evaluate_clean_control_and_injections():
    cases = [{"speech_id": "s", "take_id": "test", "take": CONTROL, "baseline": BASELINE}]
    rep = evaluate(cases, DetectionConfig())
    assert rep["controls"]["fp_word_rate"] == 0.0
    i = rep["injections"]
    assert i["n_unscorable"] == 0
    for kind in ("fast", "slow", "quiet", "long_pause", "missing_pause"):
        assert i["by_kind"][kind]["attributable"] == i["by_kind"][kind]["n"], kind
    assert json.dumps(evaluate(cases, DetectionConfig()), sort_keys=True) == json.dumps(rep, sort_keys=True)


def test_boundary_metrics_and_truth_spans():
    from scripts.eval_detection import boundary_errors, truth_span
    words = [{"start": 0.0, "end": 0.5}, {"start": 0.6, "end": 1.0}, {"start": 1.5, "end": 2.0}]
    assert truth_span(words, "quiet", 0, 1) == (0.0, 1.0)
    assert truth_span(words, "long_pause", 1, 1) == (1.0, 1.5)  # the gap after word 1
    exact = boundary_errors({"start": 0.0, "end": 1.0, "start_idx": 0, "end_idx": 1}, (0.0, 1.0), 0, 1)
    assert exact == {"start_err_s": 0.0, "end_err_s": 0.0, "iou": 1.0, "word_iou": 1.0}
    late = boundary_errors({"start": 0.6, "end": 2.0, "start_idx": 1, "end_idx": 2}, (0.0, 1.0), 0, 1)
    assert late["start_err_s"] == 0.6 and late["end_err_s"] == 1.0
    assert late["iou"] == 0.2 and late["word_iou"] == round(1 / 3, 3)


def test_injection_strength_scales_and_defaults_to_standard():
    assert inject(CONTROL, "quiet", 4, 4, 2.0)["energy"]["words"][4]["energy_rel_db"] == \
        CONTROL["energy"]["words"][4]["energy_rel_db"] - 12.0
    assert inject(CONTROL, "long_pause", 4, 4)["pause"]["words"][4]["pause_after_s"] == pytest.approx(1.2)


def test_severity_ladder_is_monotone_on_synthetic_take():
    from scripts.eval_detection import severity_ladder
    from src.flaws import FlawConfig
    cases = [{"speech_id": "s", "take_id": "test", "take": CONTROL, "baseline": BASELINE}]
    ladder = severity_ladder(cases, DetectionConfig(), FlawConfig())
    for kind in ("fast", "slow", "quiet", "long_pause"):
        assert ladder[kind]["monotone_sites"] == ladder[kind]["n_sites"], kind
        assert ladder[kind]["mean_score"] == sorted(ladder[kind]["mean_score"]), kind
