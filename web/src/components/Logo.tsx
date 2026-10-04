import { cn } from "@/lib/utils";

/** Mark: five bars of a waveform on an ink tile, one of them lit in signal lime: a recording
 *  with the moment that went off found in it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={cn("size-7 shrink-0", className)} aria-hidden>
      <rect width="28" height="28" rx="8" fill="#12161c" />
      {[
        [7, 11.5, 5],
        [10.5, 8.5, 11],
        [14, 10.5, 7],
        [17.5, 5.5, 17],
        [21, 10, 8],
      ].map(([x, y, h]) => (
        <rect key={x} x={x - 1} y={y} width="2" height={h} rx="1" fill={x === 17.5 ? "#c6f36b" : "#e6eaf0"} />
      ))}
      <rect x="15.2" y="23.6" width="4.6" height="1.6" rx="0.8" fill="#c6f36b" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display text-[20px] leading-none font-[460] tracking-[-0.025em] text-ink", className)}>
      Rhetor<span className="font-[380] italic">Trace</span>
    </span>
  );
}
