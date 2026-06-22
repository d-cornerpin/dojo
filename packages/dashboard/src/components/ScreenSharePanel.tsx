import { useEffect, useState } from 'react';
import * as api from '../lib/api';

// Settings > Dojo > Screen Sharing. Disabled by default. Enable detects whether
// macOS Screen Sharing is already on (and never clobbers it), or runs the dojo-
// managed setup, which prompts for an admin password ON THE MAC. The dojo stores
// no password — when connecting, the user enters their Mac login as a second
// factor. Lives next to Remote Access.

export const ScreenShareSettings = () => {
  const [status, setStatus] = useState<api.ScreenShareStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const res = await api.getScreenShareStatus();
    if (res.ok) setStatus(res.data);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const onEnable = async () => {
    setBusy(true); setError(null);
    const res = await api.enableScreenShare();
    if (res.ok) {
      setStatus(res.data.status);
      if (res.data.state === 'error') setError(res.data.error ?? 'Something went wrong.');
    } else {
      setError('Enable failed.');
    }
    setBusy(false);
  };

  const onDisable = async () => {
    setBusy(true); setError(null);
    const res = await api.disableScreenShare();
    if (res.ok) {
      setStatus(res.data.status);
      if (!res.data.success && res.data.error) setError(res.data.error);
    } else {
      setError('Disable failed.');
    }
    setBusy(false);
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;

  const enabled = status?.enabled ?? false;

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">Screen Sharing</div>
        <div className="scard__desc">
          Let the agent show this Mac's screen in the canvas, and optionally take control, so it
          can ask you to click or approve something here while you're remote. When connecting,
          you enter the screen-sharing (VNC) password you set on this Mac — the dojo never stores it.
          Set that password in System Settings &gt; General &gt; Sharing &gt; Screen Sharing (i) &gt;
          Computer Settings &gt; "VNC viewers may control screen with password".
        </div>
      </div>

      {error && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>{error}</div>
      )}

      {enabled ? (
        <div className="glass-nested rounded-xl p-3 space-y-2">
          <div className="tech__head">
            <span className="pill pill--ok"><i className="dot" />Enabled</span>
            <span className="text-[10px] text-ui/25">
              {status?.managedByDojo ? 'dojo-managed' : 'using existing Screen Sharing'}
            </span>
            <span className="toolbar__spacer" />
            <span className="text-[10px] text-ui/25">{status?.running ? 'listening' : 'not listening'}</span>
          </div>
          <button type="button" onClick={onDisable} disabled={busy} className="btn btn--sm">
            {busy ? 'Working...' : 'Disable'}
          </button>
        </div>
      ) : (
        <div className="glass-nested rounded-xl p-3 space-y-2">
          <p className="text-xs text-ui/55">
            Enabling turns on macOS Screen Sharing. You'll need to be at this Mac to approve a
            one-time admin prompt (and possibly a Privacy approval in System Settings). Also set a
            VNC password (see above) — that's what you'll type to connect. After that, the agent can
            open the screen for you from anywhere.
          </p>
          <button type="button" onClick={onEnable} disabled={busy} className="btn btn--primary btn--sm">
            {busy ? 'Enabling...' : 'Enable'}
          </button>
        </div>
      )}
    </div>
  );
};
