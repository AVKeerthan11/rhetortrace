import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { FindingPage } from "@/features/finding/FindingPage";
import { Explorer } from "@/features/timeline/Explorer";
import { explorePath, overviewPath } from "@/lib/takes";
import { Evaluation } from "@/pages/Evaluation";
import { Home } from "@/pages/Home";
import { Method } from "@/pages/Method";
import { Overview } from "@/pages/Overview";
import { Robustness } from "@/pages/Robustness";

/** Old /take/:id/studio and /speech/:id/... links keep working. */
function LegacyRedirect({ to }: { to: "overview" | "explore" }) {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  return <Navigate to={to === "explore" ? explorePath(id) + (params.get("f") ? `?f=${params.get("f")}` : "") : overviewPath(id)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="take/:id" element={<Overview />} />
        <Route path="take/:id/finding/:n" element={<FindingPage />} />
        <Route path="take/:id/explore" element={<Explorer />} />
        <Route path="evaluation" element={<Evaluation />} />
        <Route path="evaluation/robustness" element={<Robustness />} />
        <Route path="robustness" element={<Navigate to="/evaluation/robustness" replace />} />
        <Route path="method" element={<Method />} />
        <Route path="take/:id/studio" element={<LegacyRedirect to="explore" />} />
        <Route path="speech/:id/overview" element={<LegacyRedirect to="overview" />} />
        <Route path="speech/:id/studio" element={<LegacyRedirect to="explore" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
