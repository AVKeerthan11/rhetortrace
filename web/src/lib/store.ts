import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface Layers {
  pitch: boolean;
  energy: boolean;
  reference: boolean;
  deviation: boolean;
  truth: boolean;
}

interface UiState {
  layers: Layers;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  setLayers: (l: Layers) => void;
  toggleLayer: (k: keyof Layers) => void;
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
      layers: { pitch: true, energy: true, reference: true, deviation: false, truth: false },
      paletteOpen: false,
      shortcutsOpen: false,
      setLayers: (layers) => set({ layers }),
      toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    }),
    {
      name: "rhetortrace:ui",
      storage: safeStorage,
      partialize: (s) => ({ layers: s.layers }),
    },
  ),
);
