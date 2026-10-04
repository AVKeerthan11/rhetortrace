import { lazy } from "react";
import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { evaluationPath, explorePath, methodPath, overviewPath, robustnessPath } from "@/lib/takes";
import { Home } from "@/pages/Home";

// Route-level code splitting: Home is part of the first load; everything else loads on demand.
// The three screens of a recording live under one layout route (the persistent stage).
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));

const TakeLayout = named(() => import("@/features/stage/TakeLayout"), "TakeLayout");
const Overview = named(() => import("@/pages/Overview"), "Overview");
const FindingPage = named(() => import("@/features/finding/FindingPage"), "FindingPage");
const Explorer = named(() => import("@/features/timeline/Explorer"), "Explorer");
const NewAnalysis = named(() => import("@/pages/NewAnalysis"), "NewAnalysis");
const AnalysisStatus = named(() => import("@/pages/AnalysisStatus"), "AnalysisStatus");
const Recordings = named(() => import("@/pages/Recordings"), "Recordings");
const Lab = named(() => import("@/pages/Lab"), "Lab");
const Examples = named(() => import("@/pages/Examples"), "Examples");
const Evaluation = named(() => import("@/pages/Evaluation"), "Evaluation");
const Robustness = named(() => import("@/pages/Robustness"), "Robustness");
const Method = named(() => import("@/pages/Method"), "Method");

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
        <Route path="analyze" element={<NewAnalysis />} />
        <Route path="analyze/:runId" element={<AnalysisStatus />} />
        <Route path="recordings" element={<Recordings />} />

        <Route path="take/:id" element={<TakeLayout />}>
          <Route index element={<Overview />} />
          <Route path="finding/:n" element={<FindingPage />} />
          <Route path="explore" element={<Explorer />} />
        </Route>

        <Route path="lab" element={<Lab />} />
        <Route path="lab/examples" element={<Examples />} />
        <Route path="lab/evaluation" element={<Evaluation />} />
        <Route path="lab/robustness" element={<Robustness />} />
        <Route path="lab/method" element={<Method />} />

        {/* earlier addresses */}
        <Route path="evaluation" element={<Navigate to={evaluationPath} replace />} />
        <Route path="evaluation/robustness" element={<Navigate to={robustnessPath} replace />} />
        <Route path="robustness" element={<Navigate to={robustnessPath} replace />} />
        <Route path="method" element={<Navigate to={methodPath} replace />} />
        <Route path="take/:id/studio" element={<LegacyRedirect to="explore" />} />
        <Route path="speech/:id/overview" element={<LegacyRedirect to="overview" />} />
        <Route path="speech/:id/studio" element={<LegacyRedirect to="explore" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
