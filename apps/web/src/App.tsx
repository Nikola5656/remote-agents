import { useLayoutEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Nav } from "./components/Nav";
import { LiveProvider, useLive } from "./live";
import { AgentDocuments } from "./pages/AgentDocuments";
import { AgentDetail } from "./pages/AgentDetail";
import { Agents } from "./pages/Agents";
import { Health } from "./pages/Health";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { ToastProvider } from "./toast";

function BootSkeleton() {
  return (
    <main className="boot">
      <div className="skeleton-stack boot__skeleton">
        <div className="skeleton skeleton--hero" />
        <div className="skeleton skeleton--block" />
        <div className="skeleton skeleton--block" />
      </div>
    </main>
  );
}

function RequireAuth() {
  const { username, ready } = useAuth();
  const location = useLocation();
  if (!ready) {
    return <BootSkeleton />;
  }
  if (!username) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

function LinkBanner() {
  const { mode } = useLive();
  if (mode === "live") return null;
  return (
    <div className={`link-banner link-banner--${mode}`} role="status">
      {mode === "poll"
        ? "Live link lost — reconnecting… updates refresh every 3s"
        : "Connecting to the control server…"}
    </div>
  );
}

function AppShell() {
  const { pathname } = useLocation();
  useLayoutEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, [pathname]);
  const { markSignedOut, username } = useAuth();
  return (
    <LiveProvider enabled={Boolean(username)} onUnauth={markSignedOut}>
      <div className="shell">
        <Nav />
        <LinkBanner />
        <main className="shell__main">
          <Outlet />
        </main>
      </div>
    </LiveProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/health" element={<Health />} />
              <Route path="/overview" element={<Overview />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/agents/:id/documents" element={<AgentDocuments />} />
              <Route path="/agents/:id" element={<AgentDetail />} />
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Route>
          </Route>
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
