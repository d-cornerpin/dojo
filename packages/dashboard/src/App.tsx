import { Routes, Route, Navigate, useNavigate, Outlet } from 'react-router-dom';
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';
import { ToastProvider, ToastContainer, useToast } from './hooks/useToast';
import type { WsEvent } from '@dojo/shared';
import { Sidebar } from './components/Sidebar';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { Chat } from './pages/Chat';
import { Agents } from './pages/Agents';
import { AgentDetailPage } from './pages/AgentDetail';
import { Tracker } from './pages/Tracker';
import { Techniques } from './pages/Techniques';
import { TechniqueDetail } from './pages/TechniqueDetail';
import { TechniqueBuilder } from './pages/TechniqueBuilder';
import { Memory } from './pages/Memory';
import { Health } from './pages/Health';
import { Settings } from './pages/Settings';
import { Costs } from './pages/Costs';
import * as api from './lib/api';
import { PostMigrationBanner } from './components/PostMigrationBanner';

// ── Auth guard — redirects to login if not authenticated ──

const RequireAuth = () => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};

// ── Setup redirect — checks if OOBE is needed ──

const SetupGate = () => {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    const check = async () => {
      const result = await api.getSetupStatus();
      if (result.ok && result.data.isFirstRun) {
        navigate('/setup', { replace: true });
      }
      setChecked(true);
    };
    check();
  }, [isAuthenticated, navigate]);

  if (!checked) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return <Outlet />;
};

// ── WebSocket shell — single provider for all dashboard pages ──
// Mounts ONLY after authentication, so the token always exists.
// Persists across page navigation (single mount).

const WebSocketShell = () => {
  return (
    <WebSocketProvider>
      <Outlet />
    </WebSocketProvider>
  );
};

// ── Dashboard layout with sidebar ──

const GradientBlobs = () => (
  <div className="gradient-blob-layer">
    <div className="blob blob-purple" />
    <div className="blob blob-teal" />
    <div className="blob blob-warm" />
  </div>
);

const DashboardLayout = () => {
  return (
    <ToastProvider>
      <GradientBlobs />
      <ToastContainer />
      <div className="h-dvh flex overflow-hidden relative z-[1]" style={{ backgroundColor: 'transparent' }}>
        <Sidebar />
        <main className="flex-1 flex flex-col h-full overflow-hidden pt-[48px] md:pt-0">
          <PostMigrationBanner />
          <GlobalAlerts />
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
};

// ── Routes ──

const AppRoutes = () => {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Authenticated */}
      <Route element={<RequireAuth />}>
        {/* Setup (no sidebar, no WS needed) */}
        <Route path="/setup" element={<Setup />} />

        {/* Dashboard — WebSocket wraps all pages, single mount */}
        <Route element={<WebSocketShell />}>
          <Route element={<SetupGate />}>
            <Route element={<DashboardLayout />}>
              <Route path="/" element={<Chat />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/techniques" element={<Techniques />} />
              <Route path="/techniques/new" element={<TechniqueBuilder />} />
              <Route path="/techniques/:id/edit" element={<TechniqueBuilder />} />
              <Route path="/techniques/:id" element={<TechniqueDetail />} />
              <Route path="/tracker" element={<Tracker />} />
              <Route path="/memory" element={<Memory />} />
              <Route path="/costs" element={<Costs />} />
              <Route path="/health" element={<Health />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

// ── Global WebSocket-driven alerts (uses the shared toast system) ──

const GlobalAlerts = () => {
  const { subscribe } = useWebSocket();
  const toast = useToast();

  useEffect(() => {
    const unsub = subscribe('cost:alert', (event: WsEvent) => {
      const e = event as { type: string; data: { scope: string; percentage: number; currentSpend: number; limitUsd: number } };
      const pct = e.data.percentage;
      if (pct >= 90) {
        toast.error(`Resources nearly depleted (90%) — $${e.data.currentSpend.toFixed(2)} of $${e.data.limitUsd.toFixed(2)}`);
      } else if (pct >= 75) {
        toast.warning('Resources running low (75%)');
      } else {
        toast.info(`Resources at half strength (50%) — $${e.data.currentSpend.toFixed(2)} of $${e.data.limitUsd.toFixed(2)}`);
      }
    });

    const unsub2 = subscribe('resource:warning', (event: WsEvent) => {
      const e = event as { type: string; data: { freeMb: number; totalMb: number } };
      toast.warning(`Low memory: ${(e.data.freeMb / 1024).toFixed(1)}GB free`);
    });

    return () => { unsub(); unsub2(); };
  }, [subscribe, toast]);

  return null; // rendering is handled by ToastContainer
};

export const App = () => {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
};
