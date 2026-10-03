import { useMemo } from "react";
import { player } from "@/lib/player";
import type { Layers } from "@/lib/store";
import type { Take, Word } from "@/lib/types";
import { Timeline } from "@/features/timeline/Timeline";
import { useView } from "@/features/timeline/useView";
import { WordTiming } from "./WordTiming";

/** A few seconds of the timeline around one finding, with only the lane that finding is about.
 *  Pauses and pacing also get a word-timing comparison against the reference deliveries. */
export function CloseUp({ take, flawIndex }: { take: Take; flawIndex: number }) {
  const f = take.flaws[flawIndex];
  const pad = Math.max(1.2, (f.end - f.start) * 0.6);
  const initial = useMemo<[number, number]>(() => [f.start - pad, f.end + pad], [f.start, f.end, pad]);
  const { view, setView } = useView(take.duration, initial);

  const layers = useMemo<Layers>(
    () => ({ pitch: f.category === "pitch", energy: f.category === "energy", reference: true, deviation: false, truth: false }),
    [f.category],
  );
  const hearWord = (w: Word) => w.start !== null && w.end !== null && player.playSegment(w.start - 0.05, w.end + 0.1, `“${w.text}” · this recording`);
  const timing = f.category === "pause" || f.category === "pacing";

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-hairline bg-well/50 px-3 pt-2 pb-2">
        <Timeline take={take} view={view} setView={setView} player={player} selected={flawIndex}
          onSelect={() => {}} onWord={hearWord} layers={layers} compact />
        <p className="mt-1 pl-[76px] text-[11.5px] text-faint">
          {f.category === "pitch" || f.category === "energy"
            ? "The line is this recording; the shaded band is the range of the reference deliveries. "
            : ""}
          Click a word to hear it. Drag to pan, Ctrl + scroll to zoom.
        </p>
      </div>
      {timing && <WordTiming take={take} f={f} />}
    </div>
  );
}
