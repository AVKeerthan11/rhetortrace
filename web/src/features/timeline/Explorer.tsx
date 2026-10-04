import { useCallback, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CircleCheck, CircleX, Pause, Play, X } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { plainEvidence, plainTitle, takeRange, truthFor } from "@/lib/findings";
import { fmt } from "@/lib/format";
import { spring } from "@/lib/motion";
import { player, usePlayerState, type Player } from "@/lib/player";
import { useCaptureOnUnmount, useFlightTarget } from "@/lib/flight";
import { findingPath } from "@/lib/takes";
import { kindLabel } from "@/lib/validation";
import type { Take, Word } from "@/lib/types";
import { FindingNumber } from "@/components/FindingNumber";
import { SeverityBadge } from "@/components/SeverityBadge";
import { useTakeContext } from "@/features/stage/context";
import { useStage } from "@/features/stage/store";
import { Transcript } from "./Transcript";

/** Every measurement: the stage above shows all lanes (it unfolded from the overview or a
 *  finding); here the transcript, with the selected finding's summary sheet. Selection lives in
 *  the URL (?f=<finding number>), so the stage, J / K and shared links all agree. Keys are the
 *  recording's (useStageKeys). */
export function Explorer() {
  const { take, ranking, ranks } = useTakeContext();
  const selected = useStage((s) => s.selected);
  const [params, setParams] = useSearchParams();
  const fParam = params.get("f");

  // ?f= -> selected finding, framed by the camera
  useEffect(() => {
    const n = Number(fParam);
    const i = n >= 1 && n <= ranking.length ? ranking[n - 1] : null;
    const s = useStage.getState();
    s.setSelected(i);
    if (i === null) return;
    const f = take.flaws[i];
    const pad = Math.max(1.4, (f.end - f.start) * 0.75);
    s.setView([f.start - pad, f.end + pad]);
    player.stop();
    player.seek(f.start);
  }, [fParam, ranking, take]);

  const close = useCallback(() => setParams({}, { replace: true }), [setParams]);
  const jumpToWord = useCallback((w: Word) => {
    if (w.start === null || w.end === null) return;
    const [a, b] = useStage.getState().view;
    const span = Math.min(b - a, 8), c = (w.start + w.end) / 2;
    useStage.getState().setView([c - span / 2, c + span / 2]);
    player.seek(w.start);
  }, []);

  return (
    <div className="relative h-full bg-surface">
      <div className="h-full transition-[padding] duration-300 lg:pr-[var(--sheet)]" style={{ ["--sheet" as string]: selected !== null ? "392px" : "0px" }}>
        <Transcript take={take} selected={selected} player={player} onWord={jumpToWord} />
      </div>
      <AnimatePresence>
        {selected !== null && (
          <FindingSheet key={selected} take={take} flawIndex={selected} rank={ranks[selected]} player={player} onClose={close} />
        )}
      </AnimatePresence>
    </div>
  );
}

function FindingSheet({ take, flawIndex, rank, player, onClose }: { take: Take; flawIndex: number; rank: number; player: Player; onClose: () => void }) {
  const f = take.flaws[flawIndex];
  const m = f.explanation.strongest_evidence;
  const ev = m ? plainEvidence(m) : null;
  const { playing, label } = usePlayerState(player);
  const myLabel = `Finding ${rank} · this recording`;
  const isPlaying = playing && label === myLabel;
  const [a, b] = takeRange(take, f);
  const truth = truthFor(take, f);
  const root = useRef<HTMLElement>(null);
  const badge = useFlightTarget<HTMLSpanElement>(`badge-${rank}`);
  const title = useFlightTarget<HTMLHeadingElement>(`title-${rank}`);
  useCaptureOnUnmount(root, rank);
  return (
    <motion.aside ref={root}
      initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }} transition={spring.smooth}
      className="absolute inset-x-2 bottom-2 z-10 flex max-h-[62%] flex-col overflow-y-auto rounded-2xl bg-surface p-5 shadow-float lg:inset-x-auto lg:top-3 lg:right-3 lg:bottom-auto lg:max-h-[calc(100%-24px)] lg:w-[368px]"
    >
      <div className="flex items-center gap-2">
        <FindingNumber n={rank} category={f.category} active ref={badge} flight="badge" />
        <span className="text-[11.5px] font-semibold tracking-[0.12em] uppercase" style={{ color: CATEGORY[f.category].color }}>{CATEGORY[f.category].label}</span>
        <SeverityBadge level={f.severity.level} label={f.severity.label} />
        <button onClick={onClose} aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-ink">
          <X className="size-4" />
        </button>
      </div>
      <h2 ref={title} data-flight="title" className="mt-3 font-display text-[28px] leading-tight">{plainTitle(f)}</h2>
      <p className="mt-1 text-[14px] text-muted-foreground">“{f.words.join(" ")}” · {fmt(f.start, 1)}–{fmt(f.end, 1)} s</p>
      {ev && <p className="mt-4 text-[13.5px] leading-relaxed text-ink/80">{ev.lead} {ev.compare}</p>}
      {truth && (
        <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
          {truth[0] ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-truth" /> : <CircleX className="mt-0.5 size-3.5 shrink-0 text-warn" />}
          {truth[0] ? `Matches the injected “${kindLabel(truth[0].kind).toLowerCase()}” edit.` : "No edit was injected here: a false alarm on this demo."}
        </p>
      )}
      <div className="space-y-2 pt-5">
        <button onClick={() => (isPlaying ? player.stop() : player.playSegment(a, b, myLabel))}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-full border border-hairline text-[13.5px] font-medium transition-colors hover:border-ink/25">
          {isPlaying ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
          {isPlaying ? "Stop" : "Play this moment"}
        </button>
        <Link to={findingPath(take.id, rank)}
          className="group flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-medium text-primary-foreground">
          Open finding: hear, compare, improve
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </motion.aside>
  );
}
