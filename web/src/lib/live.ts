import { player } from "./player";

// Live level of what is audible, from a Web Audio analyser on the player's audio elements.
// Used only to draw (the live trace on the stage); never stored, never part of the analysis.
//
// Safety: routing an <audio> element through Web Audio silences it while the AudioContext is
// suspended, and browsers only let a context start inside a user gesture. So the context is
// created on the first pointer / key gesture, and the elements are routed only once it is
// running. If anything fails, playback is untouched and level() stays 0.

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let buf: Float32Array<ArrayBuffer> | null = null;
let routed = false;

function route() {
  if (routed || !ctx || ctx.state !== "running") return;
  try {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    buf = new Float32Array(analyser.fftSize);
    for (const el of [player.main, player.ref]) ctx.createMediaElementSource(el).connect(analyser);
    analyser.connect(ctx.destination);
    routed = true;
  } catch {
    analyser = null;
  }
}

function onGesture() {
  const Ctor = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  if (!Ctor) return;
  try {
    ctx ??= new Ctor();
    if (ctx.state === "running") route();
    else void ctx.resume().then(route, () => {});
  } catch {
    /* no live level */
  }
}

let installed = false;
/** Start listening for the first user gesture (idempotent). */
export function installLiveLevel() {
  if (installed || typeof window === "undefined" || typeof window.AudioContext === "undefined") return;
  installed = true;
  for (const type of ["pointerdown", "keydown"] as const) window.addEventListener(type, onGesture, { capture: true });
}

/** RMS of the audible signal right now, 0..1 (0 when unavailable or silent). */
export function level(): number {
  if (!analyser || !buf) return 0;
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export const liveAvailable = () => routed;
