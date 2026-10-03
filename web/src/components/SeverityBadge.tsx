import { SEVERITY_STYLE, capitalize } from "@/lib/categories";
import { cn } from "@/lib/utils";

/** Severity is typographic: badge weight and fill grow with level, never a traffic light. */
export function SeverityBadge({ level, label, className }: { level: number; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-[19px] items-center rounded-[5px] border px-1.5 text-[11px] font-medium tracking-wide", SEVERITY_STYLE[level].badge, className)}>
      {capitalize(label)}
    </span>
  );
}
