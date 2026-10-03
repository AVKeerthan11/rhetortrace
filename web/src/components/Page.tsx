import { motion } from "motion/react";
import { rise } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Building blocks for the reading pages (evaluation, robustness, method): one serif headline,
// prose, hairline tables. Same column and type scale as the recording overview.

export function ReadingPage({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className={cn("mx-auto px-8 pt-12 pb-28", wide ? "max-w-4xl" : "max-w-3xl")}>{children}</div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header>
      <motion.div {...rise(0)} className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">{eyebrow}</motion.div>
      <motion.h1 {...rise(1)} className="mt-2 font-display text-[44px] leading-[1.04] tracking-[-0.015em]">{title}</motion.h1>
      {children && (
        <motion.div {...rise(2)} className="mt-4 max-w-2xl space-y-3 text-[15px] leading-relaxed text-muted-foreground">
          {children}
        </motion.div>
      )}
    </header>
  );
}

export function Section({ id, title, lead, aside, children, i = 3 }: {
  id?: string; title: React.ReactNode; lead?: React.ReactNode; aside?: React.ReactNode; children?: React.ReactNode; i?: number;
}) {
  return (
    <motion.section {...rise(i)} id={id} className="mt-14 scroll-mt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[28px] leading-tight">{title}</h2>
        {aside}
      </div>
      {lead && <div className="mt-2 max-w-2xl text-[14.5px] leading-relaxed text-muted-foreground">{lead}</div>}
      {children && <div className="mt-5">{children}</div>}
    </motion.section>
  );
}

/** Big number with a plain sentence under it. Typographic, not a chart. */
export function Stat({ value, label, sub }: { value: React.ReactNode; label: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="border-t border-ink/80 pt-3">
      <div className="font-display text-[44px] leading-none tabular">{value}</div>
      <div className="mt-2 text-[14px] leading-snug text-ink/85">{label}</div>
      {sub && <div className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Hairline table: header in small caps, numbers right-aligned and tabular. */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-xl border border-hairline bg-surface", className)}>
      <table className="w-full text-[13.5px] [&>tbody>tr:first-child>td]:border-t-0">{children}</table>
    </div>
  );
}

export function Th({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <th className={cn("border-b border-hairline px-3 py-2.5 first:pl-4 last:pr-4 text-[10.5px] font-medium tracking-[0.1em] whitespace-nowrap text-faint uppercase", right ? "text-right" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, right, mono, muted, className, colSpan }: {
  children?: React.ReactNode; right?: boolean; mono?: boolean; muted?: boolean; className?: string; colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={cn("border-t border-hairline px-3 py-2.5 align-baseline first:pl-4 last:pr-4",
      right && "text-right", mono && "font-mono text-[12.5px] whitespace-nowrap tabular", muted && "text-muted-foreground", className)}>
      {children}
    </td>
  );
}

export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("mt-3 text-[12.5px] leading-relaxed text-muted-foreground", className)}>{children}</p>;
}
