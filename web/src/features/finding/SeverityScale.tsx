import { motion } from "motion/react";
import { CATEGORY } from "@/lib/categories";
import { fmt } from "@/lib/format";
import { REF, wash } from "@/lib/grammar";
import { ease } from "@/lib/motion";
import { severityScale } from "@/lib/score";
import type { Flaw, Take } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Where this finding sits on the severity scale, in the units the pipeline uses (robust z, how
 *  far outside the reference deliveries' variation). The levels are bands of increasing
 *  opacity; the stem is the effective z that sets the severity (evidence × support), with the
 *  median and peak word as small markers. Mirrors flaws.py severity() exactly. */
export function SeverityScale({ take, f }: { take: Take; f: Flaw }) {
  const sc = severityScale(take, f);
  const s = f.severity;
  const eff = Math.abs(s.effective_z), ev = Math.abs(s.evidence_z), med = Math.abs(s.median_z), peak = Math.abs(s.peak_z);
  const top = Math.max(sc.zMax, peak, eff) + 0.6;
  const X = (z: number) => `${(Math.max(0, Math.min(top, z)) / top) * 100}%`;
  const c = CATEGORY[f.category].color;
  const bands = [{ level: 0, z: sc.zMin, label: take.severity_settings.labels[0] ?? "negligible" }, ...sc.levels];
  const marks: { z: number; label: string; hollow?: boolean }[] = [
    { z: med, label: `median word z ${fmt(med, 1)}`, hollow: true },
    { z: peak, label: `strongest word z ${fmt(peak, 1)}`, hollow: true },
    ...(Math.abs(ev - eff) > 0.05 ? [{ z: ev, label: `evidence z ${fmt(ev, 1)}, before support (${fmt(s.support, 2)})` }] : []),
  ];
  return (
    <div className="text-[12px]">
      <div className="relative mt-5 h-[46px]">
        {/* level bands: severity as opacity, never a traffic light */}
        {bands.map((b, k) => {
          const next = bands[k + 1]?.z ?? top;
          return (
            <div key={b.level} className="absolute top-[10px] h-[18px]" style={{ left: X(b.z), width: `calc(${X(next)} - ${X(b.z)})`, background: wash(c, 0.05 + b.level * 0.08) }}>
              <span className={`absolute top-[21px] left-0.5 text-[10px] whitespace-nowrap ${b.level === s.level ? "font-semibold text-ink" : "text-faint"}`}>
                {(next - b.z) / top > 0.07 ? b.label : ""}
              </span>
            </div>
          );
        })}
        <div className="absolute inset-x-0 top-[28px] h-px bg-ink/15" />
        {/* the detector's threshold */}
        <div className="absolute top-[6px] h-[26px] w-px bg-ink/50" style={{ left: X(sc.zOpen) }} />
        {marks.map((m) => (
          <Tooltip key={m.label}>
            <TooltipTrigger render={<span />}
              className={`absolute top-[15px] size-[9px] -translate-x-1/2 rounded-full border-[1.5px] ${m.hollow ? "bg-surface" : ""}`}
              style={{ left: X(m.z), borderColor: REF.ghost, background: m.hollow ? undefined : REF.line }} />
            <TooltipContent>{m.label}</TooltipContent>
          </Tooltip>
        ))}
        {/* the stem: effective z, growing from zero */}
        <motion.div className="absolute top-[2px] h-[34px] w-[3px] -translate-x-1/2 rounded-full" style={{ background: c }}
          initial={{ left: "0%" }} animate={{ left: X(eff) }} transition={{ delay: 0.2, duration: 0.8, ease }} />
        <motion.span className="absolute -top-[14px] -translate-x-1/2 rounded px-1 font-mono text-[10.5px] font-medium whitespace-nowrap text-[var(--on-category)]"
          style={{ background: c }} initial={{ left: "0%", opacity: 0 }} animate={{ left: X(eff), opacity: 1 }} transition={{ delay: 0.2, duration: 0.8, ease }}>
          z {fmt(eff, 1)}
        </motion.span>
      </div>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-faint">
        severity = (z − {fmt(sc.zMin, 0)}) / ({fmt(sc.zMax, 0)} − {fmt(sc.zMin, 0)}) = {fmt(s.score, 2)} → {s.label}
      </p>
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        z: how many spreads of the reference deliveries' own variation this is away from them. The thin line is where a moment
        gets flagged (z {fmt(sc.zOpen, 0)}); hollow dots are the median and the strongest word.
      </p>
    </div>
  );
}
