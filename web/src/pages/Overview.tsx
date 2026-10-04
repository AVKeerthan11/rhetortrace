import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, Info, Pause, Play, ScanLine } from "lucide-react";
import { CATEGORIES, CATEGORY } from "@/lib/categories";
import { CATEGORY_MEANING, plainTitle, takeRange } from "@/lib/findings";
import { fmt, fmtShort } from "@/lib/format";
import { ease } from "@/lib/motion";
import { player, usePlayerState } from "@/lib/player";
import { explorePath, findingPath, overviewPath, referenceName } from "@/lib/takes";
import type { Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AnnotatedTranscript } from "@/components/AnnotatedTranscript";
import { AnswerKey } from "@/components/AnswerKey";
import { FindingNumber } from "@/components/FindingNumber";
import { SeverityBadge } from "@/components/SeverityBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTakeContext } from "@/features/stage/context";
import { useStage } from "@/features/stage/store";
import { captureFlights, useFlightTarget } from "@/lib/flight";
import { findingAt, useTimeSelect } from "@/lib/time";

const rise = (i: number) => ({ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.04 * i, duration: 0.4, ease } });

/** The whole recording, zoomed out: what it is, the verdict, every finding, and the script with
 *  the findings marked in it. The stage above shows where each finding sits; hovering a finding
 *  here or there highlights it in both. */
export function Overview() {
  const { take, ranking } = useTakeContext();
  const navigate = useNavigate();
  const hovered = useStage((s) => s.hovered);
  // the finding under the focus time (pointer anywhere, else the playhead): marked "now" in the list
  const now = useTimeSelect("focus", (t) => findingAt(take, t));
  const setHovered = useStage((s) => s.setHovered);
  const open = (rank: number) => navigate(findingPath(take.id, rank + 1));
  const top = ranking.length ? take.flaws[ranking[0]] : null;
  const demo = take.kind === "demo";
  const user = take.kind === "user";
  const opening = take.transcript.split(" ").slice(0, 12).join(" ");

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="page grid-page gap-y-12 pt-8 pb-28 lg:pt-10">
        <div className="col-span-full min-w-0 lg:col-span-7">
          <motion.h1 {...rise(0)} className="font-display text-display-l">“{opening} …”</motion.h1>
          <motion.p {...rise(1)} className="mt-3 text-[14px] text-muted-foreground">
            {Math.round(take.duration)} seconds · {take.words.length} words · compared with{" "}
            {take.baseline.references.length} reference deliveries of the same script
          </motion.p>
          <motion.div {...rise(2)}><ContextNote take={take} demo={demo} user={user} /></motion.div>

          {/* verdict */}
          <motion.section {...rise(3)} className="mt-10 flex flex-wrap items-end gap-x-8 gap-y-4">
            <div className="min-w-0 flex-1 basis-[320px]">
              {top ? (
                <>
                  <p className="font-display text-display-m">
                    {ranking.length} moment{ranking.length === 1 ? "" : "s"} differ from the reference deliveries.
                  </p>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                    The most serious: <span className="text-ink">{plainTitle(top).toLowerCase()}</span> on “{top.words.slice(0, 6).join(" ")}
                    {top.words.length > 6 ? " …" : ""}”.
                  </p>
                </>
              ) : (
                <p className="font-display text-display-m">This delivery matches the reference deliveries. Nothing to flag.</p>
              )}
            </div>
            <ScoreChip take={take} />
          </motion.section>

          {top && (
            <motion.div {...rise(4)} className="mt-7">
              <Link to={findingPath(take.id, 1)}
                className="group inline-flex h-12 items-center gap-2.5 rounded-full bg-ink pr-5 pl-6 text-[15px] font-medium text-primary-foreground shadow-[0_6px_20px_-6px_color-mix(in_oklab,var(--shadow)_45%,transparent)] transition-transform hover:scale-[1.02] active:scale-[0.99]">
                Start with the most important finding
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </motion.div>
          )}

          {ranking.length > 0 && (
            <motion.section {...rise(5)} className="mt-12">
              <h2 className="mb-2 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">All findings, most important first</h2>
              <ol className="-mx-3">
                {ranking.map((fi, r) => (
                  <FindingRow key={fi} take={take} flawIndex={fi} rank={r} hovered={hovered === fi} now={now === fi} onHover={(on) => setHovered(on ? fi : null)} />
                ))}
              </ol>
            </motion.section>
          )}
        </div>

        {/* the margin: the script with the findings marked, and how the score is made */}
        <aside aria-label="The script and the score" className="col-span-full min-w-0 space-y-10 lg:col-span-5 lg:col-start-8 xl:col-span-4 xl:col-start-9">
          <motion.section {...rise(3)} className="border-t border-hairline pt-4">
            <h2 className="mb-3 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">The script, with each finding marked</h2>
            <AnnotatedTranscript take={take} ranking={ranking} onOpen={open} className="text-[17.5px] leading-[1.8]"
              onHover={(r) => setHovered(r === null ? null : ranking[r])} />
          </motion.section>

          {demo && take.ground_truth && (
            <motion.section {...rise(4)} className="border-t border-hairline pt-4">
              <h2 className="mb-1 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">What was injected</h2>
              <p className="mb-3 text-[13px] text-muted-foreground">The answer key for this demo: each edit, and the finding that caught it.</p>
              <AnswerKey take={take} />
            </motion.section>
          )}

          <motion.section {...rise(5)} className="border-t border-hairline pt-4">
            <h2 className="mb-3 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">How the delivery score is made</h2>
            <ScoreBreakdown take={take} />
          </motion.section>

          <Link to={explorePath(take.id)}
            className="group flex items-center gap-2 border-t border-hairline pt-5 text-[13.5px] text-muted-foreground transition-colors hover:text-ink">
            <ScanLine className="size-4" /> Explore every measurement in the timeline
            <ArrowRight className="ml-auto size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
          </Link>
        </aside>
      </div>
    </div>
  );
}

function ContextNote({ take, demo, user }: { take: Take; demo: boolean; user: boolean }) {
  if (demo)
    return (
      <p className="mt-4 flex items-start gap-2 rounded-xl bg-highlight-soft/70 px-3.5 py-2.5 text-[13px] leading-snug text-ink/80">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Demo recording: {take.ground_truth?.length ?? "several"} flaws were injected on purpose into{" "}
          <RecordingLink take={take} takeId={take.source_take} />. It is compared with the other clean deliveries (
          <RefLinks take={take} />). “What was injected”, beside the findings, shows which findings match the edits.
        </span>
      </p>
    );
  if (user)
    return (
      <p className="mt-4 flex items-start gap-2 rounded-xl bg-ink/[0.04] px-3.5 py-2.5 text-[13px] leading-snug text-ink/75">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Your recording, compared with the reference deliveries you chose (<RefLinks take={take} />). Each finding is a place where
          your delivery differs from all of them{take.qc.asr_wer != null && <>; speech recognition matched {Math.round((1 - take.qc.asr_wer) * 100)}% of the
          transcript's words</>}.
        </span>
      </p>
    );
  return (
    <p className="mt-4 flex items-start gap-2 rounded-xl bg-ink/[0.04] px-3.5 py-2.5 text-[13px] leading-snug text-ink/75">
      <Info className="mt-0.5 size-4 shrink-0" />
      <span>
        Clean recording: a good delivery, compared with the other clean deliveries (<RefLinks take={take} />). Nothing was
        injected here, so every finding is a difference between good speakers, or a false alarm.
      </span>
    </p>
  );
}

function RecordingLink({ take, takeId }: { take: Take; takeId: string | null }) {
  if (!takeId) return null;
  return (
    <Link to={overviewPath(`${take.speech_id}__${takeId}`)} className="text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink">
      clean recording {takeId.split("_")[1]}
    </Link>
  );
}

function RefLinks({ take }: { take: Take }) {
  return (
    <>
      {take.baseline.references.map((r, i) => (
        <span key={r}>
          {i > 0 && (i === take.baseline.references.length - 1 ? " and " : ", ")}
          {take.kind === "user" ? <span className="text-ink">{referenceName(take, r)}</span> : <RecordingLink take={take} takeId={r} />}
        </span>
      ))}
    </>
  );
}

function ScoreChip({ take }: { take: Take }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div />} className="shrink-0 cursor-help text-right">
        <div className="flex items-center justify-end gap-1 text-[11px] font-medium tracking-[0.12em] text-faint uppercase">
          Delivery score <Info className="size-3" />
        </div>
        <div className="mt-0.5 font-mono text-[22px] text-ink/80 tabular">
          {fmt(take.score.total, 1)}
          <span className="text-[13px] text-faint"> / 100</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px]">
        Starts at 100 and loses points for each finding, more for severe ones. It is a summary only: the findings are what to act on.
      </TooltipContent>
    </Tooltip>
  );
}

function FindingRow({ take, flawIndex, rank, hovered, now, onHover }: {
  take: Take; flawIndex: number; rank: number; hovered: boolean; now: boolean; onHover: (on: boolean) => void;
}) {
  const f = take.flaws[flawIndex];
  const { playing, label } = usePlayerState();
  const myLabel = `Finding ${rank + 1} · this recording`;
  const isPlaying = playing && label === myLabel;
  const [a, b] = takeRange(take, f);
  const badge = useFlightTarget<HTMLSpanElement>(`badge-${rank + 1}`);
  const title = useFlightTarget<HTMLSpanElement>(`title-${rank + 1}`);
  return (
    <li data-finding-row={rank + 1} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}
      data-now={now || undefined}
      className={cn("group relative flex items-center gap-3 rounded-xl px-3 py-3 transition-[background-color,box-shadow] duration-150", hovered && "bg-surface shadow-float")}>
      {/* "now": the playhead or the pointer is inside this finding */}
      <span aria-hidden className={cn("absolute top-3 bottom-3 left-0 w-[2px] rounded-full bg-[var(--now)] transition-opacity duration-150", now ? "opacity-100" : "opacity-0")} />
      <button
        onClick={() => (isPlaying ? player.stop() : player.playSegment(a, b, myLabel))}
        aria-label={isPlaying ? "Stop" : `Play finding ${rank + 1}`}
        className="relative z-10 grid size-8 shrink-0 place-items-center rounded-full border border-hairline bg-surface text-ink/70 transition-colors hover:border-ink/30 hover:text-ink"
      >
        {isPlaying ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
      </button>
      <Link to={findingPath(take.id, rank + 1)} onClick={(e) => captureFlights(e.currentTarget.closest("li"), rank + 1)} className="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 after:rounded-xl">
        <FindingNumber n={rank + 1} category={f.category} active={hovered} ref={badge} flight="badge" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span ref={title} data-flight="title" className="text-[15px] font-medium">{plainTitle(f)}</span>
            <SeverityBadge level={f.severity.level} label={f.severity.label} />
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
            “{f.words.slice(0, 9).join(" ")}{f.words.length > 9 ? " …" : ""}”
          </span>
        </span>
        <span className="hidden font-mono text-[11.5px] text-faint tabular sm:inline">{fmtShort(f.start)}</span>
        <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </Link>
    </li>
  );
}

function ScoreBreakdown({ take }: { take: Take }) {
  // count the findings listed (n_tracks also counts tracks folded into other findings)
  const rows = CATEGORIES.map((c) => ({ c, row: take.score.categories[c], n: take.flaws.filter((f) => f.category === c).length }));
  return (
    <div className="text-[13px]">
      <p className="mb-3 text-muted-foreground">
        Each aspect of delivery starts at full marks and loses points for its findings. The aspects are weighted and added up.
      </p>
      <table className="w-full">
        <tbody className="divide-y divide-hairline">
          {rows.map(({ c, row, n }) => (
            <tr key={c}>
              <td className="py-2 pr-3">
                <Tooltip>
                  <TooltipTrigger render={<span />} className="flex cursor-help items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: CATEGORY[c].color }} />
                    {CATEGORY[c].label}
                  </TooltipTrigger>
                  <TooltipContent>{CATEGORY_MEANING[c]}</TooltipContent>
                </Tooltip>
              </td>
              <td className="py-2 pr-3 text-right whitespace-nowrap text-muted-foreground">
                {n ? `${n} finding${n === 1 ? "" : "s"}` : row.lost > 0 ? "within other findings" : "no findings"}
              </td>
              <td className="py-2 text-right font-mono text-[12.5px] tabular">{row.lost > 0 ? `−${fmt(row.lost, 1)}` : "0"}</td>
            </tr>
          ))}
          <tr>
            <td className="pt-3 font-medium" colSpan={2}>Delivery score</td>
            <td className="pt-3 text-right font-mono text-[13px] font-medium tabular">{fmt(take.score.total, 1)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
