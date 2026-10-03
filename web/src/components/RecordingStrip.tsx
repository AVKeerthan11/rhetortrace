import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Pause, Play } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle } from "@/lib/findings";
import { fmtShort } from "@/lib/format";
import { ease } from "@/lib/motion";
import { usePlayerState, usePlayerTime, type Player } from "@/lib/player";
import type { Take } from "@/lib/types";
import { FindingNumber } from "@/components/FindingNumber";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const H = 64;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** The whole recording as one strip: waveform, where each finding sits, and a playhead.
 *  Numbered markers open the finding; clicking the waveform seeks. */
export function RecordingStrip({ take, ranking, player, onOpen, hovered, onHover }: {
  take: Take;
  ranking: number[];
  player: Player;
  onOpen: (rank: number) => void;
  hovered: number | null;
  onHover: (rank: number | null) => void;
}) {
  const [ref, W] = useWidth();
  const d = take.duration;
  const x = (t: number) => (t / d) * W;
  const { playing, label } = usePlayerState(player);
  const playingTake = playing && label === "This recording";

  const bars = useMemo(() => {
    if (!W) return [];
    const p = take.peaks, step = 3, out: { x: number; h: number }[] = [];
    let peak = 0;
    for (let i = 0; i < p.bins; i++) peak = Math.max(peak, Math.abs(p.min[i]), Math.abs(p.max[i]));
    for (let px = 0; px < W; px += step) {
      const a = Math.floor((px / W) * p.bins), b = Math.max(a + 1, Math.floor(((px + step) / W) * p.bins));
      let hi = 0;
      for (let i = a; i < Math.min(p.bins, b); i++) hi = Math.max(hi, Math.abs(p.min[i]), Math.abs(p.max[i]));
      out.push({ x: px, h: Math.max(1.5, Math.pow(hi / (peak || 1), 0.8) * (H / 2 - 4)) });
    }
    return out;
  }, [take, W]);

  // markers: lay out left to right, dropping to a second row when two would overlap
  const markers = useMemo(() => {
    const items = ranking.map((fi, r) => ({ r, f: take.flaws[fi], cx: x((take.flaws[fi].start + take.flaws[fi].end) / 2) })).sort((a, b) => a.cx - b.cx);
    const lastX = [-99, -99];
    return items.map((m) => {
      const row = m.cx - lastX[0] >= 28 ? 0 : m.cx - lastX[1] >= 28 ? 1 : 0;
      lastX[row] = m.cx;
      return { ...m, row };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, ranking, W]);
  const rows = Math.max(1, ...markers.map((m) => m.row + 1));

  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - r.left) / r.width) * d);
  };

  return (
    <div className="flex items-start gap-4">
      <button
        onClick={() => player.toggle()}
        aria-label={playingTake ? "Pause recording" : "Play the whole recording"}
        className="mt-[14px] grid size-11 shrink-0 place-items-center rounded-full bg-ink text-primary-foreground shadow-[0_2px_8px_rgba(27,26,23,0.18)] transition-transform hover:scale-[1.04] active:scale-95"
      >
        {playingTake ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
      </button>

      <div className="min-w-0 flex-1">
        <div ref={ref} className="relative cursor-pointer" style={{ height: H }} onPointerDown={seek}>
          {W > 0 && (
            <svg width={W} height={H} className="absolute inset-0 overflow-visible">
              {/* finding spans */}
              {ranking.map((fi, r) => {
                const f = take.flaws[fi];
                const a = x(f.start), b = Math.max(x(f.end), a + 3);
                return (
                  <motion.rect key={fi} x={a} y={0} width={b - a} height={H} rx={4}
                    fill={CATEGORY[f.category].color}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: hovered === r ? 0.3 : 0.13 }}
                    transition={{ duration: 0.2 }} />
                );
              })}
              <clipPath id="played"><PlayedClip player={player} W={W} d={d} /></clipPath>
              <g fill="rgba(27,26,23,0.24)">
                {bars.map((b) => <rect key={b.x} x={b.x} y={H / 2 - b.h} width={2} height={b.h * 2} rx={1} />)}
              </g>
              <g fill="rgba(27,26,23,0.85)" clipPath="url(#played)">
                {bars.map((b) => <rect key={b.x} x={b.x} y={H / 2 - b.h} width={2} height={b.h * 2} rx={1} />)}
              </g>
              <Playhead player={player} W={W} d={d} />
            </svg>
          )}
        </div>

        {/* numbered markers under their spans */}
        <div className="relative" style={{ height: rows * 30 + 4 }}>
          {W > 0 && markers.map((m, k) => (
            <motion.div key={m.r} className="absolute -translate-x-1/2" style={{ left: m.cx, top: 6 + m.row * 30 }}
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + k * 0.05, duration: 0.3, ease }}>
              <span className="absolute bottom-full left-1/2 w-px -translate-x-1/2 bg-ink/20" style={{ height: 6 + m.row * 30 }} />
              <Tooltip>
                <TooltipTrigger
                  onClick={() => onOpen(m.r)}
                  onPointerEnter={() => onHover(m.r)}
                  onPointerLeave={() => onHover(null)}
                  aria-label={`Finding ${m.r + 1}: ${plainTitle(m.f)}`}
                  className="block rounded-full transition-transform hover:scale-110"
                >
                  <FindingNumber n={m.r + 1} category={m.f.category} active={hovered === m.r} />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="flex-col items-start gap-0.5">
                  <span className="font-medium">{plainTitle(m.f)}</span>
                  <span className="text-muted-foreground">“{m.f.words.slice(0, 6).join(" ")}{m.f.words.length > 6 ? " …" : ""}”</span>
                </TooltipContent>
              </Tooltip>
            </motion.div>
          ))}
        </div>

        <div className="flex justify-between font-mono text-[11px] text-faint tabular">
          <span>0:00</span>
          <span>{fmtShort(d)}</span>
        </div>
      </div>
    </div>
  );
}

function PlayedClip({ player, W, d }: { player: Player; W: number; d: number }) {
  const t = usePlayerTime(player);
  return <rect x={0} y={0} width={(Math.min(t, d) / d) * W} height={H} />;
}

function Playhead({ player, W, d }: { player: Player; W: number; d: number }) {
  const t = usePlayerTime(player);
  if (t <= 0) return null;
  const px = (Math.min(t, d) / d) * W;
  return <rect x={px - 0.75} y={-3} width={1.5} height={H + 6} rx={0.75} fill="var(--ink)" />;
}
