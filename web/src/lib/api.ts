import type { Take } from "./types";

// Client of the analysis server (src/server.py). The dev / preview server proxies /api to it
// (vite.config.ts), so the static demo works without it and nothing here is needed for /data.

export const API = "/api";

/** Uploaded analyses are addressed by their run id ("job-20261003-104058-9ea136e8"). */
export const isRunId = (id: string | undefined | null): id is string => !!id && /^job-[a-z0-9-]+$/.test(id);

export type StageName = "ingest" | "align" | "features" | "baseline" | "detection" | "flaws" | "export";
export type JobState = "queued" | "running" | "succeeded" | "failed";

/** Plain names for the pipeline's stages (src/pipeline.py STAGES). */
export const STAGE_TEXT: Record<StageName, { title: string; body: string }> = {
  ingest: { title: "Checking the files", body: "Audio converted to 16 kHz mono; length, silence and transcript checked." },
  align: { title: "Lining up words with the audio", body: "Speech models time every word and check the recording follows the transcript. The slowest step." },
  features: { title: "Measuring the delivery", body: "Pitch, loudness, pace, pauses and voice quality, word by word." },
  baseline: { title: "Learning the reference range", body: "How the good deliveries vary on each word." },
  detection: { title: "Finding moments that differ", body: "Words where your delivery falls outside that range." },
  flaws: { title: "Scoring each finding", body: "Severity, exact boundaries and a plain explanation." },
  export: { title: "Preparing the results", body: "Contours, waveform and audio for the player." },
};


export interface ErrorInfo {
  code: string;
  kind: "input" | "refused" | "stale" | "config" | "internal" | string;
  stage: string | null;
  message: string;
  detail: Record<string, unknown>;
}

export interface Stage {
  name: StageName;
  state: "pending" | "running" | "done" | "failed";
  seconds: number | null;
  [info: string]: unknown;
}

export interface RunStatus {
  run_id: string;
  state: JobState;
  queue_position: number | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  stage: StageName | null;
  stages: Stage[] | null;
  warnings: string[];
  error: ErrorInfo | null;
  results_url: string | null;
}

export interface Submitted {
  run_id: string;
  state: JobState;
  queue_position: number | null;
  status_url: string;
  results_url: string;
}

export interface RunResult {
  run_id: string;
  result: { run_id: string; id: string; n_flaws: number; score: number; warnings: string[] };
  document: Take;
  audio: Record<string, string>;
}

/** A failed request: the server's typed error (src/errors.py to_dict), or a transport problem. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: string;
  readonly stage: string | null;
  readonly detail: Record<string, unknown>;

  constructor(status: number, info: Partial<ErrorInfo> & { message: string }) {
    super(info.message);
    this.name = "ApiError";
    this.status = status;
    this.code = info.code ?? "error";
    this.kind = info.kind ?? (status >= 500 ? "internal" : "input");
    this.stage = info.stage ?? null;
    this.detail = info.detail ?? {};
  }
}

/** status 0: the server could not be reached at all. */
export const unreachable = () =>
  new ApiError(0, { code: "server_unreachable", kind: "internal", message: "The analysis server is not reachable." });

async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // proxy errors (backend down) and HTML pages are not JSON
  }
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail) && "message" in detail)
    return new ApiError(res.status, detail as ErrorInfo);
  if (Array.isArray(detail)) {
    // FastAPI request validation: [{loc: ["body", "audio"], msg: "Field required"}, ...]
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    const field = first?.loc?.slice(1).join(".");
    return new ApiError(res.status, { code: "invalid_request", kind: "input", message: `${field ? `${field}: ` : ""}${first?.msg ?? "invalid request"}` });
  }
  if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status === 500 && body === null)) {
    return res.status === 503 ? new ApiError(503, { code: "busy", kind: "internal", message: "The analysis server is busy. Try again in a moment." })
      : unreachable();
  }
  return new ApiError(res.status, { message: `HTTP ${res.status}` });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, init);
  } catch {
    throw unreachable();
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

export interface AnalysisRequest {
  audio: File;
  /** a file, or pasted text (sent as transcript.txt) */
  transcript: File | string | null;
  references: File[];
  /** instead of references: a dataset script's clean takes ("speech_01") */
  referencesFrom?: string | null;
  name?: string;
}

export function analysisForm(req: AnalysisRequest): FormData {
  const form = new FormData();
  form.append("audio", req.audio, req.audio.name);
  if (typeof req.transcript === "string") {
    form.append("transcript", new File([req.transcript], "transcript.txt", { type: "text/plain" }));
  } else if (req.transcript) {
    form.append("transcript", req.transcript, req.transcript.name);
  }
  if (req.referencesFrom) form.append("references_from", req.referencesFrom);
  else for (const r of req.references) form.append("references", r, r.name);
  if (req.name) form.append("name", req.name);
  return form;
}

export const submitAnalysis = (req: AnalysisRequest) =>
  request<Submitted>("/analyze", { method: "POST", body: analysisForm(req) });

export const getStatus = (runId: string) => request<RunStatus>(`/status/${runId}`);
export const getResult = (runId: string) => request<RunResult>(`/results/${runId}`);

/** The server's take document, made addressable like a dataset take: its id is the run id (so
 *  /take/<run id>/... routes work) and its audio points at the server's FLAC files. */
export function resultToTake(res: RunResult): Take {
  const doc = res.document;
  const served = (path: string) => {
    const file = path.split("/").pop()!;
    const url = res.audio[file];
    return url ? `api${url}` : path; // audioUrl() adds the leading "/"
  };
  return { ...doc, id: res.run_id, audio: served(doc.audio), references: doc.references.map((r) => ({ ...r, audio: served(r.audio) })) };
}

/** Whether the analysis server answers (the static demo works either way). */
export async function serverAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/openapi.json`);
    return res.ok && (res.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

// ------------------------------------------------------- recent analyses (this browser)

export interface RecentRun {
  run_id: string;
  name: string;
  submitted_at: string;
}

const RECENT_KEY = "rhetortrace.recentRuns";

export function recentRuns(): RecentRun[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((r) => isRunId(r?.run_id)) : [];
  } catch {
    return [];
  }
}

export function rememberRun(run: RecentRun) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([run, ...recentRuns().filter((r) => r.run_id !== run.run_id)].slice(0, 8)));
  } catch {
    // storage unavailable (private mode): the run is still reachable by its URL
  }
}

// ------------------------------------------------------------ plain-language errors

export interface Explained {
  title: string;
  /** what to do about it */
  hint: string | null;
}

/** A short title and advice for a typed error; the server's own message is shown under it. */
export function explainError(e: Pick<ErrorInfo, "code" | "kind" | "detail"> & { status?: number }): Explained {
  switch (e.code) {
    case "server_unreachable":
      return { title: "The analysis server is not running", hint: "Start it with python -m src.server, then try again. The demo recordings work without it." };
    case "busy":
      return { title: "The analysis server is busy", hint: "Several analyses are already waiting. Try again in a few minutes." };
    case "upload_too_large":
      return { title: "A file is too large", hint: "Shorten or compress the recording (FLAC or MP3 work well) and upload it again." };
    case "empty_upload":
      return { title: "A file is empty", hint: "Choose the file again; it may not have finished saving." };
    case "off_script":
      return { title: "The recording does not follow the transcript", hint: "Check that the transcript is the text actually spoken in this recording." };
    case "alignment_failed":
      return { title: "The words could not be lined up with the audio", hint: "Check the transcript matches the recording and that the speech is clearly audible." };
    case "invalid_audio":
      return { title: "This audio cannot be analysed", hint: "Use a WAV, FLAC, OGG or MP3 file of the speech." };
    case "invalid_transcript":
      return {
        title: "The transcript cannot be used",
        // detail.script: the given text differs from the built-in script's (src/pipeline.py)
        hint: e.detail?.script ? "With built-in references the transcript must be that script's text. Leave it empty to use it as is."
          : "Use a plain UTF-8 text file with the words of the speech.",
      };
    case "invalid_references":
      return { title: "Check the reference recordings", hint: "Give at least two different clean deliveries of the same text." };
    case "model_failed":
      return {
        title: "The speech model stopped",
        hint: e.detail?.out_of_memory ? "The server ran out of memory. Close other programs on it and try again." : "Try again; if it keeps failing, check the server log.",
      };
    case "interrupted":
      return { title: "The server restarted during this analysis", hint: "Submit the recording again." };
  }
  if (e.kind === "input") return { title: "These files cannot be analysed", hint: null };
  if (e.kind === "refused") return { title: "The analysis was stopped", hint: null };
  return { title: "Something went wrong on the analysis server", hint: "Try again; if it keeps failing, check the server log." };
}
