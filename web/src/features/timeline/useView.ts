import { useCallback, useEffect, useRef, useState } from "react";
import { animate, type AnimationPlaybackControls } from "motion";

export type View = [number, number];
const MIN_SPAN = 0.8;

/** Visible time window of the timeline, with smooth (motion) transitions.
 *  `initial` opens on a window (e.g. one finding) instead of the whole recording. */
export function useView(duration: number, initial?: View) {
  const home = (): View => {
    if (!initial) return [0, duration || 1];
    const span = Math.min(duration, Math.max(MIN_SPAN, initial[1] - initial[0]));
    const start = Math.max(0, Math.min(duration - span, initial[0]));
    return [start, start + span];
  };
  const [view, setViewState] = useState<View>(home);
  const current = useRef<View>(view);
  const anim = useRef<AnimationPlaybackControls | null>(null);

  const normalize = useCallback(
    ([a, b]: View): View => {
      const span = Math.min(duration, Math.max(MIN_SPAN, b - a));
      const start = Math.max(0, Math.min(duration - span, a));
      return [start, start + span];
    },
    [duration],
  );

  const setView = useCallback(
    (target: View, smooth = true) => {
      const to = normalize(target);
      anim.current?.stop();
      if (!smooth) {
        current.current = to;
        setViewState(to);
        return;
      }
      const from = current.current;
      anim.current = animate(0, 1, {
        duration: 0.42,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (k) => {
          const v: View = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
          current.current = v;
          setViewState(v);
        },
      });
    },
    [normalize],
  );

  useEffect(() => {
    current.current = home();
    setViewState(home());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, initial?.[0], initial?.[1]]);

  const zoom = useCallback(
    (factor: number, center?: number) => {
      const [a, b] = current.current;
      const c = center ?? (a + b) / 2;
      setView([c - (c - a) * factor, c + (b - c) * factor]);
    },
    [setView],
  );

  return { view, setView, zoom, fit: () => setView([0, duration]), current };
}
