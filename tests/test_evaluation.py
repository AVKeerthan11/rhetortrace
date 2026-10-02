"""Evaluation metrics, protocol edge cases, perturbations and deterministic reports."""

import json

import numpy as np
import pytest

from scripts.evaluate import evaluate, render
from scripts.robustness import (
    alignment_shift, detection_change, perturb, seed_for, speech_power,
)
from src.baseline import BaselineConfig
from src.detection import DetectionConfig
from src.evaluation import (
    boundary_errors, calibration, classify_injection, detection_metrics, dumps, file_hashes, monotonicity, prf,
    summarize,
)
from src.flaws import FlawConfig
from tests.test_detection import BASELINE, CONTROL, REFS, make_take


def track(cat, direction, a, b, start=None, end=None):
    return {"category": cat, "direction": direction, "start_idx": a, "end_idx": b,
            "start": float(a) if start is None else start, "end": float(b + 1) if end is None else end}


# ---------------------------------------------------------------- P / R / F1


def test_prf_edge_cases():
    assert prf(3, 1, 1) == {"tp": 3, "fp": 1, "fn": 1, "precision": 0.75, "recall": 0.75, "f1": 0.75}
    none = prf(0, 0, 0)
    assert none["precision"] is None and none["recall"] is None and none["f1"] is None
    only_fp = prf(0, 2, 0)  # predictions but no positives (e.g. clarity: never injected)
    assert only_fp["precision"] == 0.0 and only_fp["recall"] is None and only_fp["f1"] is None
    assert prf(0, 2, 3)["f1"] == 0.0
    assert prf(2, 0, 0)["precision"] == 1.0


def test_classify_injection_counts_only_changed_tracks():
    control = [track("pitch", "flatter", 2, 5), track("energy", "quiet", 20, 24)]
    injected = [track("pitch", "flatter", 2, 5),           # unchanged control FP: not a new prediction
                track("energy", "quiet", 20, 24),
                track("pacing", "fast", 10, 15),           # the injected flaw
                track("pacing", "fast", 16, 16),           # duplicate match -> collateral
                track("pacing", "slow", 11, 12),           # wrong direction -> collateral
                track("pause", "long", 30, 30)]            # elsewhere -> collateral
    res = classify_injection(injected, control, "pacing", "fast", 10, 17)
    assert (res["tp"]["start_idx"], res["tp"]["end_idx"]) == (10, 15)  # larger overlap wins
    assert sorted((t["category"], t["direction"], t["start_idx"]) for t in res["collateral"]) == [
        ("pacing", "fast", 16), ("pacing", "slow", 11), ("pause", "long", 30)]
    assert res["confounded"] is False
    # a same-category control track at the site makes the injection confounded
    assert classify_injection(injected, control, "pitch", "flatter", 4, 8)["confounded"] is True


def test_changed_control_track_counts_as_detection():
    control = [track("energy", "quiet", 20, 22)]
    res = classify_injection([track("energy", "quiet", 18, 25)], control, "energy", "quiet", 18, 25)
    assert res["tp"] is not None and res["confounded"] is True  # reported, excluded from recall


def test_detection_metrics_protocol():
    kinds = {"fast": "pacing", "quiet": "energy"}
    controls = [[track("pitch", "flatter", 1, 3)], []]
    tp = track("pacing", "fast", 5, 9)
    injections = [
        {"kind": "fast", "scorable": True, "confounded": False, "tp": tp, "collateral": []},
        {"kind": "fast", "scorable": True, "confounded": False, "tp": None, "collateral": [track("pause", "long", 2, 2)]},
        {"kind": "quiet", "scorable": False, "confounded": False, "tp": None, "collateral": []},  # unscorable
        {"kind": "quiet", "scorable": True, "confounded": True, "tp": tp, "collateral": []},     # confounded
    ]
    m = detection_metrics(controls, injections, kinds)
    assert m["excluded"] == {"confounded": 1, "unscorable": 1}
    assert (m["per_category"]["pacing"]["tp"], m["per_category"]["pacing"]["fn"]) == (1, 1)
    assert m["per_category"]["pitch"]["control_fp"] == 1 and m["per_category"]["pitch"]["precision"] == 0.0
    assert m["per_category"]["pause"]["collateral_fp"] == 1
    assert m["per_category"]["energy"]["recall"] is None  # its only injections were excluded
    assert (m["overall"]["tp"], m["overall"]["fp"], m["overall"]["fn"]) == (1, 2, 1)
    assert m["overall"]["precision"] == round(1 / 3, 4) and m["overall"]["recall"] == 0.5


# ------------------------------------------------- boundaries and severity


def test_boundary_errors_and_summary():
    exact = boundary_errors(track("pause", "long", 3, 3, 1.0, 1.5), (1.0, 1.5), 3, 3)
    assert exact == {"start_err_s": 0.0, "end_err_s": 0.0, "iou": 1.0, "word_iou": 1.0}
    disjoint = boundary_errors(track("energy", "quiet", 10, 12, 5.0, 6.0), (1.0, 2.0), 2, 4)
    assert disjoint["iou"] == 0.0 and disjoint["word_iou"] == 0.0
    assert summarize([]) == {"n": 0}
    assert summarize([1.0, 3.0]) == {"n": 2, "mean": 2.0, "median": 2.0, "p90": 2.8, "max": 3.0}


def test_monotonicity():
    m = monotonicity([0.5, 1.0, 2.0], [[0.1, 0.4, 0.9], [0.0, 0.5, 0.5], [0.3, 0.2, 0.8]])
    assert (m["n_sites"], m["monotone_sites"]) == (3, 2) and m["spearman_rho"] > 0.5
    assert monotonicity([1.0, 2.0], [[0.0, 0.0]])["spearman_rho"] is None  # constant scores: undefined
    assert monotonicity([1.0], [])["monotone_fraction"] is None


def test_calibration():
    labels = ["negligible", "mild", "noticeable", "strong", "severe"]
    c = calibration([0.5, 0.6, 0.9], [3, 3, 4], labels)
    assert c["modal_level"] == "strong" and c["modal_agreement"] == round(2 / 3, 4)
    assert c["levels"] == {"negligible": 0, "mild": 0, "noticeable": 0, "strong": 2, "severe": 1}
    assert calibration([], [], labels) == {"n": 0}


# ------------------------------------------------------------ reproducibility


def test_file_hashes_normalize_line_endings(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"x\r\ny\r\n")
    (tmp_path / "b.txt").write_bytes(b"x\ny\n")
    h = file_hashes(["b.txt", "a.txt", "missing.txt"], tmp_path)
    assert list(h) == ["a.txt", "b.txt", "missing.txt"] and h["a.txt"] == h["b.txt"] and h["missing.txt"] is None


def test_dumps_is_canonical():
    assert dumps({"b": 1, "a": {"d": 2, "c": 3}}) == dumps({"a": {"c": 3, "d": 2}, "b": 1})
    assert dumps({}).endswith("\n")


def _synthetic_eval():
    cases = [{"speech_id": "s", "take_id": t["take_id"], "take": t, "baseline": BASELINE}
             for t in (CONTROL, make_take("test2", 1))]
    return evaluate(cases, DetectionConfig(), FlawConfig(), BaselineConfig(), {"s": BASELINE}, {"s": REFS},
                    config_path=None)


def test_evaluation_report_is_deterministic():
    a, b = _synthetic_eval(), _synthetic_eval()
    assert dumps(a) == dumps(b) and render(a) == render(b)
    syn = a["synthetic"]
    assert syn["controls"]["fp_word_rate"] == 0.0 and syn["detection"]["overall"]["control_fp"] == 0
    assert set(syn["per_kind"]) >= {"fast", "slow", "quiet", "monotone", "long_pause", "missing_pause"}
    assert syn["severity"]["pooled_monotone_sites"] == syn["severity"]["pooled_sites"]
    for kind in ("fast", "slow", "long_pause"):
        assert syn["per_kind"][kind]["recall"] == 1.0
    assert set(a["reference"]["influence"]["s"]) == {r["take_id"] for r in REFS}
    json.loads(dumps(a))  # serializable


# ---------------------------------------------------------------- robustness


WORDS = [{"aligned": True, "start": 0.1, "end": 0.4}, {"aligned": True, "start": 0.6, "end": 0.9}]


def _tone():
    t = np.arange(16000) / 16000
    return 0.1 * np.sin(2 * np.pi * 220 * t)


def test_noise_perturbation_is_seeded_and_hits_the_snr():
    x = _tone()
    a, _ = perturb(x, "noise_snr20", WORDS, seed_for("noise_snr20", "s", "t"))
    b, _ = perturb(x, "noise_snr20", WORDS, seed_for("noise_snr20", "s", "t"))
    assert np.array_equal(a, b)
    snr = 10 * np.log10(speech_power(x, WORDS) / np.mean((a - x) ** 2))
    assert snr == pytest.approx(20.0, abs=0.5)
    c, _ = perturb(x, "noise_snr20", WORDS, seed_for("noise_snr20", "s", "other"))
    assert not np.array_equal(a, c)


def test_gain_resample_mp3_and_clipping():
    x = _tone()
    y, info = perturb(x, "gain_-12db", WORDS, 0)
    assert np.allclose(y, x * 10 ** (-12 / 20)) and info["clipped_samples"] == 0
    _, loud = perturb(x * 8, "gain_+6db", WORDS, 0)
    assert loud["clipped_samples"] > 0
    for cond in ("resample_8k", "resample_22k", "mp3_32k", "clean_rerun"):
        y, info = perturb(x, cond, WORDS, 0)
        assert len(y) == len(x) and np.abs(y).max() <= 1.0
    y, info = perturb(x, "mp3_32k", WORDS, 0)
    assert info["kbps"] > 0 and np.corrcoef(x, y)[0, 1] > 0.9  # a lossy copy of the same signal


def test_alignment_shift_and_detection_change():
    clean = {"words": [{"aligned": True, "start": 0.0, "end": 0.5}, {"aligned": True, "start": 0.6, "end": 1.0}]}
    pert = {"words": [{"aligned": True, "start": 0.0, "end": 0.58}, {"aligned": True, "start": 0.6, "end": 1.0}],
            "quality": {"status": "pass", "n_low_score": 0}}
    s = alignment_shift(clean, pert)
    assert s["words_shifted_gt_50ms"] == 1 and s["shift_s"]["max"] == 0.08
    d = detection_change([track("energy", "quiet", 2, 5), track("pause", "long", 9, 9)],
                         [track("energy", "quiet", 3, 5), track("pitch", "flatter", 12, 14)])
    assert (d["clean_tracks"], d["perturbed_tracks"], d["kept"], d["new"]) == (2, 2, 1, 1)
    assert d["word_jaccard"] == round(3 / 8, 4)  # {3,4,5} of {2,3,4,5,9,12,13,14}
    assert detection_change([], [])["word_jaccard"] == 1.0
