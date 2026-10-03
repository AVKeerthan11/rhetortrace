import { motion } from "motion/react";
import { ease } from "@/lib/motion";
import type { Measurement } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** One measurement on a number line: the reference deliveries (dots), their spread (band),
 *  and this recording (filled marker). */
export function EvidencePlot({ m, color, showNote = true }: { m: Measurement; color: string; showNote?: boolean }) {
  const pts = (m.reference_points ?? []).filter((p) => p.value !== null) as { take: string; value: number }[];
  const vals = [m.observed!, ...(m.reference !== null ? [m.reference] : []), ...pts.map((p) => p.value), ...(m.reference_band ?? [])];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.18 || Math.abs(hi) * 0.1 || 1;
  lo -= pad;
  hi += pad;
  const X = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div>
      <div className="relative h-[52px]">
        <div className="absolute inset-x-0 top-[28px] h-px bg-ink/10" />
        {m.reference_band && (
          <div className="absolute top-[21px] h-[15px] rounded-[3px] bg-ink/[0.08]"
            style={{ left: X(m.reference_band[0]), width: `calc(${X(m.reference_band[1])} - ${X(m.reference_band[0])})` }} />
        )}
        {m.reference !== null && <div className="absolute top-[17px] h-[23px] w-px bg-ink/45" style={{ left: X(m.reference) }} />}
        {pts.map((p) => (
          <Tooltip key={p.take}>
            <TooltipTrigger
              render={<span />}
              className="absolute top-[23px] size-[11px] -translate-x-1/2 rounded-full border-[1.5px] border-ink/60 bg-surface"
              style={{ left: X(p.value) }}
            />
            <TooltipContent>{p.take}: {p.value} {m.unit}</TooltipContent>
          </Tooltip>
        ))}
        {/* this recording: slides out from the reference value to where it was measured */}
        <motion.span className="absolute top-[4px] flex -translate-x-1/2 flex-col items-center leading-4"
          initial={{ left: X(m.reference ?? m.observed!) }} animate={{ left: X(m.observed!) }} transition={{ delay: 0.25, duration: 0.8, ease }}>
          <span className="font-mono text-[11px] font-medium whitespace-nowrap" style={{ color }}>
            {m.bound === "upper" ? "≤" : ""}{m.observed}
          </span>
          <span className="mt-[1px] size-[15px] rounded-full shadow-[0_0_0_3px_var(--surface)]" style={{ background: color }} />
        </motion.span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: color }} />this recording</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border border-ink/60" />each reference delivery</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[2px] bg-ink/[0.12]" />usual range</span>
        <span className="ml-auto font-mono">{m.unit}</span>
      </div>
      {showNote && m.note && <p className="mt-2 text-[11px] text-faint">{m.note}</p>}
    </div>
  );
}
