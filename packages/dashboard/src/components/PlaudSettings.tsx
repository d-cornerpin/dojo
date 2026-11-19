import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { formatDateShort } from '../lib/dates';

// Plaud is a meeting-recording / AI-summary service. Single account per Dojo
// install (no slot model); connecting runs `plaud login` on the Dojo host.
// The CLI may open the sign-in browser on that host even when asked not to, so
// the card says where the sign-in finishes and keeps the printed URL for
// anyone driving the dashboard from another device.
// `reauthRequired` is a third state served by the route, never re-derived here:
// an expired login must never render as Connected.

// The signed-out / login-expired part of the card.
const PlaudDisconnectedPanel = ({ status, onConnect }: { status: api.PlaudStatus; onConnect: () => void }) => (
    <>
      {status.reauthRequired && (
        <div className="alert-banner alert-warning text-xs">
          <p className="font-medium mb-1">
            Your Plaud login has expired{status.email ? ` (${status.email})` : ''}.
          </p>
          <p className="text-ui/55">
            Your agents can&apos;t reach your recordings until you reconnect. Nothing else is
            affected.
          </p>
        </div>
      )}
      <button
        onClick={onConnect}
        className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
      >
        {status.reauthRequired ? 'Reconnect Plaud' : 'Connect Plaud'}
      </button>
      <p className="text-xs text-ui/55">
        Signing in happens <span className="font-medium">on the Mac that runs Dojo</span>: a
        browser window opens there, and the sign-in has to be completed on that machine. If
        you&apos;re reading this from your phone or another computer, use the link that appears
        below once you click, or go over to the Mac.
      </p>
      <p className="text-[11px] text-ui/40">
        No Plaud account?{' '}
        <a
          href="https://www.plaud.ai/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cp-teal hover:text-cp-teal/80 underline"
        >
          Sign up at plaud.ai ↗
        </a>
      </p>
    </>
);

export const PlaudSettings = () => {
  const [status, setStatus] = useState<api.PlaudStatus | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const toast = useToast();
  const { subscribe } = useWebSocket();
  const loadedRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest status answer is applied: an older, slower one must not undo a newer one.
  const loadSeq = useRef(0);

  const loadStatus = async () => {
    const seq = ++loadSeq.current;
    const result = await api.getPlaudStatus();
    if (seq !== loadSeq.current) return;
    if (!result.ok) { setLoadError(result.error); return; }
    if (result.ok) {
      setLoadError(null);
      setStatus(result.data);
      if (result.data.loginInProgress && result.data.loginUrl) {
        setAuthUrl(result.data.loginUrl);
        setConnecting(true);
      }
    }
  };

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadStatus();
  }, []);

  useEffect(() => {
    const unsubUrl = subscribe('plaud:auth_url', (msg: unknown) => {
      const m = msg as { url?: string };
      if (m.url) setAuthUrl(m.url);
    });
    const unsubConnected = subscribe('plaud:connected', (msg: unknown) => {
      const m = msg as { email?: string };
      setConnecting(false);
      setAuthUrl(null);
      toast.info(`Plaud connected${m.email ? ` as ${m.email}` : ''}.`);
      loadStatus();
    });
    const unsubFailed = subscribe('plaud:login_failed', (msg: unknown) => {
      const m = msg as { error?: string };
      setConnecting(false);
      setAuthUrl(null);
      toast.error(`Plaud connection failed: ${m.error ?? 'unknown error'}`);
      loadStatus();
    });
    const unsubDisconnected = subscribe('plaud:disconnected', () => {
      setAuthUrl(null);
      loadStatus();
    });
    return () => {
      unsubUrl();
      unsubConnected();
      unsubFailed();
      unsubDisconnected();
    };
  }, [subscribe, toast]);

  const handleConnect = async () => {
    setConnecting(true);
    setAuthUrl(null);
    const result = await api.connectPlaud();
    if (!result.ok) {
      setConnecting(false);
      toast.error(`Connect failed: ${result.error}`);
      return;
    }
    if (result.data?.status === 'already_in_progress') {
      toast.info('A Plaud login is already in progress.');
      loadStatus();
    }
    // Otherwise the WebSocket events (plaud:auth_url, plaud:connected,
    // plaud:login_failed) finish the job.
  };

  const handleCancel = async () => {
    const result = await api.cancelPlaudConnect();
    if (!result.ok) {
      // The sign-in is still running on the box: keep showing it.
      toast.error(`Cancel failed: ${result.error}`);
      loadStatus();
      return;
    }
    setConnecting(false);
    setAuthUrl(null);
    toast.info('Plaud connect cancelled.');
    loadStatus();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    const result = await api.disconnectPlaud();
    setDisconnecting(false);
    if (!result.ok) {
      toast.error(`Disconnect failed: ${result.error}`);
      return;
    }
    toast.info('Plaud disconnected.');
    loadStatus();
  };

  if (!status) {
    return (
      <div className="tile">
        <h3 className="scard__title">Plaud</h3>
        {loadError ? (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-ui/55">Could not load Plaud status: {loadError}</p>
            <button onClick={loadStatus} className="px-3 py-2 glass-btn text-sm rounded-lg transition-colors">Retry</button>
          </div>
        ) : null}
        {!loadError && <p className="text-xs text-ui/40 mt-2">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="tile space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="scard__title">Plaud</h3>
        {status.connected && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-cp-teal/20 text-cp-teal">Connected</span>
        )}
        {status.reauthRequired && !connecting && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-cp-amber/20 text-cp-amber">Login expired</span>
        )}
      </div>
      <p className="text-xs text-ui/40">
        Plaud captures meeting audio (device or app) and auto-generates transcripts and summaries. Connect to give your agents read access to recordings, transcripts, AI summaries, and signed audio download URLs.
      </p>

      {/* ── Disconnected / expired state ── */}
      {!status.connected && !connecting && (
          <PlaudDisconnectedPanel status={status} onConnect={handleConnect} />
      )}

      {/* ── Connecting state ── */}
      {connecting && (
        <div className="space-y-2">
          {authUrl ? (
            <>
              <div className="alert-banner alert-info text-xs">
                <p className="font-medium mb-1">Open this URL to sign in to Plaud:</p>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-cp-blue break-all"
                >
                  {authUrl}
                </a>
                <p className="mt-2 text-ui/55">
                  A browser may already have opened on the Mac that runs Dojo, finishing the
                  sign-in there works too. The dashboard will update automatically once you
                  complete it.
                </p>
              </div>
              <button
                onClick={handleCancel}
                className="px-3 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <p className="text-xs text-ui/55 italic">Starting Plaud login… waiting for the auth URL.</p>
          )}
        </div>
      )}

      {/* ── Connected state ── */}
      {status.connected && !connecting && (
        <>
          <div className="text-sm text-ui/80">
            Connected as <span className="font-medium">{status.email ?? '(unknown email)'}</span>
            {status.connectedAt && (
              <span className="text-xs text-ui/40 ml-2">
                since {formatDateShort(status.connectedAt)}
              </span>
            )}
          </div>
          <p className="text-xs text-ui/40">
            Available agent tools: <code>plaud_list_recordings</code>, <code>plaud_recent_recordings</code>, <code>plaud_search_recordings</code>, <code>plaud_get_recording</code>, <code>plaud_get_transcript</code>, <code>plaud_get_summary</code>, <code>plaud_get_audio_url</code>, <code>plaud_account_info</code>.
          </p>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-3 py-2 glass-btn text-sm rounded-lg transition-colors disabled:opacity-60"
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </>
      )}
    </div>
  );
};
