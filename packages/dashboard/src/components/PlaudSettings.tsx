import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';

// Plaud is a meeting-recording / AI-summary service. Single account per
// Dojo install (no slot model). Auth flow is interactive:
//   1. Click Connect → backend spawns `plaud login` subprocess
//   2. CLI emits an OAuth URL → backend broadcasts as `plaud:auth_url`
//   3. User clicks URL, signs in, browser callback completes the dance
//   4. CLI subprocess exits 0 → backend broadcasts `plaud:connected`
//      (or `plaud:login_failed` on non-zero exit)
//
// Once connected, agents see plaud_* tools the next time their tool
// surface is assembled. The CLI owns ~/.plaud/tokens.json and refreshes
// silently after that.

export const PlaudSettings = () => {
  const [status, setStatus] = useState<api.PlaudStatus | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const toast = useToast();
  const { subscribe } = useWebSocket();
  const loadedRef = useRef(false);

  const loadStatus = async () => {
    const result = await api.getPlaudStatus();
    if (result.ok) {
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

  // Listen for Plaud auth events via the WebSocket event-bus.
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
    // Otherwise wait for the WebSocket events (plaud:auth_url, then
    // plaud:connected or plaud:login_failed).
  };

  const handleCancel = async () => {
    await api.cancelPlaudConnect();
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
      <div className="glass-card p-4">
        <h3 className="card-header">Plaud</h3>
        <p className="text-xs text-ui/40 mt-2">Loading…</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="card-header">Plaud</h3>
        {status.connected && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-cp-teal/20 text-cp-teal">Connected</span>
        )}
      </div>
      <p className="text-xs text-ui/40">
        Plaud captures meeting audio (device or app) and auto-generates transcripts and summaries. Connect to give your agents read access to recordings, transcripts, AI summaries, and signed audio download URLs.
      </p>

      {/* ── Disconnected state ── */}
      {!status.connected && !connecting && (
        <>
          <button
            onClick={handleConnect}
            className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
          >
            Connect Plaud
          </button>
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
                  The dashboard will update automatically once you complete the sign-in.
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
                since {new Date(status.connectedAt).toLocaleDateString()}
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
