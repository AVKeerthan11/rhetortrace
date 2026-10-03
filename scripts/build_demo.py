"""Synthetic audio-injection demo takes (DEMO DATA, not human flawed recordings).

A good take is edited at the audio level with Praat (parselmouth), at word
spans fixed below, and then processed by the unchanged pipeline: forced
alignment, all features, detection (baseline without the source take, see
``src.detection.baseline_for``) and flaw refinement / severity / explanation.

Edits (word spans in the source take's alignment):
  fast        span time-compressed to 0.67 x its duration (Praat overlap-add
              "Lengthen", pitch preserved)
  slow        span stretched to 1.5 x
  long_pause  1.0 s of the take's own background (its leading silence, tiled)
              inserted in the gap after a word that had no pause
  monotone    span resynthesized with a flat pitch at its own median F0
              (Praat Manipulation, overlap-add); duration unchanged
Splices use 5 ms linear crossfades. The ground truth is the edited word span
(a pause: the gap after its word), recorded with times from the new alignment.

Outputs:
  dataset/<speech>/audio/<take>.wav            (git-ignored; rebuilt from the source)
  results/demo/<speech>/<take>.json            manifest + ground truth (schema: src/demo.py;
                                               written once, complete, before detection reads it)
  results/{alignments,features,detections,flaws}/<speech>/<take>.*

    python scripts/build_demo.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import parselmouth
import soundfile as sf
from parselmouth.praat import call, run

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.alignment import SAMPLE_RATE, AlignmentConfig, build_alignment_doc, load_alignment, load_audio  # noqa: E402
from src.baseline import BaselineConfig, load_take  # noqa: E402
from src.demo import SCHEMA_VERSION as MANIFEST_SCHEMA, remove_manifest, write_manifest  # noqa: E402
from src.detection import DetectionConfig, baseline_for, detect_take, save_detection  # noqa: E402
from src.features import energy, pause, pitch, rate, spectral  # noqa: E402
from src.flaws import FlawConfig, save_flaws, score_detection  # noqa: E402

LABEL = "synthetic audio injection"
DEMOS = {  # (speech, demo take): source take and edits (kind, first word, last word)
    ("speech_01", "synth_01"): ("good_02", [("fast", 7, 14), ("slow", 40, 47), ("long_pause", 60, 60),
                                            ("monotone", 92, 100)]),
    ("speech_02", "synth_01"): ("good_03", [("slow", 6, 13), ("fast", 24, 31), ("long_pause", 50, 50),
                                            ("monotone", 98, 107)]),
}
KIND = {"fast": ("pacing", "fast"), "slow": ("pacing", "slow"), "long_pause": ("pause", "long"),
        "monotone": ("pitch", "flatter")}
FACTOR = {"fast": 0.67, "slow": 1.5}
PAUSE_S = 1.0
XFADE_S = 0.005
PITCH_RANGE = (75.0, 500.0)
PRAAT_SEED = 1337  # config.yaml reproducibility.seed


# ------------------------------------------------------------------ editing


def lengthen(seg: np.ndarray, factor: float) -> np.ndarray:
    """Pitch-preserving time scaling. Praat's overlap-add draws on its random generator
    when the duration changes, so it is seeded for this call (byte-identical demo audio)."""
    s = parselmouth.Sound(seg.astype(np.float64), SAMPLE_RATE)
    run(f"random_initializeWithSeedUnsafelyButPredictably ({PRAAT_SEED})")
    try:
        return call(s, "Lengthen (overlap-add)", *PITCH_RANGE, factor).values[0]
    finally:
        run("random_initializeSafelyAndUnpredictably ()")


def flatten_pitch(seg: np.ndarray) -> np.ndarray:
    s = parselmouth.Sound(seg.astype(np.float64), SAMPLE_RATE)
    f0 = s.to_pitch_ac(time_step=0.01, pitch_floor=PITCH_RANGE[0], pitch_ceiling=PITCH_RANGE[1])
    voiced = f0.selected_array["frequency"]
    voiced = voiced[voiced > 0]
    manip = call(s, "To Manipulation", 0.01, *PITCH_RANGE)
    tier = call("Create PitchTier", "flat", s.xmin, s.xmax)
    call(tier, "Add point", (s.xmin + s.xmax) / 2, float(np.median(voiced)))
    call([tier, manip], "Replace pitch tier")
    out = call(manip, "Get resynthesis (overlap-add)").values[0]
    return out[:len(seg)] if len(out) >= len(seg) else np.pad(out, (0, len(seg) - len(out)))


def background(audio: np.ndarray, first_start: float, length: int) -> np.ndarray:
    """The take's own leading silence, tiled to ``length`` samples (with crossfades)."""
    lead = audio[int(0.1 * SAMPLE_RATE):int((first_start - 0.1) * SAMPLE_RATE)]
    out = lead.copy()
    while len(out) < length:
        out = splice(out, lead)
    return out[:length]


def splice(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    n = min(int(XFADE_S * SAMPLE_RATE), len(a), len(b))
    if n == 0:
        return np.concatenate([a, b])
    ramp = np.linspace(0.0, 1.0, n)
    return np.concatenate([a[:-n], a[-n:] * (1 - ramp) + b[:n] * ramp, b[n:]])


def apply_edits(audio: np.ndarray, words: list[dict], edits: list) -> tuple[np.ndarray, list[dict]]:
    """Edited audio and per-edit records (original times)."""
    cuts, records = [], []
    for kind, a, b in sorted(edits, key=lambda e: e[1]):
        if kind == "long_pause":
            t = (words[a]["end"] + words[a + 1]["start"]) / 2
            cuts.append((t, t, kind))
            records.append({"kind": kind, "word_range": [a, b], "original": [words[a]["end"], words[a + 1]["start"]],
                            "params": {"inserted_s": PAUSE_S}})
        else:
            t0, t1 = words[a]["start"], words[b]["end"]
            cuts.append((t0, t1, kind))
            records.append({"kind": kind, "word_range": [a, b], "original": [t0, t1],
                            "params": {"factor": FACTOR[kind]} if kind in FACTOR else {"pitch": "flat at span median"}})
    out, pos = np.zeros(0), 0
    for t0, t1, kind in cuts:
        i0, i1 = int(round(t0 * SAMPLE_RATE)), int(round(t1 * SAMPLE_RATE))
        out = splice(out, audio[pos:i0]) if len(out) else audio[pos:i0].astype(np.float64)
        seg = audio[i0:i1].astype(np.float64)
        if kind == "long_pause":
            seg = background(audio, words[0]["start"], int(PAUSE_S * SAMPLE_RATE))
        elif kind in FACTOR:
            seg = lengthen(seg, FACTOR[kind])
        else:
            seg = flatten_pitch(seg)
        out = splice(out, seg)
        pos = i1
    out = splice(out, audio[pos:].astype(np.float64))
    return np.clip(out, -1.0, 1.0), records


# ----------------------------------------------------------------- pipeline


def check_sites(source: dict, pause_doc: dict, edits: list) -> None:
    for kind, a, b in edits:
        if kind == "long_pause":
            w = pause_doc["words"][a]
            if w["boundary_after"] != "within_sentence" or w["is_pause_after"] is not False:
                raise ValueError(f"long_pause after word {a} must be a within-sentence non-pause gap")
        low = set(source["quality"]["low_score_idx"]) | set(source["quality"]["too_short_idx"])
        if low & set(range(a, b + 2 if kind == "long_pause" else b + 1)):
            raise ValueError(f"{kind} {a}-{b} touches low-confidence words {sorted(low & set(range(a, b + 2)))}")


def ground_truth(records: list[dict], words: list[dict]) -> list[dict]:
    """Injected spans with times from the edited take's own alignment (a pause: the gap after its word)."""
    out = []
    for rec in records:
        a, b = rec["word_range"]
        cat, direction = KIND[rec["kind"]]
        start, end = (words[a]["end"], words[a + 1]["start"]) if rec["kind"] == "long_pause"             else (words[a]["start"], words[b]["end"])
        out.append({"kind": rec["kind"], "category": cat, "direction": direction,
                    "start_idx": a, "end_idx": b, "start": start, "end": end})
    return out


def build(speech_id: str, take_id: str, config: str) -> dict:
    source_take, edits = DEMOS[(speech_id, take_id)]
    align_cfg = AlignmentConfig.from_yaml(config)
    source = load_alignment(Path(align_cfg.output_dir) / speech_id / f"{source_take}.json")
    feats = Path(BaselineConfig.from_yaml(config).features_dir) / speech_id
    check_sites(source, json.loads((feats / f"{source_take}.pause.json").read_text(encoding="utf-8")), edits)
    # a stale manifest must not outlive a failed rebuild: until the new one is written
    # this take has none (and the dashboard exporter refuses to export it)
    remove_manifest(speech_id, take_id)

    audio, records = apply_edits(load_audio(source["audio"]["path"]), source["words"], edits)
    wav = Path(align_cfg.dataset_dir) / speech_id / "audio" / f"{take_id}.wav"
    sf.write(wav, audio, SAMPLE_RATE, subtype="PCM_16")
    doc = build_alignment_doc(speech_id, take_id, align_cfg)

    # one complete manifest, written before detection reads source_take from it
    manifest = {"schema_version": MANIFEST_SCHEMA, "speech_id": speech_id, "take_id": take_id, "label": LABEL,
                "source_take": source_take, "source_audio_sha256": source["audio"]["sha256"],
                "audio_sha256": doc["audio"]["sha256"], "edits": records,
                "ground_truth": ground_truth(records, doc["words"])}
    write_manifest(manifest)

    for module, cfg_cls in ((pitch, pitch.PitchConfig), (energy, energy.EnergyConfig), (rate, rate.RateConfig),
                            (pause, pause.PauseConfig), (spectral, spectral.SpectralConfig)):
        module.extract_take(speech_id, take_id, cfg_cls.from_yaml(config), align_cfg)
    base_cfg = BaselineConfig.from_yaml(config)
    baseline, source_path = baseline_for(speech_id, take_id, base_cfg, align_cfg)
    detection = detect_take(load_take(speech_id, take_id, base_cfg, align_cfg), baseline,
                            DetectionConfig.from_yaml(config), source_path)
    save_detection(detection, DetectionConfig.from_yaml(config))
    flaws = score_detection(detection, FlawConfig.from_yaml(config))
    save_flaws(flaws, FlawConfig.from_yaml(config))
    return {"manifest": manifest, "flaws": flaws}


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Build synthetic audio-injection demo takes.")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args(argv)
    for speech_id, take_id in DEMOS:
        out = build(speech_id, take_id, args.config)
        print(f"{speech_id}/{take_id} ({LABEL}, from {out['manifest']['source_take']}):")
        for gt in out["manifest"]["ground_truth"]:
            print(f"  truth  {gt['kind']:10s} w{gt['start_idx']}-{gt['end_idx']}  {gt['start']:.2f}-{gt['end']:.2f}s")
        for f in out["flaws"]["flaws"]:
            print(f"  flaw   {f['category']}/{f['direction']}  w{f['start_idx']}-{f['end_idx']}  "
                  f"{f['start']:.2f}-{f['end']:.2f}s  {f['severity']['label']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
