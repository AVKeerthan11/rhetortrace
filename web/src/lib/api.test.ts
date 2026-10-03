import { describe, expect, it, vi } from "vitest";
import { ApiError, analysisForm, explainError, getStatus, isRunId, resultToTake, submitAnalysis, type RunResult } from "./api";
import type { Take } from "./types";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const typed = (status: number, code: string, kind: string, message: string, detail = {}) =>
  json(status, { detail: { code, kind, stage: "submit", message, detail } });
const file = (name: string, text = "x") => new File([text], name);

describe("run ids", () => {
  it("are the server's job ids, not dataset take ids", () => {
    expect(isRunId("job-20261003-104058-9ea136e8")).toBe(true);
    expect(isRunId("speech_01__synth_01")).toBe(false);
    expect(isRunId("job-../x")).toBe(false);
    expect(isRunId(undefined)).toBe(false);
  });
});

describe("analysisForm", () => {
  it("sends uploads under the server's field names", () => {
    const f = analysisForm({ audio: file("talk.wav"), transcript: "Four score", references: [file("a.wav"), file("b.wav")] });
    expect((f.get("audio") as File).name).toBe("talk.wav");
    const t = f.get("transcript") as File;
    expect(t.name).toBe("transcript.txt");
    expect(f.getAll("references").map((r) => (r as File).name)).toEqual(["a.wav", "b.wav"]);
    expect(f.has("references_from")).toBe(false);
  });

  it("uses references_from instead of uploaded references", () => {
    const f = analysisForm({ audio: file("talk.wav"), transcript: null, references: [file("a.wav")], referencesFrom: "speech_01" });
    expect(f.get("references_from")).toBe("speech_01");
    expect(f.has("references")).toBe(false);
    expect(f.has("transcript")).toBe(false);
  });
});

describe("errors", () => {
  const req = { audio: file("talk.wav"), transcript: "text", references: [file("a.wav"), file("b.wav")] };
  const fails = async (res: Response | Error) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
    return (await submitAnalysis(req).catch((e) => e)) as ApiError;
  };

  it.each([
    [400, "invalid_input", "input", "give reference recordings"],
    [413, "upload_too_large", "input", "talk.wav: larger than 200 MB"],
    [503, "busy", "internal", "16 analyses are queued"],
    [500, "internal_error", "internal", "KeyError: boom"],
  ])("HTTP %i keeps the typed error", async (status, code, kind, message) => {
    const e = await fails(typed(status, code, kind, message));
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.kind, e.message, e.stage]).toEqual([status, code, kind, message, "submit"]);
  });

  it("HTTP 422 request validation becomes a readable message", async () => {
    const e = await fails(json(422, { detail: [{ loc: ["body", "audio"], msg: "Field required", type: "missing" }] }));
    expect([e.status, e.code, e.message]).toEqual([422, "invalid_request", "audio: Field required"]);
  });

  it.each([
    ["network failure", new TypeError("Failed to fetch")],
    ["proxy without backend", new Response("", { status: 502 })],
    ["dev proxy error page", new Response("Internal Server Error", { status: 500 })],
  ])("%s means the server is unreachable", async (_, res) => {
    const e = await fails(res);
    expect([e.status, e.code]).toEqual([0, "server_unreachable"]);
    expect(explainError(e).title).toBe("The analysis server is not running");
  });

  it("explains job errors in plain language", () => {
    expect(explainError({ code: "off_script", kind: "refused", detail: {} }).title).toBe("The recording does not follow the transcript");
    expect(explainError({ code: "model_failed", kind: "internal", detail: { out_of_memory: true } }).hint).toMatch(/out of memory/);
    expect(explainError({ code: "something_new", kind: "input", detail: {} }).title).toBe("These files cannot be analysed");
    expect(explainError({ code: "stale_artifact", kind: "stale", detail: {} }).title).toBe("Something went wrong on the analysis server");
  });

  it("a 404 status is an ApiError the page can recognise", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(typed(404, "unknown_run", "input", "no analysis job 'job-x'"));
    const e = (await getStatus("job-x").catch((x) => x)) as ApiError;
    expect([e.status, e.code]).toEqual([404, "unknown_run"]);
  });
});

describe("resultToTake", () => {
  it("addresses the document by run id and plays the server's audio", () => {
    const doc = {
      id: "script__recording", kind: "user", audio: "audio/script__recording.flac",
      references: [{ take_id: "ref_01", audio: "audio/script__ref_01.flac", words: [] }],
    } as unknown as Take;
    const res: RunResult = {
      run_id: "job-1", document: doc, result: { run_id: "job-1", id: doc.id, n_flaws: 0, score: 100, warnings: [] },
      audio: { "script__recording.flac": "/results/job-1/audio/script__recording.flac", "script__ref_01.flac": "/results/job-1/audio/script__ref_01.flac" },
    };
    const take = resultToTake(res);
    expect(take.id).toBe("job-1");
    expect(take.audio).toBe("api/results/job-1/audio/script__recording.flac");
    expect(take.references[0].audio).toBe("api/results/job-1/audio/script__ref_01.flac");
    expect(doc.audio).toBe("audio/script__recording.flac"); // the cached document is not mutated
  });
});

describe("transcript errors", () => {
  it("advise differently for a mismatch with the built-in script", () => {
    expect(explainError({ code: "invalid_transcript", kind: "input", detail: { script: ["four"], given: ["this"] } }).hint).toMatch(/built-in references/);
    expect(explainError({ code: "invalid_transcript", kind: "input", detail: {} }).hint).toMatch(/UTF-8/);
  });
});
