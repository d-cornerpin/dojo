import { Routes, Route, Navigate, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';
import { ToastProvider, useToast } from './hooks/useToast';
import type { WsEvent } from '@dojo/shared';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { Chat } from './pages/Chat';
import { InterAgentLane } from './pages/InterAgentLane';
import { Agents } from './pages/Agents';
import { AgentConfigPanel } from './pages/AgentConfigPanel';
import { Tracker } from './pages/Tracker';
import { Techniques } from './pages/Techniques';
import { TechniqueDetail } from './pages/TechniqueDetail';
import { TechniqueSessionRoute } from './pages/TechniqueSessionRoute';
import { Memory } from './pages/Memory';
import { Health } from './pages/Health';
import { Settings } from './pages/Settings';
import { Costs } from './pages/Costs';
import * as api from './lib/api';
import { PostMigrationBanner } from './components/PostMigrationBanner';
import { ThemeProvider } from './themes/ThemeProvider';
import { OrbProvider } from './components/orb/OrbProvider';
import { ActiveAgentProvider } from './components/ActiveAgentProvider';
import { RightDockProvider } from './components/RightDockProvider';
import { TechniqueSessionProvider } from './components/TechniqueSessionProvider';

// ── Auth guard — redirects to login if not authenticated ──

const RequireAuth = () => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#f0e6d2] flex items-center justify-center">
        <div className="text-[#7a6a52]">Loading...</div>
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
      <div className="min-h-screen bg-[#f0e6d2] flex items-center justify-center">
        <div className="text-[#7a6a52]">Loading...</div>
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

// Shared chrome for every authenticated surface: the toast system. Both the
// dojo3 stage and the full-page surfaces render inside it via <Outlet/>.
const DashboardChrome = () => (
  // ToastProvider is shared; the dojo3 stage renders its own orb-anchored
  // notification cards (Dojo3Notifications), while the full-page chrome below
  // keeps the classic corner ToastContainer — same queue, two surfaces.
  <ToastProvider>
    <SystemRestartOverlay />
    <Outlet />
  </ToastProvider>
);

// ── Server-restart overlay (FA-G5) ──
//
// The server broadcasts system:restart right before it exits to restart under
// launchd. Without a consumer, every OTHER connected device (and any restart
// not triggered from the local Settings button, e.g. agent-controls or remote) just
// saw the socket drop and churned through raw reconnect attempts. This mounts
// ONE overlay at the chrome level (inside WebSocketShell, above every routed
// page) so any device rides out the ~1-2s gap with a plain "Restarting…" screen
// instead of connection noise, then clears itself once the socket reconnects.
// The local Settings inline note stays; this covers the cases it can't.
const SystemRestartOverlay = () => {
  const { subscribe, connectionStatus } = useWebSocket();
  const [restarting, setRestarting] = useState(false);
  // We must not clear on the FIRST 'connected' (the socket is still up at the
  // instant the marker arrives (the server exits a beat later). Only clear
  // once we've actually observed the socket drop and come back.
  const sawDropRef = useRef(false);

  useEffect(() => {
    const unsub = subscribe('system:restart', (event: WsEvent) => {
      if (event.type !== 'system:restart') return;
      sawDropRef.current = false;
      setRestarting(true);
    });
    return unsub;
  }, [subscribe]);

  useEffect(() => {
    if (!restarting) return;
    if (connectionStatus !== 'connected') {
      sawDropRef.current = true; // socket dropped during the restart gap
      return;
    }
    if (sawDropRef.current) {
      // Reconnected, so let the fresh server settle a beat, then reveal the app.
      const t = setTimeout(() => { setRestarting(false); sawDropRef.current = false; }, 600);
      return () => clearTimeout(t);
    }
  }, [restarting, connectionStatus]);

  // Safety net: never wedge the overlay if a reconnect never lands (dev server
  // killed for good). The socket layer already redirects to /login after
  // repeated failures; this is a belt-and-suspenders clear.
  useEffect(() => {
    if (!restarting) return;
    const t = setTimeout(() => setRestarting(false), 60_000);
    return () => clearTimeout(t);
  }, [restarting]);

  if (!restarting) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4"
      style={{ background: 'var(--overlay-dark)' }}
    >
      <div className="glass-panel rounded-2xl px-8 py-6 flex flex-col items-center gap-3">
        <svg width="28" height="28" className="animate-spin text-ui/70" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="text-sm font-medium text-ui/90">Restarting…</div>
        <div className="text-xs text-ui/55">The dashboard will reconnect automatically once it's back up.</div>
      </div>
    </div>
  );
};

// The PERSISTENT dojo3 shell: one Chat (stage + orb) that stays mounted
// across all panel surfaces, so the orb never reloads on navigation. The
// routed page is injected as the panel content via <Outlet/>; on "/" there
// is no panel (just the chat). Because this layout element stays mounted
// while any of its child routes match, navigating Agents -> Vault -> ...
// only swaps the panel content, not the orb.
const Dojo3Shell = () => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  // Technique build/edit routes don't overlay a panel — the chat itself becomes
  // the trainer conversation (slides nothing, stays in focus) and the Technique
  // Mat docks on the right. Their <Outlet/> mounts the session controller
  // outside the panel slot so it can start the session + open the dock.
  const isTechniqueBuild = /^\/techniques\/(new|[^/]+\/edit)$/.test(location.pathname);
  const showPanel = !isHome && !isTechniqueBuild;
  return (
    <OrbProvider>
      <ActiveAgentProvider>
        <RightDockProvider>
          <TechniqueSessionProvider>
            <PostMigrationBanner />
            <GlobalAlerts />
            <NavigationHandler />
            <div className="h-dvh w-full overflow-hidden relative z-[1]">
              <Chat panel={showPanel ? { content: <Outlet /> } : null} />
              {isTechniqueBuild && <Outlet />}
            </div>
          </TechniqueSessionProvider>
        </RightDockProvider>
      </ActiveAgentProvider>
    </OrbProvider>
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
            <Route element={<DashboardChrome />}>
              {/* Persistent orb stage; routed pages become panel content */}
              <Route element={<Dojo3Shell />}>
                <Route index element={null} />
                <Route path="interagent" element={<InterAgentLane />} />
                <Route path="agents" element={<Agents />} />
                <Route path="agents/:id" element={<AgentConfigPanel />} />
                <Route path="techniques" element={<Techniques />} />
                <Route path="tracker" element={<Tracker />} />
                <Route path="memory" element={<Memory />} />
                <Route path="costs" element={<Costs />} />
                <Route path="health" element={<Health />} />
                <Route path="settings" element={<Settings />} />
                {/* Technique build/edit run inside the persistent shell: the
                    chat becomes the trainer conversation and the Mat docks
                    right. The controller renders null (see Dojo3Shell). */}
                <Route path="techniques/new" element={<TechniqueSessionRoute />} />
                <Route path="techniques/:id/edit" element={<TechniqueSessionRoute />} />
                {/* Technique detail renders as a dojo3 panel like every other
                    page (it self-headers via .phead). The more specific
                    new/edit routes above out-rank this :id match. */}
                <Route path="techniques/:id" element={<TechniqueDetail />} />
              </Route>
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

  // D-B v2 (owner-directed): the Healer's consent asks no longer toast. They queue
  // in the Healer section of Vitals (HealerVitals) in plain language, and the only
  // out-of-band lane is a text for a critical diagnostic while the owner is away.
  // The urgent-approval toast wiring (present-on-frame + re-present-on-load/reconnect
  // + orb reddening) is retired here. The generic action-toast capability stays in
  // useToast for other features; this consumer is removed. HealerVitals keeps its
  // own healer:proposal subscription, so the WS frames are still emitted.

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

    // System dep installed at server startup (typically post-update).
    // Lets the user know a brew package was just added so they don't get
    // a surprise "feature X works now" or have to read server logs.
    const unsub3 = subscribe('system:dep_installed', (event: WsEvent) => {
      const e = event as { type: string; data: { pkg: string; status: 'installed' | 'failed' } };
      if (e.data.status === 'installed') {
        toast.success(`System dependency installed: ${e.data.pkg}`);
      } else {
        toast.error(`Failed to install system dependency: ${e.data.pkg}`);
      }
    });

    // D-B v2: the Healer's consent asks are no longer toasted here (retired). They
    // live in the Healer section of Vitals; HealerVitals owns the healer:proposal
    // subscription for its live refresh.

    return () => { unsub(); unsub2(); unsub3(); };
  }, [subscribe, toast]);

  return null; // rendering is handled by ToastContainer
};

// ── Agent-driven navigation ──
//
// Lets the agent move the user's view (open a page or a Settings tab) in
// response to "take me to X" / "where do I change Y?". The server emits
// ui:navigate (from the open_page / open_settings tools); this handler is
// the only place that consumes it. Mounted inside Dojo3Shell so it sits
// within both the router (useNavigate) and the WebSocket context.
const NavigationHandler = () => {
  const { subscribe } = useWebSocket();
  const navigate = useNavigate();

  useEffect(() => {
    const unsub = subscribe('ui:navigate', (event: WsEvent) => {
      if (event.type !== 'ui:navigate') return;
      const { path, tab, section } = event.data;
      if (path === '/settings' && tab) {
        const q = new URLSearchParams({ tab });
        if (section) q.set('section', section);
        navigate(`/settings?${q.toString()}`);
      } else if (typeof path === 'string' && path.startsWith('/')) {
        navigate(path);
      }
    });
    return unsub;
  }, [subscribe, navigate]);

  return null;
};

export const App = () => {
  return (
    <AuthProvider>
      <ThemeProvider>
        <AppRoutes />
      </ThemeProvider>
    </AuthProvider>
  );
};
