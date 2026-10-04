import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { useCurrentTake } from "@/components/layout/useCurrentTake";
import { PageState } from "@/components/PageState";
import { useTake } from "@/lib/data";
import { rankFindings } from "@/lib/findings";
import { duration, ease, levelSwap } from "@/lib/motion";
import { installLiveLevel } from "@/lib/live";
import { player, useTakeAudio } from "@/lib/player";
import { useUi } from "@/lib/store";
import { explorePath, findingPath } from "@/lib/takes";
import type { Take, Word } from "@/lib/types";
import type { TakeContext } from "./context";
import { Stage } from "./Stage";
import { StageHeader } from "./StageHeader";
import { StageTransport } from "./StageTransport";
import { useStageKeys } from "./useStageKeys";
import { LEVEL_MOVE, LEVEL_ORDER, findingWindow, useStage, type Level } from "./store";

// One recording, three zoom levels. This layout route stays mounted while the user moves
// between /take/:id (overview), /take/:id/finding/:n and /take/:id/explore: the stage, its
// audio, camera and selection persist, and only the content underneath changes. Moving deeper
// is a camera move on the same waveform (the whole recording → one moment → every measurement).

const prefetch = () => {
  void import("@/pages/Overview");
  void import("@/features/finding/FindingPage");
  void import("@/features/timeline/Explorer");
};

export function TakeLayout() {
  const { id } = useParams();
  const { data: take, error } = useTake(id);
  if (error) return <PageState title="Could not load this recording" detail={error} />;
  if (!take) return <StageSkeleton />;
  return <TakeLayoutBody key={take.id} take={take} />;
}

function TakeLayoutBody({ take }: { take: Take }) {
  useState(() => useStage.getState().reset(take.id, take.duration)); // before the first paint
  useTakeAudio(take.audio);
  useEffect(prefetch, []);
  useEffect(installLiveLevel, []);
  const navigate = useNavigate();
  const { view: level, rank } = useCurrentTake();
  const layers = useUi((s) => s.layers);
  const ranking = useMemo(() => rankFindings(take), [take]);
  const ranks = useMemo(() => {
    const r: number[] = [];
    ranking.forEach((fi, k) => (r[fi] = k + 1));
    return r;
  }, [ranking]);
  const focus = level === "finding" && rank ? (ranking[rank - 1] ?? null) : null;
  const byTime = useMemo(() => take.flaws.map((_, i) => i).sort((a, b) => take.flaws[a].start - take.flaws[b].start), [take]);

  // camera: each level frames the recording its own way
  useEffect(() => {
    const s = useStage.getState();
    if (level !== "explore") s.setSelected(null);
    if (level === "overview") s.setView([0, take.duration], LEVEL_MOVE);
    else if (level === "finding" && focus !== null) {
      s.setView(findingWindow(take.flaws[focus]), LEVEL_MOVE);
      s.setLastRank(rank!);
    }
    // explore keeps the current window (it zooms from wherever the user was); ?f= frames a finding
  }, [level, focus, rank, take]);

  // content direction: deeper levels rise from below the stage, shallower ones come down
  const [prevLevel, setPrevLevel] = useState<Level>(level);
  const [dir, setDir] = useState(1);
  if (prevLevel !== level) {
    setDir(Math.sign(LEVEL_ORDER[level] - LEVEL_ORDER[prevLevel]) || 1);
    setPrevLevel(level);
  }

  const onFinding = useCallback(
    (i: number) => navigate(level === "explore" ? explorePath(take.id, ranks[i]) : findingPath(take.id, ranks[i]), { replace: level === "explore" }),
    [level, navigate, take.id, ranks],
  );
  const onWord = useCallback(
    (w: Word) => {
      if (w.start === null || w.end === null) return;
      if (level === "finding") return player.playSegment(w.start - 0.05, w.end + 0.1, `“${w.text}” · this recording`);
      if (level === "explore") {
        const [a, b] = useStage.getState().view;
        const span = Math.min(b - a, 8), c = (w.start + w.end) / 2;
        useStage.getState().setView([c - span / 2, c + span / 2]);
      }
      player.seek(w.start);
    },
    [level],
  );
  const onStep = useCallback(
    (d: 1 | -1) => {
      if (!byTime.length) return;
      const sel = useStage.getState().selected;
      const pos = sel === null ? (d === 1 ? -1 : 0) : byTime.indexOf(sel);
      const next = byTime[(pos + d + byTime.length) % byTime.length];
      navigate(explorePath(take.id, ranks[next]), { replace: true });
    },
    [byTime, navigate, take.id, ranks],
  );

  useStageKeys({ take, level, rank, ranking, ranks, focus, onStep });

  const ctx: TakeContext = { take, ranking, ranks, onStep };
  const outlet = useOutlet(ctx);

  return (
    <div className="flex h-full flex-col">
      {/* the stage: the recording itself is the primary surface of every screen of it */}
      {/* the instrument: the recording stage, a raised panel on a band a step deeper than the page */}
      <section aria-label="Recording" className="studio-band shrink-0">
        <div className="page">
          <StageHeader take={take} level={level} rank={rank} ranking={ranking} />
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.standard, ease }}
            className="studio-panel rounded-2xl px-2 pt-2 pb-1.5 sm:px-3">
            <Stage take={take} level={level} player={player} ranks={ranks} focus={focus} layers={layers} onFinding={onFinding} onWord={onWord} />
          </motion.div>
          <StageTransport take={take} level={level} player={player} ranks={ranks} onStep={onStep} />
        </div>
      </section>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div key={level} custom={dir} variants={levelSwap} initial="initial" animate="animate" exit="exit" className="h-full">
            <Suspense fallback={<ContentSkeleton />}>{outlet}</Suspense>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ContentSkeleton() {
  return (
    <div className="page space-y-4 pt-10">
      <div className="shimmer h-8 w-1/2 rounded-lg" />
      <div className="shimmer h-4 w-2/3 rounded" />
      <div className="shimmer h-40 w-full rounded-2xl" />
    </div>
  );
}

function StageSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="studio-band">
        <div className="page space-y-3 py-4">
          <div className="shimmer h-8 w-64 rounded-lg" />
          <div className="shimmer h-[150px] w-full rounded-xl" />
          <div className="shimmer h-8 w-48 rounded-full" />
        </div>
      </div>
      <ContentSkeleton />
    </div>
  );
}
