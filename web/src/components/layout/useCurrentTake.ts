import { useMatch } from "react-router-dom";

export type TakeView = "overview" | "finding" | "explore";

/** The take in the URL (if any), which screen of it is open, and the finding number. */
export function useCurrentTake(): { id: string | null; view: TakeView; rank: number | null } {
  const finding = useMatch("/take/:id/finding/:n");
  const explore = useMatch("/take/:id/explore");
  const overview = useMatch("/take/:id");
  if (finding) return { id: finding.params.id!, view: "finding", rank: Number(finding.params.n) || null };
  if (explore) return { id: explore.params.id!, view: "explore", rank: null };
  if (overview) return { id: overview.params.id!, view: "overview", rank: null };
  return { id: null, view: "overview", rank: null };
}
