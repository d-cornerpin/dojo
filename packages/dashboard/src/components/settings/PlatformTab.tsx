// ── Settings → The Dojo tab: the seven cards it stacks: server control, orb quality, migration,
// remote access, Ollama, agent limits, search. Also exports AgentSdkSetup for the provider form.

import { useGuardedLoad } from '../../lib/load-guard';
import { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { RemoteAccessSettings } from './RemoteAccessSettings';
import { MigrationExport } from '../MigrationExport';
import { ImportWizard } from '../ImportWizard';
import { StandardModels } from './StandardModels';
import {
  getOrbQualityCached,
  refreshOrbQualityFromServer,
  setOrbQuality,
  type OrbQualityPref,
} from '../orb/orbQuality';


export const PlatformTab = () => {
  return (
    <div className="scards">
      <AgentLimitsSettings />
      <OllamaSettings />
      <RemoteAccessSettings />
      <SearchSettings />
      <MigrationSettings />
      <OrbQualitySettings />
      <ServerControlSettings />
    </div>
  );
};

// Remote-admin escape valve: in production launchd (KeepAlive=true) restarts the process
// within seconds; in dev (tsx watch) nothing restarts it, so the confirm dialog says so.
const ServerControlSettings = () => {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [backups, setBackups] = useState<api.ListPlatformBackupsResponse | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const toast = useToast();
  const keepCount = backups?.keepDefault ?? 2;   // the server's number; the label and the request share it

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
    // Leave the "restarting" overlay up; the reconnect logic reloads the page when the
    // server returns, so there is deliberately no setRestarting(false) here.
  };

  const doCleanup = async () => {
    setCleaning(true);
    const result = await api.cleanupPlatformBackups(keepCount);
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

    // Poll every 5s until the cleanup finishes: each request returns instantly, so
    // Cloudflare's 100s ceiling is never a factor and the rm -rf runs server-side.
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
            NOT bring it back, you'll need to re-run the command in your terminal.
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
            {backups.count > keepCount && (
              <button
                type="button"
                onClick={doCleanup}
                disabled={cleaning}
                className="btn btn--sm"
              >
                {cleaning ? 'Cleaning up…' : `Clean up old backups (keep most recent ${keepCount})`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

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

export const OllamaSettings = () => {
  const load = useGuardedLoad<string | null>('ollama_max_concurrent_models', async (key) => {
    const r = await api.getSetting(key);
    return r.ok ? { ok: true as const, data: r.data.value } : r;
  });
  if (load.status === 'loading') return <div className="tile loading-state">Loading...</div>;
  if (load.status === 'failed') {
    return (
      <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }} role="alert">
        Could not load the Ollama setting, so it can&apos;t be changed right now. Nothing has been changed.{' '}
        <button type="button" className="btn btn--ghost" onClick={load.reload}>Retry</button>
      </div>
    );
  }
  return <OllamaSettingsEditor initial={load.data} />;
};

const OllamaSettingsEditor = ({ initial }: { initial: string | null }) => {
  const [maxConcurrent, setMaxConcurrent] = useState(initial || '1');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    const res = await api.setSetting('ollama_max_concurrent_models', maxConcurrent);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError(res.error);
    }
    setSaving(false);
  };

  return (
    <div className="tile">
      <div className="scard__title">Ollama (Local Models)</div>
      <div className="scard__desc">
        How many different agent models each Ollama may keep loaded at once; an agent that needs another model waits its turn.
        The Dojo's own two models and the embedder always stay loaded beside them, and the Dojo sets Ollama's own limit to fit.
      </div>
      <StandardModels repair />
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
        {error && <span className="text-xs text-cp-coral">{error}</span>}
      </div>
      <div className="fhelp">
        When agents use more local models than this limit, requests queue until the current model finishes.
        A 7B model uses ~4GB RAM, a 30B model uses ~16GB.
      </div>
    </div>
  );
};

const AGENT_LIMIT_KEYS = [
  { key: 'spawn_max_children', label: 'Max Children Per Agent', description: 'Maximum sub-agents a single parent can have active at once', default: 3, min: 1, max: 20 },
  { key: 'spawn_max_depth', label: 'Max Spawn Depth', description: 'How many levels deep agents can spawn sub-agents (primary agent = depth 0)', default: 2, min: 1, max: 10 },
];

export const AgentLimitsSettings = () => {
  // Every limit is read before any is shown: a limit that failed to read must not appear as its
  // built-in default, because Save writes them all.
  const load = useGuardedLoad<Record<string, string>>('agent-limits', async () => {
    const initial: Record<string, string> = {};
    for (const item of AGENT_LIMIT_KEYS) {
      const result = await api.getSetting(item.key);
      if (!result.ok) return result;
      initial[item.key] = result.data.value ? result.data.value : String(item.default);
    }
    return { ok: true as const, data: initial };
  });
  if (load.status === 'loading') return <div className="tile loading-state">Loading...</div>;
  if (load.status === 'failed') {
    return (
      <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }} role="alert">
        Could not load the capacity limits, so it can&apos;t be changed right now. Nothing has been changed.{' '}
        <button type="button" className="btn btn--ghost" onClick={load.reload}>Retry</button>
      </div>
    );
  }
  return <AgentLimitsEditor initial={load.data ?? {}} />;
};

const AgentLimitsEditor = ({ initial }: { initial: Record<string, string> }) => {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    let failure: string | null = null;
    for (const item of AGENT_LIMIT_KEYS) {
      const val = values[item.key];
      if (val !== undefined) {
        const res = await api.setSetting(item.key, val);
        if (!res.ok) {
          failure = `${item.label}: ${res.error}`;
          break;
        }
      }
    }
    setSaved(failure === null);
    setError(failure);
    if (failure === null) setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

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
        {error && <span className="text-xs text-cp-coral">{error}</span>}
      </div>
    </div>
  );
};

export const SearchSettings = () => {
  const load = useGuardedLoad<{ provider?: string | null; hasKey: boolean }>('search-config', () => api.getSearchConfig());
  if (load.status === 'loading') return <div className="tile loading-state">Loading...</div>;
  if (load.status === 'failed') {
    return (
      <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }} role="alert">
        Could not load the search settings, so it can&apos;t be changed right now. Nothing has been changed.{' '}
        <button type="button" className="btn btn--ghost" onClick={load.reload}>Retry</button>
      </div>
    );
  }
  return <SearchSettingsEditor initial={load.data!} />;
};

const SearchSettingsEditor = ({ initial }: { initial: { provider?: string | null; hasKey: boolean } }) => {
  const [provider, setProvider] = useState(initial.provider ?? 'brave');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(initial.hasKey);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'valid' | 'invalid' | null>(null);
  const [error, setError] = useState<string | null>(null);

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
