import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { animate, motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { ArrowRight } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle, rankFindings } from "@/lib/findings";
import { fmt, fmtShort } from "@/lib/format";
import { cssVar, inkAlpha } from "@/lib/grammar";
import { ease, prefersReducedMotion } from "@/lib/motion";
import { scoreSteps } from "@/lib/score";
import { useUi } from "@/lib/store";
import { overviewPath, speechName } from "@/lib/takes";
import type { Take, TakeSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FindingNumber } from "@/components/FindingNumber";

// The home page's opening scene: RhetorTrace analysing a real recording, in four seconds.
// One timeline (`scan`, 0..1 across the recording) drives everything, so every moving part
// says the same thing:
//   · the horizon: the recording's waveform rises across the page; a lime scan line sweeps it,
//     the bars it has passed brighten, and each finding's span takes its colour as it is reached,
//     with a numbered chip above it
//   · the instrument card: each finding is listed as the scan reaches it, and the delivery score
//     falls from 100 by exactly what each finding costs (lib/score: the pipeline's formula)
// Afterwards a faint ambient sweep passes every few seconds. Reduced motion: the end state.

const RISE_S = 1.0;
const SCAN_S = 3.4;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** The scene's clock: rise (0..1, the waveform growing in) and scan (0..1, across the recording). */
function useScene(ready: boolean) {
  const rise = useMotionValue(0);
  const scan = useMotionValue(0);
  const ambient = useMotionValue(-1);
  useEffect(() => {
    if (!ready) return;
    if (prefersReducedMotion()) {
      rise.set(1);
      scan.set(1);
      return;
    }
    const a = animate(rise, 1, { duration: RISE_S, ease });
    const b = animate(scan, 1, { delay: RISE_S * 0.6, duration: SCAN_S, ease: [0.45, 0.05, 0.4, 1] });
    // after the analysis: a faint light passes over the recording every few seconds
    let timer = 0;
    let c: ReturnType<typeof animate> | null = null;
    const loop = () => {
      ambient.set(0);
      c = animate(ambient, 1, { duration: 2.6, ease: "linear", onComplete: () => { ambient.set(-1); timer = window.setTimeout(loop, 6000); } });
    };
    timer = window.setTimeout(loop, (RISE_S * 0.6 + SCAN_S + 3) * 1000);
    return () => {
      a.stop();
      b.stop();
      c?.stop();
      clearTimeout(timer);
    };
  }, [ready, rise, scan, ambient]);
  return { rise, scan, ambient };
}

export function HeroScene({ demo, take, opening, children }: { demo: TakeSummary | null; take: Take | null; opening: string | null; children: React.ReactNode }) {
  const { rise, scan, ambient } = useScene(!!take);
  // how many findings (in time order) the scan has reached: drives the chips and the card's list
  const order = useMemo(() => (take ? take.flaws.map((_, i) => i).sort((a, b) => take.flaws[a].start - take.flaws[b].start) : []), [take]);
  const [reached, setReached] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const update = (k: number) => {
      if (!take) return;
      const t = k * take.duration;
      setReached(order.filter((i) => take.flaws[i].start <= t).length);
      setDone(k >= 1);
    };
    update(scan.get());
    return scan.on("change", update);
  }, [scan, take, order]);

  return (
    <>
      <div className="grid-page relative z-10 items-center gap-y-12 pt-10 lg:pt-16">
        <div className="col-span-full lg:col-span-7">{children}</div>
        <div className="col-span-full lg:col-span-5">
          {demo && opening ? (
            <InstrumentCard demo={demo} take={take} opening={opening} scan={scan} reached={reached} order={order} done={done} />
          ) : (
            <div className="studio-panel h-[440px] animate-pulse rounded-2xl" />
          )}
        </div>
      </div>
      <Horizon take={take} rise={rise} scan={scan} ambient={ambient} reached={reached} order={order} />
    </>
  );
}

// ------------------------------------------------------------------------- horizon

function Horizon({ take, rise, scan, ambient, reached, order }: {
  take: Take | null; rise: MotionValue<number>; scan: MotionValue<number>;
  ambient: MotionValue<number>; reached: number; order: number[];
}) {
  const [box, W] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useUi((s) => s.theme);
  const H = 190;
  const ranks = useMemo(() => {
    if (!take) return [];
    const r: number[] = [];
    rankFindings(take).forEach((fi, k) => (r[fi] = k + 1));
    return r;
  }, [take]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !take || !W) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = take.peaks, n = p.bins, d = take.duration, mid = H / 2;
    const bar = 2, gap = 2.5;
    const bars: { x: number; f: number; amp: number; color: string | null }[] = [];
    const colorAt = (t: number) => {
      const f = take.flaws.find((fl) => t >= fl.start && t <= fl.end);
      return f ? cssVar(`--cat-${f.category}`, c) : null;
    };
    for (let x = 0; x < W; x += bar + gap) {
      const f = x / W, a = Math.floor(f * n), b = Math.max(a + 1, Math.floor(((x + bar + gap) / W) * n));
      let hi = 0;
      for (let i = a; i < Math.min(n, b); i++) hi = Math.max(hi, Math.abs(p.min[i]), Math.abs(p.max[i]));
      bars.push({ x, f, amp: Math.max(1.5, Math.min(mid - 4, hi * H * 1.35)), color: colorAt(f * d) });
    }
    const idle = inkAlpha(0.13, c), lit = inkAlpha(0.42, c), now = cssVar("--now", c);
    const draw = () => {
      const r = rise.get(), s = scan.get(), am = ambient.get();
      g.clearRect(0, 0, W, H);
      for (const b of bars) {
        const grow = Math.min(1, Math.max(0, (r * 1.5 - b.f * 0.5)));
        if (grow <= 0) continue;
        const h = b.amp * (1 - Math.pow(1 - grow, 3));
        const passed = b.f <= s;
        g.globalAlpha = 1;
        g.fillStyle = passed ? (b.color ?? lit) : idle;
        if (passed && b.color) g.globalAlpha = 0.9;
        // the ambient light: a soft brightening around its position
        if (am >= 0) {
          const dist = Math.abs(b.f - am);
          if (dist < 0.05) g.globalAlpha = Math.min(1, g.globalAlpha + (1 - dist / 0.05) * 0.5);
        }
        g.beginPath();
        g.roundRect(b.x, mid - h, bar, h * 2, 1);
        g.fill();
      }
      g.globalAlpha = 1;
      // the scan line
      if (s > 0 && s < 1) {
        const x = s * W;
        const grad = g.createLinearGradient(x - 90, 0, x, 0);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, now);
        g.globalAlpha = 0.18;
        g.fillStyle = grad;
        g.fillRect(x - 90, 6, 90, H - 12);
        g.globalAlpha = 1;
        g.fillStyle = now;
        g.shadowColor = now;
        g.shadowBlur = 14;
        g.fillRect(x - 1, 4, 2, H - 8);
        g.shadowBlur = 0;
      }
    };
    draw();
    const subs = [rise.on("change", draw), scan.on("change", draw), ambient.on("change", draw)];
    return () => subs.forEach((u) => u());
  }, [take, W, rise, scan, ambient, theme]);

  return (
    <div ref={box} className="relative z-0 mt-10 lg:mt-14" style={{ height: H + 46, maskImage: "linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent)" }}>
      <canvas ref={canvas} aria-hidden className="absolute inset-x-0 bottom-0 block" style={{ width: W, height: H }} />
      {/* the findings, as the scan reaches them */}
      {take && W > 0 && order.map((fi, k) => {
        const f = take.flaws[fi];
        const left = (f.start / take.duration) * W;
        const row = k % 2;
        return (
          <motion.div key={fi} className="absolute flex items-center gap-1.5 whitespace-nowrap" style={{ left, top: row === 0 ? 0 : 22 }}
            initial={false} animate={k < reached ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 8, scale: 0.9 }} transition={{ duration: 0.35, ease }}>
            <span className="absolute top-full left-[9px] h-[30px] w-px" style={{ background: `linear-gradient(${CATEGORY[f.category].color}, transparent)`, height: row === 0 ? 52 : 30 }} />
            <FindingNumber n={ranks[fi]} category={f.category} active className="size-[18px] text-[10px]" />
            <span className="hidden text-[12px] font-medium text-ink/85 md:inline">{plainTitle(f)}</span>
          </motion.div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ instrument card

function InstrumentCard({ demo, take, opening, scan, reached, order, done }: {
  demo: TakeSummary; take: Take | null; opening: string; scan: MotionValue<number>; reached: number; order: number[]; done: boolean;
}) {
  const score = useRef<HTMLSpanElement>(null);
  const steps = useMemo(() => (take ? scoreSteps(take) : []), [take]);
  useEffect(() => {
    const set = (k: number) => {
      if (!take || !score.current) return;
      const t = k * take.duration;
      // each finding's cost is taken across its span, as the scan crosses it
      const s = 100 - steps.reduce((acc, st) => acc + st.lost * Math.min(1, Math.max(0, (t - st.start) / Math.max(0.05, st.end - st.start))), 0);
      score.current.textContent = fmt(k >= 1 ? demo.score : s, 1);
    };
    set(scan.get());
    return scan.on("change", set);
  }, [scan, take, steps, demo.score]);

  // a gentle tilt toward the pointer
  const mx = useMotionValue(0), my = useMotionValue(0);
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [5, -5]), { stiffness: 140, damping: 18 });
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-6, 6]), { stiffness: 140, damping: 18 });
  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    if (prefersReducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
    my.set((e.clientY - r.top) / r.height - 0.5);
  };

  return (
    <div style={{ perspective: 1200 }}>
      <motion.div style={{ rotateX: rx, rotateY: ry, transformStyle: "preserve-3d" }}
        initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.25, duration: 0.7, ease }}
        onPointerMove={onMove} onPointerLeave={() => { mx.set(0); my.set(0); }}>
        <Link to={overviewPath(demo.id)} aria-label={`Open the controlled example: ${opening}`}
          className="studio-panel group relative block overflow-hidden rounded-2xl p-5 sm:p-6">
          {/* a soft lime light, high on the card */}
          <span aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full opacity-60 blur-3xl"
            style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--signal) 22%, transparent), transparent 70%)" }} />
          <div className="relative flex items-center justify-between gap-3">
            <span className="label-caps text-faint">Controlled example · {speechName(demo.speech_id)} · {fmtShort(demo.duration)}</span>
            <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className={cn("size-1.5 rounded-full bg-signal", !done && "animate-pulse")} /> {done ? "analysed" : "analysing…"}
            </span>
          </div>
          <p className="relative mt-3 font-display text-[clamp(19px,1.5vw,23px)] leading-snug text-ink/90">“{opening}”</p>

          <div className="relative mt-5 flex items-end justify-between gap-4">
            <div>
              <div className="font-mono text-[44px] leading-none font-medium tracking-tight tabular">
                <span ref={score}>100.0</span><span className="text-[15px] font-normal text-faint"> / 100</span>
              </div>
              <div className="mt-1.5 text-[12.5px] text-muted-foreground">delivery score</div>
            </div>
            <div className="text-right text-[12.5px] text-muted-foreground">
              <div className="font-mono text-[22px] leading-none text-ink tabular">{reached}</div>
              <div className="mt-1.5">finding{reached === 1 ? "" : "s"}</div>
            </div>
          </div>

          {/* the findings, in the order the scan reaches them: space reserved, so nothing jumps */}
          <ol className="relative mt-5 space-y-1 border-t border-hairline pt-3">
            {take && order.map((fi, k) => {
              const f = take.flaws[fi];
              const on = k < reached;
              return (
                <motion.li key={fi} className="flex items-center gap-2.5 py-[3px] text-[13px]" initial={false}
                  animate={on ? { opacity: 1, x: 0 } : { opacity: 0.18, x: -6 }} transition={{ duration: 0.3, ease }}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: CATEGORY[f.category].color }} />
                  <span className="min-w-0 flex-1 truncate text-ink/90">{plainTitle(f)}</span>
                  <span className="text-[11.5px] text-muted-foreground">{f.severity.label}</span>
                  <span className="w-[42px] text-right font-mono text-[11.5px] text-faint tabular">{fmtShort(f.start)}</span>
                </motion.li>
              );
            })}
          </ol>

          <div className="relative mt-5 flex items-center justify-between gap-3 border-t border-hairline pt-4">
            <span className="text-[12.5px] text-muted-foreground">
              {demo.ground_truth ? <><span className="text-ink">{demo.ground_truth[0]} of {demo.ground_truth[1]}</span> injected flaws found</> : "compared with 2 good deliveries"}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground">
              Open the analysis <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </Link>
      </motion.div>
    </div>
  );
}
