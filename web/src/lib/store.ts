import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface Layers {
  pitch: boolean;
  energy: boolean;
  reference: boolean;
  deviation: boolean;
  truth: boolean;
  /** rhythm threads: each reference delivery's words joined to this recording's */
  threads: boolean;
}

export type Theme = "studio" | "report";

interface UiState {
  layers: Layers;
  /** explorer transcript: words spaced by their real pauses */
  rhythm: boolean;
  /** appearance: dark studio (default) or light report */
  theme: Theme;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  setLayers: (l: Layers) => void;
  toggleLayer: (k: keyof Layers) => void;
  setRhythm: (on: boolean) => void;
  setTheme: (t: Theme) => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
}

// Storage access can throw (private mode, blocked site data); fall back to memory.
const safeStorage = createJSONStorage(() => {
  try {
    localStorage.setItem("rt:probe", "1");
    localStorage.removeItem("rt:probe");
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      layers: { pitch: true, energy: true, reference: true, deviation: false, truth: false, threads: true },
      rhythm: false,
      theme: "studio",
      paletteOpen: false,
      shortcutsOpen: false,
      setLayers: (layers) => set({ layers }),
      toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
      setRhythm: (rhythm) => set({ rhythm }),
      setTheme: (theme) => set({ theme }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    }),
    {
      name: "rhetortrace:ui",
      storage: safeStorage,
      partialize: (s) => ({ layers: s.layers, rhythm: s.rhythm, theme: s.theme }),
      // layers added later (threads) keep their default for settings saved before them
      merge: (saved, current) => {
        const p = (saved ?? {}) as Partial<UiState>;
        return { ...current, ...p, layers: { ...current.layers, ...p.layers } };
      },
    },
  ),
);
