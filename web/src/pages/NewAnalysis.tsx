import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, AudioLines, CircleAlert, FileText, LoaderCircle, RotateCw, Upload, X } from "lucide-react";
import {
  ApiError, recentRuns, rememberRun, serverAvailable, submitAnalysis, type AnalysisRequest,
} from "@/lib/api";
import { useIndex } from "@/lib/data";
import { rise } from "@/lib/motion";
import { groupBySpeech, runPath, speechName } from "@/lib/takes";
import { cn } from "@/lib/utils";
import { ErrorCallout } from "@/components/ErrorCallout";
import { PageHeader, ReadingPage } from "@/components/Page";

const AUDIO_ACCEPT = ".wav,.flac,.ogg,.oga,.mp3,.aiff,.aif,audio/*";

/** Upload a recording, its transcript and reference deliveries; POST /analyze; go to its status page. */
export function NewAnalysis() {
  const navigate = useNavigate();
  const [audio, setAudio] = useState<File | null>(null);
  const [textMode, setTextMode] = useState<"file" | "paste">("file");
  const [textFile, setTextFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [refMode, setRefMode] = useState<"upload" | "builtin">("upload");
  const [refs, setRefs] = useState<File[]>([]);
  const [builtin, setBuiltin] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { data: index } = useIndex();
  const scripts = index ? groupBySpeech(index.takes).filter((g) => g.takes.some((t) => t.kind === "control")) : [];

  const check = () => {
    setOnline(null);
    void serverAvailable().then(setOnline);
  };
  useEffect(() => {
    void serverAvailable().then(setOnline);
  }, []);

  const transcript = textMode === "file" ? textFile : text.trim() ? text : null;
  const missing = [
    !audio && "your recording",
    !transcript && refMode === "upload" && "the transcript",
    refMode === "upload" && refs.length < 2 && `${2 - refs.length} more reference recording${refs.length === 1 ? "" : "s"}`,
    refMode === "builtin" && !builtin && "a reference script",
  ].filter(Boolean) as string[];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (missing.length || !audio || submitting) return;
    setSubmitting(true);
    setError(null);
    const req: AnalysisRequest = { audio, transcript, references: refMode === "upload" ? refs : [], referencesFrom: refMode === "builtin" ? builtin : null };
    try {
      const res = await submitAnalysis(req);
      rememberRun({ run_id: res.run_id, name: audio.name, submitted_at: new Date().toISOString() });
      navigate(runPath(res.run_id));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, { message: String(err) }));
      if (err instanceof ApiError && err.code === "server_unreachable") setOnline(false);
      setSubmitting(false);
    }
  };

  return (
    <ReadingPage>
      <PageHeader eyebrow="New analysis" title="Analyse a recording">
        <p>
          Upload a delivery of a speech, the text it follows, and at least two good deliveries of the same text. RhetorTrace
          compares yours with them word by word and shows where it differs.
        </p>
      </PageHeader>

      {online === false && (
        <motion.div {...rise(2)} role="status" className="mt-8 flex items-start gap-3 rounded-xl bg-highlight-soft/70 px-4 py-3 text-[13.5px] text-ink/85">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">The analysis server is not running</div>
            <div className="mt-0.5 text-ink/70">
              Start it with <code className="font-mono text-[12.5px]">python -m src.server</code>. The demo recordings work without it.
            </div>
          </div>
          <button type="button" onClick={check} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] transition-colors hover:bg-ink/5">
            <RotateCw className="size-3.5" /> Check again
          </button>
        </motion.div>
      )}

      <motion.form {...rise(3)} onSubmit={submit} className="mt-10 space-y-10" aria-label="New analysis">
        <Field n={1} title="Your recording" lead="The delivery to analyse. WAV, FLAC, OGG or MP3, up to 15 minutes.">
          <FilePick label="Choose your recording" icon={AudioLines} accept={AUDIO_ACCEPT} files={audio ? [audio] : []}
            onFiles={(f) => setAudio(f[0] ?? null)} onRemove={() => setAudio(null)} />
        </Field>

        <Field n={2} title="The transcript"
          lead={refMode === "builtin" ? "Optional with built-in references: the script's own text is used, and a transcript you give must match it." : "The words the recording follows, as plain text."}
          aside={<Segmented value={textMode} onChange={setTextMode} options={[["file", "Upload a file"], ["paste", "Paste text"]]} label="Transcript input" />}>
          {textMode === "file" ? (
            <FilePick label="Choose the transcript" icon={FileText} accept=".txt,text/plain" files={textFile ? [textFile] : []}
              onFiles={(f) => setTextFile(f[0] ?? null)} onRemove={() => setTextFile(null)} />
          ) : (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Transcript text"
              placeholder="Four score and seven years ago…"
              className="block w-full resize-y rounded-xl border border-hairline bg-surface px-4 py-3 text-[14.5px] leading-relaxed outline-none placeholder:text-faint focus:border-ink/30" />
          )}
        </Field>

        <Field n={3} title="Reference deliveries" lead="Good deliveries of the same text. Your recording is compared with all of them."
          aside={<Segmented value={refMode} onChange={setRefMode} options={[["upload", "Upload"], ["builtin", "Built-in"]]} label="Reference source" />}>
          {refMode === "upload" ? (
            <FilePick label="Choose two or more recordings" icon={AudioLines} accept={AUDIO_ACCEPT} multiple files={refs}
              onFiles={(f) => setRefs((r) => [...r, ...f.filter((x) => !r.some((y) => y.name === x.name && y.size === x.size))])}
              onRemove={(i) => setRefs((r) => r.filter((_, j) => j !== i))} />
          ) : (
            <div className="space-y-2" role="radiogroup" aria-label="Built-in reference script">
              {scripts.length === 0 && <p className="text-[13.5px] text-muted-foreground">No built-in scripts are available.</p>}
              {scripts.map((g) => (
                <button key={g.speech} type="button" role="radio" aria-checked={builtin === g.speech} onClick={() => setBuiltin(g.speech)}
                  className={cn("flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                    builtin === g.speech ? "border-ink/40 bg-surface shadow-float" : "border-hairline bg-surface hover:border-ink/20")}>
                  <span className={cn("grid size-4 place-items-center rounded-full border", builtin === g.speech ? "border-ink" : "border-ink/25")}>
                    {builtin === g.speech && <span className="size-2 rounded-full bg-ink" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium">{speechName(g.speech)}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">“{g.opening}” · {g.takes.filter((t) => t.kind === "control").length} clean deliveries</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Field>

        {error && <ErrorCallout error={error} />}

        <div className="flex items-center gap-4 border-t border-hairline pt-6">
          <button type="submit" disabled={missing.length > 0 || submitting || online === false}
            className="group inline-flex h-12 items-center gap-2.5 rounded-full bg-ink pr-5 pl-6 text-[15px] font-medium text-primary-foreground shadow-[0_6px_20px_-6px_rgba(27,26,23,0.45)] transition-transform enabled:hover:scale-[1.02] enabled:active:scale-[0.99] disabled:opacity-40">
            {submitting ? <><LoaderCircle className="size-4 animate-spin" /> Uploading…</> : <>Analyse <ArrowRight className="size-4 transition-transform group-enabled:group-hover:translate-x-1" /></>}
          </button>
          <span className="text-[13px] text-muted-foreground">
            {missing.length ? `Still needed: ${missing.join(", ")}.` : "Analysis takes about a minute per new recording."}
          </span>
        </div>
      </motion.form>

      <RecentRuns />
    </ReadingPage>
  );
}

function Field({ n, title, lead, aside, children }: { n: number; title: string; lead: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.12em] text-faint uppercase"><span className="font-mono">0{n}</span></div>
          <h2 className="mt-1 font-display text-[26px] leading-tight">{title}</h2>
          <p className="mt-1 text-[13.5px] text-muted-foreground">{lead}</p>
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 rounded-full border border-hairline bg-surface p-0.5 text-[12.5px]">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} onClick={() => onChange(v)}
          className={cn("rounded-full px-3 py-1 transition-colors", value === v ? "bg-selected text-ink" : "text-muted-foreground hover:text-ink")}>
          {text}
        </button>
      ))}
    </div>
  );
}

const size = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

function FilePick({ label, icon: Icon, accept, multiple, files, onFiles, onRemove }: {
  label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; accept: string; multiple?: boolean;
  files: File[]; onFiles: (f: File[]) => void; onRemove: (i: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const showPicker = multiple || files.length === 0;
  return (
    <div className="space-y-2">
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-xl border border-hairline bg-surface px-4 py-2.5">
          <Icon className="size-4 text-ink/60" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-[14px]">{f.name}</span>
          <span className="font-mono text-[11.5px] text-faint tabular">{size(f.size)}</span>
          <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}
            className="grid size-7 place-items-center rounded-full text-faint transition-colors hover:bg-hover hover:text-ink">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {showPicker && (
        <label
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
          className={cn("flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-[14px] transition-colors",
            over ? "border-ink/40 bg-surface" : "border-ink/15 bg-surface/50 hover:border-ink/30 hover:bg-surface")}>
          <Upload className="size-4 text-ink/60" strokeWidth={1.75} />
          <span className="flex-1">{files.length && multiple ? "Add another recording" : label}</span>
          <span className="text-[12.5px] text-faint">or drop {multiple ? "files" : "a file"} here</span>
          <input ref={input} type="file" accept={accept} multiple={multiple} aria-label={label} className="sr-only"
            onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
        </label>
      )}
    </div>
  );
}

function RecentRuns() {
  const [runs] = useState(recentRuns);
  if (!runs.length) return null;
  return (
    <motion.section {...rise(4)} className="mt-14">
      <h2 className="mb-2 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Your recent analyses</h2>
      <div className="divide-y divide-hairline rounded-xl border border-hairline bg-surface">
        {runs.map((r) => (
          <Link key={r.run_id} to={runPath(r.run_id)} className="group flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-hover">
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{r.name}</span>
            <span className="text-[12.5px] text-muted-foreground">{new Date(r.submitted_at).toLocaleString()}</span>
            <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
          </Link>
        ))}
      </div>
    </motion.section>
  );
}
