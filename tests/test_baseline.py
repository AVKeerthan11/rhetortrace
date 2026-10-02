"""Reference-baseline construction from synthetic cached feature docs."""

import copy
import json
import math
from pathlib import Path

import numpy as np
import pytest

from src.alignment import AlignmentConfig
from src.baseline import (
    MAD_K,
    BaselineConfig,
    build_baseline,
    load_take,
    reference_takes,
    robust_stats,
    robust_z,
    save_baseline,
    word_values,
)

CFG = BaselineConfig()
TEXTS = ["Four", "score.", "Seven", "years", "ago."]


def make_take(take_id, f0=(0.0, 1.0, -1.0, 0.5, 0.0), scale=1.0, low=(), silent=(), pitch_fail=()):
    """5 words / 2 sentences; `scale` stretches all timing (2.0 = half speed)."""
    starts = [0.5, 1.0, 2.0, 2.5, 3.0]
    ends = [0.8, 1.3, 2.3, 2.8, 3.4]
    words = [{"idx": i, "text": t, "norm": t.strip(".").lower(), "aligned": True,
              "start": s * scale, "end": e * scale} for i, (t, s, e) in enumerate(zip(TEXTS, starts, ends))]
    durs = [(e - s) * scale for s, e in zip(starts, ends)]
    gaps = [(starts[i + 1] - ends[i]) * scale for i in range(4)]
    art = 5 / sum(durs)
    key = f"key-{take_id}"
    common = {"alignment_cache_key": key, "audio_sha256": f"sha-{take_id}"}
    w = lambda i: {"idx": i, "text": TEXTS[i], "aligned": True}  # noqa: E731
    return {
        "take_id": take_id,
        "alignment": {"cache_key": key, "audio": {"sha256": f"sha-{take_id}"}, "words": words,
                      "quality": {"low_score_idx": list(low), "too_short_idx": []}},
        "pitch": {**common, "words": [
            {**w(i), "f0_median_st": None if i in pitch_fail else f0[i],
             "f0_range_st": None if i in pitch_fail else 2.0,
             "pitch_failure": "insufficient_voicing" if i in pitch_fail else None} for i in range(5)]},
        "energy": {**common, "words": [
            {**w(i), "energy_rel_db": -1.0 * i, "energy_peak_rel_db": 3.0,
             "energy_status": "silent" if i in silent else "voiced", "energy_failure": None} for i in range(5)]},
        "rate": {**common,
                 "take": {"start": words[0]["start"], "end": words[-1]["end"],
                          "speech_rate_wps": 5 / (words[-1]["end"] - words[0]["start"]), "articulation_rate_wps": art},
                 "regions": [{"region_idx": r, "first_idx": a, "last_idx": b, "speech_rate_wps": 2.0 / scale,
                              "articulation_rate_wps": 3.0 / scale} for r, a, b in ((0, 0, 1), (1, 2, 4))],
                 "words": [{**w(i), "duration_s": durs[i], "local_articulation_rate_wps": art,
                            "rate_failure": None} for i in range(5)]},
        "pause": {**common, "settings": {"sentence_end": ".?!"},
                  "summary": {"within_sentence": {"n_pauses": 0, "total_pause_s": 0.0}},
                  "regions": [{"n_pauses": 0, "pause_ratio": 0.0, "pause_after_s": gaps[1], "pause_after_failure": None},
                              {"n_pauses": 0, "pause_ratio": 0.0, "pause_after_s": None, "pause_after_failure": "take_end"}],
                  "words": [{**w(i), "pause_after_s": gaps[i] if i < 4 else None,
                             "is_pause_after": gaps[i] >= 0.15 if i < 4 else None,
                             "after_failure": None if i < 4 else "take_end"} for i in range(5)]},
        "spectral": {**common,
                     "regions": [{"centroid_rel_oct": 0.0, "spectral_failure": None}] * 2,
                     "words": [{**w(i), "centroid_rel_oct": 0.1, "flatness": 0.01, "mfcc_mean": [1.0, -1.0],
                                "spectral_failure": None} for i in range(5)]},
    }


def three_takes(**kw):
    return [make_take("good_01", f0=(0.0,) * 5, **kw), make_take("good_02", f0=(1.0,) * 5),
            make_take("good_03", f0=(2.0,) * 5)]


def word(doc, idx, name):
    return doc["words"][idx]["features"][name]


# ---------------------------------------------------------------- statistics


def test_robust_stats_median_and_small_sample_mad():
    med, mad = robust_stats([0.0, 1.0, 2.0])
    assert med == 1.0
    assert mad == pytest.approx(MAD_K * 1.495 * 1.0)
    med, mad = robust_stats([[0.0, 5.0], [1.0, 5.0], [3.0, 5.0]])  # elementwise for vectors
    assert list(med) == [1.0, 5.0] and mad[1] == 0.0


def test_word_baseline_median_scale_and_values():
    doc = build_baseline("s", three_takes(), CFG)
    f0 = word(doc, 0, "f0_median_st")
    assert f0["status"] == "ok" and f0["n"] == 3
    assert f0["values"] == [0.0, 1.0, 2.0]
    assert f0["median"] == 1.0
    assert f0["scale"] >= doc["feature_definitions"]["words"]["f0_median_st"]["resolution"]
    # identical values: MAD 0, scale floored at the measurement resolution, never 0
    energy = word(doc, 2, "energy_rel_db")
    assert energy["mad"] == 0.0 and energy["scale"] == 0.5
    assert word(doc, 1, "is_pause_after")["p"] == 1.0  # all references pause after "score."
    assert word(doc, 0, "mfcc")["median"] == [1.0, -1.0]


def test_missing_values_are_excluded_with_reason():
    takes = three_takes()
    takes[0] = make_take("good_01", pitch_fail=(3,))
    doc = build_baseline("s", takes, CFG)
    f0 = word(doc, 3, "f0_median_st")
    assert f0["n"] == 2 and f0["values"][0] is None
    assert f0["excluded"] == {"good_01": "insufficient_voicing"}
    assert f0["median"] == 1.5  # median of the two usable values, not of a 0

    takes[1] = make_take("good_02", pitch_fail=(3,))
    f0 = word(build_baseline("s", takes, CFG), 3, "f0_median_st")
    assert f0["status"] == "insufficient" and "median" not in f0 and "scale" not in f0
    # last word has no boundary after it
    assert word(doc, 4, "pause_after_s")["status"] == "insufficient"
    assert word(doc, 4, "pause_after_s")["excluded"]["good_01"] == "take_end"


def test_low_confidence_values_are_excluded():
    take = make_take("good_01", low=(2,), silent=(4,))
    rows = word_values(take)
    assert all(v == (None, "low_alignment_confidence") for v in rows[2].values())
    # the boundary before a low-confidence word is unreliable too
    assert rows[1]["pause_after_s"] == (None, "low_alignment_confidence")
    assert rows[1]["f0_median_st"][0] is not None
    assert rows[4]["energy_rel_db"] == (None, "silent")
    assert rows[4]["f0_median_st"][0] is not None


def test_outlier_reference_does_not_move_median_or_scale():
    # one wild value at word 0; the other words agree to within 0.2 st
    takes = [make_take("good_01", f0=(1.0,) * 5), make_take("good_02", f0=(1.1,) * 5),
             make_take("good_03", f0=(10.0, 1.2, 1.2, 1.2, 1.2))]
    f0 = word(build_baseline("s", takes, CFG), 0, "f0_median_st")
    assert f0["median"] == 1.1
    assert f0["scale"] < 1.0  # the 10.0 does not inflate the spread
    assert f0["outliers"] == ["good_03"]
    assert robust_z(10.0, f0) > CFG.outlier_z


def test_tempo_normalized_duration_is_take_comparable():
    normal, slow = word_values(make_take("a")), word_values(make_take("b", scale=2.0))
    for a, b in zip(normal, slow):
        assert a["duration_rel"][0] == pytest.approx(b["duration_rel"][0])
        assert b["log_duration"][0] == pytest.approx(a["log_duration"][0] + math.log(2))


def test_region_and_take_baselines():
    doc = build_baseline("s", [make_take("good_01"), make_take("good_02", scale=1.1), make_take("good_03", scale=0.9)], CFG)
    assert [r["region_idx"] for r in doc["regions"]] == [0, 1]
    assert [w["region_idx"] for w in doc["words"]] == [0, 0, 1, 1, 1]
    rate = doc["regions"][0]["features"]["log_speech_rate"]
    assert rate["median"] == pytest.approx(math.log(2.0), abs=1e-4)
    assert doc["regions"][1]["features"]["pause_after_s"]["status"] == "insufficient"
    assert doc["take"]["log_articulation_rate"]["status"] == "ok"


# ------------------------------------------------------- determinism, inputs


def test_output_is_deterministic_and_order_independent(tmp_path):
    takes = three_takes()
    a = build_baseline("s", takes, CFG)
    b = build_baseline("s", list(reversed(copy.deepcopy(takes))), CFG)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    cfg = BaselineConfig(output_dir=str(tmp_path))
    first = save_baseline(a, cfg).read_bytes()
    assert save_baseline(b, cfg).read_bytes() == first


def test_validation_leave_one_out_and_correlation():
    doc = build_baseline("s", three_takes(), CFG)
    loo = doc["validation"]["leave_one_out"]
    assert sorted(loo) == ["good_01", "good_02", "good_03"]
    assert loo["good_02"]["features"]["f0_median_st"]["median_abs_z"] == 0.0  # midpoint of the others
    assert set(doc["validation"]["profile_correlation"]["duration_rel"]) == {
        "good_01~good_02", "good_01~good_03", "good_02~good_03"}
    # two references: statistics but no leave-one-out
    assert build_baseline("s", three_takes()[:2], CFG)["validation"]["leave_one_out"] is None


def test_rejects_too_few_or_mismatched_references():
    with pytest.raises(ValueError, match="at least"):
        build_baseline("s", three_takes()[:1], CFG)
    takes = three_takes()
    takes[2]["alignment"]["words"][1]["norm"] = "scores"
    with pytest.raises(ValueError, match="word sequence"):
        build_baseline("s", takes, CFG)


def test_load_take_rejects_stale_feature_cache(tmp_path):
    take = make_take("good_01")
    align_dir, feat_dir = tmp_path / "alignments" / "s", tmp_path / "features" / "s"
    align_dir.mkdir(parents=True)
    feat_dir.mkdir(parents=True)
    (align_dir / "good_01.json").write_text(json.dumps(take["alignment"]), encoding="utf-8")
    (align_dir / "bad_01.json").write_text("{}", encoding="utf-8")
    for src in ("pitch", "energy", "rate", "pause", "spectral"):
        (feat_dir / f"good_01.{src}.json").write_text(json.dumps(take[src]), encoding="utf-8")
    cfg = BaselineConfig(features_dir=str(tmp_path / "features"))
    align_cfg = AlignmentConfig(output_dir=str(tmp_path / "alignments"))
    assert reference_takes("s", cfg, align_cfg) == ["good_01"]
    assert load_take("s", "good_01", cfg, align_cfg)["pitch"]["words"][0]["f0_median_st"] == 0.0

    stale = dict(take["energy"], alignment_cache_key="old")
    (feat_dir / "good_01.energy.json").write_text(json.dumps(stale), encoding="utf-8")
    with pytest.raises(RuntimeError, match="stale"):
        load_take("s", "good_01", cfg, align_cfg)


@pytest.mark.skipif(not Path("results/features/speech_01/good_03.spectral.json").exists(),
                    reason="cached features not available")
def test_real_cached_references_build():
    cfg, align_cfg = BaselineConfig(), AlignmentConfig()
    takes = [load_take("speech_01", t, cfg, align_cfg) for t in reference_takes("speech_01", cfg, align_cfg)]
    doc = build_baseline("speech_01", takes, cfg)
    assert [r["take_id"] for r in doc["references"]] == ["good_01", "good_02", "good_03"]
    assert len(doc["words"]) == 118
    scales = [w["features"]["f0_median_st"].get("scale") for w in doc["words"]]
    assert all(s is None or s > 0 for s in scales)
    assert np.isfinite(doc["validation"]["leave_one_out"]["good_01"]["median_abs_z"])


def test_pitch_span_values_window_floor_and_missing():
    from src.baseline import pitch_span_values, pitch_span_windows
    take = make_take("good_01", f0=(0.0, 2.0, 1.0, -1.0, 1.0), pitch_fail=(3,))
    assert pitch_span_windows(take, CFG) == [[0, 1], [0, 1], [2, 3, 4], [2, 3, 4], [2, 3, 4]]  # sentence-clipped
    spans = pitch_span_values(take, word_values(take), CFG)
    assert spans[0] == (None, "insufficient_span_pitch")  # "Four score." has 2 words
    assert spans[2] == (None, "insufficient_span_pitch")  # word 3 has no pitch: 2 voiced words left
    flat = make_take("good_01", f0=(0.0, 0.0, 0.0, 0.0, 0.0))
    wide = BaselineConfig(pitch_span_words=5, pitch_span_min_words=2)
    assert pitch_span_values(flat, word_values(flat), wide)[3][0] == pytest.approx(math.log(0.25))  # floored
    spans = pitch_span_values(take, word_values(take), wide)
    assert spans[0][0] == pytest.approx(math.log(1.0))  # std(0, 2) = 1 st
    assert spans[3][0] == pytest.approx(math.log(0.25))  # words 2 and 4 both 1.0 st: std 0 -> floor
