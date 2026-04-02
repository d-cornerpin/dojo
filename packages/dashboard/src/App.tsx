import { Routes, Route, Navigate, useNavigate, Outlet } from 'react-router-dom';
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';
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
      <GlobalAlerts />
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
    <>
      <GradientBlobs />
      <div className="h-screen flex overflow-hidden relative z-[1]" style={{ backgroundColor: 'transparent' }}>
        <Sidebar />
        <main className="flex-1 flex flex-col h-full overflow-hidden">
          <PostMigrationBanner />
          <Outlet />
        </main>
      </div>
    </>
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

// ── Global Alert Toasts ──

interface AlertToast {
  id: number;
  message: string;
  level: 'warning' | 'error' | 'info';
  timestamp: number;
}

let alertIdCounter = 0;

const GlobalAlerts = () => {
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const { subscribe } = useWebSocket();

  const addToast = useCallback((message: string, level: 'warning' | 'error' | 'info') => {
    const id = ++alertIdCounter;
    setToasts(prev => [...prev, { id, message, level, timestamp: Date.now() }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 8000);
  }, []);

  useEffect(() => {
    const unsub = subscribe('cost:alert', (event: WsEvent) => {
      const e = event as { type: string; data: { scope: string; percentage: number; currentSpend: number; limitUsd: number } };
      const pct = e.data.percentage;
      const level = pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'info';
      const msg = pct >= 90
        ? `Resources nearly depleted (90%) — $${e.data.currentSpend.toFixed(2)} of $${e.data.limitUsd.toFixed(2)}`
        : pct >= 75
        ? `Resources running low (75%)`
        : `Resources at half strength (50%) — $${e.data.currentSpend.toFixed(2)} of $${e.data.limitUsd.toFixed(2)}`;
      addToast(msg, level);
    });

    const unsub2 = subscribe('resource:warning', (event: WsEvent) => {
      const e = event as { type: string; data: { freeMb: number; totalMb: number } };
      addToast(`Low memory: ${(e.data.freeMb / 1024).toFixed(1)}GB free`, 'warning');
    });

    return () => { unsub(); unsub2(); };
  }, [subscribe, addToast]);

  if (toasts.length === 0) return null;

  const toastColors = {
    info: 'glass-toast-info',
    warning: 'glass-toast-warning',
    error: 'glass-toast-error',
  };

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      {toasts.map(t => (
        <div key={t.id} className={`glass-toast ${toastColors[t.level]} px-4 py-3 text-sm text-white animate-slide-in-right`}>
          <div className="flex items-center justify-between gap-3">
            <span>{t.message}</span>
            <button
              onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              className="text-white/40 hover:text-white shrink-0"
            >&times;</button>
          </div>
        </div>
      ))}
    </div>
  );
};

export const App = () => {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
};
