// The New Analysis journey through the real routes and pages, with the analysis server mocked at
// fetch: upload -> POST /analyze -> /status polling (stages as the server reports them) ->
// /results -> the existing overview, finding and explorer screens.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RunStatus, Stage } from "@/lib/api";
import { player } from "@/lib/player";

const RUN = "job-20261003-120000-abcdef01";
const index = readFileSync("public/data/index.json", "utf-8");
const demo = JSON.parse(readFileSync("public/data/speech_01__synth_01.json", "utf-8"));
// what the server exports for an uploaded recording: same document, user kind, upload names
const document = {
  ...demo, id: "speech_01__recording", take_id: "recording", kind: "user", label: "talk.wav", source_take: null,
  ground_truth: null, edits: null, audio: "audio/speech_01__recording.flac",
  baseline: { ...demo.baseline, source: "references:ref_01,ref_02", references: ["ref_01", "ref_02"] },
  references: demo.references.map((r: { audio: string }, i: number) => ({ ...r, take_id: `ref_0${i + 1}`, audio: `audio/speech_01__ref_0${i + 1}.flac` })),
  display: { recording: "talk.wav", references: { ref_01: "anna.wav", ref_02: "ben.wav" } },
  qc: { ...demo.qc, asr_wer: 0.068 },
};
const audio = Object.fromEntries(["recording", "ref_01", "ref_02"].map((t) => [`speech_01__${t}.flac`, `/results/${RUN}/audio/speech_01__${t}.flac`]));

const NAMES = ["ingest", "align", "features", "baseline", "detection", "flaws", "export"] as const;
const stages = (done: number, running?: number, failed?: number): Stage[] =>
  NAMES.map((name, i) => ({ name, state: i < done ? "done" : i === running ? "running" : i === failed ? "failed" : "pending", seconds: i < done ? 0.5 + i : null }));
const status = (s: Partial<RunStatus>): RunStatus => ({
  run_id: RUN, state: "running", queue_position: 0, submitted_at: "2026-10-03T12:00:00Z", started_at: "2026-10-03T12:00:01Z",
  finished_at: null, stage: null, stages: null, warnings: [], error: null, results_url: null, ...s,
});

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

/** A scripted analysis server. ``statuses`` are returned one per poll (the last one repeats). */
function server({ statuses = [] as RunStatus[], post = json({ run_id: RUN, state: "queued", queue_position: 1 }, 202), online = true } = {}) {
  const calls: { method: string; url: string; body?: FormData }[] = [];
  let poll = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body as FormData | undefined });
    if (url === "/data/index.json") return new Response(index, { headers: { "content-type": "application/json" } });
    if (url.startsWith("/data/")) return new Response(readFileSync(`public${url}`, "utf-8"));
    if (!online) throw new TypeError("Failed to fetch");
    if (url === "/api/openapi.json") return json({ openapi: "3.1.0" });
    if (url === "/api/analyze") return post.clone();
    if (url === `/api/status/${RUN}`) return json(statuses[Math.min(poll++, statuses.length - 1)]);
    if (url === `/api/results/${RUN}`) return json({ run_id: RUN, result: { run_id: RUN, id: document.id, n_flaws: document.flaws.length, score: document.score.total, warnings: [] }, document, audio });
    return json({ detail: { code: "unknown_run", kind: "input", stage: null, message: "not found", detail: {} } }, 404);
  });
  return calls;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider delay={0}><App /></TooltipProvider>
    </MemoryRouter>,
  );
}

const wav = (name: string) => new File([new Uint8Array(4000)], name, { type: "audio/wav" });

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText("Choose your recording"), wav("talk.wav"));
  await user.click(screen.getByRole("tab", { name: "Paste text" }));
  await user.type(screen.getByLabelText("Transcript text"), "Four score and seven years ago");
  await user.upload(screen.getByLabelText("Choose two or more recordings"), [wav("anna.wav"), wav("ben.wav")]);
}

describe("new analysis journey", () => {
  it("uploads, follows the server's stages, and opens the result in the existing screens", async () => {
    const calls = server({ statuses: [
      status({ state: "queued", queue_position: 1, started_at: null }),
      status({ stage: "align", stages: stages(1, 1) }),
      status({ state: "succeeded", stages: stages(7), finished_at: "2026-10-03T12:01:00Z", results_url: `/results/${RUN}` }),
    ] });
    const user = userEvent.setup();
    renderAt("/analyze");

    const submit = await screen.findByRole("button", { name: /Analyse/ });
    expect(submit).toBeDisabled();
    await fillForm(user);
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    // the request carried the files under the server's field names
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/analyze");
    expect((post.body!.get("audio") as File).name).toBe("talk.wav");
    expect(post.body!.getAll("references").map((f) => (f as File).name)).toEqual(["anna.wav", "ben.wav"]);
    expect(await (post.body!.get("transcript") as File).text()).toBe("Four score and seven years ago");

    // status page: queued, then the stages exactly as /status reports them
    expect(await screen.findByText(/Waiting in the queue/)).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Analysis stages" }, { timeout: 4000 });
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-state"))).toEqual(["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    expect(within(list).getByText("Lining up words with the audio")).toBeInTheDocument();

    // succeeded -> the existing overview, fed by /results
    // the recording stage names the upload; the overview explains the comparison
    expect(await screen.findByRole("heading", { name: "talk.wav" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Your recording")).toBeInTheDocument();
    expect(await screen.findByText(/compared with the reference deliveries you chose/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getAllByText("anna.wav").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Overview/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("What was injected")).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${document.flaws.length} moments differ`))).toBeInTheDocument();
    expect(player.main.src).toMatch(new RegExp(`/api/results/${RUN}/audio/speech_01__recording\\.flac$`));
    expect(calls.filter((c) => c.url === `/api/status/${RUN}`)).toHaveLength(3);

    // into a finding: the reference is the uploaded file, played from the server
    await user.click(screen.getByRole("link", { name: /Start with the most important finding/ }));
    expect(await screen.findAllByText(/anna\.wav/)).not.toHaveLength(0);
  });

  it("shows the typed error when the pipeline refuses the recording", async () => {
    server({ statuses: [status({
      state: "failed", stage: "align", stages: stages(1, undefined, 1), finished_at: "2026-10-03T12:00:30Z",
      error: { code: "off_script", kind: "refused", stage: "align", message: "talk.wav does not follow the transcript: 35% of the words differ", detail: { wer: 0.35 } },
    })] });
    renderAt(`/analyze/${RUN}`);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The recording does not follow the transcript")).toBeInTheDocument();
    expect(within(alert).getByText(/35% of the words differ/)).toBeInTheDocument();
    expect(within(alert).getByText("off_script · align")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Could not analyse/ })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Analysis stages" })).getAllByRole("listitem")[1]).toHaveAttribute("data-state", "failed");
  });

  it.each([
    [413, "upload_too_large", "A file is too large"],
    [400, "invalid_input", "These files cannot be analysed"],
    [503, "busy", "The analysis server is busy"],
    [500, "internal_error", "Something went wrong on the analysis server"],
  ])("a rejected upload (HTTP %i) stays on the form with the reason", async (code, errCode, title) => {
    server({ post: json({ detail: { code: errCode, kind: code >= 500 ? "internal" : "input", stage: "submit", message: `server says ${code}`, detail: {} } }, code) });
    const user = userEvent.setup();
    renderAt("/analyze");
    await screen.findByRole("button", { name: /Analyse/ });
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /Analyse/ }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(title)).toBeInTheDocument();
    expect(within(alert).getByText(`server says ${code}`)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "New analysis" })).toBeInTheDocument();
  });

  it("without the server: the form says how to start it, and the demo still works", async () => {
    server({ online: false });
    const user = userEvent.setup();
    renderAt("/analyze");
    expect(await screen.findByText("The analysis server is not running")).toBeInTheDocument();
    await fillForm(user);
    expect(screen.getByRole("button", { name: /Analyse/ })).toBeDisabled();

    await user.click(screen.getByRole("link", { name: /RhetorTrace home/ }));
    await user.click(await screen.findByRole("link", { name: /See it on an example/ }, { timeout: 4000 }));
    expect(await screen.findByText(/Demo recording: \d+ flaws were injected/)).toBeInTheDocument();
  });

  it("an unknown run id is a clear not-found page", async () => {
    server();
    renderAt("/analyze/job-does-not-exist");
    expect(await screen.findByText("No such analysis")).toBeInTheDocument();
  });
});

describe("information architecture", () => {
  it("old addresses redirect into the Lab", async () => {
    server({ online: false });
    renderAt("/evaluation");
    expect(await screen.findByRole("heading", { name: "How often is RhetorTrace right?" }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lab" })).toHaveAttribute("aria-current", "page");
  });

  it("the Lab lists the controlled examples; Home does not", async () => {
    server({ online: false });
    renderAt("/lab/examples");
    expect(await screen.findAllByRole("link", { name: /Open analysis/ }, { timeout: 4000 })).toHaveLength(2);
    expect(screen.getAllByText(/Clean recording 0\d/).length).toBe(6);
  });

  it("Your recordings shows analyses started in this browser, with their state", async () => {
    server({ statuses: [status({ state: "succeeded", stages: stages(7), finished_at: "2026-10-03T12:01:00Z", results_url: `/results/${RUN}` })] });
    localStorage.setItem("rhetortrace.recentRuns", JSON.stringify([{ run_id: RUN, name: "talk.wav", submitted_at: "2026-10-03T12:00:00Z" }]));
    renderAt("/recordings");
    expect(await screen.findByText("Analysed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /talk\.wav/ })).toHaveAttribute("href", `/take/${RUN}`);
  });

  it("an analysis can be deleted from Your recordings, after confirming, and the deletion undone", async () => {
    server({ statuses: [status({ state: "succeeded", stages: stages(7), results_url: `/results/${RUN}` })] });
    localStorage.setItem("rhetortrace.recentRuns", JSON.stringify([{ run_id: RUN, name: "talk.wav", submitted_at: "2026-10-03T12:00:00Z" }]));
    const user = userEvent.setup();
    renderAt("/recordings");
    await user.click(await screen.findByRole("button", { name: "Delete talk.wav" }));
    // nothing is deleted until confirmed
    expect(screen.getByRole("link", { name: /talk\.wav/ })).toBeInTheDocument();
    await user.click(within(await screen.findByRole("group", { name: "Delete talk.wav?" })).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No recordings yet.")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("rhetortrace.recentRuns")!)).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("link", { name: /talk\.wav/ })).toBeInTheDocument();
  });

  it("moving between the zoom levels keeps one recording stage", async () => {
    server({ statuses: [status({ state: "succeeded", stages: stages(7) })] });
    const user = userEvent.setup();
    renderAt(`/take/${RUN}`);
    const stage = await screen.findByRole("region", { name: "Recording" }, { timeout: 5000 });
    await user.click(screen.getByRole("link", { name: /Start with the most important finding/ }));
    expect(await screen.findByRole("link", { name: /Finding 1 of/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "Recording" })).toBe(stage); // the same element: not re-mounted
    await user.click(screen.getByRole("link", { name: /Timeline explorer/ }));
    expect(await screen.findByText("Transcript")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recording" })).toBe(stage);
  });
});
