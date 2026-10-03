export function fmt(x: number | null | undefined, nd = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return x.toFixed(nd);
}

export function fmtSigned(x: number | null | undefined, nd = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(nd)}`;
}

export function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** "0:45", "1:05" — for durations and positions shown to people, not to analysts. */
export function fmtShort(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.floor(t - m * 60)).padStart(2, "0")}`;
}

export function fmtSeconds(t: number | null | undefined, nd = 2): string {
  return t === null || t === undefined ? "—" : `${t.toFixed(nd)}s`;
}

export function humanize(s: string): string {
  return s.replaceAll("_", " ");
}

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
