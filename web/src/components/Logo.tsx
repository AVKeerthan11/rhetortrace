import { cn } from "@/lib/utils";

/** Mark: five ink bars of a waveform, one struck through with the highlighter. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={cn("size-7 shrink-0", className)} aria-hidden>
      <rect width="28" height="28" rx="8" fill="var(--ink)" />
      <rect x="5" y="15.2" width="18" height="5.2" rx="1.6" fill="var(--highlight)" />
      {[
        [7, 11, 6],
        [10.5, 7.5, 13],
        [14, 9.5, 9],
        [17.5, 6, 16],
        [21, 10.5, 7],
      ].map(([x, y, h]) => (
        <rect key={x} x={x - 0.9} y={y} width="1.8" height={h} rx="0.9" fill="#fbfaf7" />
      ))}
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display text-[21px] leading-none tracking-[-0.01em] text-ink", className)}>
      Rhetor<span className="italic">Trace</span>
    </span>
  );
}
