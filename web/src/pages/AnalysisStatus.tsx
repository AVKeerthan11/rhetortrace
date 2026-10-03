import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { motion } from "motion/react";
import { Check, Circle, CircleAlert, LoaderCircle, Plus, WifiOff } from "lucide-react";
import { ApiError, getStatus, recentRuns, STAGE_TEXT, type RunStatus, type Stage, type StageName } from "@/lib/api";
import { fmt } from "@/lib/format";
import { rise } from "@/lib/motion";
import { analyzePath, overviewPath } from "@/lib/takes";
import { cn } from "@/lib/utils";
import { PageHeader, ReadingPage } from "@/components/Page";
import { PageState } from "@/components/PageState";
import { ErrorCallout } from "@/components/ErrorCallout";

const POLL_MS = 1000;

/** Live progress of one analysis job (GET /status/{run_id}); opens the results when it succeeds. */
export function AnalysisStatus() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [lost, setLost] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const s = await getStatus(runId);
        if (!alive) return;
        setStatus(s);
        setLost(false);
        if (s.state === "succeeded") navigate(overviewPath(runId), { replace: true });
        else if (s.state !== "failed") timer = window.setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) return setMissing(e.message);
        setLost(true); // server down or restarting: keep trying, a little slower
        timer = window.setTimeout(poll, POLL_MS * 3);
      }
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [runId, navigate]);

  if (missing) return <PageState title="No such analysis" detail={missing} retry={false} />;
  const name = recentRuns().find((r) => r.run_id === runId)?.name ?? "your recording";
  const failed = status?.state === "failed";

  return (
    <ReadingPage>
      <PageHeader eyebrow="New analysis" title={failed ? <>Could not analyse {name}</> : <>Analysing {name}</>}>
        <p><StateLine status={status} /></p>
      </PageHeader>

      {lost && (
        <motion.div {...rise(2)} role="status" className="mt-6 flex items-center gap-2.5 rounded-xl bg-highlight-soft/70 px-4 py-2.5 text-[13.5px] text-ink/85">
          <WifiOff className="size-4" /> Lost contact with the analysis server. Retrying…
        </motion.div>
      )}

      {failed && status.error && (
        <motion.div {...rise(2)} className="mt-8">
          <ErrorCallout error={status.error} action={
            <Link to={analyzePath} className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-primary-foreground">
              <Plus className="size-3.5" /> Start a new analysis
            </Link>
          } />
        </motion.div>
      )}

      <motion.section {...rise(3)} className="mt-10">
        {status?.stages ? (
          <ol aria-label="Analysis stages" className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface">
            {status.stages.map((s) => <StageRow key={s.name} stage={s} />)}
          </ol>
        ) : (
          <div className="shimmer h-[300px] rounded-2xl" aria-label={status ? "Waiting to start" : "Loading"} />
        )}
      </motion.section>

      {status && status.warnings.length > 0 && (
        <motion.section {...rise(4)} className="mt-8">
          <h2 className="mb-2 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Notes from the checks</h2>
          <ul className="space-y-1 text-[13px] text-muted-foreground">
            {status.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </motion.section>
      )}
    </ReadingPage>
  );
}

function useElapsed(since: string | null, until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since || until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since, until]);
  if (!since) return null;
  return Math.max(0, ((until ? Date.parse(until) : now) - Date.parse(since)) / 1000);
}

function StateLine({ status }: { status: RunStatus | null }) {
  const elapsed = useElapsed(status?.started_at ?? null, status?.finished_at ?? null);
  if (!status) return <>Connecting to the analysis server…</>;
  const t = elapsed != null ? ` · ${fmt(elapsed, 0)} s` : "";
  switch (status.state) {
    case "queued":
      return <>Waiting in the queue{status.queue_position && status.queue_position > 1 ? ` behind ${status.queue_position - 1} other analys${status.queue_position === 2 ? "is" : "es"}` : ""}. Analyses run one at a time.</>;
    case "running":
      return <>{status.stage ? STAGE_TEXT[status.stage].title : "Starting"}{t}</>;
    case "succeeded":
      return <>Done{t}. Opening the results…</>;
    case "failed":
      return <>Stopped{status.error?.stage && status.error.stage in STAGE_TEXT ? ` while ${STAGE_TEXT[status.error.stage as StageName].title.toLowerCase()}` : ""}{t}.</>;
  }
}

function StageRow({ stage }: { stage: Stage }) {
  const text = STAGE_TEXT[stage.name] ?? { title: stage.name, body: "" };
  const icon = {
    pending: <Circle className="size-4 text-ink/20" />,
    running: <LoaderCircle className="size-4 animate-spin text-ink" />,
    done: <Check className="size-4 text-ink/70" />,
    failed: <CircleAlert className="size-4 text-destructive" />,
  }[stage.state];
  return (
    <li data-stage={stage.name} data-state={stage.state} className={cn("flex items-start gap-3.5 px-5 py-3.5", stage.state === "pending" && "opacity-55")}>
      <span className="mt-0.5" aria-label={stage.state}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[14.5px]", stage.state === "running" && "font-medium")}>{text.title}</span>
        <span className="block text-[13px] leading-snug text-muted-foreground">{text.body}</span>
      </span>
      <span className="font-mono text-[11.5px] text-faint tabular">{stage.seconds != null ? `${fmt(stage.seconds, 1)} s` : ""}</span>
    </li>
  );
}
