// ── Settings → The Platform tab and the eight cards it stacks: server control, feng shui, orb quality,
// migration, remote access, Ollama, agent limits, search and the Agent SDK setup.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useTheme } from '../../themes';
import { MigrationExport } from '../MigrationExport';
import { ImportWizard } from '../ImportWizard';
import {
  getOrbQualityCached,
  refreshOrbQualityFromServer,
  setOrbQuality,
  type OrbQualityPref,
} from '../orb/orbQuality';


// ── Providers Tab ──

// ── Platform Tab ──

export const PlatformTab = () => {
  return (
    <div className="scards">
      <AgentLimitsSettings />
      <OllamaSettings />
      <RemoteAccessSettings />
      <SearchSettings />
      <MigrationSettings />
      <OrbQualitySettings />
      {/* Feng Shui (theme) card hidden per request; component kept for easy restore. */}
      {/* <FengShuiSettings /> */}
      <ServerControlSettings />
    </div>
  );
};

// ── Server Control (restart) ──
//
// Remote-admin escape valve. In production the DOJO server runs under
// launchd with KeepAlive=true, so exiting the process triggers a fresh
// start within seconds. In dev (tsx watch), there's no auto-restart -
// the confirm dialog warns about that case so the user doesn't end up
// staring at a dead server.
const ServerControlSettings = () => {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [backups, setBackups] = useState<api.ListPlatformBackupsResponse | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const load = async () => {
      setBackupsLoading(true);
      const result = await api.listPlatformBackups();
      if (result.ok) setBackups(result.data);
      setBackupsLoading(false);
    };
    load();
  }, []);

  const doRestart = async () => {
    setRestarting(true);
    const result = await api.restartServer();
    if (!result.ok) {
      toast.error(`Restart failed: ${result.error}`);
      setRestarting(false);
      setConfirming(false);
      return;
    }
    const mode = result.data?.mode ?? 'production';
    toast.info(
      mode === 'production'
        ? 'Restarting server. Reconnecting in a few seconds…'
        : 'Server exiting. Dev mode: re-run `npm run dev` to bring it back.',
    );
    // Leave the "restarting" overlay up; the WebSocket will drop and the
    // dashboard's reconnect logic will pick the server back up (in prod).
    // No setRestarting(false) — the page will reload itself on reconnect.
  };

  const doCleanup = async () => {
    setCleaning(true);
    const result = await api.cleanupPlatformBackups(1);
    if (!result.ok) {
      toast.error(`Cleanup failed to start: ${result.error}`);
      setCleaning(false);
      return;
    }
    const data = result.data;
    if (data?.status === 'noop') {
      toast.info(data.message);
      setCleaning(false);
      return;
    }
    toast.info(`Cleaning up ${data?.targetCount ?? '?'} backup(s) in the background. This can take a few minutes.`);

    // Poll the cleanup status endpoint every 5s until it finishes. The
    // request itself returns instantly so Cloudflare's 100s ceiling is
    // never a factor; the actual rm -rf runs server-side independently.
    const start = Date.now();
    const MAX_POLL_MS = 10 * 60 * 1000; // 10-minute ceiling on our patience
    while (Date.now() - start < MAX_POLL_MS) {
      await new Promise(r => setTimeout(r, 5000));
      const status = await api.getCleanupStatus();
      if (!status.ok) continue; // transient; keep polling
      const s = status.data;
      if (s && !s.inProgress) {
        if (s.error) {
          toast.error(`Cleanup failed: ${s.error}`);
        } else if (s.failedCount > 0) {
          toast.warning(`Cleanup partially complete: ${s.deletedCount} deleted, ${s.failedCount} failed. ${s.remainingOnDisk} backups still on disk.`);
        } else {
          toast.info(`Cleaned up ${s.deletedCount} backup(s). ${s.remainingOnDisk} kept.`);
        }
        const refresh = await api.listPlatformBackups();
        if (refresh.ok) setBackups(refresh.data);
        setCleaning(false);
        return;
      }
    }
    // Polling timeout (10 min) - tell the user the job is still running.
    toast.warning('Cleanup is taking longer than expected. It is still running in the background; refresh the page later to check.');
    setCleaning(false);
  };

  return (
    <div className="tile space-y-3">
      <div>
        <div className="scard__title">Server</div>
        <div className="scard__desc">
          Most settings on this tab hot-reload and do not need a restart. Use this if you've changed
          something deeper (model registry, OAuth config) that asked for a restart, or if the server
          looks stuck and you want to recycle it without SSHing to the host.
        </div>
      </div>

      {!confirming && !restarting && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="btn"
        >
          Restart server
        </button>
      )}

      {confirming && !restarting && (
        <div className="space-y-2">
          <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
            This exits the server process immediately. In production it auto-restarts via launchd
            within a few seconds. <strong>If you're running `npm run dev`</strong>, tsx watch will
            NOT bring it back — you'll need to re-run the command in your terminal.
          </div>
          <div className="srow">
            <button
              type="button"
              onClick={doRestart}
              className="btn btn--primary btn--sm"
            >
              Yes, restart now
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="px-3 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {restarting && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          Restarting server… the dashboard will reconnect automatically once it's back up.
        </div>
      )}

      {/* ── Platform backups cleanup ── */}
      <div className="pt-3 border-t border-ui/10 space-y-2">
        <div className="text-sm font-medium text-ui/80">Platform backups</div>
        <p className="text-xs text-ui/40">
          Each auto-update saves a copy of the previous platform under <code>~/.dojo/platform.backup-&lt;version&gt;</code> for rollback safety. Updates from v2.7.18+ auto-prune the oldest, keeping the most recent {backups?.keepDefault ?? 2}. Use this if older backups have piled up and you need disk space now.
        </p>
        {backupsLoading && <p className="text-xs text-ui/40 italic">Loading backups…</p>}
        {!backupsLoading && backups && (
          <>
            <p className="text-xs text-ui/55">
              {backups.count === 0
                ? 'No backups on disk.'
                : `${backups.count} backup(s) on disk.`}
            </p>
            {backups.count > 1 && (
              <button
                type="button"
                onClick={doCleanup}
                disabled={cleaning}
                className="btn btn--sm"
              >
                {cleaning ? 'Cleaning up…' : 'Clean up old backups (keep most recent 1)'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ── Feng Shui (Theme Picker) ──

const FengShuiSettings = () => {
  const { themeId, setTheme, themes } = useTheme();

  return (
    <div className="tile">
      <div className="scard__title">Feng Shui</div>
      <div className="scard__desc">
        Choose the visual theme for your Dojo.
      </div>

      {themes.map(theme => {
        const selected = themeId === theme.id;
        return (
          <div
            key={theme.id}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => setTheme(theme.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTheme(theme.id); } }}
            className={`radio-card ${selected ? 'is-selected' : ''}`}
          >
            <span className="radio-card__dot" />
            <div>
              <div className="radio-card__name">{theme.name}</div>
              <div className="radio-card__desc">{theme.description}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ── Orb (performance) ──

const ORB_QUALITY_OPTIONS: { id: OrbQualityPref; name: string; desc: string }[] = [
  { id: 'full', name: 'Full', desc: 'The standard animated glass orb.' },
  { id: 'lite', name: 'Lite', desc: 'Same orb at lower resolution and frame rate. Noticeably lighter on the GPU (a touch softer), good for thin laptops.' },
  { id: 'static', name: 'Static', desc: 'The orb, frozen. No animation and almost no power, but it still looks like the real orb and still shows task icons.' },
];

const OrbQualitySettings = () => {
  const [pref, setPref] = useState<OrbQualityPref>(() => getOrbQualityCached());

  useEffect(() => {
    let cancelled = false;
    void refreshOrbQualityFromServer().then((v) => { if (!cancelled) setPref(v); });
    return () => { cancelled = true; };
  }, []);

  const choose = (id: OrbQualityPref) => {
    setPref(id);
    setOrbQuality(id); // persists + applies live to any mounted orb
  };

  return (
    <div className="tile">
      <div className="scard__title">Orb</div>
      <div className="scard__desc">
        How much effort the animated orb spends rendering. Lower settings save power and run cooler on lightweight laptops.
      </div>
      {ORB_QUALITY_OPTIONS.map((opt) => {
        const selected = pref === opt.id;
        return (
          <div
            key={opt.id}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => choose(opt.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(opt.id); } }}
            className={`radio-card ${selected ? 'is-selected' : ''}`}
          >
            <span className="radio-card__dot" />
            <div>
              <div className="radio-card__name">{opt.name}</div>
              <div className="radio-card__desc">{opt.desc}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ── Migration (Export/Import) ──

const MigrationSettings = () => {
  const [showImport, setShowImport] = useState(false);

  return (
    <div className="tile">
      <div className="scard__title">Migration</div>
      <div className="scard__desc">
        Export your entire dojo to move it to another machine, or import from a previous export.
      </div>

      <div className="srow">
        <MigrationExport />
        <button type="button" onClick={() => setShowImport(true)} className="btn">
          Import Dojo
        </button>
      </div>

      {showImport && (
        <ImportWizard
          asModal
          onClose={() => setShowImport(false)}
          onComplete={() => window.location.reload()}
        />
      )}
    </div>
  );
};

// ── Remote Access (Cloudflare Tunnel) ──

type TunnelStatus = {
  enabled: boolean;
  mode: 'quick' | 'named';
  status: string;
  url: string | null;
  error: string | null;
  startedAt: number | null;
  cloudflaredInstalled: boolean;
};

const RemoteAccessSettings = () => {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'quick' | 'named'>('quick');
  const [token, setToken] = useState('');
  const [namedUrl, setNamedUrl] = useState('');
  const [acting, setActing] = useState(false);
  const [installing, setInstalling] = useState(false);

  const load = async () => {
    const result = await api.request<TunnelStatus>('/system/tunnel');
    setLoading(false);
    if (!result.ok) {
      // ⚠ THE DEFECT THIS REPLACES (BACKLOG line 31): the bare `fetch` here had
      // no `.catch` and `load` is called from an effect, so with no server the
      // rejection ESCAPED — and `status` stayed null, which this card draws as
      // "cloudflared is not installed". It told the owner a lie about his box
      // and offered him an install button for software he already has.
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setStatus(result.data);
    setMode(result.data.mode);
    // Pre-fill the named URL field from the saved value (when in named mode)
    // so the user can see what's stored without re-typing it.
    if (result.data.mode === 'named' && result.data.url && !namedUrl) {
      setNamedUrl(result.data.url);
    }
  };

  useEffect(() => { load(); }, []);

  // Poll while tunnel is starting
  useEffect(() => {
    if (status?.status !== 'starting') return;
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [status?.status]);

  const handleSaveNamedUrl = async () => {
    setActing(true);
    await api.request('/system/tunnel/named-url', {
      method: 'POST',
      body: JSON.stringify({ url: namedUrl.trim() || null }),
    });
    await load();
    setActing(false);
  };

  const handleEnable = async () => {
    setActing(true);
    if (mode === 'named' && token.trim()) {
      await api.request('/system/tunnel/token', {
        method: 'POST',
        body: JSON.stringify({
          token: token.trim(),
          // Send the URL alongside the token so it's persisted in the same call
          url: namedUrl.trim() || null,
        }),
      });
    }
    await api.request('/system/tunnel/enable', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    await load();
    setActing(false);
  };

  const handleDisable = async () => {
    setActing(true);
    await api.request('/system/tunnel/disable', { method: 'POST' });
    await load();
    setActing(false);
  };

  const handleInstall = async () => {
    setInstalling(true);
    await api.request('/system/tunnel/install-cloudflared', { method: 'POST' });
    await load();
    setInstalling(false);
  };

  const copyUrl = () => {
    if (status?.url) {
      navigator.clipboard.writeText(status.url);
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
                {status.url && <span className="link" onClick={copyUrl}>Copy</span>}
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

// ── Ollama Settings ──

const OllamaSettings = () => {
  const [maxConcurrent, setMaxConcurrent] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const load = async () => {
      const result = await api.getSetting('ollama_max_concurrent_models');
      if (result.ok && result.data.value) {
        setMaxConcurrent(result.data.value);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    await api.setSetting('ollama_max_concurrent_models', maxConcurrent);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;

  return (
    <div className="tile">
      <div className="scard__title">Ollama (Local Models)</div>
      <div className="scard__desc">
        Controls how many different Ollama models can be loaded in RAM simultaneously.
        Set to 1 for 16GB machines, 2+ if you have more RAM.
      </div>
      <label className="flabel">Max Concurrent Models</label>
      <div className="srow">
        <input
          type="number"
          min={1}
          max={8}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
          className="finput"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>
      <div className="fhelp">
        When agents use more local models than this limit, requests queue until the current model finishes.
        A 7B model uses ~4GB RAM, a 30B model uses ~16GB.
      </div>
    </div>
  );
};

// ── Agent Limits Settings ──

const AGENT_LIMIT_KEYS = [
  { key: 'spawn_max_concurrent', label: 'Max Concurrent Agents', description: 'Maximum number of non-terminated agents running at the same time', default: 5, min: 1, max: 50 },
  { key: 'spawn_max_children', label: 'Max Children Per Agent', description: 'Maximum sub-agents a single parent can have active at once', default: 3, min: 1, max: 20 },
  { key: 'spawn_max_depth', label: 'Max Spawn Depth', description: 'How many levels deep agents can spawn sub-agents (primary agent = depth 0)', default: 2, min: 1, max: 10 },
  { key: 'spawn_default_timeout', label: 'Default Timeout (seconds)', description: 'How long a temp agent runs before auto-terminating. 900 = 15 minutes.', default: 900, min: 60, max: 86400 },
];

const AgentLimitsSettings = () => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const load = async () => {
      const initial: Record<string, string> = {};
      for (const item of AGENT_LIMIT_KEYS) {
        const result = await api.getSetting(item.key);
        initial[item.key] = result.ok && result.data.value ? result.data.value : String(item.default);
      }
      setValues(initial);
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    for (const item of AGENT_LIMIT_KEYS) {
      const val = values[item.key];
      if (val !== undefined) {
        await api.setSetting(item.key, val);
      }
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;

  return (
    <div className="tile">
      <div className="scard__title">Dojo Capacity</div>
      <div className="scard__desc">
        Controls how many agents can run and how they are spawned. Changes take effect immediately.
      </div>
      <div className="fgrid">
        {AGENT_LIMIT_KEYS.map((item) => (
          <div key={item.key}>
            <label className="flabel">{item.label}</label>
            <input
              type="number"
              min={item.min}
              max={item.max}
              value={values[item.key] ?? item.default}
              onChange={(e) => setValues(prev => ({ ...prev, [item.key]: e.target.value }))}
              className="finput"
            />
            <div className="fhelp">{item.description}</div>
          </div>
        ))}
      </div>
      <div className="srow">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary"
        >
          {saving ? 'Saving...' : 'Save Limits'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>
    </div>
  );
};

// ── Search Settings ──

const SearchSettings = () => {
  const [provider, setProvider] = useState('brave');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'valid' | 'invalid' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const result = await api.getSearchConfig();
      if (result.ok) {
        setProvider(result.data.provider ?? 'brave');
        setHasKey(result.data.hasKey);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    setValidationResult(null);

    const result = await api.setSearchConfig(provider, apiKey.trim());
    if (result.ok) {
      setHasKey(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  const handleValidate = async () => {
    const keyToValidate = apiKey.trim() || undefined;
    if (!keyToValidate && !hasKey) {
      setError('Enter an API key first');
      return;
    }
    setValidating(true);
    setError(null);
    setValidationResult(null);

    // If user typed a new key, validate that; otherwise we can't validate without the key
    if (!keyToValidate) {
      setError('Enter an API key to validate');
      setValidating(false);
      return;
    }

    const result = await api.validateSearchKey(provider, keyToValidate);
    if (result.ok && result.data.valid) {
      setValidationResult('valid');
    } else {
      setValidationResult('invalid');
      setError(result.ok ? 'Key is invalid' : result.error);
    }
    setValidating(false);
  };

  if (loading) return null;

  return (
    <div className="tile">
      <div className="scard__title">Web Search Provider</div>
      <div className="scard__desc">
        Configure web search for the web_search tool.
      </div>

      <label className="flabel">Provider</label>
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        className="finput field--select"
        style={{ marginBottom: 14 }}
      >
        <option value="brave">Brave Search</option>
      </select>

      <label className="flabel">Brave Search API Key</label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={hasKey ? '••••••••••••••••' : 'Enter Brave Search API key'}
        aria-label="API key"
        className="finput"
      />
      <div className="fhelp" style={{ marginBottom: 14 }}>
        Brave Search has a free tier (2,000 queries/month).{' '}
        <a
          href="https://api-dashboard.search.brave.com/app/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          Get a key
        </a>{' '}
        · No account?{' '}
        <a
          href="https://api-dashboard.search.brave.com/register"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          Sign up
        </a>
      </div>

      {error && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          {error}
        </div>
      )}

      {validationResult === 'valid' && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          API key is valid
        </div>
      )}

      <div className="srow">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleValidate}
          disabled={validating || (!apiKey.trim() && !hasKey)}
          className="btn btn--sm"
        >
          {validating ? 'Validating...' : 'Validate'}
        </button>
        <span className="toolbar__spacer" />
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
        <span className={`pill ${hasKey ? 'pill--ok' : ''}`}>
          {hasKey ? 'Configured' : 'Not configured'}
        </span>
      </div>
    </div>
  );
};

// ── Agent SDK Setup (inline in provider form) ──

export const AgentSdkSetup = () => {
  const [status, setStatus] = useState<{ cliInstalled: boolean; version: string | null; packageAvailable: boolean } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [authResult, setAuthResult] = useState<{ authenticated: boolean; error?: string } | null>(null);

  useEffect(() => {
    api.request<{ cliInstalled: boolean; version: string | null; packageAvailable: boolean }>('/config/agent-sdk/status').then(res => {
      if (res.ok) setStatus(res.data);
    });
  }, []);

  const handleVerify = async () => {
    setVerifying(true);
    setAuthResult(null);
    const res = await api.request<{ authenticated: boolean; error?: string }>('/config/agent-sdk/verify', { method: 'POST' });
    if (res.ok) setAuthResult(res.data);
    setVerifying(false);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-ui/40">
        Use your Claude Pro or Max subscription through the Agent SDK. Requires two things: the Claude Code CLI installed, and a signed-in Claude account.{' '}
        <a
          href="https://claude.ai/upgrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cp-teal hover:text-cp-teal/80 underline"
        >
          Don't have Claude Pro? Sign up ↗
        </a>
      </p>

      <div className="space-y-2 text-xs">
        {/* Step 1: CLI installed */}
        <div className="flex items-center gap-2">
          <span className={status?.cliInstalled ? 'text-cp-teal' : 'text-cp-amber'}>
            {status?.cliInstalled ? '\u2713' : '1.'}
          </span>
          <span className="text-ui/55">
            {status?.cliInstalled
              ? `Claude Code CLI installed (${status.version})`
              : 'Install Claude Code CLI'}
          </span>
        </div>
        {!status?.cliInstalled && (
          <div className="text-ui/25 ml-5 space-y-1">
            <p>Run this in your terminal:</p>
            <code className="block bg-ui/[0.05] px-2 py-1 rounded text-[11px]">curl -fsSL https://claude.ai/install.sh | bash</code>
          </div>
        )}

        {/* Step 2: Signed in */}
        <div className="flex items-center gap-2">
          <span className={authResult?.authenticated ? 'text-cp-teal' : status?.cliInstalled ? 'text-cp-amber' : 'text-ui/25'}>
            {authResult?.authenticated ? '\u2713' : '2.'}
          </span>
          <span className={status?.cliInstalled ? 'text-ui/55' : 'text-ui/25'}>
            {authResult?.authenticated ? 'Signed in to Claude' : 'Sign in to your Claude account'}
          </span>
        </div>
        {status?.cliInstalled && !authResult?.authenticated && (
          <div className="text-ui/25 ml-5 space-y-1">
            <p>Run this in your terminal and sign in with your Claude Pro/Max account:</p>
            <code className="block bg-ui/[0.05] px-2 py-1 rounded text-[11px]">claude</code>
            <p>Then click Verify below.</p>
          </div>
        )}
      </div>

      {status?.cliInstalled && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleVerify}
            disabled={verifying}
            className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg transition-colors"
          >
            {verifying ? 'Verifying...' : 'Verify Connection'}
          </button>
          {authResult && !authResult.authenticated && (
            <span className="text-xs text-cp-coral">
              {authResult.error ?? 'Not authenticated. Run `claude` in your terminal and sign in.'}
            </span>
          )}
        </div>
      )}

      <div className="alert-banner alert-warning">
        <p className="text-[10px] text-cp-amber/70">
          Agent SDK subscription billing is subject to Anthropic's usage policies. If you experience issues, switch to API Key.
        </p>
      </div>
    </div>
  );
};
