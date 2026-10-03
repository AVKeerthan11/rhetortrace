import { useEffect, useSyncExternalStore } from "react";
import { audioUrl } from "@/lib/data";

type Listener = () => void;
export type Range = [number, number];

/** One clip in a play queue: a range of this take, or of a reference take. */
export type Clip =
  | { kind: "take"; range: Range; label: string }
  | { kind: "ref"; src: string; range: Range; label: string };

/** App-wide audio: one take channel plus an A/B reference channel. It lives for the whole
 *  session so playback survives tab and route changes. Time is an external store so only
 *  the components that show it (playhead, clock, waveform progress) re-render per frame. */
export class Player {
  readonly main = new Audio();
  readonly ref = new Audio();
  private listeners = new Set<Listener>();
  private raf = 0;
  private stopAt: { el: HTMLAudioElement; t: number } | null = null;
  src: string | null = null;
  time = 0;
  playing = false;
  refPlaying = false;
  refLabel: string | null = null;
  rate = 1;
  loop: Range | null = null;
  /** What is audible right now, for the "now playing" pill. */
  label: string | null = null;
  /** Clips still to play after the current one (A/B comparisons). */
  private queue: Clip[] = [];
  private gapTimer = 0;
  /** A reference clip was requested but has not started yet (it may still be loading). */
  private starting = false;

  constructor() {
    this.main.preload = "auto";
    this.ref.preload = "auto";
    for (const el of [this.main, this.ref]) {
      el.addEventListener("play", () => this.sync());
      el.addEventListener("pause", () => this.sync());
      el.addEventListener("ended", () => this.sync());
    }
    this.main.addEventListener("seeked", () => this.sync());
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  /** Point the take channel at a take's audio. No-op when it is already loaded. */
  load(src: string) {
    if (this.src === src) return;
    this.stop();
    this.src = src;
    this.loop = null;
    this.main.src = audioUrl(src);
    this.main.playbackRate = this.rate;
    this.time = 0;
    this.emit();
  }

  private sync() {
    this.time = this.main.currentTime;
    this.playing = !this.main.paused;
    this.refPlaying = !this.ref.paused;
    if (!this.refPlaying) this.refLabel = null;
    if (this.refPlaying) this.starting = false;
    if (!this.playing && !this.refPlaying && !this.queue.length && !this.gapTimer && !this.starting) this.label = null;
    cancelAnimationFrame(this.raf);
    if (this.playing || this.refPlaying) this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  private tick = () => {
    if (this.stopAt && this.stopAt.el.currentTime >= this.stopAt.t) {
      this.stopAt = null;
      if (this.queue.length) {
        // keep the label alive across the short gap between clips
        this.gapTimer = window.setTimeout(() => {
          this.gapTimer = 0;
          this.playClip(this.queue.shift()!);
        }, 350);
      }
      this.main.pause();
      this.ref.pause();
    }
    if (this.loop && !this.main.paused && this.main.currentTime >= this.loop[1]) this.main.currentTime = this.loop[0];
    this.time = this.main.currentTime;
    this.emit();
    if (!this.main.paused || !this.ref.paused) this.raf = requestAnimationFrame(this.tick);
  };

  toggle() {
    this.clearQueue();
    this.ref.pause();
    this.stopAt = null;
    this.label = "This recording";
    if (this.main.paused) {
      if (this.loop && (this.main.currentTime < this.loop[0] || this.main.currentTime >= this.loop[1])) this.main.currentTime = this.loop[0];
      void this.main.play();
    } else this.main.pause();
  }

  seek(t: number) {
    this.main.currentTime = Math.max(0, t);
    this.time = this.main.currentTime;
    this.emit();
  }

  playSegment(a: number, b: number, label = "This recording") {
    this.clearQueue();
    this.label = label;
    this.ref.pause();
    this.main.currentTime = Math.max(0, a);
    this.stopAt = { el: this.main, t: b };
    void this.main.play();
  }

  playReference(src: string, a: number, b: number, label: string) {
    this.clearQueue();
    this.startReference(src, a, b, label);
  }

  /** Play clips one after another (e.g. this take, then a reference delivery). */
  playSequence(clips: Clip[]) {
    if (!clips.length) return;
    this.clearQueue();
    this.queue = clips.slice(1);
    this.playClip(clips[0]);
  }

  private playClip(c: Clip) {
    if (c.kind === "take") {
      this.label = c.label;
      this.ref.pause();
      this.main.currentTime = Math.max(0, c.range[0]);
      this.stopAt = { el: this.main, t: c.range[1] };
      void this.main.play();
    } else this.startReference(c.src, c.range[0], c.range[1], c.label);
  }

  private clearQueue() {
    this.starting = false;
    this.queue = [];
    clearTimeout(this.gapTimer);
    this.gapTimer = 0;
  }

  private startReference(src: string, a: number, b: number, label: string) {
    this.label = label;
    this.starting = true;
    this.main.pause();
    const start = () => {
      this.ref.currentTime = Math.max(0, a);
      this.stopAt = { el: this.ref, t: b };
      this.refLabel = label;
      void this.ref.play();
    };
    const url = audioUrl(src);
    if (this.ref.src.endsWith(url)) start();
    else {
      this.ref.src = url;
      this.ref.addEventListener("loadedmetadata", start, { once: true });
    }
  }

  setRate(r: number) {
    this.rate = Math.round(Math.min(2, Math.max(0.5, r)) * 100) / 100;
    this.main.playbackRate = this.rate;
    this.ref.playbackRate = this.rate;
    this.emit();
  }

  setLoop(range: Range | null) {
    this.loop = range;
    this.emit();
  }

  stop() {
    this.clearQueue();
    this.label = null;
    this.main.pause();
    this.ref.pause();
    this.stopAt = null;
  }
}

export const player = new Player();

/** Load a take's audio into the shared player and return it. */
export function useTakeAudio(src: string): Player {
  useEffect(() => player.load(src), [src]);
  return player;
}

export function usePlayerTime(p: Player = player): number {
  return useSyncExternalStore(p.subscribe, () => p.time);
}

export function usePlayerState(p: Player = player) {
  const playing = useSyncExternalStore(p.subscribe, () => p.playing);
  const refPlaying = useSyncExternalStore(p.subscribe, () => p.refPlaying);
  const refLabel = useSyncExternalStore(p.subscribe, () => p.refLabel);
  const rate = useSyncExternalStore(p.subscribe, () => p.rate);
  const loop = useSyncExternalStore(p.subscribe, () => p.loop);
  const src = useSyncExternalStore(p.subscribe, () => p.src);
  const label = useSyncExternalStore(p.subscribe, () => p.label);
  return { playing, refPlaying, refLabel, rate, loop, src, label };
}
