import { useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "./motion";

// Shared-element flights between screens of a recording. The same finding appears as a row on
// the overview, as the header of its page and as the explorer's summary sheet; when the user
// moves between them, its number badge and its title fly from where they were to where they
// are now instead of disappearing and reappearing.
//
//   captureFlights(root, rank, { lift })   before leaving: remember every [data-flight] under root
//   useCaptureOnUnmount(ref, rank)         the same, when a screen goes away (any way of leaving)
//   useFlightTarget("badge-3")             on the element that receives the flight
//
// The flight is a fixed-position clone. With `lift` it appears at once where the user clicked
// and waits there while the screens swap. When the target mounts, the clone follows the target's
// live position every frame (the target may itself be moving: page transitions, the camera) and
// cross-fades into it. Unclaimed captures expire after TTL, so a stale one never plays.

interface Pending {
  node: HTMLElement;
  rect: DOMRect;
  font: number;
  at: number;
  expire: number;
}

const pending = new Map<string, Pending>();
const TTL = 1500;
const DURATION = 560;

const fontSize = (el: Element) => parseFloat(getComputedStyle(el).fontSize) || 16;

function place(node: HTMLElement, rect: DOMRect) {
  Object.assign(node.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    margin: "0", zIndex: "60", pointerEvents: "none", transformOrigin: "0 0", whiteSpace: "nowrap", willChange: "transform, opacity",
  });
  node.removeAttribute("data-flight");
  node.setAttribute("aria-hidden", "true");
}

function drop(key: string, p: Pending) {
  clearTimeout(p.expire);
  p.node.remove();
  if (pending.get(key) === p) pending.delete(key);
}

/** Remember the [data-flight] elements under root as the starting points of flights for this
 *  finding. lift: show the clones at once, waiting in place for their target. */
export function captureFlights(root: Element | null | undefined, rank: number, { lift = true } = {}) {
  if (!root || typeof window === "undefined" || prefersReducedMotion()) return;
  root.querySelectorAll<HTMLElement>("[data-flight]").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) return;
    const key = `${el.dataset.flight}-${rank}`;
    const old = pending.get(key);
    if (old) drop(key, old);
    const node = el.cloneNode(true) as HTMLElement;
    place(node, rect);
    if (lift) document.body.appendChild(node);
    const p: Pending = { node, rect, font: fontSize(el), at: performance.now(), expire: 0 };
    p.expire = window.setTimeout(() => drop(key, p), TTL);
    pending.set(key, p);
  });
}

/** Capture the [data-flight] elements under ref when the component unmounts, however the user
 *  leaves. An unmount within moments of mounting is React's strict-mode re-run, not a real exit,
 *  and must not replace the flight that brought the element here. */
export function useCaptureOnUnmount(ref: React.RefObject<HTMLElement | null>, rank: number) {
  useLayoutEffect(() => {
    const el = ref.current, mounted = performance.now();
    return () => {
      if (performance.now() - mounted > 100) captureFlights(el, rank, { lift: false });
    };
  }, [ref, rank]);
}

/** Ref for an element that receives the flight `key` (e.g. "badge-3") when it mounts. */
export function useFlightTarget<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const p = pending.get(key);
    const el = ref.current;
    if (!p || !el || performance.now() - p.at > TTL) return;
    clearTimeout(p.expire);
    // the flight claims it when it lands; a strict-mode re-run in between still finds it, and a
    // target that goes away mid-flight lets the clone expire shortly
    const stop = fly(p, el, () => drop(key, p));
    return () => {
      stop();
      if (pending.get(key) === p) p.expire = window.setTimeout(() => drop(key, p), 200);
    };
  }, [key]);
  return ref;
}

function fly(p: Pending, target: HTMLElement, landed: () => void) {
  const clone = p.node;
  if (!clone.isConnected) document.body.appendChild(clone);
  target.style.opacity = "0";
  const scaleTo = fontSize(target) / p.font;
  const t0 = performance.now();
  let raf = 0;
  const ease = (k: number) => 1 - Math.pow(1 - k, 4);
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / DURATION), e = ease(k);
    const r = target.getBoundingClientRect();
    const dx = (r.left - p.rect.left) * e, dy = (r.top - p.rect.top) * e, s = 1 + (scaleTo - 1) * e;
    clone.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    // cross-fade over the last third (the two may differ in typeface)
    const fade = Math.max(0, (k - 0.66) / 0.34);
    clone.style.opacity = String(1 - fade);
    target.style.opacity = String(fade);
    if (k < 1) raf = requestAnimationFrame(step);
    else {
      target.style.opacity = "";
      landed();
    }
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    target.style.opacity = "";
    clone.style.transform = "";
    clone.style.opacity = "";
  };
}
