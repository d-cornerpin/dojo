import { useState, useRef, useEffect, useCallback, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PostMigrationCheck } from '@dojo/shared';
import { useWebSocket } from '../hooks/useWebSocket';
import type { ExportManifest } from './PostMigrationBanner';

// FENG-SHUI EXEMPTION: the migration flow uses standard Tailwind status colors
// (green/amber/red/blue) for universal success/warning/error/progress. Migration
// is explicitly exempt per FENG-SHUI-THEME-SPEC.md. Inputs/buttons stay themed.

type WizardStep = 'upload' | 'scan' | 'restore' | 'deps' | 'setup';
const STEP_ORDER: WizardStep[] = ['upload', 'scan', 'restore', 'deps', 'setup'];
const STEP_LABELS: Record<WizardStep, string> = {
  upload: 'Upload', scan: 'Scan', restore: 'Restore', deps: 'Dependencies', setup: 'Set up',
};

interface Props {
  /** OOBE (no-auth /api/setup/migration/*) vs authed Settings (/api/migration/*). */
  isOobe?: boolean;
  /** Render inside a centered modal (Settings) vs embedded in the page (OOBE). */
  asModal?: boolean;
  /** Jump straight to a step (e.g. 'setup' when resuming from the banner). */
  initialStep?: WizardStep;
  /** Called when the user finishes/closes after a successful import. */
  onComplete?: () => void;
  /** Called to dismiss the wizard without finishing (modal X / cancel). */
  onClose?: () => void;
}

interface Preflight {
  manifest: ExportManifest;
  integrityOk: boolean;
  passwordOk: boolean;
  diskOk: boolean;
  freeBytes: number | null;
}

const fmtBytes = (n: number | null | undefined): string => {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

export const ImportWizard = ({ isOobe = false, asModal = false, initialStep, onComplete, onClose }: Props) => {
  const apiBase = isOobe ? '/api/setup/migration' : '/api/migration';
  const { subscribe } = useWebSocket();

  const [step, setStep] = useState<WizardStep>(initialStep ?? 'upload');
  const [file, setFile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [password, setPassword] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // scan
  const [scanning, setScanning] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  // When the export carries a named Cloudflare tunnel, the user must confirm
  // they've turned it off on the OLD dojo before we proceed (two dojos can't
  // share one named tunnel + key).
  const [ackTunnel, setAckTunnel] = useState(false);

  // restore
  const [restoreProgress, setRestoreProgress] = useState<{ progress: number; message: string }>({ progress: 0, message: '' });
  const [restoring, setRestoring] = useState(false);

  // deps
  const [depRunning, setDepRunning] = useState(false);
  const [depLines, setDepLines] = useState<string[]>([]);
  const [depDone, setDepDone] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // setup / checks
  const [checks, setChecks] = useState<PostMigrationCheck[]>([]);
  const [markedDone, setMarkedDone] = useState<Set<string>>(new Set());
  const [busyCta, setBusyCta] = useState<string | null>(null);

  // Ollama model downloads — mirror OOBE: one at a time, poll byte progress,
  // surface the real error, retry per model.
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<{ completed: number; total: number; status: string } | null>(null);
  const [modelDone, setModelDone] = useState<Set<string>>(new Set());
  const [modelErr, setModelErr] = useState<Record<string, string>>({});
  const daemonStartedRef = useRef(false);

  const getHeaders = useCallback((): Record<string, string> => {
    const token = localStorage.getItem('dojo_token');
    const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };
  }, []);

  // Live WS wiring for the lifetime of the wizard.
  useEffect(() => {
    const unsubs = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe('migration:progress', (e: any) => {
        if (e.data) setRestoreProgress({ progress: e.data.progress, message: e.data.message });
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe('migration:depsetup', (e: any) => {
        const d = e.data || {};
        if (typeof d.line === 'string') setDepLines((prev) => [...prev.slice(-400), d.line]);
        if (d.done) { setDepRunning(false); setDepDone(true); }
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe('migration:checks', (e: any) => {
        if (e.data?.checks) setChecks(e.data.checks);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe]);

  // Resume case (opened straight at 'setup' from the banner): load the checks.
  useEffect(() => {
    if (step !== 'setup' || checks.length > 0) return;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/import/status`, { headers: getHeaders() });
        const data = await res.json();
        if (data.ok) setChecks(data.data.checks || []);
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // When deps finish, pull the latest checks and move to the guided step.
  useEffect(() => {
    if (!depDone) return;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/import/status`, { headers: getHeaders() });
        const data = await res.json();
        if (data.ok) setChecks(data.data.checks || []);
      } catch { /* checks also arrive via WS */ }
      setStep('setup');
    })();
  }, [depDone, apiBase, getHeaders]);

  // ── Step actions ──

  const handleFile = async (selected: File) => {
    setError(null); setManifest(null); setFile(selected);
    try {
      const res = await fetch(`${apiBase}/manifest`, {
        method: 'POST',
        headers: { ...getHeaders(), 'Content-Type': 'application/octet-stream' },
        body: selected,
      });
      const data = await res.json();
      if (data.ok) setManifest(data.data);
      else { setError(data.error || 'Invalid export file'); setFile(null); }
    } catch { setError('Failed to read export file'); setFile(null); }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith('.zip')) handleFile(f);
    else setError('Please drop a .zip file');
  };

  const runScan = async () => {
    if (!file) return;
    setStep('scan'); setScanning(true); setPreflight(null); setError(null);
    try {
      const res = await fetch(`${apiBase}/preflight`, {
        method: 'POST',
        headers: { ...getHeaders(), 'Content-Type': 'application/octet-stream', 'X-Export-Password': encodeURIComponent(password) },
        body: file,
      });
      const data = await res.json();
      if (data.ok) setPreflight(data.data);
      else setError(data.error || 'Scan failed');
    } catch (e) { setError(e instanceof Error ? e.message : 'Scan failed'); }
    finally { setScanning(false); }
  };

  const runRestore = useCallback(async () => {
    if (!file) return;
    setRestoring(true); setError(null);
    setRestoreProgress({ progress: 2, message: 'Starting…' });
    try {
      const res = await fetch(`${apiBase}/import`, {
        method: 'POST',
        headers: { ...getHeaders(), 'Content-Type': 'application/octet-stream', 'X-Export-Password': encodeURIComponent(password) },
        body: file,
      });
      const data = await res.json();
      if (data.ok) {
        setChecks(data.data.checks || []);
        setRestoreProgress({ progress: 100, message: 'Restored.' });
        setStep('deps');
      } else {
        setError(data.error || 'Import failed');
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setRestoring(false); }
  }, [file, password, apiBase, getHeaders]);

  const runDeps = useCallback(async () => {
    setDepRunning(true); setDepDone(false); setDepLines([]); setError(null);
    try {
      const res = await fetch(`${apiBase}/run-dependency-setup`, { method: 'POST', headers: { ...getHeaders(), 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!data.ok) { setError(data.error || 'Could not start the installer'); setDepRunning(false); setDepDone(true); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Installer failed to start'); setDepRunning(false); setDepDone(true); }
  }, [apiBase, getHeaders]);

  // Auto-run restore on entering the step; auto-run deps on entering that step.
  const restoreStartedRef = useRef(false);
  const depsStartedRef = useRef(false);
  useEffect(() => {
    if (step === 'restore' && !restoreStartedRef.current) { restoreStartedRef.current = true; void runRestore(); }
    if (step === 'deps' && !depsStartedRef.current) { depsStartedRef.current = true; void runDeps(); }
  }, [step, runRestore, runDeps]);

  const recheck = async () => {
    try {
      const res = await fetch(`${apiBase}/import/recheck`, { method: 'POST', headers: { ...getHeaders(), 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.ok) setChecks(data.data.checks || []);
    } catch { /* ignore */ }
  };

  const openSystemSettings = async (pane: string) => {
    setBusyCta(`sys-${pane}`);
    setError(null);
    try {
      const res = await fetch(`/api/setup/permissions/request/${pane}`, { method: 'POST', headers: { ...getHeaders(), 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({ ok: res.ok }));
      if (!data.ok) setError(data.error || `Couldn't open System Settings (${res.status}).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open System Settings.");
    } finally { setBusyCta(null); }
  };

  // Start an OAuth reconnect right here: POST /api/<provider>/connect → open the
  // returned authUrl so the user signs in (the redirect resolves on localhost).
  const reconnectOAuth = async (provider: string) => {
    setBusyCta(`oauth-${provider}`);
    setError(null);
    try {
      const res = await fetch(`/api/${provider}/connect?slot=agent`, {
        method: 'POST',
        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.ok && data.data?.authUrl) {
        window.open(data.data.authUrl, '_blank', 'width=600,height=700');
      } else {
        setError(data.error || 'Could not start the reconnect. If you just imported in first-run setup, finish entering the dojo, then reconnect from Settings.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the reconnect.');
    } finally {
      setBusyCta(null);
    }
  };

  const rerunInstaller = async () => {
    setStep('deps'); depsStartedRef.current = false;
  };

  // ── Ollama model downloads (mirror OOBE: stream progress, real errors, retry) ──
  // Poll byte progress while a pull is in flight.
  useEffect(() => {
    if (!pullingModel) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/setup/ollama/pull-progress', { headers: getHeaders() });
        const data = await res.json();
        if (data.ok && data.data && data.data.model === pullingModel) {
          setModelProgress({ completed: data.data.completed, total: data.data.total, status: data.data.status });
        }
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, [pullingModel, getHeaders]);

  const pullModel = useCallback(async (model: string) => {
    setModelErr((e) => { const n = { ...e }; delete n[model]; return n; });
    setPullingModel(model);
    setModelProgress({ completed: 0, total: 0, status: 'starting' });
    // brew install doesn't start the daemon — make sure it's up before the first pull.
    if (!daemonStartedRef.current) {
      daemonStartedRef.current = true;
      try { await fetch('/api/setup/deps/install/ollama-start', { method: 'POST', headers: { ...getHeaders(), 'Content-Type': 'application/json' } }); } catch { /* best effort */ }
    }
    try {
      const res = await fetch('/api/setup/ollama/pull', {
        method: 'POST',
        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (data.ok) setModelDone((d) => new Set(d).add(model));
      else setModelErr((e) => ({ ...e, [model]: data.error || 'Download failed' }));
    } catch (err) {
      setModelErr((e) => ({ ...e, [model]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPullingModel(null);
      setModelProgress(null);
    }
  }, [getHeaders]);

  const pullAllModels = useCallback(async (models: string[]) => {
    for (const m of models) {
      if (modelDone.has(m)) continue;
      await pullModel(m); // sequential — server tracks one pull at a time
    }
  }, [pullModel, modelDone]);

  // ── CTA renderer ──
  const renderCta = (chk: PostMigrationCheck) => {
    const cta = chk.cta;
    if (!cta) return null;
    if (cta.type === 'link') {
      // OOBE isn't authed yet, so settings links would bounce to login — show the
      // path as guidance instead; in the authed dashboard render a real link.
      return isOobe
        ? <span className="text-xs text-ui/40">After entering the dojo: {cta.label}</span>
        : <a href={cta.target} className="btn btn--primary text-xs">{cta.label}</a>;
    }
    if (cta.type === 'open_system_settings') {
      return <button onClick={() => openSystemSettings(cta.target || 'full_disk')} disabled={busyCta === `sys-${cta.target}`} className="btn btn--primary text-xs">{cta.label}</button>;
    }
    if (cta.type === 'reconnect_oauth') {
      const p = cta.target || 'google';
      return <button onClick={() => reconnectOAuth(p)} disabled={busyCta === `oauth-${p}`} className="btn btn--primary text-xs">{busyCta === `oauth-${p}` ? 'Opening…' : cta.label}</button>;
    }
    if (cta.type === 'run_installer') {
      return <button onClick={rerunInstaller} className="btn text-xs">{cta.label}</button>;
    }
    if (cta.type === 'recheck') {
      return <button onClick={recheck} className="btn text-xs">{cta.label}</button>;
    }
    return null;
  };

  // ── Derived ──
  // Scan passes when the archive is sound AND, if it carries a named Cloudflare
  // tunnel, the user has confirmed they turned it off on the old dojo.
  const tunnelAckNeeded = !!preflight?.manifest.contents.cloudflare_named_tunnel;
  const scanPass = !!preflight && preflight.integrityOk && preflight.passwordOk && preflight.diskOk
    && (!tunnelAckNeeded || ackTunnel);
  const actionCards = checks.filter((c) => c.category === 'action' && c.status !== 'ok' && !markedDone.has(c.id));
  const techniqueCards = checks.filter((c) => c.category === 'technique' && !markedDone.has(c.id));
  // Ollama models get their own section with download progress + retry — pull
  // them out of the generic automated list.
  const ollamaModels = checks.filter((c) => c.id.startsWith('ollama-model-'));
  const automated = checks.filter((c) => !c.id.startsWith('ollama-model-') && (c.category === 'automated' || (!c.category && c.status === 'ok')));
  const missingModels = ollamaModels.filter((m) => m.status !== 'ok' && !modelDone.has(m.label)).length;
  const remaining = actionCards.length + techniqueCards.length;

  // ── Step bodies ──
  const StatusRow = ({ ok, label, sub }: { ok: boolean | 'pending'; label: string; sub?: string }) => (
    <div className="flex items-start gap-3 py-1.5">
      <span className={`w-5 text-center shrink-0 ${ok === 'pending' ? 'text-blue-400 animate-pulse' : ok ? 'text-green-500' : 'text-red-400'}`}>
        {ok === 'pending' ? '⏳' : ok ? '✓' : '✗'}
      </span>
      <div className="min-w-0">
        <div className="text-sm text-ui/80">{label}</div>
        {sub && <div className="text-xs text-ui/40">{sub}</div>}
      </div>
    </div>
  );

  let body: React.ReactNode = null;

  if (step === 'upload') {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-ui/55">Move an entire dojo to this machine. Upload the <strong className="text-ui/80">dojo-export.zip</strong> you created on the other machine and enter its password.</p>
        {!file ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-ui/[0.10] hover:border-ui/[0.15]'}`}
          >
            <p className="text-ui/55 text-sm">Drag &amp; drop your <strong className="text-ui/70">dojo-export.zip</strong></p>
            <p className="text-ui/25 text-xs mt-1">or click to browse</p>
            <input ref={fileInputRef} type="file" accept=".zip" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        ) : (
          <div className="glass-nested rounded-lg p-3 flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-sm text-ui/80 truncate">{file.name}</div>
              <div className="text-xs text-ui/40">{fmtBytes(file.size)}{manifest ? ` · from ${manifest.exported_from.hostname}` : ' · reading…'}</div>
            </div>
            <button onClick={() => { setFile(null); setManifest(null); }} className="text-xs text-ui/40 hover:text-ui/70 shrink-0 ml-3">Change</button>
          </div>
        )}
        <div>
          <label className="block text-sm text-ui/70 mb-1">Export Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="The password set during export" className="glass-input" />
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    );
  } else if (step === 'scan') {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-ui/55">Checking the archive before anything is touched on this machine.</p>
        {scanning && <StatusRow ok="pending" label="Verifying archive integrity and password…" />}
        {preflight && (
          <div className="glass-nested rounded-lg p-3">
            <StatusRow ok={preflight.integrityOk} label="Archive integrity" sub={preflight.integrityOk ? 'Checksum verified' : 'Checksum mismatch — the file may be corrupted'} />
            <StatusRow ok={preflight.passwordOk} label="Password" sub={preflight.passwordOk ? 'Correct' : 'Wrong password for this archive'} />
            <StatusRow ok={preflight.diskOk} label="Disk space" sub={`${fmtBytes(preflight.freeBytes)} free · needs ~${fmtBytes(preflight.manifest.contents.database_size_bytes * 2)}`} />
          </div>
        )}
        {preflight && (
          <div className="glass-nested rounded-lg p-3 text-xs text-ui/55 space-y-1">
            <div className="text-ui/70 text-sm font-medium mb-1">This export contains</div>
            <div>{preflight.manifest.contents.agents_count} agents · {preflight.manifest.contents.techniques_count} techniques · {preflight.manifest.contents.vault_entries_count} vault entries</div>
            <div>Database {fmtBytes(preflight.manifest.contents.database_size_bytes)} · Providers: {preflight.manifest.contents.providers.join(', ') || 'none'}</div>
            {preflight.manifest.contents.google_workspace_connected && <div>Google Workspace: {preflight.manifest.contents.google_workspace_email}</div>}
            {preflight.manifest.contents.ollama_models.length > 0 && <div>Ollama models: {preflight.manifest.contents.ollama_models.join(', ')}</div>}
          </div>
        )}
        {preflight?.manifest.contents.cloudflare_named_tunnel && (
          <div className="text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-2">
            <p className="text-red-300 font-medium">⚠ Turn off the Cloudflare tunnel on your OLD dojo first</p>
            <p className="text-ui/70 text-xs">
              This export uses a <strong>named Cloudflare tunnel</strong>. A named tunnel can only run on one
              machine at a time — if the old dojo keeps tunneling with the same name and key, neither dojo will
              connect. On the old machine, go to <strong>Settings → Remote Access</strong> and turn the tunnel
              off before continuing here.
            </p>
            <label className="flex items-start gap-2 text-xs text-ui/80 cursor-pointer">
              <input type="checkbox" checked={ackTunnel} onChange={(e) => setAckTunnel(e.target.checked)} className="mt-0.5" />
              <span>I've disabled the Cloudflare tunnel on my old dojo.</span>
            </label>
          </div>
        )}
        {!isOobe && (
          <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/15 rounded-lg p-3">
            This replaces the current dojo on this machine. A timestamped backup of the current one is made automatically first.
          </div>
        )}
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    );
  } else if (step === 'restore') {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-ui/55">Restoring your dojo — database, files, credentials &amp; keys.</p>
        <div className="relative h-2 bg-ui/[0.12] rounded-full overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${Math.max(2, restoreProgress.progress)}%` }} />
        </div>
        <p className="text-sm text-ui/55 text-center">{restoreProgress.message || (restoring ? 'Working…' : '')}</p>
        {error && (
          <div className="space-y-2">
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={() => { restoreStartedRef.current = false; setStep('restore'); }} className="btn btn--primary text-xs">Retry</button>
          </div>
        )}
      </div>
    );
  } else if (step === 'deps') {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-ui/55">Installing everything your dojo needs — core tools (Ollama, cloudflared) and every technique's dependencies (brew, pip, npm, git). This can take a few minutes.</p>
        <div className="flex items-center gap-3">
          <span className={`w-5 text-center ${depDone ? 'text-green-500' : 'text-blue-400 animate-pulse'}`}>{depDone ? '✓' : '⏳'}</span>
          <span className="text-sm text-ui/70">{depDone ? 'Dependencies installed.' : 'Installing dependencies…'}</span>
          <button onClick={() => setShowLog((s) => !s)} className="text-xs text-ui/40 hover:text-ui/70 ml-auto">{showLog ? 'Hide log' : 'Show log'}</button>
        </div>
        {showLog && (
          <pre className="max-h-56 overflow-auto text-[11px] font-mono text-ui/55 bg-black/20 rounded-lg p-2 whitespace-pre-wrap">{depLines.join('\n') || 'Starting…'}</pre>
        )}
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    );
  } else { // setup
    body = (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ui/70">
            {remaining === 0 && missingModels === 0
              ? 'Your dojo is fully set up and matches the original.'
              : `${remaining} item${remaining === 1 ? '' : 's'} need your attention${missingModels ? `${remaining ? ', plus' : ''} ${missingModels} model${missingModels === 1 ? '' : 's'} to download` : ''}. Everything else is done.`}
          </p>
          <button onClick={recheck} className="btn text-xs shrink-0">Re-check</button>
        </div>

        {actionCards.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs uppercase tracking-wide text-ui/40">Needs you</h4>
            {actionCards.map((c) => (
              <div key={c.id} className="glass-nested rounded-lg p-3 flex items-start gap-3">
                <span className="text-amber-400 mt-0.5">{'⚠️'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ui/80">{c.label}</div>
                  {c.detail && <div className="text-xs text-ui/45 mt-0.5">{c.detail}</div>}
                </div>
                <div className="shrink-0">{renderCta(c)}</div>
              </div>
            ))}
          </div>
        )}

        {techniqueCards.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs uppercase tracking-wide text-ui/40">Technique setup</h4>
            {techniqueCards.map((c) => (
              <div key={c.id} className="glass-nested rounded-lg p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm text-ui/80 font-medium">{c.label}</div>
                  <button onClick={() => setMarkedDone((p) => new Set(p).add(c.id))} className="text-xs text-ui/40 hover:text-green-500 shrink-0">Mark done</button>
                </div>
                <div className="mt-2 space-y-1">
                  {(c.detailItems ?? []).map((it, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className={`shrink-0 ${it.kind === 'install' ? 'text-green-500' : 'text-ui/40'}`}>{it.kind === 'install' ? '✓' : '•'}</span>
                      <span className={it.kind === 'install' ? 'text-ui/45' : 'text-ui/70'}>
                        {it.kind === 'install' ? <>Auto-installed: <span className="font-mono">{it.text}</span></> : it.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {ollamaModels.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs uppercase tracking-wide text-ui/40">Local models</h4>
              {ollamaModels.some((m) => m.status !== 'ok' && !modelDone.has(m.label)) && (
                <button
                  onClick={() => pullAllModels(ollamaModels.filter((m) => m.status !== 'ok' && !modelDone.has(m.label)).map((m) => m.label))}
                  disabled={!!pullingModel}
                  className="btn btn--primary text-xs shrink-0 disabled:opacity-40"
                >
                  {pullingModel ? 'Downloading…' : 'Download all'}
                </button>
              )}
            </div>
            {ollamaModels.map((m) => {
              const name = m.label;
              const done = m.status === 'ok' || modelDone.has(name);
              const active = pullingModel === name;
              const err = modelErr[name];
              const pct = active && modelProgress && modelProgress.total > 0 ? Math.round((100 * modelProgress.completed) / modelProgress.total) : 0;
              return (
                <div key={m.id} className="glass-nested rounded-lg p-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span className={done ? 'text-green-500' : active ? 'text-blue-400 animate-pulse' : err ? 'text-red-400' : 'text-ui/40'}>
                      {done ? '✓' : active ? '⏳' : err ? '✗' : '•'}
                    </span>
                    <span className="font-mono text-ui/80">{name}</span>
                    <span className="ml-auto">
                      {done ? (
                        <span className="text-xs text-green-500">downloaded</span>
                      ) : active ? (
                        <span className="text-xs text-ui/45">
                          {fmtBytes(modelProgress?.completed)}{modelProgress && modelProgress.total > 0 ? ` / ${fmtBytes(modelProgress.total)}` : ''}
                        </span>
                      ) : (
                        <button onClick={() => pullModel(name)} disabled={!!pullingModel} className="btn text-xs disabled:opacity-40">
                          {err ? 'Retry' : 'Download'}
                        </button>
                      )}
                    </span>
                  </div>
                  {active && (
                    <div className="relative h-1.5 bg-ui/[0.12] rounded-full overflow-hidden mt-2">
                      <div className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all" style={{ width: `${Math.max(3, pct)}%` }} />
                    </div>
                  )}
                  {err && !active && <div className="text-xs text-red-400/80 mt-1 break-words">{err}</div>}
                </div>
              );
            })}
          </div>
        )}

        <details className="glass-nested rounded-lg p-3">
          <summary className="text-xs uppercase tracking-wide text-ui/40 cursor-pointer">What migrated automatically ({automated.length})</summary>
          <div className="mt-2 space-y-1">
            {automated.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-xs">
                <span className={c.status === 'ok' ? 'text-green-500' : c.status === 'in_progress' ? 'text-blue-400 animate-pulse' : 'text-amber-400'}>
                  {c.status === 'ok' ? '✓' : c.status === 'in_progress' ? '⏳' : '⚠️'}
                </span>
                <span className="text-ui/55">{c.label}</span>
                {c.status !== 'ok' && c.cta && <span className="ml-auto">{renderCta(c)}</span>}
              </div>
            ))}
          </div>
        </details>
      </div>
    );
  }

  // ── Footer nav ──
  const idx = STEP_ORDER.indexOf(step);
  const canNext =
    step === 'upload' ? !!file && !!manifest && password.length >= 8 :
    step === 'scan' ? scanPass :
    false;

  const footer = (
    <div className="flex items-center justify-between pt-2">
      <button
        onClick={onClose}
        className="btn text-xs disabled:opacity-30"
      >
        {step === 'setup' ? 'Close' : 'Cancel'}
      </button>
      <div className="flex items-center gap-2">
        {step === 'upload' && <button onClick={runScan} disabled={!canNext} className="btn btn--primary disabled:opacity-30 disabled:cursor-not-allowed">Scan</button>}
        {step === 'scan' && <button onClick={() => setStep('restore')} disabled={!canNext} className="btn btn--primary disabled:opacity-30 disabled:cursor-not-allowed">Import</button>}
        {step === 'setup' && <button onClick={() => onComplete?.()} className="btn btn--primary">{isOobe ? 'Enter the Dojo' : 'Done'}</button>}
      </div>
    </div>
  );

  const stepper = (
    <div className="flex items-center gap-1.5 mb-4">
      {STEP_ORDER.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${i < idx ? 'bg-green-500/15 text-green-500' : i === idx ? 'bg-blue-500/15 text-blue-400' : 'bg-ui/[0.06] text-ui/35'}`}>
            {i < idx ? '✓' : i + 1} {STEP_LABELS[s]}
          </span>
        </div>
      ))}
    </div>
  );

  const content = (
    <div className="space-y-1">
      <h3 className="text-base font-bold text-ui mb-3">Import a Dojo</h3>
      {stepper}
      {body}
      {footer}
    </div>
  );

  if (!asModal) return content;

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
      <div className="glass-modal-bg rounded-xl p-6 max-w-2xl w-full max-h-[88vh] overflow-y-auto">
        {content}
      </div>
    </div>,
    document.querySelector('.dojo3-stage') ?? document.body,
  );
};
