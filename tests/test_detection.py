"""Candidate flaw detection on synthetic references with injected deviations."""

import copy
import json
from dataclasses import replace

import pytest

from src.baseline import BaselineConfig, build_baseline
from src.detection import (
    DetectionConfig,
    deviation,
    detect_take,
    hysteresis_spans,
    running_median,
    save_detection,
)

N = 20
SENT_END = 9  # word 9 ends sentence 0
CFG = DetectionConfig()


def make_take(take_id, j=0, f0=None, energy=None, dur=None, gaps=None, low=(), silent=(), pitch_fail=()):
    """20 words / 2 sentences. j in {-1, 0, 1} jitters every value like a different good take."""
    f0 = f0 or [((i * 7) % 5 - 2) * 1.0 + 0.3 * j for i in range(N)]
    energy = energy or [((i * 3) % 4 - 2) * 1.5 + 0.5 * j for i in range(N)]
    dur = dur or [(0.2 + 0.05 * (i % 3)) * (1 + 0.03 * j) for i in range(N)]
    gaps = gaps or [0.6 + 0.02 * j if i == SENT_END else 0.04 + 0.02 * (j == 1) for i in range(N - 1)]
    texts = [f"w{i}." if i in (SENT_END, N - 1) else f"w{i}" for i in range(N)]
    starts, t = [], 0.5
    for i in range(N):
        starts.append(t)
        t += dur[i] + (gaps[i] if i < N - 1 else 0)
    words = [{"idx": i, "text": texts[i], "norm": f"w{i}", "aligned": True,
              "start": round(starts[i], 4), "end": round(starts[i] + dur[i], 4)} for i in range(N)]
    art = N / sum(dur)
    key = f"key-{take_id}"
    common = {"alignment_cache_key": key, "audio_sha256": f"sha-{take_id}"}

    def w(i):
        return {"idx": i, "text": texts[i], "aligned": True}

    def region(a, b, after, fail):
        return {"n_pauses": 0, "pause_ratio": 0.0, "pause_after_s": after, "pause_after_failure": fail}

    return {
        "take_id": take_id,
        "alignment": {"cache_key": key, "audio": {"sha256": f"sha-{take_id}"}, "words": words,
                      "quality": {"low_score_idx": list(low), "too_short_idx": []}},
        "pitch": {**common, "words": [
            {**w(i), "f0_median_st": None if i in pitch_fail else f0[i],
             "f0_range_st": None if i in pitch_fail else 2.0 + 0.2 * j,
             "pitch_failure": "insufficient_voicing" if i in pitch_fail else None} for i in range(N)]},
        "energy": {**common, "words": [
            {**w(i), "energy_rel_db": energy[i], "energy_peak_rel_db": energy[i] + 3.0,
             "energy_status": "silent" if i in silent else "voiced", "energy_failure": None} for i in range(N)]},
        "rate": {**common,
                 "take": {"start": words[0]["start"], "end": words[-1]["end"],
                          "speech_rate_wps": N / (words[-1]["end"] - words[0]["start"]), "articulation_rate_wps": art},
                 "regions": [{"region_idx": 0, "first_idx": 0, "last_idx": SENT_END, "speech_rate_wps": 2.5,
                              "articulation_rate_wps": art},
                             {"region_idx": 1, "first_idx": SENT_END + 1, "last_idx": N - 1,
                              "speech_rate_wps": 2.5, "articulation_rate_wps": art}],
                 "words": [{**w(i), "duration_s": dur[i], "local_articulation_rate_wps": 1.0 / dur[i], "local_speech_rate_wps": 0.8 / dur[i],
                            "rate_failure": None} for i in range(N)]},
        "pause": {**common, "settings": {"sentence_end": ".?!", "min_pause_s": 0.15},
                  "summary": {"within_sentence": {"n_pauses": 0, "total_pause_s": 0.0}},
                  "regions": [region(0, SENT_END, gaps[SENT_END], None), region(SENT_END + 1, N - 1, None, "take_end")],
                  "words": [{**w(i), "pause_after_s": gaps[i] if i < N - 1 else None,
                             "boundary_after": None if i == N - 1 else "sentence" if i == SENT_END else "within_sentence",
                             "is_pause_after": gaps[i] >= 0.15 if i < N - 1 else None,
                             "after_failure": None if i < N - 1 else "take_end"} for i in range(N)]},
        "spectral": {**common,
                     "regions": [{"centroid_rel_oct": 0.0, "spectral_failure": None}] * 2,
                     "words": [{**w(i), "n_active": 20, "centroid_rel_oct": 0.05 * ((i % 3) - 1) + 0.02 * j,
                                "flatness": 0.01 * (1 + 0.05 * j), "mfcc_mean": [1.0 + 0.3 * j, -1.0, 0.5 * (i % 2)],
                                "spectral_failure": None} for i in range(N)]},
    }


REFS = [make_take("good_01", -1), make_take("good_02", 0), make_take("good_03", 1)]
BASELINE = build_baseline("s", REFS, BaselineConfig())


def detect(take, baseline=BASELINE, cfg=CFG):
    return detect_take(take, baseline, cfg)


def regions_of(doc, category):
    return [r for r in doc["regions"] if category in r["categories"]]


def with_values(src, idx, **fields):
    """Copy of a take with feature fields changed on word idx (pitch/energy/rate/pause words)."""
    take = copy.deepcopy(src)
    for i in idx:
        for name, fn in fields.items():
            source = {"energy_rel_db": "energy", "energy_peak_rel_db": "energy", "f0_median_st": "pitch",
                      "f0_range_st": "pitch", "duration_s": "rate", "local_articulation_rate_wps": "rate",
                      "pause_after_s": "pause"}[name]
            rec = take[source]["words"][i]
            rec[name] = fn(rec[name])
    return take


CONTROL = make_take("test", 0)


# ----------------------------------------------------------------- helpers


def test_hysteresis_and_running_median():
    assert hysteresis_spans([0, 1.6, 3.2, 2.0, 0.5, 1.8, 1.9, 0], 3.0, 1.5) == [(1, 3)]
    assert hysteresis_spans([3.5], 3.0, 1.5) == [(0, 0)]
    assert running_median([0, 9, 0, 4, 4, 4], 3) == [4.5, 0.0, 4.0, 4.0, 4.0, 4.0]
    assert running_median([0, 9, 0], 1) == [0, 9, 0]


def test_deviation_cell_statuses():
    cell = {"status": "ok", "median": 1.0, "scale": 0.5}
    assert deviation(2.0, None, cell, "f0_median_st", CFG, 0.15)["z"] == 2.0
    assert deviation(None, "unaligned", cell, "f0_median_st", CFG, 0.15)["status"] == "missing"
    low = deviation(None, "low_alignment_confidence", cell, "f0_median_st", CFG, 0.15)
    assert low["status"] == "low_confidence" and low["z"] is None
    nob = deviation(2.0, None, {"status": "insufficient"}, "f0_median_st", CFG, 0.15)
    assert nob["status"] == "no_baseline" and nob["z"] is None
    # silent word: level is an upper bound, so only a drop counts
    assert deviation(None, "silent", cell, "energy_rel_db", CFG, 0.15, raw=-4.0)["z"] == -10.0
    assert deviation(None, "silent", cell, "energy_rel_db", CFG, 0.15, raw=9.0)["z"] == 0.0


def test_sub_threshold_gaps_do_not_deviate():
    cell = {"status": "ok", "median": 0.04, "scale": 0.02}
    assert deviation(0.02, None, cell, "pause_after_s", CFG, 0.15)["z"] == 0.0  # both below a pause
    assert deviation(0.65, None, cell, "pause_after_s", CFG, 0.15)["z"] == pytest.approx(5.0)  # floor 0.1 s


# ------------------------------------------------------- injected deviations


def test_no_deviation_control_has_no_regions():
    doc = detect(CONTROL)
    assert doc["regions"] == []
    assert doc["summary"]["n_regions"] == 0
    # a reference-like jittered take is also clean
    assert detect(make_take("test", 1))["regions"] == []


def test_energy_drop_is_detected_and_located():
    doc = detect(with_values(CONTROL, range(4, 9), energy_rel_db=lambda v: v - 8, energy_peak_rel_db=lambda v: v - 8))
    (r,) = doc["regions"]
    assert (r["start_idx"], r["end_idx"]) == (4, 8)
    assert r["dominant_category"] == "energy" and r["direction"] == "quiet"
    assert r["start"] == doc["words"][4]["start"] and r["end"] == doc["words"][8]["end"]
    assert r["words"] == ["w4", "w5", "w6", "w7", "w8"]
    ev = r["evidence"][0]
    assert ev["category"] == "energy" and ev["z"] < -3 and {"value", "median", "scale"} <= set(ev)


def test_fast_span_is_pacing():
    doc = detect(with_values(CONTROL, range(11, 17), duration_s=lambda v: v * 0.6,
                             local_articulation_rate_wps=lambda v: v / 0.6))
    (r,) = regions_of(doc, "pacing")
    assert r["dominant_category"] == "pacing" and r["direction"] == "fast"
    assert 11 <= r["start_idx"] and r["end_idx"] <= 17


def test_inserted_and_missing_pauses():
    doc = detect(with_values(CONTROL, [14], pause_after_s=lambda v: 1.2))
    (r,) = doc["regions"]
    assert r["dominant_category"] == "pause" and r["direction"] == "long"
    assert (r["start_idx"], r["end_idx"]) == (14, 14)
    # the region spans the gap: end of word 14 to start of word 15
    assert (r["start"], r["end"]) == (doc["words"][14]["start"], doc["words"][15]["start"])

    doc = detect(with_values(CONTROL, [SENT_END], pause_after_s=lambda v: 0.03))
    (r,) = doc["regions"]
    assert r["dominant_category"] == "pause" and r["direction"] == "short"
    assert r["start_idx"] == SENT_END


def test_monotone_span_is_pitch():
    doc = detect(with_values(CONTROL, range(10, 18), f0_median_st=lambda v: 0.0, f0_range_st=lambda v: 0.4))
    (r,) = regions_of(doc, "pitch")
    assert r["dominant_category"] == "pitch" and r["direction"] == "flatter"


# ---------------------------------------------------------------- safeguards


def test_duration_quantization_widens_short_word_scale():
    cell = {"status": "ok", "median": -2.5, "scale": 0.1}  # ~82 ms word
    plain = deviation(-2.0, None, cell, "log_duration", replace(CFG, duration_frame_s=0.0), 0.15)
    take = make_take("test", 0)
    short = replace(CFG, duration_frame_s=0.02)
    # error of one 20 ms frame on an 82 ms word dominates the 0.1 reference spread
    meas = 0.02 / 0.082
    quant = deviation(-2.0, None, cell, "log_duration", short, 0.15, meas_sigma=meas)
    assert plain["z"] == 5.0 and quant["z"] == pytest.approx(0.5 / (0.1 ** 2 + meas ** 2) ** 0.5, abs=1e-3)
    # in the pipeline the measurement error uses the shorter of test and reference duration
    on = detect(take, cfg=short)["words"][0]["features"]["log_duration"]["scale"]
    off = detect(take, cfg=replace(CFG, duration_frame_s=0.0))["words"][0]["features"]["log_duration"]["scale"]
    assert on > off


def test_pitch_direction_flatter_vs_livelier():
    flat = detect(with_values(CONTROL, range(10, 18), f0_median_st=lambda v: 0.0, f0_range_st=lambda v: 0.4))
    assert {t["direction"] for r in flat["regions"] for t in r["tracks"] if t["category"] == "pitch"} == {"flatter"}
    lively = detect(with_values(CONTROL, range(10, 18), f0_median_st=lambda v: 3 * v if v else 6.0,
                                f0_range_st=lambda v: 6.0))
    assert {t["direction"] for r in lively["regions"] for t in r["tracks"] if t["category"] == "pitch"} == {"livelier"}
    # undirected pitch (safeguard off) keeps the old behaviour
    off = detect(with_values(CONTROL, range(10, 18), f0_median_st=lambda v: 0.0, f0_range_st=lambda v: 0.4),
                 cfg=replace(CFG, pitch_directional=False))
    assert regions_of(off, "pitch")[0]["direction"] is None


def test_flatter_and_livelier_runs_do_not_chain():
    take = with_values(CONTROL, range(4, 8), f0_median_st=lambda v: 0.0, f0_range_st=lambda v: 0.4)
    take = with_values(take, range(8, 12), f0_median_st=lambda v: 3 * v if v else 6.0, f0_range_st=lambda v: 6.0)
    tracks = [t for r in detect(take)["regions"] for t in r["tracks"] if t["category"] == "pitch"]
    assert sorted(t["direction"] for t in tracks) == ["flatter", "livelier"]
    one = [t for r in detect(take, cfg=replace(CFG, pitch_directional=False))["regions"]
           for t in r["tracks"] if t["category"] == "pitch"]
    assert len(one) == 1  # undirected: one chained region


def test_clarity_active_frame_gate():
    take = copy.deepcopy(CONTROL)
    take["spectral"]["words"][3]["n_active"] = 5
    doc = detect(take, cfg=replace(CFG, min_clarity_active_frames=10))
    f = doc["words"][3]["features"]
    assert f["mfcc"]["status"] == "low_confidence" and f["mfcc"]["reason"] == "few_active_frames"
    assert f["energy_rel_db"]["status"] == "ok"
    assert detect(take)["words"][3]["features"]["mfcc"]["status"] == "ok"  # off by default


def test_alignment_score_gate_covers_word_and_gap_before():
    take = copy.deepcopy(CONTROL)
    for w in take["alignment"]["words"]:
        w["alignment_score"] = 0.9
    take["alignment"]["words"][6]["alignment_score"] = 0.4
    doc = detect(take, cfg=replace(CFG, min_alignment_score=0.6))
    assert all(d["status"] == "low_confidence" for n, d in doc["words"][6]["features"].items() if n != "is_pause_after")
    assert doc["words"][5]["features"]["pause_after_s"]["reason"] == "low_alignment_score"
    assert doc["words"][5]["features"]["f0_median_st"]["status"] == "ok"
    assert doc["words"][7]["features"]["f0_median_st"]["status"] == "ok"


# --------------------------------------------------------- missing baseline


def test_missing_baseline_cells_are_explicit_not_anomalous():
    refs = [make_take("good_01", -1, pitch_fail=range(5, 9)), make_take("good_02", 0, pitch_fail=range(5, 9)),
            make_take("good_03", 1)]
    baseline = build_baseline("s", refs, BaselineConfig())
    # the test take's pitch there is wildly off, but there is no baseline to compare with
    doc = detect(with_values(CONTROL, range(5, 9), f0_median_st=lambda v: v + 12), baseline)
    assert doc["regions"] == []
    for i in range(5, 9):
        assert doc["words"][i]["features"]["f0_median_st"]["status"] == "no_baseline"
        assert doc["words"][i]["categories"]["pitch"] is None
    pitch_cells = [w["features"][n]["status"] for w in doc["words"] for n in ("f0_median_st", "f0_range_st")]
    assert pitch_cells.count("no_baseline") == 8  # 4 words x 2 pitch features

    doc = detect(make_take("test", 0, pitch_fail=range(5, 9), low=[12]))
    assert doc["words"][5]["features"]["f0_median_st"]["status"] == "missing"
    assert doc["words"][12]["features"]["energy_rel_db"]["status"] == "low_confidence"
    assert doc["regions"] == []


def test_silent_word_counts_as_energy_drop():
    take = with_values(make_take("test", 0, silent=range(4, 9)), range(4, 9), energy_rel_db=lambda v: v - 10,
                       energy_peak_rel_db=lambda v: v - 10)
    doc = detect(take)
    assert doc["words"][5]["features"]["energy_rel_db"]["bound"] == "upper"
    assert [r["dominant_category"] for r in doc["regions"]] == ["energy"]


# ---------------------------------------------------- grouping and merging


def test_adjacent_anomalies_merge_and_categories_combine():
    drop = dict(energy_rel_db=lambda v: v - 8, energy_peak_rel_db=lambda v: v - 8)
    # one normal word inside a drop is bridged by the running median
    (r,) = detect(with_values(CONTROL, [3, 4, 5, 7, 8, 9], **drop))["regions"]
    assert (r["start_idx"], r["end_idx"]) == (3, 9)
    # two normal words (~0.6 s) between drops: merged only within merge_gap_seconds
    take = with_values(CONTROL, [2, 3, 4, 7, 8, 9], **drop)
    assert [(r["start_idx"], r["end_idx"]) for r in detect(take)["regions"]] == [(2, 4), (7, 9)]
    (r,) = detect(take, cfg=replace(CFG, merge_gap_seconds=1.0))["regions"]
    assert (r["start_idx"], r["end_idx"]) == (2, 9)

    # an energy drop overlapping a stronger slowdown: one candidate, pacing dominant
    take = with_values(CONTROL, range(11, 16), **drop)
    take = with_values(take, range(11, 17), duration_s=lambda v: v * 3.0, local_articulation_rate_wps=lambda v: v / 3.0)
    (r,) = detect(take)["regions"]
    assert r["categories"] == ["pacing", "energy"]
    assert r["dominant_category"] == "pacing" and r["direction"] == "slow"
    assert len(r["tracks"]) == 2


def test_opposite_directions_do_not_merge():
    take = with_values(CONTROL, [3, 4, 5], energy_rel_db=lambda v: v - 8, energy_peak_rel_db=lambda v: v - 8)
    take = with_values(take, [6, 7, 8], energy_rel_db=lambda v: v + 8, energy_peak_rel_db=lambda v: v + 8)
    tracks = [t for r in detect(take)["regions"] for t in r["tracks"]]
    assert sorted(t["direction"] for t in tracks) == ["loud", "quiet"]


def test_short_runs_below_min_words_are_dropped():
    doc = detect(with_values(CONTROL, [6], energy_rel_db=lambda v: v - 8, energy_peak_rel_db=lambda v: v - 8))
    assert doc["regions"] == []
    assert doc["summary"]["n_words_over_z_open"] == 1  # the deviation is still in the word record


# -------------------------------------------------------------- determinism


def test_deterministic_output(tmp_path):
    take = with_values(CONTROL, range(4, 9), energy_rel_db=lambda v: v - 8, energy_peak_rel_db=lambda v: v - 8)
    a, b = detect(take), detect(copy.deepcopy(take))
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    cfg = replace(CFG, output_dir=str(tmp_path))
    first = save_detection(a, cfg).read_bytes()
    assert save_detection(b, cfg).read_bytes() == first
    # reference order does not change the result
    reordered = build_baseline("s", list(reversed(REFS)), BaselineConfig())
    assert json.dumps(detect(take, reordered), sort_keys=True) == json.dumps(a, sort_keys=True)


def test_rejects_take_of_another_script():
    take = copy.deepcopy(CONTROL)
    take["alignment"]["words"][3]["norm"] = "other"
    with pytest.raises(ValueError, match="word sequence"):
        detect(take)


def test_config_from_yaml_matches_defaults():
    cfg = DetectionConfig.from_yaml()
    assert (cfg.z_open, cfg.z_close, cfg.min_words, cfg.min_scale) == (
        CFG.z_open, CFG.z_close, CFG.min_words, CFG.min_scale)


# ------------------------------------------------------- span pitch variation

CONTOUR = [((i * 7) % 5 - 2) * 1.0 for i in range(N)]  # +-2 st word-to-word contour


def amp_refs(contour=CONTOUR, flat=()):
    """References whose contour amplitude differs by +-15 % (natural span-spread variation)."""
    def f0(j):
        return [(0.1 * (i % 2) if i in flat else v * (1 + 0.15 * j)) for i, v in enumerate(contour)]
    return [make_take(f"good_0{k + 1}", j, f0=f0(j)) for k, j in enumerate((-1, 0, 1))]


AMP_BASELINE = build_baseline("s", amp_refs(), BaselineConfig())
FLAT_SPAN = range(10, 20)


def flattened(k, contour=CONTOUR, **kw):
    """Control take with words 10-19 compressed toward the speaker median by factor k."""
    return make_take("test", 0, f0=[v * k if i in FLAT_SPAN else v for i, v in enumerate(contour)], **kw)


def pitch_flatter(doc):
    return [t for r in doc["regions"] for t in r["tracks"] if t["category"] == "pitch" and t["direction"] == "flatter"]


def test_strong_flattening_detected_by_span_evidence():
    doc = detect(flattened(0.0), AMP_BASELINE)
    (t,) = pitch_flatter(doc)
    assert 10 <= t["start_idx"] <= 12 and t["end_idx"] == 19
    (r,) = doc["regions"]
    assert r["dominant_category"] == "pitch" and r["evidence"][0]["feature"] == "log_f0_span_std"
    span = doc["words"][15]["features"]["log_f0_span_std"]
    assert span["one_sided"] == "flatter" and span["z"] < -3


def test_mild_flattening_detected_but_natural_variation_is_not():
    (t,) = pitch_flatter(detect(flattened(0.4), AMP_BASELINE))  # contour compressed to 40 %
    assert (t["start_idx"], t["end_idx"]) == (10, 19)
    # word-level pitch z alone (span evidence disabled) misses it
    assert pitch_flatter(detect(flattened(0.4), AMP_BASELINE, replace(CFG, monotone_min_ref_std_st=1e9))) == []
    # compressing to 50 % is z ~ -2.8 against +-15 % reference amplitudes: below z_open
    assert pitch_flatter(detect(flattened(0.5), AMP_BASELINE)) == []
    assert pitch_flatter(detect(flattened(0.9), AMP_BASELINE)) == []  # within the references' range
    assert detect(flattened(1.0), AMP_BASELINE)["regions"] == []


def test_livelier_span_is_not_monotone_evidence():
    doc = detect(flattened(1.6), AMP_BASELINE)
    span = doc["words"][15]["features"]["log_f0_span_std"]
    assert span["z"] == 0.0  # one-sided: clipped
    assert pitch_flatter(doc) == []


def test_naturally_flat_reference_span_is_not_applicable():
    flat_refs = amp_refs(flat=FLAT_SPAN)
    baseline = build_baseline("s", flat_refs, BaselineConfig())
    doc = detect(flattened(0.0, contour=[0.0 if i in FLAT_SPAN else v for i, v in enumerate(CONTOUR)]), baseline)
    span = doc["words"][15]["features"]["log_f0_span_std"]
    assert span["status"] == "not_applicable" and span["reason"] == "reference_low_variation"
    assert pitch_flatter(doc) == []
    # with the gate off, a span at the std floor still cannot be flatter than a floored reference
    off = detect(flattened(0.0, contour=[0.0 if i in FLAT_SPAN else v for i, v in enumerate(CONTOUR)]), baseline,
                 replace(CFG, monotone_min_ref_std_st=0.0))
    assert off["words"][15]["features"]["log_f0_span_std"]["z"] == 0.0


def test_missing_pitch_in_test_span_is_low_confidence():
    doc = detect(flattened(0.0, pitch_fail=[15]), AMP_BASELINE)
    for i in range(13, 18):  # every window containing word 15
        cell = doc["words"][i]["features"]["log_f0_span_std"]
        assert cell["status"] == "low_confidence" and cell["reason"] == "incomplete_span"
    assert doc["words"][12]["features"]["log_f0_span_std"]["status"] == "ok"
    # a merely missing word (no flattening) must not look flatter
    assert detect(make_take("test", 0, f0=CONTOUR, pitch_fail=[15]), AMP_BASELINE)["regions"] == []


def test_span_pitch_with_missing_reference_values():
    refs = [make_take(f"good_0{k + 1}", j, f0=[v * (1 + 0.15 * j) for v in CONTOUR], pitch_fail=range(12, 18))
            for k, j in enumerate((-1, 0, 1))]
    baseline = build_baseline("s", refs, BaselineConfig())
    cell = baseline["words"][15]["features"]["log_f0_span_std"]
    assert cell["status"] == "insufficient"  # fewer than 3 voiced words in the window
    assert set(cell["excluded"].values()) == {"insufficient_span_pitch"}
    doc = detect(flattened(0.0), baseline)
    assert doc["words"][15]["features"]["log_f0_span_std"]["status"] == "no_baseline"


def test_span_pitch_detection_is_deterministic():
    a = detect(flattened(0.4), AMP_BASELINE)
    b = detect(flattened(0.4), build_baseline("s", list(reversed(amp_refs())), BaselineConfig()))
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
