// Types of the artifacts exported by scripts/build_dashboard.py (web/public/data/*.json) and, for
// uploaded recordings, served by the analysis server (src/server.py, GET /results/{run_id}).
// They mirror the Python pipeline's outputs; the frontend never recomputes analysis values.

export type Category = "pacing" | "pitch" | "pause" | "energy" | "clarity";
export type Direction = string | null;

export interface ReferencePoint {
  take: string;
  value: number | null;
  excluded: string | null;
}

export interface Measurement {
  idx: number;
  word: string;
  feature: string;
  label: string;
  unit: string;
  observed: number | null;
  reference: number | null;
  comparison: "ratio" | "difference" | null;
  change: number | null;
  z: number;
  stored: { value: number | number[] | null; median: number | number[] | null; scale: number | null };
  statement: string;
  bound?: "upper";
  note?: string;
  reference_points?: ReferencePoint[];
  reference_band?: [number, number];
}

export interface Severity {
  score: number;
  level: number;
  label: string;
  evidence_z: number;
  effective_z: number;
  median_z: number;
  peak_z: number;
  n_evidence_words: number;
  n_top: number;
  support: number;
}

export interface Explanation {
  summary: string;
  headline: string;
  category: Category;
  direction: Direction;
  severity: { level: number; label: string; score: number };
  time: { start: number; end: number; duration_s: number };
  word_range: [number, number];
  words: string[];
  strongest_evidence: Measurement | null;
  supporting_evidence: Measurement[];
  unavailable_evidence: { feature: string; label: string; n_words: number; reasons: Record<string, number> }[];
  confidence: { value: number; label: string };
  quality_flags: { flag: string; note: string }[];
  co_occurring?: {
    category: Category;
    direction: Direction;
    headline: string;
    severity: { level: number; label: string; score: number };
    time: { start: number; end: number; duration_s: number };
    word_range: [number, number];
  }[];
}

export interface Track {
  category: Category;
  direction: Direction;
  start_idx: number;
  end_idx: number;
  start: number;
  end: number;
  duration_s: number;
  start_uncertainty_s: number;
  end_uncertainty_s: number;
  words: string[];
  n_words: number;
  word_coverage: number;
  severity: Severity;
  confidence: number;
  flags: string[];
  strongest_evidence: { idx: number; text: string; feature: string; value: unknown; median: unknown; scale: number; z: number } | null;
  boundary: {
    detected_start_idx: number;
    detected_end_idx: number;
    detected_start: number;
    detected_end: number;
    trimmed_words: number;
    extended_words: number;
  };
  explanation: Explanation;
}

export interface Flaw extends Track {
  flaw_id: number;
  region_id: number;
  secondary: Track[];
}

export interface WordFeature {
  feature: string;
  label: string;
  unit?: string;
  observed?: number | null;
  reference?: number | null;
  z?: number;
  bound?: "upper" | null;
  status?: string;
  reason?: string | null;
}

export interface Word {
  idx: number;
  text: string;
  start: number | null;
  end: number | null;
  sentence: number | null;
  low_confidence: boolean;
  alignment_score: number | null;
  categories: Record<Category, { score: number; direction: Direction; feature: string } | null>;
  features: WordFeature[];
}

export interface ContourSet {
  take: (number | null)[];
  band: { lo: (number | null)[]; hi: (number | null)[]; median: (number | null)[] };
  [reference: string]: unknown;
}

export interface GroundTruth {
  kind: string;
  category: Category;
  direction: Direction;
  start_idx: number;
  end_idx: number;
  start: number;
  end: number;
  detected: boolean;
  detected_span?: [number, number];
  iou?: number;
  word_iou?: number;
  start_err_s?: number;
  end_err_s?: number;
  severity?: string;
}

export interface ProfileRow {
  label: string;
  unit: string;
  n_tracks: number;
  worst: number | null;
  seconds: number;
  word_share: number;
  take_z: number | null;
  observed?: number;
  reference?: number;
}

export interface ScoreRow {
  weight: number;
  n_tracks: number;
  penalty: number;
  score: number;
  contribution: number;
  lost: number;
}

export interface Take {
  id: string;
  speech_id: string;
  take_id: string;
  /** demo: synthetic injection; control: clean dataset take; user: an uploaded recording */
  kind: TakeKind;
  label: string;
  source_take: string | null;
  duration: number;
  audio: string;
  audio_sha256: string;
  transcript: string;
  qc: {
    status: string; warnings: string[]; low_score_idx: number[]; too_short_idx: number[]; aligned_ratio: number; mean_alignment_score: number;
    /** uploaded recordings only: ASR word error rate against the transcript */
    asr_wer?: number | null;
  };
  baseline: { source: string; references: string[]; in_sample: boolean };
  references: { take_id: string; audio: string; words: [number | null, number | null][] }[];
  severity_settings: { level_thresholds: number[]; labels: string[]; z_min: number; z_max: Record<string, number> };
  detection_settings: { z_open: number; z_close: number };
  summary: { n_flaws: number; by_level: Record<string, number>; by_category: Record<string, number>; max_score: number };
  profile: Record<Category, ProfileRow>;
  score: { total: number; categories: Record<Category, ScoreRow>; settings: { weights: Record<string, number>; flaws_to_zero: number } };
  flaws: Flaw[];
  words: Word[];
  contours: { step: number; t0: number; n: number; pitch: ContourSet; energy: ContourSet };
  peaks: { bins: number; min: number[]; max: number[] };
  ground_truth: GroundTruth[] | null;
  edits: { kind: string; word_range: [number, number]; original: [number, number]; params: Record<string, unknown> }[] | null;
  /** uploaded recordings only: the names the files were uploaded under */
  display?: { recording: string; references: Record<string, string> };
}

export type TakeKind = "demo" | "control" | "user";

export interface TakeSummary {
  id: string;
  speech_id: string;
  take_id: string;
  kind: TakeKind;
  label: string;
  source_take: string | null;
  duration: number;
  n_flaws: number;
  score: number;
  opening: string;
  ground_truth: [number, number] | null;
  /** [start, end, category, severity level] per finding */
  marks: [number, number, Category, number][];
}

// ------------------------------------------------------------ validation
// index.json "validation": summaries of results/validation/{evaluation,robustness}.json.

export interface DetectionCounts {
  tp: number;
  fp: number;
  fn: number;
  control_fp: number;
  collateral_fp: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface KindStats {
  n: number;
  n_clean: number;
  recall: number | null;
  iou: number | null;
  start_err: number | null;
  start_err_p90: number | null;
  end_err: number | null;
  end_err_p90: number | null;
  severity: number | null;
  collateral_fp: number;
}

export interface ControlTake {
  case: string;
  n_tracks: number;
  n_words: number;
  tracks: Record<string, number>;
  tracks_per_min: number;
  words_flagged: number;
}

export interface SeverityCalibration {
  strengths: number[];
  detected: number[];
  mean_score: (number | null)[];
  std: (number | null)[];
  monotone: [number, number];
  rho: number | null;
}

export interface ReferenceRun {
  clean_recall: number | null;
  control_tracks: number;
  n_clean: number;
  words_flagged: number;
}

export interface InfluenceCell {
  cells_lost: number;
  max: number;
  mean: number;
  median: number;
  n: number;
  p90: number;
}

export interface RobustnessSummary {
  alignment_mean_shift_s: number;
  alignment_p90_shift_s: number;
  clean_tracks: number;
  perturbed_tracks: number;
  kept_tracks: number;
  new_tracks: number;
  new_by_track: Record<string, number>;
  injection_recall_clean: number;
  injection_recall_perturbed: number;
  kept_boundary_move_s_mean: number;
  mean_word_jaccard: number;
  n_words: number;
  words_shifted_gt_50ms: number;
  values_lost: Record<string, number>;
  z_drift_median: Record<string, number>;
  qc_status: string[];
}

export interface Validation {
  detection: { overall: DetectionCounts; per_category: Record<Category, DetectionCounts>; excluded: Record<string, number> };
  per_kind: Record<string, KindStats>;
  controls: {
    fp_word_rate: number;
    n_tracks: number;
    n_words: number;
    tracks_per_min: number;
    words_flagged: number;
    per_take: ControlTake[];
  };
  severity: Record<string, SeverityCalibration>;
  severity_pooled: [number, number];
  reference: {
    in_sample_vs_loo: Record<string, { in_sample: ReferenceRun; leave_one_out: ReferenceRun }>;
    influence: Record<string, Record<string, Record<Category, InfluenceCell>>>;
  };
  robustness: Record<string, RobustnessSummary>;
  metadata: {
    config: Record<string, string>;
    code: Record<string, string>;
    n_inputs: number;
    libraries: Record<string, string>;
    python: string;
  };
  demo_injections: Record<string, GroundTruth[]>;
}

export interface Index {
  takes: TakeSummary[];
  validation: Validation;
}
