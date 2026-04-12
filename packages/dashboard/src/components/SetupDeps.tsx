import { useState, useEffect, useCallback } from 'react';

// ════════════════════════════════════════
// Dependencies & Local Models — OOBE Step
// ════════════════════════════════════════

const API = '/api/setup';

type DepStatus = 'checking' | 'installed' | 'installing' | 'failed' | 'not-installed';

interface DepState {
  node: DepStatus;
  brew: DepStatus;
  ollama: DepStatus;
  ollamaRunning: boolean;
  cliclick: DepStatus;
  playwright: DepStatus;
  nomic: DepStatus;
  gws: DepStatus;
  gcloud: DepStatus;
}

interface OllamaModel {
  name: string;
  size: number;
  details?: { parameter_size?: string };
}

// ── Fetch helpers ──

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const resp = await fetch(url, opts);
    const json = await resp.json();
    if (json.ok) return { ok: true, data: json.data };
    return { ok: false, error: json.error ?? 'Unknown error' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Dep check item ──

const DepItem = ({ label, status, detail, error, onRetry }: {
  label: string;
  status: DepStatus;
  detail?: string;
  error?: string;
  onRetry?: () => void;
}) => {
  const icon = status === 'installed' ? '\u2705'
    : status === 'installing' ? '\u{1F504}'
    : status === 'checking' ? '\u23F3'
    : status === 'failed' ? '\u274C'
    : '\u2B1C';

  const color = status === 'installed' ? 'text-green-400'
    : status === 'installing' ? 'text-yellow-400'
    : status === 'checking' ? 'text-yellow-400'
    : status === 'failed' ? 'text-red-400'
    : 'white/40';

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`text-lg ${status === 'installing' ? 'animate-spin' : ''}`}>{icon}</span>
        <div className="min-w-0">
          <span className={`text-sm ${color}`}>{label}</span>
          {detail && <p className="text-[10px] white/30">{detail}</p>}
          {error && <p className="text-[10px] text-red-400/70">{error}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === 'installing' && (
          <span className="text-xs text-yellow-500 animate-pulse">Installing...</span>
        )}
        {status === 'checking' && (
          <span className="text-xs text-yellow-500 animate-pulse">Checking...</span>
        )}
        {(status === 'failed' || status === 'not-installed') && onRetry && (
          <button onClick={onRetry} className="px-2 py-1 text-xs bg-cp-amber/20 text-cp-amber hover:bg-cp-amber/30 rounded transition-colors">
            {status === 'failed' ? 'Retry' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
};

// ════════════════════════════════════════
// Main Component
// ════════════════════════════════════════

export const SetupDeps = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [deps, setDeps] = useState<DepState>({
    node: 'checking', brew: 'checking', ollama: 'checking',
    ollamaRunning: false, cliclick: 'checking', playwright: 'checking', nomic: 'checking', gws: 'checking', gcloud: 'checking',
  });
  const [depErrors, setDepErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<'deps' | 'models'>('deps');
  const [installedModels, setInstalledModels] = useState<OllamaModel[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<{ completed: number; total: number; status: string } | null>(null);
  const [manualModel, setManualModel] = useState('');
  const [configured, setConfigured] = useState(false);

  const [pullElapsed, setPullElapsed] = useState(0);

  // Required deps: all must be installed before proceeding
  // Also block Next while a model is downloading
  const requiredReady =
    !pulling &&
    deps.node === 'installed' &&
    deps.brew === 'installed' &&
    deps.ollama === 'installed' &&
    deps.ollamaRunning &&
    deps.nomic === 'installed' &&
    deps.gws === 'installed' &&
    deps.gcloud === 'installed';

  const allInstalling = [deps.ollama, deps.cliclick, deps.playwright, deps.nomic, deps.gws, deps.gcloud].some(s => s === 'installing');

  useEffect(() => {
    onReady?.(requiredReady);
  }, [requiredReady, onReady]);

  // ── Check deps (no auto-install) ──

  const checkDeps = useCallback(async () => {
    setDeps(d => ({ ...d, node: 'checking', brew: 'checking', ollama: 'checking', cliclick: 'checking', playwright: 'checking', nomic: 'checking', gws: 'checking', gcloud: 'checking' }));

    const result = await fetchJson<{
      node: { installed: boolean; version: string };
      brew: { installed: boolean };
      ollama: { installed: boolean; running: boolean };
      cliclick: { installed: boolean };
      playwright: { installed: boolean };
      nomic: { installed: boolean };
      gws: { installed: boolean };
      gcloud: { installed: boolean };
    }>(`${API}/deps/check`);

    if (!result.ok) return;
    const d = result.data;

    setDeps({
      node: d.node.installed ? 'installed' : 'not-installed',
      brew: d.brew.installed ? 'installed' : 'not-installed',
      ollama: d.ollama.installed ? 'installed' : 'not-installed',
      ollamaRunning: d.ollama.running,
      cliclick: d.cliclick.installed ? 'installed' : 'not-installed',
      playwright: d.playwright.installed ? 'installed' : 'not-installed',
      nomic: d.nomic.installed ? 'installed' : 'not-installed',
      gws: d.gws.installed ? 'installed' : 'not-installed',
      gcloud: d.gcloud.installed ? 'installed' : 'not-installed',
    });

    if (d.ollama.installed && d.nomic.installed) {
      setPhase('models');
      loadInstalledModels();
      // Auto-configure Ollama provider
      await fetchJson(`${API}/ollama/auto-configure`, { method: 'POST' });
      setConfigured(true);
    }

    return d;
  }, []);

  // ── Install a single dep ──

  const installDep = async (dep: string) => {
    setDeps(d => ({ ...d, [dep]: 'installing' }));
    setDepErrors(e => ({ ...e, [dep]: '' }));

    if (dep === 'ollama') {
      const r = await fetchJson(`${API}/deps/install/ollama`, { method: 'POST' });
      if (r.ok) {
        setDeps(d => ({ ...d, ollama: 'installed' }));
        // Also start Ollama
        await fetchJson(`${API}/deps/install/ollama-start`, { method: 'POST' });
        // Re-check to get running state
        const check = await fetchJson<{ ollama: { running: boolean } }>(`${API}/deps/check`);
        if (check.ok) setDeps(d => ({ ...d, ollamaRunning: check.data.ollama.running }));
      } else {
        setDeps(d => ({ ...d, ollama: 'failed' }));
        setDepErrors(e => ({ ...e, ollama: r.error }));
      }
    } else if (dep === 'cliclick') {
      const r = await fetchJson(`${API}/deps/install/cliclick`, { method: 'POST' });
      setDeps(d => ({ ...d, cliclick: r.ok ? 'installed' : 'failed' }));
      if (!r.ok) setDepErrors(e => ({ ...e, cliclick: r.error }));
    } else if (dep === 'playwright') {
      const r = await fetchJson(`${API}/deps/install/playwright`, { method: 'POST' });
      setDeps(d => ({ ...d, playwright: r.ok ? 'installed' : 'failed' }));
      if (!r.ok) setDepErrors(e => ({ ...e, playwright: r.error }));
    } else if (dep === 'gws') {
      const r = await fetchJson(`${API}/deps/install/gws`, { method: 'POST' });
      setDeps(d => ({ ...d, gws: r.ok ? 'installed' : 'failed' }));
      if (!r.ok) setDepErrors(e => ({ ...e, gws: r.error }));
    } else if (dep === 'gcloud') {
      const r = await fetchJson(`${API}/deps/install/gcloud`, { method: 'POST' });
      setDeps(d => ({ ...d, gcloud: r.ok ? 'installed' : 'failed' }));
      if (!r.ok) setDepErrors(e => ({ ...e, gcloud: r.error }));
    } else if (dep === 'nomic') {
      const r = await fetchJson(`${API}/ollama/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text' }),
      });
      if (r.ok) {
        setDeps(d => ({ ...d, nomic: 'installed' }));
        await fetchJson(`${API}/ollama/auto-configure`, { method: 'POST' });
        setConfigured(true);
      } else {
        setDeps(d => ({ ...d, nomic: 'failed' }));
        setDepErrors(e => ({ ...e, nomic: r.error }));
      }
    }
  };

  // ── Auto-install all missing on mount ──

  const installAllMissing = useCallback(async () => {
    const d = await checkDeps();
    if (!d) return;

    // Install missing deps sequentially
    if (!d.ollama.installed) {
      await installDep('ollama');
    } else if (d.ollama.installed && !d.ollama.running) {
      // Start Ollama if installed but not running
      setDeps(dd => ({ ...dd, ollama: 'installing' }));
      await fetchJson(`${API}/deps/install/ollama-start`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 3000));
      const check = await fetchJson<{ ollama: { running: boolean } }>(`${API}/deps/check`);
      if (check.ok) {
        setDeps(dd => ({ ...dd, ollama: 'installed', ollamaRunning: check.data.ollama.running }));
      }
    }

    if (!d.cliclick.installed) await installDep('cliclick');
    if (!d.playwright.installed) await installDep('playwright');
    if (!d.gws.installed) await installDep('gws');
    if (!d.gcloud.installed) await installDep('gcloud');

    // Re-check Ollama running state before pulling nomic
    const recheck = await fetchJson<{ ollama: { running: boolean }; nomic: { installed: boolean } }>(`${API}/deps/check`);
    if (recheck.ok) {
      setDeps(dd => ({ ...dd, ollamaRunning: recheck.data.ollama.running }));
      if (!recheck.data.nomic.installed && recheck.data.ollama.running) {
        await installDep('nomic');
      }
    }

    // Final check
    await checkDeps();
    setPhase('models');
    loadInstalledModels();
  }, []);

  useEffect(() => { installAllMissing(); }, []);

  // ── Load installed models ──

  const loadInstalledModels = async () => {
    const r = await fetchJson<OllamaModel[]>(`${API}/ollama/models`);
    if (r.ok) setInstalledModels(r.data);
  };

  // ── Pull progress via polling ──

  useEffect(() => {
    if (!pulling) { setPullElapsed(0); setPullProgress(null); return; }

    // Elapsed timer
    const timerInterval = setInterval(() => setPullElapsed(e => e + 1), 1000);

    // Poll progress every second
    const pollInterval = setInterval(async () => {
      try {
        const r = await fetchJson<{
          model: string;
          status: string;
          completed: number;
          total: number;
          layers: number;
          error: string | null;
        } | null>(`${API}/ollama/pull-progress`);
        if (r.ok && r.data && r.data.model === pulling) {
          setPullProgress({
            completed: r.data.completed,
            total: r.data.total,
            status: r.data.status,
          });
        }
      } catch { /* ignore poll errors */ }
    }, 1000);

    return () => {
      clearInterval(timerInterval);
      clearInterval(pollInterval);
    };
  }, [pulling]);

  const pullModel = async (model: string) => {
    setPulling(model);
    setPullError(null);
    setPullElapsed(0);
    setPullProgress(null);
    const r = await fetchJson(`${API}/ollama/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (r.ok) {
      await fetchJson(`${API}/ollama/auto-configure`, { method: 'POST' });
      setConfigured(true);
      await loadInstalledModels();
    } else {
      setPullError(r.error);
    }
    setPulling(null);
  };

  // ── Remove a model ──

  const removeModel = async (name: string) => {
    await fetchJson(`${API}/ollama/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadInstalledModels();
  };

  const hasFailed = [deps.ollama, deps.cliclick, deps.playwright, deps.nomic, deps.gws, deps.gcloud].some(s => s === 'failed');

  return (
    <div className="space-y-6">
      {/* Section 1: Dependencies */}
      <div>
        <h3 className="card-header mb-3">System Dependencies</h3>
        <div className="glass-nested rounded-xl p-4 divide-y divide-gray-700">
          <DepItem label="Node.js" status={deps.node} detail="Platform runtime" />
          <DepItem label="Homebrew" status={deps.brew} detail="macOS package manager" />
          <DepItem
            label="Ollama"
            status={deps.ollama}
            detail={deps.ollamaRunning ? 'Running' : deps.ollama === 'installed' ? 'Installed — starting...' : 'Local model runtime'}
            error={depErrors.ollama}
            onRetry={() => installDep('ollama')}
          />
          <DepItem
            label="cliclick"
            status={deps.cliclick}
            detail="Mouse & keyboard control"
            error={depErrors.cliclick}
            onRetry={() => installDep('cliclick')}
          />
          <DepItem
            label="Playwright Chromium"
            status={deps.playwright}
            detail="Headless browser for web browsing"
            error={depErrors.playwright}
            onRetry={() => installDep('playwright')}
          />
          <DepItem
            label="Google Workspace CLI"
            status={deps.gws}
            detail="Gmail, Calendar, Drive, Docs, Sheets, Slides"
            error={depErrors.gws}
            onRetry={() => installDep('gws')}
          />
          <DepItem
            label="Google Cloud SDK"
            status={deps.gcloud}
            detail="Required for Google Workspace authentication"
            error={depErrors.gcloud}
            onRetry={() => installDep('gcloud')}
          />
          <DepItem
            label="nomic-embed-text"
            status={deps.nomic}
            detail="Embedding model for semantic memory"
            error={depErrors.nomic}
            onRetry={deps.ollamaRunning ? () => installDep('nomic') : undefined}
          />
        </div>

        {/* Retry all / status bar */}
        {hasFailed && (
          <div className="mt-3 flex items-center justify-between px-1">
            <span className="text-xs text-red-400">Some dependencies failed to install</span>
            <button
              onClick={installAllMissing}
              disabled={allInstalling}
              className="px-3 py-1.5 text-xs glass-btn-blue rounded-lg transition-colors"
            >
              Retry All
            </button>
          </div>
        )}

        {allInstalling && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-cp-amber text-xs animate-pulse">
            Installing dependencies... This may take a few minutes.
          </div>
        )}

        {requiredReady && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-cp-teal/10 border border-cp-teal/20 text-cp-teal text-xs">
            All required dependencies are ready. You can proceed to the next step.
          </div>
        )}
      </div>

      {/* Section 2: Local Models (once Ollama is ready) */}
      {phase === 'models' && deps.ollamaRunning && deps.nomic === 'installed' && (
        <div>
          <h3 className="card-header mb-1">Choose a Local Model</h3>
          <p className="text-xs white/40 mb-3">
            A local model runs on your machine for free. It's used for lightweight tasks, as a fallback when API providers are down,
            and for system services. You can skip this if you only want to use API models.
          </p>

          {/* Recommended model */}
          <div className="glass-nested rounded-xl p-4 mb-3 border white/[0.08]">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-sm font-medium white/90">qwen3.5:9b</span>
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">Recommended</span>
                <p className="text-xs white/40 mt-1">Good balance of capability and speed for machines with 16GB+ RAM. Free, runs locally.</p>
              </div>
              {installedModels.some(m => m.name.includes('qwen3.5')) ? (
                <span className="text-xs text-green-400 shrink-0">{'\u2705'} Installed</span>
              ) : (
                <button
                  onClick={() => pullModel('qwen3.5:9b')}
                  disabled={pulling !== null}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg shrink-0 transition-colors ${
                    pulling === 'qwen3.5:9b' ? 'bg-yellow-600/20 text-yellow-400' : 'glass-btn-blue'
                  }`}
                >
                  {pulling === 'qwen3.5:9b' ? 'Downloading...' : 'Install'}
                </button>
              )}
            </div>
          </div>

          {/* Manual pull */}
          <div className="flex gap-2 mb-4">
            <input
              value={manualModel}
              onChange={(e) => setManualModel(e.target.value)}
              placeholder="Or type a model name (e.g., llama3.3, gemma3:4b)"
              className="glass-input flex-1"
            />
            <button
              onClick={() => { if (manualModel.trim()) pullModel(manualModel.trim()); }}
              disabled={!manualModel.trim() || pulling !== null}
              className="px-3 py-2 glass-btn-blue text-sm rounded-lg transition-colors shrink-0"
            >
              {pulling && pulling !== 'qwen3.5:9b' ? 'Pulling...' : 'Pull'}
            </button>
          </div>

          {pulling && (() => {
            const pct = pullProgress && pullProgress.total > 0
              ? Math.round((pullProgress.completed / pullProgress.total) * 100)
              : null;
            const downloadedMb = pullProgress ? Math.round(pullProgress.completed / (1024 * 1024)) : 0;
            const totalMb = pullProgress && pullProgress.total > 0 ? Math.round(pullProgress.total / (1024 * 1024)) : null;
            const speed = pullElapsed > 0 && downloadedMb > 0 ? (downloadedMb / pullElapsed).toFixed(1) : null;
            const statusText = pullProgress?.status ?? 'downloading';
            const isVerifying = statusText.includes('verifying') || statusText.includes('writing');

            return (
              <div className="alert-banner alert-warning mb-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="animate-spin">{'\u{1F504}'}</span>
                    <span>
                      {isVerifying ? 'Verifying' : 'Downloading'} {pulling}
                    </span>
                  </div>
                  <span className="text-yellow-400/60">
                    {Math.floor(pullElapsed / 60)}m {pullElapsed % 60}s
                  </span>
                </div>

                {/* Progress bar */}
                <div className="w-full h-2 rounded-full bg-white/[0.08] overflow-hidden mb-1.5">
                  <div
                    className="h-full rounded-full bg-yellow-500/60 transition-all duration-300"
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-[10px] text-yellow-400/50">
                  <span>
                    {pct !== null ? `${pct}%` : 'Starting...'}{' '}
                    {totalMb ? `— ${downloadedMb}MB / ${totalMb > 1024 ? `${(totalMb / 1024).toFixed(1)}GB` : `${totalMb}MB`}` : ''}
                  </span>
                  <span>
                    {speed ? `${speed} MB/s` : ''}
                  </span>
                </div>

                <p className="mt-1.5 text-[10px] text-yellow-400/40">
                  Do not navigate away — the download will stop.
                </p>
              </div>
            );
          })()}

          {pullError && (
            <div className="alert-banner alert-error mb-3">{pullError}</div>
          )}

          {/* Installed models */}
          {installedModels.length > 0 && (
            <div>
              <h4 className="text-xs font-medium white/55 mb-2">Installed Models</h4>
              <div className="glass-nested rounded-xl divide-y divide-gray-700">
                {installedModels.map((m) => {
                  const sizeMb = Math.round(m.size / (1024 * 1024));
                  const isEmbedding = m.name.includes('nomic-embed') || m.name.includes('embed');
                  return (
                    <div key={m.name} className="flex items-center justify-between px-4 py-2">
                      <div>
                        <span className="text-sm white/90">{m.name}</span>
                        <span className="text-xs white/30 ml-2">{sizeMb > 1024 ? `${(sizeMb / 1024).toFixed(1)}GB` : `${sizeMb}MB`}</span>
                        {isEmbedding && <span className="text-[10px] white/20 ml-2">(embedding model)</span>}
                      </div>
                      {!isEmbedding && (
                        <button onClick={() => removeModel(m.name)}
                          className="text-xs text-red-400 hover:text-red-300">Remove</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════
// Permissions Check — separate OOBE step
// ════════════════════════════════════════

export const SetupPermissions = () => {
  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(true);
  const [expandedHint, setExpandedHint] = useState<string | null>(null);

  const checkPermissions = async () => {
    setChecking(true);
    const r = await fetchJson<Record<string, string>>(`${API}/permissions/check`);
    if (r.ok) setPermissions(r.data);
    setChecking(false);
  };

  useEffect(() => { checkPermissions(); }, []);

  const openSettings = async (apiKey: string) => {
    await fetchJson(`${API}/permissions/request/${apiKey}`, { method: 'POST' });
    // Re-check after a delay (user needs time to toggle in System Settings)
    setTimeout(checkPermissions, 5000);
  };

  const permItems = [
    {
      key: 'screen_recording',
      apiKey: 'screen',
      label: 'Screen Recording',
      description: 'Allows agents to see your screen and take screenshots',
      hint: 'Click "Open Settings" first — this triggers macOS to add the process to the Screen Recording list. Look for "node" or "screencapture" and toggle it ON. If not listed, click "+", press Cmd+Shift+G, and type the path from running "which node" in Terminal.',
    },
    {
      key: 'accessibility',
      apiKey: 'accessibility',
      label: 'Accessibility',
      description: 'Allows agents to control mouse and keyboard',
      hint: 'System Settings → Privacy & Security → Accessibility. Click "+" and add /opt/homebrew/bin/cliclick (Apple Silicon) or /usr/local/bin/cliclick (Intel). If you can\'t find it, open Terminal and type: which cliclick — then add the path shown.',
    },
    {
      key: 'full_disk',
      apiKey: 'full-disk-access',
      label: 'Full Disk Access',
      description: 'Allows agents to read protected files like iMessage database',
      hint: 'Click "Open Settings" first — this triggers macOS to add "node" to the Full Disk Access list. Then look for "node" in the list and toggle it ON. If you don\'t see it, click "+", press Cmd+Shift+G, and type the path from running "which node" in Terminal. You may need to restart the DOJO server after granting this.',
    },
    {
      key: 'automation',
      apiKey: 'automation',
      label: 'Automation (AppleScript)',
      description: 'Allows iMessage sending and system automation',
      hint: 'This permission is granted automatically the first time DOJO tries to send an iMessage. If you see a macOS popup asking to allow automation, click "OK". You can also find it in System Settings → Privacy & Security → Automation → node.',
    },
  ];

  const allGranted = permItems.every(item => permissions[item.key] === 'granted');

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        These macOS permissions allow your agents to interact with your system. They're optional — you can grant them now or later in System Settings.
      </p>

      <p className="text-[10px] text-white/30">
        DOJO runs as a Node.js process, so permissions need to be granted to "node" (not Terminal). Each button opens the correct section of System Settings. Click "Help" for step-by-step instructions.
      </p>

      <div className="glass-nested rounded-xl p-4 divide-y divide-gray-700">
        {permItems.map((item) => {
          const status = permissions[item.key] ?? 'unknown';
          const icon = status === 'granted' ? '\u2705' : status === 'denied' ? '\u274C' : '\u2753';
          const isExpanded = expandedHint === item.key;

          return (
            <div key={item.key} className="py-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-lg">{icon}</span>
                  <div className="min-w-0">
                    <span className="text-sm white/80">{item.label}</span>
                    <p className="text-[10px] white/30">{item.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {status === 'granted' ? (
                    <span className="text-[10px] text-green-400">Granted</span>
                  ) : (
                    <>
                      <button
                        onClick={() => setExpandedHint(isExpanded ? null : item.key)}
                        className="text-[10px] text-white/30 hover:text-white/50 transition-colors"
                      >
                        {isExpanded ? 'Hide help' : 'Help'}
                      </button>
                      <button
                        onClick={() => openSettings(item.apiKey)}
                        className="px-2.5 py-1 text-xs bg-cp-amber/20 text-cp-amber hover:bg-cp-amber/30 rounded transition-colors"
                      >
                        Open Settings
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Expanded hint */}
              {isExpanded && status !== 'granted' && (
                <div className="mt-2 ml-9 px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10 text-[11px] text-blue-300/70 leading-relaxed">
                  {item.hint}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {checking && <p className="text-xs text-yellow-400 animate-pulse">Checking permissions...</p>}

      <div className="flex items-center justify-between">
        <button onClick={checkPermissions} className="text-xs text-blue-400 hover:text-blue-300">
          Re-check permissions
        </button>
        {allGranted && (
          <span className="text-xs text-green-400">All permissions granted</span>
        )}
      </div>
    </div>
  );
};
