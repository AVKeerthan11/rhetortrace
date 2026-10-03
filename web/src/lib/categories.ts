import { AudioLines, Gauge, PauseCircle, Activity, Sparkles, type LucideIcon } from "lucide-react";
import type { Category } from "./types";

export const CATEGORIES: Category[] = ["pacing", "pitch", "pause", "energy", "clarity"];

export const CATEGORY: Record<Category, { label: string; icon: LucideIcon; color: string; text: string; bg: string; border: string }> = {
  pacing: { label: "Pacing", icon: Gauge, color: "var(--cat-pacing)", text: "text-pacing", bg: "bg-pacing", border: "border-pacing" },
  pitch: { label: "Pitch", icon: Activity, color: "var(--cat-pitch)", text: "text-pitch", bg: "bg-pitch", border: "border-pitch" },
  pause: { label: "Pause", icon: PauseCircle, color: "var(--cat-pause)", text: "text-pause", bg: "bg-pause", border: "border-pause" },
  energy: { label: "Energy", icon: AudioLines, color: "var(--cat-energy)", text: "text-energy", bg: "bg-energy", border: "border-energy" },
  clarity: { label: "Clarity", icon: Sparkles, color: "var(--cat-clarity)", text: "text-clarity", bg: "bg-clarity", border: "border-clarity" },
};

// Severity is typographic: weight and badge emphasis, never a traffic light.
export const SEVERITY_STYLE: Record<number, { badge: string; weight: string }> = {
  0: { badge: "border-ink/10 text-muted-foreground", weight: "font-normal" },
  1: { badge: "border-ink/15 text-muted-foreground", weight: "font-normal" },
  2: { badge: "border-ink/25 text-ink/85", weight: "font-medium" },
  3: { badge: "border-ink/40 text-ink bg-ink/[0.06]", weight: "font-semibold" },
  4: { badge: "border-ink text-primary-foreground bg-ink", weight: "font-semibold" },
};

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
