import { useEffect, useState } from "react";
import type { Index, Take } from "./types";

// Static artifacts exported by scripts/build_dashboard.py into web/public.
const cache = new Map<string, Promise<unknown>>();

function load<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(path).then((r) => {
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  return cache.get(path) as Promise<T>;
}

export const audioUrl = (path: string) => `/${path}`;

type State<T> = { data: T | null; error: string | null; loading: boolean };

function useResource<T>(path: string | null): State<T> {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load<T>(path)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e: Error) => alive && setState({ data: null, error: e.message, loading: false }));
    return () => {
      alive = false;
    };
  }, [path]);
  return state;
}

export const useIndex = () => useResource<Index>("/data/index.json");
export const useTake = (id: string | undefined) => useResource<Take>(id ? `/data/${id}.json` : null);
