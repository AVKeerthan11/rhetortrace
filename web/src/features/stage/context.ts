import { useOutletContext } from "react-router-dom";
import type { Take } from "@/lib/types";

/** What the recording layout gives the screens inside it (overview, finding, explorer). */
export interface TakeContext {
  take: Take;
  /** flaw indices in importance order: finding N = ranking[N - 1] */
  ranking: number[];
  /** finding number (1-based) per flaw index */
  ranks: number[];
  /** explorer: select the next / previous finding in time */
  onStep: (dir: 1 | -1) => void;
}

export const useTakeContext = () => useOutletContext<TakeContext>();
