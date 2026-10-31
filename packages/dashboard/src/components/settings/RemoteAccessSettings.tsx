// ── Settings → Platform → the Remote Access card (Cloudflare Tunnel).

import { copyTextToClipboard } from '../../lib/clipboard';
import { useTunnel } from './useTunnel';

export const RemoteAccessSettings = () => {
  const {
    status, loading, loadError, mode, setMode, token, setToken, namedUrl, setNamedUrl,
    acting, installing, actionError, load,
    handleSaveNamedUrl, handleEnable, handleDisable, handleInstall,
  } = useTunnel();

  const copyUrl = () => {
    if (status?.url) {
      void copyTextToClipboard(status.url);
    }
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;

  const isActive = status?.status === 'active';
  const isStarting = status?.status === 'starting';

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">Remote Access</div>
        <div className="scard__desc">
          Access your dojo from anywhere via Cloudflare Tunnel.
        </div>
      </div>

      {/* Security warning */}
      {(isActive || isStarting) && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          Your dojo is accessible from the internet. Make sure you have a strong password set in Settings &gt; Security.
        </div>
      )}

      {loadError && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          Could not read the tunnel status: {loadError}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => { void load(); }}>Retry</button>
        </div>
      )}

      {actionError && (
        <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-xs text-cp-coral">
          {actionError}
        </div>
      )}

      {/* cloudflared not installed — only claimed when the status actually ARRIVED */}
      {status && !status.cloudflaredInstalled && (
        <div className="glass-nested rounded-xl p-3 space-y-2">
          <p className="text-xs text-ui/55">cloudflared is not installed.</p>
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="btn btn--primary btn--sm"
          >
            {installing ? 'Installing...' : 'Install cloudflared'}
          </button>
        </div>
      )}

      {/* Main toggle and config */}
      {status?.cloudflaredInstalled && (
        <>
          {/* Status display */}
          {isActive && (
            <div className="glass-nested rounded-xl p-3 space-y-2">
              <div className="tech__head">
                <span className="pill pill--ok"><i className="dot" />Tunnel active</span>
                {status.mode === 'quick' && <span className="text-[10px] text-ui/25">Quick Tunnel</span>}
                {status.mode === 'named' && <span className="text-[10px] text-ui/25">Named Tunnel</span>}
                <span className="toolbar__spacer" />
                {status.url && <button type="button" className="link" onClick={copyUrl}>Copy</button>}
              </div>
              {status.url && (
                <a href={status.url} target="_blank" rel="noopener noreferrer" className="mono-url" style={{ display: 'block', marginTop: 6 }}>{status.url}</a>
              )}
              {/* When in named mode and no URL saved yet, let the user add it
                  inline without disabling+re-enabling. The URL is what was
                  configured in Cloudflare's Published Application Routes. */}
              {status.mode === 'named' && !status.url && (
                <div className="space-y-1">
                  <p className="text-[10px] text-ui/40">Add the public URL you configured in Cloudflare so the dashboard and the agent can use it.</p>
                  <div className="srow">
                    <input
                      type="text"
                      value={namedUrl}
                      onChange={(e) => setNamedUrl(e.target.value)}
                      placeholder="https://dojo.example.com"
                      className="finput"
                      style={{ flex: 1, width: 'auto' }}
                    />
                    <button
                      type="button"
                      onClick={handleSaveNamedUrl}
                      disabled={acting || !namedUrl.trim()}
                      className="btn btn--primary btn--sm"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={handleDisable}
                disabled={acting}
                className="text-xs text-cp-coral hover:text-cp-coral/80 transition-colors"
              >
                {acting ? 'Stopping...' : 'Disable Remote Access'}
              </button>
            </div>
          )}

          {isStarting && (
            <div className="glass-nested rounded-xl p-3">
              <span className="pill pill--draft"><i className="dot" />Starting tunnel</span>
            </div>
          )}

          {status?.error && (
            <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-xs text-cp-coral">
              {status.error}
            </div>
          )}

          {/* Config (only show when not active) */}
          {!isActive && !isStarting && (
            <div className="space-y-3">
              {/* Mode selection */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tunnel-mode"
                    checked={mode === 'quick'}
                    onChange={() => setMode('quick')}
                    className="w-4 h-4"
                  />
                  <div>
                    <span className="text-xs text-ui/70 font-medium">Quick Tunnel</span>
                    <span className="text-[10px] text-ui/25 ml-1">(no account needed)</span>
                  </div>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tunnel-mode"
                    checked={mode === 'named'}
                    onChange={() => setMode('named')}
                    className="w-4 h-4"
                  />
                  <div>
                    <span className="text-xs text-ui/70 font-medium">Named Tunnel</span>
                    <span className="text-[10px] text-ui/25 ml-1">(persistent URL)</span>
                  </div>
                </label>
              </div>

              {mode === 'quick' && (
                <p className="text-[10px] text-ui/25">
                  Generates a random trycloudflare.com URL. No account needed. URL changes on restart.
                </p>
              )}

              {mode === 'named' && (
                <div className="space-y-2">
                  <p className="text-[10px] text-ui/40">
                    Requires a free Cloudflare account AND a domain on that account.{' '}
                    <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/" target="_blank" rel="noopener noreferrer" className="text-cp-blue hover:underline">
                      Cloudflare docs &rarr;
                    </a>
                  </p>
                  <div className="text-[10px] text-ui/40 font-medium pt-1">Phase 1 — Get the token</div>
                  <div className="text-[10px] text-ui/25 space-y-0.5">
                    <p>1. Sign in at <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" className="font-mono text-cp-blue hover:underline">one.dash.cloudflare.com</a> (NOT dash.cloudflare.com — that's a different product). First time only: pick a Team name when prompted.</p>
                    <p>2. Sidebar: <span className="font-mono">Networks &rarr; Connectors &rarr; Cloudflare Tunnels</span> &rarr; <span className="font-mono">Create a tunnel</span></p>
                    <p>3. Connector type: <span className="font-mono">Cloudflared</span>. Name it (e.g. <span className="font-mono">dojo</span>) &rarr; Save.</p>
                    <p>4. Cloudflare shows an install command. The token is the long <span className="font-mono">eyJ…</span> string after <span className="font-mono">service install</span>. Copy just that token (no spaces) and paste below.</p>
                  </div>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Cloudflare tunnel token (eyJ...)"
                    className="finput"
                  />
                  <div className="text-[10px] text-ui/40 font-medium pt-1">Phase 2 — Bind a URL (after the tunnel connects)</div>
                  <div className="text-[10px] text-ui/25 space-y-0.5">
                    <p>5. In Cloudflare, click into your tunnel &rarr; <span className="font-mono">Published application routes</span> tab &rarr; <span className="font-mono">Add a route</span></p>
                    <p>6. Subdomain: <span className="font-mono">dojo</span> (or anything). Domain: pick from the dropdown (one of your Cloudflare-managed domains). Service type: <span className="font-mono">HTTP</span> (NOT HTTPS). URL: <span className="font-mono">localhost:3001</span></p>
                    <p>7. Save. Your Dojo is now reachable at <span className="font-mono">https://subdomain.yourdomain.com</span>.</p>
                    <p>8. Paste that final URL below so the dashboard and the agent can show/use it.</p>
                  </div>
                  <input
                    type="text"
                    value={namedUrl}
                    onChange={(e) => setNamedUrl(e.target.value)}
                    placeholder="https://dojo.example.com"
                    className="finput"
                  />
                  <p className="text-[10px] text-ui/25">
                    No domain on Cloudflare yet? Add one at <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" className="font-mono text-cp-blue hover:underline">dash.cloudflare.com</a> &rarr; <span className="font-mono">+ Add &rarr; Existing domain</span> (free DNS transfer), or register one through Cloudflare Registrar (~$8–10/yr).
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={handleEnable}
                disabled={acting || (mode === 'named' && !token.trim())}
                className="btn btn--primary"
              >
                {acting ? 'Connecting...' : mode === 'named' ? 'Save & Connect' : 'Enable Remote Access'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
