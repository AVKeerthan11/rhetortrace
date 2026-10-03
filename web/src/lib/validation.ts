import type { Category, RobustnessSummary } from "./types";

// Plain-language labels for the validation reports. Values themselves come from index.json.

/** Injected flaw kinds (scripts/evaluate.py, scripts/build_demo.py). */
export const KIND: Record<string, { label: string; category: Category; how: string }> = {
  fast: { label: "Rushed phrase", category: "pacing", how: "a phrase sped up" },
  slow: { label: "Dragged phrase", category: "pacing", how: "a phrase slowed down" },
  quiet: { label: "Quieter phrase", category: "energy", how: "a phrase made quieter" },
  monotone: { label: "Monotone phrase", category: "pitch", how: "a phrase's pitch flattened" },
  monotone_mild: { label: "Slightly flattened pitch", category: "pitch", how: "a phrase's pitch partly flattened" },
  long_pause: { label: "Inserted long pause", category: "pause", how: "a long silence inserted between two words" },
  missing_pause: { label: "Removed pause", category: "pause", how: "a natural pause removed" },
};

export const kindLabel = (k: string) => KIND[k]?.label ?? k.replaceAll("_", " ");

/** Audio degradations of scripts/robustness.py, grouped for reading. */
export const CONDITIONS: { key: string; group: string; label: string }[] = [
  { key: "clean_rerun", group: "Control", label: "Same audio, run again" },
  { key: "gain_+6db", group: "Volume", label: "6 dB louder" },
  { key: "gain_-12db", group: "Volume", label: "12 dB quieter" },
  { key: "resample_22k", group: "Sample rate", label: "Resampled to 22 kHz" },
  { key: "resample_8k", group: "Sample rate", label: "Telephone band, 8 kHz" },
  { key: "mp3_32k", group: "Compression", label: "MP3 at 32 kbps" },
  { key: "mp3_24k", group: "Compression", label: "MP3 at 24 kbps" },
  { key: "noise_snr30", group: "Background noise", label: "Light noise, 30 dB SNR" },
  { key: "noise_snr20", group: "Background noise", label: "Moderate noise, 20 dB SNR" },
  { key: "noise_snr10", group: "Background noise", label: "Heavy noise, 10 dB SNR" },
];

export type Verdict = "stable" | "false-alarms" | "breaks";

/** Reading of one condition: does detection of real flaws suffer, or only false alarms grow?
 *  Thresholds are presentation choices (10 points of recall; more new tracks than the 28 clean ones would be a doubling). */
export function verdict(r: RobustnessSummary): Verdict {
  if (r.injection_recall_clean - r.injection_recall_perturbed >= 0.1) return "breaks";
  if (r.new_tracks > r.clean_tracks / 2) return "false-alarms";
  return "stable";
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  stable: "Holds up",
  "false-alarms": "More false alarms",
  breaks: "Misses real flaws",
};

/** "pacing/slow" -> category + direction (clarity has no direction: "clarity/None"). */
export function splitTrack(key: string): { category: Category; direction: string | null } {
  const [c, d] = key.split("/");
  return { category: c as Category, direction: d === "None" ? null : d };
}

/** Word features compared in the robustness z-drift table. */
export const FEATURE_LABEL: Record<string, string> = {
  f0_median_st: "Pitch level",
  log_f0_span_std: "Pitch movement",
  energy_rel_db: "Loudness",
  log_duration: "Word length",
  pause_after_s: "Pause after word",
  centroid_rel_oct: "Brightness",
};

export const pct = (x: number | null | undefined, nd = 0) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(nd)}%`);
