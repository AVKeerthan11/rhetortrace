"""The injection / control evaluation script on synthetic references."""

import copy
import json

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
