import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { motion } from "motion/react";
import { Play, Square } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { evidenceSpan } from "@/lib/evidence";
import { fmt } from "@/lib/format";
import { REF } from "@/lib/grammar";
import { prefersReducedMotion } from "@/lib/motion";
import { PROOF, player, useProofPhase, usePlayerState } from "@/lib/player";
import { referenceName } from "@/lib/takes";
import type { Flaw, Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { refSpan } from "@/features/stage/threads";

// The evidence chain of a finding: the claim (this recording's value vs the references') is
// tied to where it was measured. Pointing at either value draws a line from it to its place on
// the stage (the hatched mark on the audio, or the reference's caliper in the Threads lane);
// "Play the proof" plays this recording's moment, then the reference's, and the line follows
// whichever is audible.

const useProofFocus = create<{ focus: "take" | "ref" | null; set: (f: "take" | "ref" | null) => void }>()((set) => ({
  focus: null,
  set: (focus) => set({ focus }),
}));

const PAD = 0.3;

export function ProofRow({ take, f, refIdx }: { take: Take; f: Flaw; refIdx: number }) {
  const m = f.explanation.strongest_evidence;
  const setFocus = useProofFocus((s) => s.set);
  const phase = useProofPhase();
  const { playing, refPlaying, label } = usePlayerState();
  const span = m ? evidenceSpan(take, m) : null;
  if (!m || m.observed === null || !span) return null;
  const ref = take.references[refIdx];
  const rs = ref ? refSpan(take, refIdx, { m, span }) : null;
  const refName = ref ? referenceName(take, ref.take_id) : "";
  const c = CATEGORY[f.category].color;
  const mine: [number, number] = [Math.max(0, take.words[m.idx].start! - PAD), Math.min(take.duration, span.end + PAD)];
  const theirs: [number, number] | null = rs && ref ? [Math.max(0, (ref.words[m.idx]?.[0] ?? rs[0]) - PAD), rs[1] + PAD] : null;
  const active = (playing || refPlaying) && label?.startsWith(PROOF);

  const play = () => {
    if (active) return player.stop();
    player.playSequence([
      { kind: "take", range: mine, label: `${PROOF} this recording` },
      ...(theirs && ref ? [{ kind: "ref" as const, src: ref.audio, range: theirs, label: `${PROOF} reference ${refName}` }] : []),
    ]);
  };
  const chip = (which: "take" | "ref") => ({
    onPointerEnter: () => setFocus(which),
    onPointerLeave: () => setFocus(null),
    onFocus: () => setFocus(which),
    onBlur: () => setFocus(null),
  });
  const refValue = m.reference_points?.find((p) => p.take === ref?.take_id)?.value ?? m.reference;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[13px]">
      <button {...chip("take")} data-proof-chip="take" onClick={() => player.playSegment(mine[0], mine[1], `${PROOF} this recording`)}
        className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors", phase === "take" ? "border-ink bg-highlight-soft" : "border-hairline hover:border-ink/30")}>
        <span className="size-2.5 rounded-full" style={{ background: c }} />
        This recording <span className="font-mono font-medium" style={{ color: c }}>{m.bound === "upper" ? "≤" : ""}{fmt(m.observed, 2)} {m.unit}</span>
      </button>
      <span className="text-faint">vs</span>
      {ref && refValue !== null && (
        <button {...chip("ref")} data-proof-chip="ref" disabled={!theirs}
          onClick={() => theirs && player.playReference(ref.audio, theirs[0], theirs[1], `${PROOF} reference ${refName}`)}
          className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors", phase === "ref" ? "border-ink bg-highlight-soft" : "border-hairline hover:border-ink/30")}>
          <span className="size-2.5 rounded-full border-[1.5px]" style={{ borderColor: REF.ghost }} />
          Reference {refName} <span className="font-mono font-medium">{fmt(refValue, 2)} {m.unit}</span>
        </button>
      )}
      <button onClick={play}
        className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 font-medium text-primary-foreground transition-transform hover:scale-[1.03]">
        {active ? <Square className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}
        {active ? "Stop" : "Play the proof"}
      </button>
      <ProofConnector color={c} refIdx={refIdx} />
    </div>
  );
}

/** A line from the claim's value to where it was measured on the stage, redrawn every frame
 *  while shown (so it follows scrolling and the camera). Fixed overlay, never interactive. */
function ProofConnector({ color, refIdx }: { color: string; refIdx: number }) {
  const focus = useProofFocus((s) => s.focus);
  const phase = useProofPhase();
  const which = phase ?? focus;
  const path = useRef<SVGPathElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!which) return;
    let raf = 0;
    const tick = () => {
      const from = document.querySelector(`[data-proof-chip="${which}"]`);
      const to = document.querySelector(which === "take" ? "[data-evidence]" : `[data-proof-anchor="ref-${refIdx}"]`);
      const stage = document.querySelector('section[aria-label="Recording"]');
      const a = from?.getBoundingClientRect(), b = to?.getBoundingClientRect(), s = stage?.getBoundingClientRect();
      // only while both ends are on screen and the chip is not scrolled under the stage
      const ok = !!a && !!b && b.width > 0 && (!s || a.top > s.bottom + 4);
      setVisible(ok);
      if (ok && path.current && dot.current) {
        const x1 = a!.left + a!.width / 2, y1 = a!.top;
        const x2 = b!.left + Math.min(b!.width / 2, 40), y2 = b!.bottom;
        const dy = Math.max(30, (y1 - y2) * 0.5);
        path.current.setAttribute("d", `M${x1},${y1} C${x1},${y1 - dy} ${x2},${y2 + dy} ${x2},${y2}`);
        dot.current.setAttribute("cx", String(x2));
        dot.current.setAttribute("cy", String(y2));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      setVisible(false);
    };
  }, [which, refIdx]);

  if (!which || typeof document === "undefined") return null;
  const stroke = which === "take" ? color : "var(--ref-line)";
  return createPortal(
    <svg className="pointer-events-none fixed inset-0 z-40 h-full w-full" aria-hidden style={{ opacity: visible ? 1 : 0 }}>
      <motion.path key={which} ref={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round"
        initial={{ pathLength: prefersReducedMotion() ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, ease: "easeOut" }} />
      <circle ref={dot} r={4} fill="var(--stage)" stroke={stroke} strokeWidth={2} />
    </svg>,
    document.body,
  );
}
