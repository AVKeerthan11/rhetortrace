import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, CircleCheck, CircleX, Pause, Play, X } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { useTake } from "@/lib/data";
import { plainEvidence, plainTitle, rankFindings, takeRange, truthFor } from "@/lib/findings";
import { fmt } from "@/lib/format";
import { isTypingTarget } from "@/lib/keys";
import { ease, spring } from "@/lib/motion";
import { usePlayerState, useTakeAudio, type Player } from "@/lib/player";
import { useUi } from "@/lib/store";
import { findingPath, overviewPath } from "@/lib/takes";
import { kindLabel } from "@/lib/validation";
import type { Take, Word } from "@/lib/types";
import { FindingNumber } from "@/components/FindingNumber";
import { PageState } from "@/components/PageState";
import { SeverityBadge } from "@/components/SeverityBadge";
import { Timeline } from "./Timeline";
import { Transcript } from "./Transcript";
import { TransportBar } from "./TransportBar";
import { useView } from "./useView";

/** Advanced view: the whole recording with every lane. Reached on purpose from the overview
 *  or a finding. Findings are numbered markers; selecting one opens a summary sheet that
 *  leads back into the guided finding page. */
export function Explorer() {
  const { id } = useParams();
  const { data: take, error } = useTake(id);
  if (error) return <PageState title="Could not load this recording" detail={error} />;
  if (!take) return <ExplorerSkeleton />;
  return <ExplorerBody key={take.id} take={take} />;
}

function ExplorerBody({ take }: { take: Take }) {
  const player = useTakeAudio(take.audio);
  const { view, setView, zoom, fit, current } = useView(take.duration);
  const layers = useUi((s) => s.layers);
  const ranking = useMemo(() => rankFindings(take), [take]);
  const ranks = useMemo(() => {
    const r: number[] = [];
    ranking.forEach((fi, k) => (r[fi] = k + 1));
    return r;
  }, [ranking]);
  const byTime = useMemo(() => take.flaws.map((_, i) => i).sort((a, b) => take.flaws[a].start - take.flaws[b].start), [take]);
  const [selected, setSelected] = useState<number | null>(null);
  const [params, setParams] = useSearchParams();

  const select = useCallback(
    (i: number | null, smooth = true) => {
      setSelected(i);
      setParams(i === null ? {} : { f: String(ranks[i]) }, { replace: true });
      if (i === null) return;
      const f = take.flaws[i];
      const pad = Math.max(1.4, (f.end - f.start) * 0.75);
      setView([f.start - pad, f.end + pad], smooth);
      player.stop();
      player.seek(f.start);
    },
    [take, ranks, setView, player, setParams],
  );

  // ?f=<finding number> (from "Open in full timeline" or a shared link)
  const fParam = params.get("f");
  const mounted = useRef(false);
  useEffect(() => {
    const n = Number(fParam);
    const i = n >= 1 && n <= ranking.length ? ranking[n - 1] : null;
    if (i !== null && i !== selected) select(i, mounted.current);
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fParam]);

  const jumpToWord = useCallback(
    (w: Word) => {
      if (w.start === null || w.end === null) return;
      const [a, b] = current.current;
      const span = Math.min(b - a, 8);
      const c = (w.start + w.end) / 2;
      setView([c - span / 2, c + span / 2]);
      player.seek(w.start);
    },
    [current, setView, player],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!byTime.length) return;
      const pos = selected === null ? (dir === 1 ? -1 : 0) : byTime.indexOf(selected);
      select(byTime[(pos + dir + byTime.length) % byTime.length]);
    },
    [byTime, selected, select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") { e.preventDefault(); player.toggle(); }
      else if (e.key === "j" || e.key === "J") step(1);
      else if (e.key === "k" || e.key === "K") step(-1);
      else if (e.key === "Escape") { if (selected !== null) select(null); else fit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, step, fit, selected, select]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-baseline gap-3 px-5 pt-4 pb-2">
        <h1 className="font-display text-[24px] leading-none">Timeline explorer</h1>
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          Every measurement across the whole recording. Click a numbered finding for its summary · scroll to zoom · drag to pan
          {take.ground_truth ? " · View › Injected edits shows the answer key" : ""}.
        </p>
        <Link to={overviewPath(take.id)} className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-ink">
          <ArrowLeft className="size-3.5" /> Summary
        </Link>
      </div>
      <motion.section initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}
        className="shrink-0 border-y border-hairline bg-well/60 px-5 pt-3 pb-3">
        <Timeline take={take} view={view} setView={setView} player={player} selected={selected}
          onSelect={(i) => select(i)} onWord={jumpToWord} layers={layers} ranks={ranks} />
      </motion.section>

      <div className="relative min-h-0 flex-1 bg-surface">
        <div className="h-full transition-[padding] duration-300" style={{ paddingRight: selected !== null ? 384 : 0 }}>
          <Transcript take={take} selected={selected} player={player} onWord={jumpToWord} />
        </div>
        <AnimatePresence>
          {selected !== null && (
            <FindingSheet key={selected} take={take} flawIndex={selected} rank={ranks[selected]} player={player} onClose={() => select(null)} />
          )}
        </AnimatePresence>
      </div>

      <TransportBar take={take} player={player} selected={selected} rank={selected !== null ? ranks[selected] : null}
        onPrev={() => step(-1)} onNext={() => step(1)} onZoom={(k) => zoom(k)} onFit={fit} />
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
  return (
    <motion.aside
      initial={{ x: 32, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 24, opacity: 0 }} transition={spring.smooth}
      className="absolute top-3 right-3 z-10 flex max-h-[calc(100%-24px)] w-[360px] flex-col overflow-y-auto rounded-2xl bg-surface p-5 shadow-float"
    >
      <div className="flex items-center gap-2">
        <FindingNumber n={rank} category={f.category} active />
        <span className="text-[11.5px] font-semibold tracking-[0.12em] uppercase" style={{ color: CATEGORY[f.category].color }}>{CATEGORY[f.category].label}</span>
        <SeverityBadge level={f.severity.level} label={f.severity.label} />
        <button onClick={onClose} aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-ink">
          <X className="size-4" />
        </button>
      </div>
      <h2 className="mt-3 font-display text-[28px] leading-tight">{plainTitle(f)}</h2>
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

function ExplorerSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="h-[230px] border-b border-hairline bg-well/60 px-5 py-4"><div className="shimmer h-full w-full rounded-lg" /></div>
      <div className="flex-1 space-y-3 bg-surface p-6">
        {[92, 78, 85, 60].map((w, i) => <div key={i} className="shimmer h-4 rounded" style={{ width: `${w}%` }} />)}
      </div>
    </div>
  );
}
