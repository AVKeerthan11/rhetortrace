import { CATEGORY } from "@/lib/categories";
import { timingRows } from "@/lib/evidence";
import { fmt } from "@/lib/format";
import { wash } from "@/lib/grammar";
import { referenceName } from "@/lib/takes";
import type { Flaw, Take } from "@/lib/types";

/** The finding's span (or, for a pause, the silence after it) in this recording and in each
 *  reference delivery. The words themselves are drawn on the stage above ("References" lane),
 *  on this recording's time axis; this is the number each row adds up to. */
export function WordTiming({ take, f }: { take: Take; f: Flaw }) {
  const rows = timingRows(take, f);
  const isPause = f.category === "pause";
  const max = Math.max(...rows.map((r) => r.spanDur ?? 0)) || 1;
  const color = CATEGORY[f.category].color;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3 text-[12.5px]">
          <span className={`w-[112px] shrink-0 truncate ${r.own ? "font-medium text-ink" : "text-muted-foreground"}`}>
            {r.own ? r.label : `Reference ${referenceName(take, r.label)}`}
          </span>
          <span className="relative h-2 flex-1 rounded-full bg-ink/[0.04]">
            {r.spanDur !== null && (
              <span className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${(r.spanDur / max) * 100}%`, background: r.own ? color : "var(--ref-line)", opacity: r.own ? 0.85 : 0.6 }} />
            )}
          </span>
          <span className="w-[52px] shrink-0 text-right font-mono text-[11.5px] tabular" style={{ color: r.own ? wash(color, 0.85, "var(--ink)") : undefined }}>
            {r.spanDur !== null ? `${fmt(r.spanDur, 2)} s` : "—"}
          </span>
        </div>
      ))}
      <p className="pt-1 text-[11.5px] text-faint">
        {isPause ? "The pause after the finding's last word, in each delivery." : "How long the finding's words took in each delivery."}{" "}
        The Threads lane on the stage joins each word to the same word in every delivery.
      </p>
    </div>
  );
}
