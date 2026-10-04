import type { Take, TakeSummary } from "./types";

// Display names and URLs for takes. Ids look like "speech_01__synth_01".

export const speechName = (speechId: string) => `Speech ${speechId.split("_")[1] ?? speechId}`;

export function takeName(t: Pick<TakeSummary, "kind" | "take_id">): string {
  const n = t.take_id.split("_")[1] ?? "";
  return t.kind === "demo" ? "Demo recording" : t.kind === "user" ? "Your recording" : `Clean recording ${n}`;
}

/** "talk.wav" for an upload, "Speech 01 · Demo recording" for a dataset recording. */
export function recordingTitle(take: Pick<Take, "kind" | "display" | "take_id" | "speech_id">): string {
  return take.kind === "user" ? (take.display?.recording ?? take.take_id) : `${speechName(take.speech_id)} · ${takeName(take)}`;
}

export const takeKindLabel = (kind: TakeSummary["kind"]) => (kind === "demo" ? "Synthetic demo" : kind === "user" ? "Uploaded" : "Control");

/** A reference delivery's name: the uploaded file name, else "good 01". */
export const referenceName = (take: Pick<Take, "display">, takeId: string) => take.display?.references[takeId] ?? takeId.replace("_", " ");

/** Routes. Findings are addressed by their importance rank (1 = most important). */
export const overviewPath = (id: string) => `/take/${id}`;
export const findingPath = (id: string, rank: number) => `/take/${id}/finding/${rank}`;
export const explorePath = (id: string, rank?: number) => `/take/${id}/explore${rank ? `?f=${rank}` : ""}`;
export const homePath = "/";
export const analyzePath = "/analyze";
export const runPath = (runId: string) => `/analyze/${runId}`;
export const recordingsPath = "/recordings";
// Lab: how RhetorTrace is tested (controlled examples and the validation reports)
export const labPath = "/lab";
export const examplesPath = "/lab/examples";
export const evaluationPath = "/lab/evaluation";
export const robustnessPath = "/lab/robustness";
export const methodPath = "/lab/method";

/** "speech_01/good_01" (validation reports) -> "speech_01__good_01" (take id). */
export const caseToId = (c: string) => c.replace("/", "__");

/** "good_01" -> "clean recording 01" */
export const refName = (takeId: string) => (takeId.startsWith("good_") ? `clean recording ${takeId.split("_")[1]}` : takeId.replace("_", " "));

/** Takes grouped by speech, demos first within each speech. */
export function groupBySpeech(takes: TakeSummary[]): { speech: string; opening: string; takes: TakeSummary[] }[] {
  const groups = new Map<string, TakeSummary[]>();
  for (const t of takes) groups.set(t.speech_id, [...(groups.get(t.speech_id) ?? []), t]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([speech, ts]) => ({
      speech,
      opening: ts[0].opening.replace(/\s*\.\.\.$/, "…"),
      takes: ts.sort((a, b) => (a.kind === b.kind ? a.take_id.localeCompare(b.take_id) : a.kind === "demo" ? -1 : 1)),
    }));
}
