import { CATEGORY } from "@/lib/categories";
import type { TakeSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A take as a thin bar with one tick per finding at its position; taller = more severe. */
export function TakeMarks({ take, className }: { take: Pick<TakeSummary, "duration" | "marks">; className?: string }) {
  return (
    <div className={cn("relative h-2.5 w-full overflow-hidden rounded-[3px] bg-ink/[0.06]", className)}>
      {take.marks.map(([start, end, category, level], i) => (
        <span
          key={i}
          className="absolute bottom-0 rounded-[1px]"
          style={{
            left: `${(start / take.duration) * 100}%`,
            width: `max(2px, ${((end - start) / take.duration) * 100}%)`,
            height: `${40 + level * 15}%`,
            background: CATEGORY[category].color,
          }}
        />
      ))}
    </div>
  );
}
