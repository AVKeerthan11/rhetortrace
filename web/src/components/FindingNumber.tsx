import { CATEGORY } from "@/lib/categories";
import type { Category } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The "①" token that ties a finding together across the strip, the list and the finding page. */
export function FindingNumber({ n, category, active, className }: { n: number; category: Category; active?: boolean; className?: string }) {
  const color = CATEGORY[category].color;
  return (
    <span
      className={cn("inline-grid size-6 shrink-0 place-items-center rounded-full font-mono text-[11.5px] font-medium tabular transition-colors", className)}
      style={
        active
          ? { background: color, color: "#fff" }
          : { background: `color-mix(in oklab, ${color} 14%, var(--surface))`, color: `color-mix(in oklab, ${color} 80%, var(--ink))`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)` }
      }
    >
      {n}
    </span>
  );
}
