import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowRight, CircleAlert, CircleCheck, Clock, LoaderCircle, Plus, Trash2, WifiOff } from "lucide-react";
import { ApiError, explainError, forgetRun, getStatus, recentRuns, restoreRun, type RecentRun, type RunStatus } from "@/lib/api";
import { ease, rise } from "@/lib/motion";
import { analyzePath, examplesPath, overviewPath, runPath } from "@/lib/takes";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Page";

type Live = RunStatus | "offline" | "missing" | null;

/** Your recordings: analyses started from this browser, with their live state on the server.
 *  (The analysis server keeps the results; this browser remembers which ones were yours.) */
export function Recordings() {
  const [runs, setRuns] = useState<RecentRun[]>(recentRuns);

  // delete: off the list at once, with a few seconds to undo
  const remove = (run: RecentRun) => {
    const at = forgetRun(run.run_id);
    setRuns(recentRuns());
    toast(`Deleted “${run.name}” from your recordings`, {
      id: `deleted-${run.run_id}`,
      duration: 6000,
      action: { label: "Undo", onClick: () => { restoreRun(run, at); setRuns(recentRuns()); } },
    });
  };
  const [live, setLive] = useState<Record<string, Live>>({});

  useEffect(() => {
    let alive = true;
    for (const r of runs) {
      getStatus(r.run_id)
        .then((s) => alive && setLive((m) => ({ ...m, [r.run_id]: s })))
        .catch((e) => alive && setLive((m) => ({ ...m, [r.run_id]: e instanceof ApiError && e.status === 404 ? "missing" : "offline" })));
    }
    return () => {
      alive = false;
    };
  }, [runs]);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="page pt-10 pb-28 lg:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <PageHeader eyebrow="Your recordings" title="Your recordings">
              <p>Every analysis you start from this browser. The analysis server keeps the results; open one to see its findings.</p>
            </PageHeader>
          </div>
          <Link to={analyzePath}
            className="group inline-flex h-11 items-center gap-2 rounded-full bg-ink pr-5 pl-4 text-[14px] font-medium text-primary-foreground shadow-[0_6px_20px_-6px_color-mix(in_oklab,var(--shadow)_45%,transparent)] transition-transform hover:scale-[1.02]">
            <Plus className="size-4 transition-transform duration-200 group-hover:rotate-90" /> New analysis
          </Link>
        </div>

        {runs.length === 0 ? (
          <motion.div {...rise(3)} className="mt-12 rounded-2xl border border-dashed border-ink/15 px-6 py-14 text-center">
            <p className="font-display text-[26px] leading-tight">No recordings yet.</p>
            <p className="mx-auto mt-2 max-w-md text-[14px] text-muted-foreground">
              Upload a delivery of a speech, its transcript and good deliveries of the same text. Your analyses will be listed here.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link to={analyzePath} className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-medium text-primary-foreground">
                Analyse a recording <ArrowRight className="size-4" />
              </Link>
              <Link to={examplesPath} className="inline-flex h-10 items-center gap-2 rounded-full border border-hairline bg-surface px-5 text-[13.5px] font-medium transition-colors hover:border-ink/25">
                See a controlled example
              </Link>
            </div>
          </motion.div>
        ) : (
          <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false} mode="popLayout">
              {runs.map((r, i) => (
                <motion.li key={r.run_id} layout {...rise(3 + i * 0.5)}
                  exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.22, ease } }}>
                  <RunCard run={r} live={live[r.run_id] ?? null} onDelete={() => remove(r)} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
        {runs.length > 0 && (
          <p className="mt-6 text-[12.5px] text-faint">Listed from this browser's history: other browsers and devices keep their own list.</p>
        )}
      </div>
    </div>
  );
}

function RunCard({ run, live, onDelete }: { run: RecentRun; live: Live; onDelete: () => void }) {
  const done = typeof live === "object" && live?.state === "succeeded";
  const to = done ? overviewPath(run.run_id) : runPath(run.run_id);
  const [confirming, setConfirming] = useState(false);
  // the card is a link: its own buttons must not open it
  const own = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  return (
    <div className="group relative h-full">
    <Link to={to}
      className="flex h-full flex-col rounded-2xl border border-hairline bg-surface p-5 transition-[box-shadow,border-color,transform] duration-200 group-hover:-translate-y-0.5 group-hover:border-transparent group-hover:shadow-float">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[22px] leading-tight">{run.name}</div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">{new Date(run.submitted_at).toLocaleString()}</div>
        </div>
        <ArrowRight className="mt-1 size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </div>
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-hairline pt-3 pr-9">
        <State live={live} />
        <span className="truncate font-mono text-[10.5px] text-faint">{run.run_id}</span>
      </div>
    </Link>

    {/* delete: a quiet icon until hovered (always visible on touch), then an in-place confirmation */}
    <AnimatePresence initial={false} mode="wait">
      {confirming ? (
        <motion.div key="confirm" role="group" aria-label={`Delete ${run.name}?`}
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16, ease }}
          className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl border border-destructive/30 bg-popover px-3 py-2 shadow-float">
          <span className="min-w-0 flex-1 text-[12.5px]">Delete this analysis from your recordings?</span>
          <button onClick={own(() => setConfirming(false))} autoFocus
            className="rounded-full px-2.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-ink">
            Cancel
          </button>
          <button onClick={own(onDelete)}
            className="rounded-full bg-destructive px-3 py-1 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90">
            Delete
          </button>
        </motion.div>
      ) : (
        <motion.button key="trash" onClick={own(() => setConfirming(true))} aria-label={`Delete ${run.name}`} title="Delete"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
          className="absolute right-3 bottom-3 grid size-8 place-items-center rounded-full text-faint transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 [@media(hover:none)]:opacity-100">
          <Trash2 className="size-4" />
        </motion.button>
      )}
    </AnimatePresence>
    </div>
  );
}

function State({ live }: { live: Live }) {
  const chip = (icon: React.ReactNode, text: string, tone?: string) => (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-[12.5px]", tone ?? "text-muted-foreground")}>{icon}<span className="truncate">{text}</span></span>
  );
  if (live === null) return chip(<LoaderCircle className="size-3.5 animate-spin" />, "Checking…");
  if (live === "offline") return chip(<WifiOff className="size-3.5" />, "Analysis server offline");
  if (live === "missing") return chip(<CircleAlert className="size-3.5" />, "No longer on this server");
  switch (live.state) {
    case "succeeded":
      return chip(<CircleCheck className="size-3.5 text-truth" />, "Analysed", "text-ink");
    case "running":
      return chip(<LoaderCircle className="size-3.5 animate-spin" />, "Analysing…", "text-ink");
    case "queued":
      return chip(<Clock className="size-3.5" />, "Waiting in the queue");
    case "failed":
      return chip(<CircleAlert className="size-3.5 text-destructive" />, live.error ? explainError(live.error).title : "Failed", "text-ink/80");
  }
}
