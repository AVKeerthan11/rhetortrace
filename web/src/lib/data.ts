import { useEffect, useState } from "react";
import { getResult, isRunId, resultToTake } from "./api";
import type { Index, Take } from "./types";

// Static artifacts exported by scripts/build_dashboard.py into web/public; uploaded analyses
// (ids "job-...") come from the analysis server instead (src/lib/api.ts).
const cache = new Map<string, Promise<unknown>>();

function load<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    // a failure is not cached: the next visit (or a finished job) tries again
    cache.set(key, fetcher().catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key) as Promise<T>;
}

const fetchJson = <T,>(path: string) => () =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });

export const audioUrl = (path: string) => `/${path}`;

type State<T> = { data: T | null; error: string | null; loading: boolean };

function useResource<T>(key: string | null, fetcher: () => Promise<T>): State<T> {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: !!key });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load<T>(key, fetcher)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e: Error) => alive && setState({ data: null, error: e.message, loading: false }));
    return () => {
      alive = false;
    };
    // the key identifies the resource; the fetcher is derived from it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export const useIndex = () => useResource<Index>("/data/index.json", fetchJson<Index>("/data/index.json"));

export function useTake(id: string | undefined) {
  const run = isRunId(id);
  const key = !id ? null : run ? `run:${id}` : `/data/${id}.json`;
  return useResource<Take>(key, run ? () => getResult(id).then(resultToTake) : fetchJson<Take>(`/data/${id}.json`));
}
