import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, CircleCheck, CircleX, Info, Lightbulb, ScanLine, TriangleAlert } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import {
  CATEGORY_MEANING, coachingTip, contextQuote, plainEvidence, plainTitle, truthFor,
} from "@/lib/findings";
import { fmt, fmtSigned, humanize } from "@/lib/format";
import { ease } from "@/lib/motion";
import { player } from "@/lib/player";
import { explorePath, findingPath, overviewPath } from "@/lib/takes";
import type { Flaw, Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { kindLabel } from "@/lib/validation";
import { FindingNumber } from "@/components/FindingNumber";
import { SeverityBadge } from "@/components/SeverityBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTakeContext } from "@/features/stage/context";
import { useStage } from "@/features/stage/store";
import { EvidencePlot } from "./EvidencePlot";
import { useCaptureOnUnmount, useFlightTarget } from "@/lib/flight";
import { HearIt } from "./HearIt";
import { ProofRow } from "./Proof";
import { SeverityScale } from "./SeverityScale";
import { WordTiming } from "./WordTiming";

export function FindingPage() {
  const { n } = useParams();
  const { take, ranking } = useTakeContext();
  const rank = Number(n);
  if (!Number.isInteger(rank) || rank < 1 || rank > ranking.length) return <Navigate to={overviewPath(take.id)} replace />;
  return <FindingBody take={take} rank={rank} ranking={ranking} />;
}

/** One finding, read like an annotated page: the walk-through (hear it, why, how to improve) in
 *  the main column and its evidence in the margin. The stage above is zoomed onto the moment. */
function FindingBody({ take, rank, ranking }: { take: Take; rank: number; ranking: number[] }) {
  const navigate = useNavigate();
  const total = ranking.length;
  const flawIndex = ranking[rank - 1];
  const f = take.flaws[flawIndex];
  const refIdx = useStage((s) => s.refIdx);
  const setRefIdx = useStage((s) => s.setRefIdx);
  // "listened" belongs to one finding: it resets by itself when the finding changes
  const [listenedRank, setListenedRank] = useState<number | null>(null);
  const listened = listenedRank === rank;
  const setListened = (v: boolean) => setListenedRank(v ? rank : null);
  // siblings move sideways, in the direction of travel (from the header stepper too)
  const [prevRank, setPrevRank] = useState(rank);
  const [dir, setDir] = useState(1);
  if (prevRank !== rank) {
    setDir(Math.sign(rank - prevRank) || 1);
    setPrevRank(rank);
  }
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [rank]);

  const go = (r: number) => {
    if (r < 1 || r > total) return;
    player.stop();
    navigate(findingPath(take.id, r));
  };

  // anything that plays this finding (the buttons, Space, the stage) counts as having listened
  useEffect(() => player.subscribe(() => {
    if (player.label?.startsWith(`Finding ${rank} ·`)) setListenedRank(rank);
  }), [rank]);

  const timing = f.category === "pause" || f.category === "pacing";

  return (
    <div ref={scroller} className="h-full overflow-y-auto scrollbar-thin">
      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.article key={rank} custom={dir}
          initial={{ opacity: 0, x: 24 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 * dir }}
          transition={{ duration: 0.3, ease }}
          className="page grid-page gap-y-12 pt-8 pb-28 lg:pt-10">
          <div className="col-span-full min-w-0 lg:col-span-7">
            <Header take={take} f={f} rank={rank} />

            <div className="mt-8">
              <HearIt take={take} f={f} rank={rank} refIdx={refIdx} setRefIdx={setRefIdx} onListened={() => setListened(true)} />
            </div>

            <Why take={take} f={f} refIdx={refIdx} />

            <Section title="How to improve">
              <div className="flex gap-3 rounded-xl bg-highlight-soft/70 p-4">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-ink/70" />
                <p className="text-[15px] leading-relaxed text-ink/85">{coachingTip(f)}</p>
              </div>
            </Section>

            {/* next step */}
            <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6">
              {rank > 1 ? (
                <button onClick={() => go(rank - 1)} className="inline-flex items-center gap-1.5 text-[13.5px] text-muted-foreground transition-colors hover:text-ink">
                  <ArrowLeft className="size-4" /> Previous
                </button>
              ) : <span />}
              {rank < total ? (
                <button onClick={() => go(rank + 1)}
                  className={cn(
                    "group inline-flex h-12 items-center gap-2.5 rounded-full pr-5 pl-6 text-[14.5px] font-medium transition-all",
                    listened
                      ? "bg-ink text-primary-foreground shadow-[0_6px_20px_-6px_color-mix(in_oklab,var(--shadow)_45%,transparent)] hover:scale-[1.02]"
                      : "border border-hairline bg-surface hover:border-ink/25",
                  )}>
                  Next finding: {plainTitle(take.flaws[ranking[rank]]).toLowerCase()}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </button>
              ) : (
                <Link to={overviewPath(take.id)}
                  className="group inline-flex h-12 items-center gap-2.5 rounded-full bg-ink pr-5 pl-6 text-[14.5px] font-medium text-primary-foreground">
                  That was the last finding. Back to the overview
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </Link>
              )}
            </div>
          </div>

          {/* the margin: evidence beside the walk-through */}
          <aside aria-label="Evidence" className="col-span-full min-w-0 space-y-9 lg:col-span-5 lg:col-start-8 lg:pt-1 xl:col-span-4 xl:col-start-9">
            <Margin title="How severe?" aside={<span className="capitalize">{f.severity.label}</span>}>
              <SeverityScale take={take} f={f} />
            </Margin>
            <Margin title="All measurements" aside={`${1 + f.explanation.supporting_evidence.length}`}>
              <Measurements f={f} />
            </Margin>
            <Margin title="How confident is this?" aside={<span className="capitalize">{f.explanation.confidence.label}</span>}>
              <Confidence f={f} />
            </Margin>
            {timing && (
              <Margin title="Word timing" aside="on the stage, vs each reference">
                <WordTiming take={take} f={f} />
              </Margin>
            )}
            <DemoCheck take={take} f={f} />
            <Link to={explorePath(take.id, rank)}
              className="group flex items-center gap-2 border-t border-hairline pt-5 text-[13.5px] text-muted-foreground transition-colors hover:text-ink">
              <ScanLine className="size-4" /> Open this moment in the timeline explorer
              <ArrowRight className="ml-auto size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
            </Link>
          </aside>
        </motion.article>
      </AnimatePresence>
    </div>
  );
}

/** A note in the margin: small caps title, hairline above. */
function Margin({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-hairline pt-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">{title}</h2>
        {aside && <span className="text-[12px] text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Header({ take, f, rank }: { take: Take; f: Flaw; rank: number }) {
  const meta = CATEGORY[f.category];
  // the finding's badge and title arrive from the row / sheet they were opened from, and leave to it
  const root = useRef<HTMLElement>(null);
  const badge = useFlightTarget<HTMLSpanElement>(`badge-${rank}`);
  const title = useFlightTarget<HTMLHeadingElement>(`title-${rank}`);
  useCaptureOnUnmount(root, rank);
  const quote = contextQuote(take, f);
  const pauseAfter = f.category === "pause" ? f.explanation.strongest_evidence : null;
  return (
    <header ref={root}>
      <div className="flex flex-wrap items-center gap-2.5">
        <FindingNumber n={rank} category={f.category} active ref={badge} flight="badge" />
        <span className="text-[12px] font-semibold tracking-[0.12em] uppercase" style={{ color: meta.color }}>{meta.label}</span>
        <SeverityBadge level={f.severity.level} label={f.severity.label} />
        <span className="text-[13px] text-muted-foreground">· {CATEGORY_MEANING[f.category]}</span>
      </div>
      <h1 ref={title} data-flight="title" className="mt-3 font-display text-display-l">{plainTitle(f)}</h1>
      <blockquote className="mt-5 font-display text-[clamp(19px,1.7vw,24px)] leading-[1.5] text-ink/55">
        {quote.clippedStart && "… "}
        {quote.words.map(({ word, inSpan }, k) => {
          const lastOfSpan = word.idx === f.end_idx;
          return (
            <span key={word.idx}>
              {inSpan ? (
                <motion.span className="marker px-0.5" initial={{ backgroundSize: "0% 100%" }} animate={{ backgroundSize: "100% 100%" }}
                  transition={{ delay: 0.2, duration: 0.6, ease }} style={{ backgroundRepeat: "no-repeat" }}>
                  {word.text}
                </motion.span>
              ) : word.text}
              {lastOfSpan && pauseAfter?.observed != null && (
                <span className="mx-1 inline-flex -translate-y-[3px] items-center rounded-full px-2 py-0.5 align-middle font-sans text-[12px] font-medium"
                  style={{ background: `color-mix(in oklab, ${meta.color} 16%, var(--surface))`, color: `color-mix(in oklab, ${meta.color} 75%, var(--ink))` }}>
                  pause {fmt(pauseAfter.observed, 1)} s
                </span>
              )}
              {k < quote.words.length - 1 ? " " : ""}
            </span>
          );
        })}
        {quote.clippedEnd && " …"}
      </blockquote>
      <div className="mt-2 font-mono text-[12px] text-faint tabular">
        at {fmt(f.start, 1)}–{fmt(f.end, 1)} s of the recording
      </div>
    </header>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[26px] leading-none">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Why({ take, f, refIdx }: { take: Take; f: Flaw; refIdx: number }) {
  const e = f.explanation;
  const m = e.strongest_evidence;
  const ev = m ? plainEvidence(m) : null;
  return (
    <Section title="Why this was flagged">
      {ev ? (
        <p className="text-[16px] leading-relaxed text-ink/85">
          {ev.lead} {ev.compare && <span className="text-ink">{ev.compare}</span>}
        </p>
      ) : (
        <p className="text-[16px] leading-relaxed text-ink/85">{e.summary}</p>
      )}
      <ProofRow take={take} f={f} refIdx={refIdx} />
      {m && m.observed !== null && (
        <div className="mt-5 rounded-xl border border-hairline bg-surface px-5 pt-4 pb-3">
          <EvidencePlot m={m} color={CATEGORY[f.category].color} showNote={false} />
        </div>
      )}
    </Section>
  );
}

function Measurements({ f }: { f: Flaw }) {
  const e = f.explanation;
  const m = e.strongest_evidence;
  return (
    <div className="space-y-2 text-[13px]">
      {[...(m ? [m] : []), ...e.supporting_evidence].map((s, i) => (
        <div key={i} className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {s.label} <span className="text-ink/80">“{s.word}”</span>
          </span>
          <span className="font-mono text-[12px] tabular">
            {s.observed !== null ? `${s.bound === "upper" ? "≤" : ""}${s.observed} vs ${s.reference} ${s.unit}` : "—"}
          </span>
          <Tooltip>
            <TooltipTrigger render={<span />} className="w-[52px] cursor-help text-right font-mono text-[12px] text-muted-foreground tabular">
              {fmtSigned(s.z, 1)}σ
            </TooltipTrigger>
            <TooltipContent className="max-w-[240px]">How far outside the reference deliveries' usual variation this is (robust z-score).</TooltipContent>
          </Tooltip>
        </div>
      ))}
      {m?.note && <p className="pt-1 text-[12px] text-muted-foreground">Note: {m.note}</p>}
      <p className="pt-2 font-mono text-[11.5px] leading-relaxed text-faint">{e.summary}</p>
    </div>
  );
}

function Confidence({ f }: { f: Flaw }) {
  const e = f.explanation;
  const flags = e.quality_flags.length + e.unavailable_evidence.length;
  return (
    <div className="space-y-2 text-[13px]">
      <p className="text-muted-foreground">
        {f.severity.n_evidence_words} of {f.n_words} words could be measured reliably. The start and end of the finding are placed within ±
        {fmt(Math.max(f.start_uncertainty_s, f.end_uncertainty_s), 2)} s.
      </p>
      {flags === 0 && (
        <p className="flex items-center gap-1.5 text-muted-foreground"><CircleCheck className="size-3.5 text-truth" /> No reliability warnings.</p>
      )}
      {e.quality_flags.map((q) => (
        <p key={q.flag} className="flex items-start gap-1.5 text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span><span className="font-medium capitalize">{humanize(q.flag)}</span>: <span className="text-muted-foreground">{q.note}</span></span>
        </p>
      ))}
      {e.unavailable_evidence.map((u) => (
        <p key={u.feature} className="text-muted-foreground">
          Not measured: {u.label} on {u.n_words} word{u.n_words > 1 ? "s" : ""}.
        </p>
      ))}
      {(e.co_occurring?.length ?? 0) > 0 && (
        <p className="text-muted-foreground">
          Also at this moment: {e.co_occurring!.map((o) => plainTitle(o).toLowerCase()).join(", ")}.
        </p>
      )}
    </div>
  );
}

function DemoCheck({ take, f }: { take: Take; f: Flaw }) {
  const truth = truthFor(take, f);
  if (!truth) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-hairline bg-ink/[0.03] px-4 py-3 text-[13.5px]">
        <Info className="mt-0.5 size-4 shrink-0 text-ink/50" />
        <p>
          <span className="font-medium">Clean recording: </span>
          nothing was injected here, so this is either a genuine difference from the other good deliveries or a false alarm. The
          reference delivery above is the best way to judge which.
        </p>
      </div>
    );
  }
  const hit = truth[0];
  const near = hit ? null : take.ground_truth?.find((g) => f.start_idx <= g.end_idx + 2 && f.end_idx >= g.start_idx - 2);
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[13.5px]", hit ? "border-truth/25 bg-truth/[0.06]" : "border-warn/25 bg-warn/[0.06]")}>
      {hit ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-truth" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-warn" />}
      <p>
        <span className="font-medium">Demo check: </span>
        {hit ? (
          <>this matches the injected “{kindLabel(hit.kind).toLowerCase()}” edit. The finding covers {Math.round((hit.iou ?? 0) * 100)}% of the same time.</>
        ) : near ? (
          <>no {CATEGORY[f.category].label.toLowerCase()} edit was injected here, so on this demo it counts as a false alarm. It sits right next to the injected “{kindLabel(near.kind).toLowerCase()}” edit, so it is likely a side effect of it.</>
        ) : (
          <>no edit was injected here, so on this demo recording this finding is a false alarm.</>
        )}{" "}
        <Link to={overviewPath(take.id)} className="whitespace-nowrap text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink">See all injected edits</Link>
      </p>
    </div>
  );
}
