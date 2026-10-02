"""Robustness of the full pipeline to controlled audio perturbations.

Each condition perturbs every good take's audio deterministically, then runs
the *existing* pipeline on it: forced alignment (ASR quality check off; it
does not change the words), pitch / energy / rate / pause / spectral
features, detection against the clean leave-one-out baseline (references stay
clean, as in use: only the tested recording is degraded) and flaw refinement.
Results are compared with the cached clean outputs.

Conditions (16 kHz PCM-16 output, like the dataset):
  clean_rerun         no change: checks that the harness itself adds nothing
  noise_snr{30,20,10} white Gaussian noise; SNR over the clean aligned speech
                      (seed derived from condition + take: reproducible)
  gain_{-12,+6}db     level change (clipped samples are counted)
  mp3_32k / mp3_24k   MP3 round trip through libsndfile (LAME), VBR quality
                      0.5 / 0.9 (~31 / ~24 kbit/s at 16 kHz mono)
  resample_8k         16 kHz -> 8 kHz -> 16 kHz (band limit 4 kHz)
  resample_22k        16 kHz -> 22.05 kHz -> 16 kHz (polyphase, mild)

Per condition and take, against clean:
  alignment   word start/end shift (s), words shifted > 50 ms, QC status
  features    |change| of normalized word features in units of the
              baseline's reference scale ("z drift"), values lost / gained
  detection   control flaw tracks clean vs perturbed: counts, word Jaccard
              of flagged words, tracks kept (same category/direction,
              overlapping), boundary change of kept tracks
  injections  clean recall and IoU of the strength-1 synthetic injections
              on the perturbed take (scripts/eval_detection.py kinds)

Intermediate audio / alignments / features go to results/tmp/robustness/
(git-ignored); the report to results/validation/robustness.json and
ROBUSTNESS.md.

    python scripts/robustness.py                  # all conditions (~20 min, CPU)
    python scripts/robustness.py --condition gain_-12db
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.eval_detection import KINDS, flaw_tracks, inject, injection_sites, truth_span  # noqa: E402
from src.alignment import SAMPLE_RATE, AlignmentConfig, build_alignment_doc, load_alignment, load_audio  # noqa: E402
from src.baseline import BaselineConfig, load_take, reference_takes, value_table  # noqa: E402
from src.detection import DetectionConfig, baseline_for, detect_take  # noqa: E402
from src.evaluation import (  # noqa: E402
    boundary_errors, classify_injection, dumps, file_hashes, fmt, summarize, write_text,
)
from src.features import energy, pause, pitch, rate, spectral  # noqa: E402
from src.flaws import FlawConfig, score_detection  # noqa: E402

WORK = Path("results/tmp/robustness")
CONDITIONS = {
    "clean_rerun": ("none", None),
    "noise_snr30": ("noise", 30.0),
    "noise_snr20": ("noise", 20.0),
    "noise_snr10": ("noise", 10.0),
    "gain_-12db": ("gain", -12.0),
    "gain_+6db": ("gain", 6.0),
    "mp3_32k": ("mp3", 0.5),
    "mp3_24k": ("mp3", 0.9),
    "resample_8k": ("resample", 8000),
    "resample_22k": ("resample", 22050),
}
DRIFT_FEATURES = ("f0_median_st", "log_f0_span_std", "energy_rel_db", "log_duration", "pause_after_s",
                  "centroid_rel_oct")
SHIFT_S = 0.05


# --------------------------------------------------------------- perturbation


def seed_for(condition: str, speech_id: str, take_id: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{condition}/{speech_id}/{take_id}".encode()).digest()[:4], "little")


def speech_power(audio: np.ndarray, words: list[dict]) -> float:
    idx = np.zeros(len(audio), dtype=bool)
    for w in words:
        if w["aligned"]:
            idx[int(w["start"] * SAMPLE_RATE):int(w["end"] * SAMPLE_RATE)] = True
    return float(np.mean(audio[idx] ** 2)) if idx.any() else float(np.mean(audio ** 2))


def perturb(audio: np.ndarray, condition: str, words: list[dict], seed: int) -> tuple[np.ndarray, dict]:
    """Deterministic perturbation; returns (audio, info)."""
    kind, param = CONDITIONS[condition]
    x = np.asarray(audio, dtype=np.float64)
    info = {"kind": kind, "param": param}
    if kind == "noise":
        p = speech_power(x, words)
        noise = np.random.default_rng(seed).standard_normal(len(x)) * np.sqrt(p / 10 ** (param / 10))
        y = x + noise
    elif kind == "gain":
        y = x * 10 ** (param / 20)
    elif kind == "mp3":
        buf = io.BytesIO()
        sf.write(buf, x.astype(np.float32), SAMPLE_RATE, format="MP3", subtype="MPEG_LAYER_III",
                 compression_level=param)
        info["kbps"] = round(buf.tell() * 8 / (len(x) / SAMPLE_RATE) / 1000, 1)
        buf.seek(0)
        y, _ = sf.read(buf, dtype="float64")
        y = (y if y.ndim == 1 else y.mean(axis=1))[:len(x)]
        y = np.pad(y, (0, len(x) - len(y)))
    elif kind == "resample":
        from math import gcd
        g = gcd(SAMPLE_RATE, int(param))
        down = resample_poly(x, int(param) // g, SAMPLE_RATE // g)
        y = resample_poly(down, SAMPLE_RATE // g, int(param) // g)[:len(x)]
        y = np.pad(y, (0, len(x) - len(y)))
    else:
        y = x.copy()
    info["clipped_samples"] = int(np.sum(np.abs(y) > 1.0))
    return np.clip(y, -1.0, 1.0), info


# ------------------------------------------------------------------ pipeline


def condition_paths(condition: str) -> dict:
    root = WORK / condition
    return {"dataset": root / "dataset", "alignments": root / "alignments", "features": root / "features"}


def prepare(condition: str, speech_id: str, take_id: str, config: str) -> dict:
    """Perturbed audio -> alignment -> features, cached by audio hash."""
    paths = condition_paths(condition)
    clean_align = load_alignment(Path("results/alignments") / speech_id / f"{take_id}.json")
    audio, info = perturb(load_audio(clean_align["audio"]["path"]), condition, clean_align["words"],
                          seed_for(condition, speech_id, take_id))
    wav = paths["dataset"] / speech_id / "audio" / f"{take_id}.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path("dataset") / speech_id / "transcript.txt", wav.parent.parent / "transcript.txt")
    sf.write(wav, audio, SAMPLE_RATE, subtype="PCM_16")

    align_cfg = replace(AlignmentConfig.from_yaml(config), dataset_dir=str(paths["dataset"]),
                        output_dir=str(paths["alignments"]), asr_qc=False)
    doc = build_alignment_doc(speech_id, take_id, align_cfg)  # cached by audio hash + settings
    out = str(paths["features"])
    feats = paths["features"] / speech_id
    stale = [m for m in (pitch, energy, rate, pause, spectral)
             if not (feats / f"{take_id}.{m.__name__.rsplit('.', 1)[1]}.json").exists()
             or json.loads((feats / f"{take_id}.{m.__name__.rsplit('.', 1)[1]}.json").read_text(encoding="utf-8"))
             ["alignment_cache_key"] != doc["cache_key"]]
    if stale:  # pitch before energy (energy reads the pitch voicing)
        pitch.extract_take(speech_id, take_id, replace(pitch.PitchConfig.from_yaml(config), output_dir=out), align_cfg)
        energy.extract_take(speech_id, take_id, replace(energy.EnergyConfig.from_yaml(config), output_dir=out),
                            align_cfg)
        rate.extract_take(speech_id, take_id, replace(rate.RateConfig.from_yaml(config), output_dir=out), align_cfg)
        pause.extract_take(speech_id, take_id, replace(pause.PauseConfig.from_yaml(config), output_dir=out),
                           align_cfg)
        spectral.extract_take(speech_id, take_id, replace(spectral.SpectralConfig.from_yaml(config), output_dir=out),
                              align_cfg)
    info["audio_sha256"] = doc["audio"]["sha256"]
    return {"align_cfg": align_cfg, "features_dir": out, "info": info}


# ------------------------------------------------------------------ metrics


def alignment_shift(clean: dict, pert: dict) -> dict:
    shifts = [max(abs(a["start"] - b["start"]), abs(a["end"] - b["end"]))
              for a, b in zip(clean["words"], pert["words"]) if a["aligned"] and b["aligned"]]
    return {"n_words": len(clean["words"]), "n_aligned": sum(w["aligned"] for w in pert["words"]),
            "qc_status": pert["quality"]["status"], "n_low_score": pert["quality"]["n_low_score"],
            "shift_s": summarize(shifts), "words_shifted_gt_50ms": sum(s > SHIFT_S for s in shifts)}


def feature_drift(clean_take: dict, pert_take: dict, baseline: dict) -> dict:
    """|perturbed - clean| per normalized word feature, in units of the reference scale."""
    span = BaselineConfig(**{k: baseline["settings"][k] for k in
                             ("pitch_span_words", "pitch_span_min_words", "pitch_span_floor_st")})
    c, p = value_table(clean_take, span)["words"], value_table(pert_take, span)["words"]
    out = {}
    for name in DRIFT_FEATURES:
        drift, lost, gained = [], 0, 0
        for wc, wp, wb in zip(c, p, baseline["words"]):
            vc, vp, scale = wc[name][0], wp[name][0], wb["features"][name].get("scale")
            if vc is not None and vp is None:
                lost += 1
            elif vc is None and vp is not None:
                gained += 1
            elif vc is not None and scale:
                drift.append(abs(vp - vc) / scale)
        out[name] = {"z_drift": summarize(drift), "lost": lost, "gained": gained}
    return out


def _covered(tracks):
    return {i for t in tracks for i in range(t["start_idx"], t["end_idx"] + 1)}


def detection_change(clean_tracks: list[dict], pert_tracks: list[dict]) -> dict:
    kept, moves = 0, []
    for t in clean_tracks:
        same = [u for u in pert_tracks if u["category"] == t["category"] and u["direction"] == t["direction"]
                and u["start_idx"] <= t["end_idx"] and u["end_idx"] >= t["start_idx"]]
        if same:
            kept += 1
            u = min(same, key=lambda u: (abs(u["start"] - t["start"]) + abs(u["end"] - t["end"]), u["start_idx"]))
            moves.append(max(abs(u["start"] - t["start"]), abs(u["end"] - t["end"])))
    a, b = _covered(clean_tracks), _covered(pert_tracks)
    new = [u for u in pert_tracks if not any(u["category"] == t["category"] and u["direction"] == t["direction"]
                                             and u["start_idx"] <= t["end_idx"] and u["end_idx"] >= t["start_idx"]
                                             for t in clean_tracks)]
    return {"clean_tracks": len(clean_tracks), "perturbed_tracks": len(pert_tracks), "kept": kept,
            "new": len(new),
            "new_by_track": dict(sorted(Counter(f"{u['category']}/{u['direction']}" for u in new).items())),
            "word_jaccard": round(len(a & b) / len(a | b), 4) if a | b else 1.0,
            "boundary_move_s": summarize(moves)}


def injection_recall(take: dict, baseline: dict, dcfg: DetectionConfig, fcfg: FlawConfig) -> dict:
    control = flaw_tracks(score_detection(detect_take(take, baseline, dcfg), fcfg))
    hits = n = 0
    ious = []
    for kind, (cat, direction) in KINDS.items():
        for a, b in injection_sites(take, kind):
            det = detect_take(inject(take, kind, a, b), baseline, dcfg)
            res = classify_injection(flaw_tracks(score_detection(det, fcfg)), control, cat, direction, a, b)
            if res["confounded"] or not any(det["words"][i]["categories"][cat] is not None for i in range(a, b + 1)):
                continue
            n += 1
            if res["tp"] is not None:
                hits += 1
                ious.append(boundary_errors(res["tp"], truth_span(det["words"], kind, a, b), a, b)["iou"])
    return {"n_clean": n, "detected": hits, "recall": round(hits / n, 4) if n else None,
            "mean_iou": round(float(np.mean(ious)), 4) if ious else None}


def evaluate_condition(condition: str, config: str) -> dict:
    align_cfg, base_cfg = AlignmentConfig.from_yaml(config), BaselineConfig.from_yaml(config)
    dcfg, fcfg = DetectionConfig.from_yaml(config), FlawConfig.from_yaml(config)
    per_take = {}
    for speech_id in sorted(p.name for p in Path(align_cfg.output_dir).iterdir() if p.is_dir()):
        for take_id in reference_takes(speech_id, base_cfg, align_cfg):
            prep = prepare(condition, speech_id, take_id, config)
            baseline, _ = baseline_for(speech_id, take_id, base_cfg, align_cfg)
            clean = load_take(speech_id, take_id, base_cfg, align_cfg)
            pert = load_take(speech_id, take_id, replace(base_cfg, features_dir=prep["features_dir"]),
                             prep["align_cfg"])
            ct = flaw_tracks(score_detection(detect_take(clean, baseline, dcfg), fcfg))
            pt = flaw_tracks(score_detection(detect_take(pert, baseline, dcfg), fcfg))
            per_take[f"{speech_id}/{take_id}"] = {
                "perturbation": prep["info"],
                "alignment": alignment_shift(clean["alignment"], pert["alignment"]),
                "features": feature_drift(clean, pert, baseline),
                "detection": detection_change(ct, pt),
                "injections": {"clean": injection_recall(clean, baseline, dcfg, fcfg),
                               "perturbed": injection_recall(pert, baseline, dcfg, fcfg)},
            }
            print(f"  {condition} {speech_id}/{take_id}: tracks {len(ct)} -> {len(pt)}  "
                  f"jaccard {per_take[f'{speech_id}/{take_id}']['detection']['word_jaccard']}", flush=True)
    return per_take


def aggregate(per_take: dict) -> dict:
    takes = list(per_take.values())
    det = [t["detection"] for t in takes]
    inj_c = [t["injections"]["clean"] for t in takes]
    inj_p = [t["injections"]["perturbed"] for t in takes]

    def recall(items):
        n = sum(i["n_clean"] for i in items)
        return round(sum(i["detected"] for i in items) / n, 4) if n else None
    return {
        "alignment_mean_shift_s": round(float(np.mean([t["alignment"]["shift_s"]["mean"] for t in takes])), 4),
        "alignment_p90_shift_s": round(float(np.mean([t["alignment"]["shift_s"]["p90"] for t in takes])), 4),
        "words_shifted_gt_50ms": sum(t["alignment"]["words_shifted_gt_50ms"] for t in takes),
        "n_words": sum(t["alignment"]["n_words"] for t in takes),
        "qc_status": sorted({t["alignment"]["qc_status"] for t in takes}),
        "z_drift_median": {f: round(float(np.median([t["features"][f]["z_drift"]["median"] for t in takes
                                                      if t["features"][f]["z_drift"]["n"]])), 4)
                           for f in DRIFT_FEATURES},
        "values_lost": {f: sum(t["features"][f]["lost"] for t in takes) for f in DRIFT_FEATURES},
        "clean_tracks": sum(d["clean_tracks"] for d in det),
        "perturbed_tracks": sum(d["perturbed_tracks"] for d in det),
        "kept_tracks": sum(d["kept"] for d in det),
        "new_tracks": sum(d["new"] for d in det),
        "new_by_track": dict(sorted(sum((Counter(d["new_by_track"]) for d in det), Counter()).items())),
        "mean_word_jaccard": round(float(np.mean([d["word_jaccard"] for d in det])), 4),
        "kept_boundary_move_s_mean": round(float(np.mean([m for d in det for m in
                                                          ([d["boundary_move_s"]["mean"]] if d["boundary_move_s"]["n"] else [])]
                                                         or [0.0])), 4),
        "injection_recall_clean": recall(inj_c),
        "injection_recall_perturbed": recall(inj_p),
    }


def render(rep: dict) -> str:
    L = ["# RhetorTrace robustness to audio perturbations", "",
         "Generated by `python scripts/robustness.py`; per-take details in `robustness.json`.",
         "Each good take's audio is perturbed, re-aligned and re-featurized with the existing pipeline, then scored "
         "against the clean leave-one-out baseline and compared with its clean outputs.", "",
         "| condition | align shift mean / p90 (s) | words >50 ms | z drift (median): f0 / span / energy / dur / pause / "
         "centroid | values lost (f0 / energy) | flaw tracks clean -> pert (kept, new) | flagged-word Jaccard | "
         "injection recall clean -> pert |",
         "|---|---|---:|---|---|---|---:|---|"]
    for cond, v in rep["conditions"].items():
        a = v["summary"]
        zd = " / ".join(fmt(a["z_drift_median"][f], nd=2) for f in DRIFT_FEATURES)
        L.append(f"| {cond} | {a['alignment_mean_shift_s']:.3f} / {a['alignment_p90_shift_s']:.3f} | "
                 f"{a['words_shifted_gt_50ms']}/{a['n_words']} | {zd} | "
                 f"{a['values_lost']['f0_median_st']} / {a['values_lost']['energy_rel_db']} | "
                 f"{a['clean_tracks']} -> {a['perturbed_tracks']} ({a['kept_tracks']}, {a['new_tracks']}) | "
                 f"{a['mean_word_jaccard']:.2f} | {fmt(a['injection_recall_clean'], pct=True)} -> "
                 f"{fmt(a['injection_recall_perturbed'], pct=True)} |")
    L += ["", "z drift: |perturbed - clean| of a normalized word feature in units of that word's reference scale "
          "(1.0 = one typical take-to-take difference). Kept = clean flaw tracks with a same-category/direction "
          "overlapping track after perturbation.", "",
          "New flaw tracks on the perturbed (otherwise clean) takes, by category/direction:", "",
          "| condition | new tracks |", "|---|---|"]
    for cond, v in rep["conditions"].items():
        new = v["summary"].get("new_by_track", {})
        L.append(f"| {cond} | {', '.join(f'{k} {n}' for k, n in new.items()) or '-'} |")
    L.append("")
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Audio-perturbation robustness of the full pipeline.")
    parser.add_argument("--condition", action="append", choices=sorted(CONDITIONS))
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--out", default="results/validation")
    args = parser.parse_args(argv)

    out_json = Path(args.out) / "robustness.json"
    rep = json.loads(out_json.read_text(encoding="utf-8")) if out_json.exists() and args.condition else {}
    rep.setdefault("conditions", {})
    for cond in args.condition or list(CONDITIONS):
        per_take = evaluate_condition(cond, args.config)
        rep["conditions"][cond] = {"summary": aggregate(per_take), "per_take": per_take}
    rep["conditions"] = {c: rep["conditions"][c] for c in CONDITIONS if c in rep["conditions"]}
    rep["metadata"] = {"config": file_hashes([args.config]),
                       "code": file_hashes(["scripts/robustness.py", "src/alignment.py", "src/features/pitch.py",
                                            "src/features/energy.py", "src/features/rate.py", "src/features/pause.py",
                                            "src/features/spectral.py", "src/detection.py", "src/flaws.py",
                                            "src/baseline.py"])}
    write_text(out_json, dumps(rep))
    write_text(Path(args.out) / "ROBUSTNESS.md", render(rep))
    print(render(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
