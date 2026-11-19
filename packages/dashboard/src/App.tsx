import { Routes, Route, Navigate, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useEffect, useState, useRef, useCallback } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';
import { ToastProvider, useToast } from './hooks/useToast';
import { PLATFORM_SENDER, type WsEvent, type ChatErrorEvent } from '@dojo/shared';
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
import { ReportPreviewCard } from './components/ReportPreviewCard';
import { OrbProvider } from './components/orb/OrbProvider';
import { ActiveAgentProvider } from './components/ActiveAgentProvider';
import { RightDockProvider } from './components/RightDockProvider';
import { TechniqueSessionProvider } from './components/TechniqueSessionProvider';


const RequireAuth = () => {
  const { isAuthenticated, isLoading, isWaiting } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#f0e6d2] flex items-center justify-center">
        <div className="text-[#7a6a52]">{isWaiting ? 'Waiting for your Dojo...' : 'Loading...'}</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};


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

// Mounts only after authentication (so the token exists) and persists across
// navigation, so one WebSocket connection serves every page.

const WebSocketShell = () => {
  return (
    <WebSocketProvider>
      <Outlet />
    </WebSocketProvider>
  );
};


// Shared chrome for every authenticated surface: the toast system.
const DashboardChrome = () => (
  // One toast queue, drawn by the dojo3 stage's orb-anchored cards (Dojo3Notifications).
  <ToastProvider>
    <SystemRestartOverlay />
    <Outlet />
  </ToastProvider>
);

// The server broadcasts system:restart just before it exits to restart. One
// chrome-level overlay lets every connected device (not just the one that
// triggered the restart) ride out the gap instead of raw reconnect noise, and
// clears once the socket reports 'connected' again.
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

  // Safety net: clear the overlay if a reconnect never lands (dev server
  // killed for good). The socket layer already redirects to /login on
  // repeated failures; this is the backstop.
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

// Persistent dojo3 shell: one Chat (stage + orb) stays mounted across all
// panel routes, so navigation swaps only panel content, never the orb.
const Dojo3Shell = () => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  // Technique build/edit mount no panel: the chat becomes the trainer
  // conversation, the Mat docks right, and their <Outlet /> runs the session
  // controller outside the panel slot.
  const isTechniqueBuild = /^\/techniques\/(new|[^/]+\/edit)$/.test(location.pathname);
  const showPanel = !isHome && !isTechniqueBuild;
  return (
    <OrbProvider>
      <ActiveAgentProvider>
        <RightDockProvider>
          <TechniqueSessionProvider>
            <PostMigrationBanner />
            <ReportPreviewCard />
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



const AppRoutes = () => {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Authenticated */}
      <Route element={<RequireAuth />}>
        {/* Setup (no sidebar, no WS needed) */}
        <Route path="/setup" element={<Setup />} />

        {/* Dashboard, WebSocket wraps all pages, single mount */}
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


export const GlobalAlerts = () => {
  const { subscribe, connectionStatus } = useWebSocket();
  const toast = useToast();
  const { addActionToast, removeToastByKey } = toast;

  // Healer consent asks are not toasted here: HealerVitals keeps its own
  // healer:proposal subscription and queues them in the Vitals page.

  // Owner notices reach this tab as platform-spoken `chat:error` frames and stay
  // sticky until dismissed (the X tells the server). On every connect the server's
  // standing cards are re-fetched, so a card outlives a page reload; an `info`
  // frame is an all-clear that removes the card it names.
  // cardKey groups one condition's changing words into one card: the end frame and
  // the X find it by key, whatever its words became.
  // A card declares its class: `action` (absent means action) stays sticky and keeps
  // the orb's red alert; `informational` is a self-expiring toast with nothing to dismiss server-side.
  const showOwnerCard = useCallback((words: string, critical: boolean, cardKey?: string, cardClass?: 'action' | 'informational') => {
    const dedupeKey = `owner-alert:${cardKey ?? words}`;
    if (cardKey) removeToastByKey(dedupeKey);   // new words for the same condition replace the card
    if (cardClass === 'informational') {
      return addActionToast({ title: '', message: words, actions: [], dedupeKey, level: 'info', needsAction: false });
    }
    return addActionToast({
      title: '', message: words, actions: [], dedupeKey, level: critical ? 'error' : 'warning',
      onDismiss: () => {
        void api.request('/config/owner-notices/dismiss', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words, ...(cardKey ? { cardKey } : {}) }),
        });
      },
    });
  }, [addActionToast, removeToastByKey]);

  // Reconcile on-screen owner cards against what the server says still stands: a tab
  // that missed a card's end frame while away must drop it. The list carries action
  // cards only; an informational toast leaves by itself.
  const onScreen = useRef(toast.toasts);
  onScreen.current = toast.toasts;
  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    let current = true;
    void api.request<Array<{ words: string; severity: string; cardKey?: string; cardClass?: 'action' | 'informational' }>>('/config/owner-notices').then((r) => {
      if (!current || !r.ok || !Array.isArray(r.data)) return;
      const standing = new Set(r.data.map((c) => `owner-alert:${c.cardKey ?? c.words}`));
      for (const t of onScreen.current) {
        if (t.dedupeKey?.startsWith('owner-alert:') && !standing.has(t.dedupeKey)) removeToastByKey(t.dedupeKey);
      }
      for (const c of r.data) {
        const key = `owner-alert:${c.cardKey ?? c.words}`;
        if (onScreen.current.some((t) => t.dedupeKey === key && t.message === c.words)) continue;   // already shown: no second startle
        showOwnerCard(c.words, c.severity === 'critical', c.cardKey, c.cardClass);
      }
    });
    return () => { current = false; };
  }, [connectionStatus, showOwnerCard, removeToastByKey]);

  useEffect(() => {
    const unsub = subscribe('chat:error', (event: WsEvent) => {
      const e = event as ChatErrorEvent;
      if (e.agentId !== PLATFORM_SENDER) return;
      if (e.severity === 'info') removeToastByKey(`owner-alert:${e.cardKey ?? e.error}`);
      else showOwnerCard(e.error, e.severity === 'error', e.cardKey, e.cardClass);
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


    return () => { unsub(); unsub2(); unsub3(); };
  }, [subscribe, toast, showOwnerCard, removeToastByKey]);

  return null; // rendering is handled by Dojo3Notifications
};

// The server emits ui:navigate (from the open_page / open_settings tools); this
// is its only consumer. It mounts inside Dojo3Shell so it has both the router
// (useNavigate) and the WebSocket context.
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
      <AppRoutes />
    </AuthProvider>
  );
};
