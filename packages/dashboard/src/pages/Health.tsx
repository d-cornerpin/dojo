import { useState, useEffect, useCallback } from 'react';
import type { HealthData, LogEntry } from '@dojo/shared';
import type { LogEntryEvent, WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatDate } from '../lib/dates';
import { ProviderHealth } from '../components/ProviderHealth';
import { HealerVitals } from '../components/HealerVitals';
import { WatcherCards } from '../components/WatcherCards';

// FA-DB2: the Health page has no server-pushed health feed. The old
// 'system:health' / 'provider:status' WS events were never emitted server-
// side, so a provider going unhealthy or the DB erroring would sit on the
// mount-time snapshot until a manual reload. We poll on this steady cadence
// instead (one interval, no per-event reload storm).
const HEALTH_POLL_INTERVAL_MS = 20_000;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const formatTimestamp = (ts: string | null): string => {
  if (!ts) return 'Never';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString();
};

const levelPill: Record<string, string> = {
  debug: 'pill--norm',
  info: 'pill--ok',
  warn: 'pill--draft',
  error: 'pill--down',
};

interface ProviderStatus {
  id: string;
  name: string;
  healthy: boolean;
  lastSuccess: string | null;
  errorCount: number;
}

interface WatchdogStatus {
  running: boolean;
  lastCheck: string | null;
  lastAlert: string | null;
}

interface IMBridgeStatus {
  enabled: boolean;
  connected: boolean;
  lastReceived: string | null;
  lastSent: string | null;
}

interface OllamaLockData {
  maxConcurrentModels: number;
  slots: Array<{ modelName: string; activeRequests: number }>;
  queuedRequests: number;
  queuedModels: string[];
}

interface ResourceData {
  memory: { used: number; total: number; free?: number; percentage: number };
  cpu: { usage?: number; loadAvg?: number[] };
  ollama: { running: boolean; models: string[] } | null;
  ollamaLock?: OllamaLockData;
}

const RemoteAccessCard = () => {
  const [tunnel, setTunnel] = useState<{ enabled: boolean; mode: string; status: string; url: string | null; startedAt: number | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('dojo_token');
    fetch('/api/system/tunnel', {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }).then(r => r.json()).then(data => {
      if (data.ok) setTunnel(data.data);
    }).catch(() => {});
  }, []);

  if (!tunnel || !tunnel.enabled) return null;

  const isActive = tunnel.status === 'active';
  const isStarting = tunnel.status === 'starting';
  const uptime = tunnel.startedAt ? Math.floor((Date.now() - tunnel.startedAt) / 60000) : 0;
  const statusLabel = isActive ? 'Active' : isStarting ? 'Starting' : 'Inactive';
  const tileClass = isActive ? 'tile tile--ok' : isStarting ? 'tile' : 'tile tile--down';
  const pillClass = isActive ? 'pill pill--ok' : isStarting ? 'pill pill--draft' : 'pill pill--down';

  const handleCopy = () => {
    if (!tunnel.url) return;
    navigator.clipboard.writeText(tunnel.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <section className="group">
      <div className="group__head">
        <div><div className="group__title">Remote Access</div></div>
      </div>
      <div className={`${tileClass} anim`} style={{ ['--ci' as string]: '120ms', marginTop: 14 }}>
        <div className="tech__head">
          <span className={pillClass}><i className="dot" />{statusLabel}</span>
          <span className="toolbar__label" style={{ paddingTop: 4 }}>
            {tunnel.mode === 'quick' ? 'Quick tunnel' : 'Named tunnel'}
          </span>
          <span className="toolbar__spacer" />
          {isActive && <span className="phead__meta">{uptime}m uptime</span>}
        </div>
        {tunnel.url && (
          <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 10 }}>
            <a className="mono-url" href={tunnel.url} target="_blank" rel="noreferrer">{tunnel.url}</a>
            <button type="button" className="link" onClick={handleCopy} style={{ flexShrink: 0 }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

const GoogleWorkspaceCard = () => {
  const [status, setStatus] = useState<{
    connected: boolean;
    email: string | null;
    services: Record<string, boolean>;
    lastActivity: string | null;
    todayActivity: { reads: number; writes: number };
  } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('dojo_token');
    fetch('/api/google/status', {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }).then(r => r.json()).then(data => {
      if (data.ok) setStatus(data.data);
    }).catch(() => {});
  }, []);

  if (!status || !status.connected) return null;

  const enabledServices = Object.entries(status.services)
    .filter(([, v]) => v)
    .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));

  return (
    <section className="group">
      <div className="group__head">
        <div><div className="group__title">Google Workspace</div></div>
      </div>
      <div className="tile tile--ok anim" style={{ ['--ci' as string]: '120ms', marginTop: 14 }}>
        <div className="tech__head">
          <span className="pill pill--ok"><i className="dot" />Connected</span>
          <span className="toolbar__spacer" />
          <span className="phead__meta">{status.email}</span>
        </div>
        <div className="tagrow">
          {enabledServices.map(svc => (
            <span key={svc} className="tag">{svc}</span>
          ))}
        </div>
        <div className="rows">
          <div>
            <span className="k">Today</span>
            <span className="v">{status.todayActivity.reads}R / {status.todayActivity.writes}W</span>
          </div>
          {status.lastActivity && (
            <div>
              <span className="k">Last activity</span>
              <span className="v">{new Date(status.lastActivity).toLocaleTimeString()}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export const Health = () => {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [componentFilter, setComponentFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [watchdog, setWatchdog] = useState<WatchdogStatus | null>(null);
  const [imBridge, setImBridge] = useState<IMBridgeStatus | null>(null);
  const [resources, setResources] = useState<ResourceData | null>(null);
  const [testMsg, setTestMsg] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const { subscribe } = useWebSocket();

  // Load initial data
  useEffect(() => {
    const load = async () => {
      let healthResult, logsResult, providerResult, watchdogResult, imResult, resourceResult;
      try {
        [healthResult, logsResult, providerResult, watchdogResult, imResult, resourceResult] =
          await Promise.all([
          api.getHealth(),
          api.getLogs(undefined, undefined, 100),
          api.getProviderHealth(),
          api.getWatchdogStatus(),
          api.getIMBridgeStatus(),
          api.getResources(),
        ]);

      if (healthResult?.ok) setHealth(healthResult.data);
      if (logsResult?.ok) setLogs(logsResult.data);
      // Provider health: API returns array directly or { providers: [] }
      if (providerResult?.ok) {
        const pd = providerResult.data as unknown;
        let providerList: ProviderStatus[] = [];
        if (Array.isArray(pd)) {
          providerList = pd;
        } else if (pd && typeof pd === 'object' && 'providers' in pd) {
          providerList = (pd as { providers: ProviderStatus[] }).providers ?? [];
        }
        // Ensure all fields have defaults
        setProviderStatuses(providerList.map(p => ({
          id: p.id ?? 'unknown',
          name: p.name ?? 'Unknown',
          healthy: p.healthy ?? true,
          lastSuccess: p.lastSuccess ?? null,
          errorCount: p.errorCount ?? 0,
        })));
      }
      // Watchdog: map field names
      if (watchdogResult?.ok) {
        const wd = watchdogResult.data as Record<string, unknown>;
        setWatchdog({
          running: wd.running as boolean,
          lastCheck: (wd.lastCheck ?? wd.lastHeartbeat ?? null) as string | null,
          lastAlert: (wd.lastAlert ?? null) as string | null,
        });
      }
      // iMessage: map field names
      if (imResult?.ok) {
        const im = imResult.data as Record<string, unknown>;
        setImBridge({
          enabled: (im.enabled ?? im.running ?? false) as boolean,
          connected: (im.connected ?? im.running ?? false) as boolean,
          lastReceived: (im.lastReceived ?? null) as string | null,
          lastSent: (im.lastSent ?? null) as string | null,
        });
      }
      if (resourceResult?.ok) setResources(resourceResult.data as ResourceData);
      } catch {
        // Initial load failed; the page renders with whatever data arrived
        // plus live websocket updates. Individual sections degrade gracefully.
      }
      setLoading(false);
    };
    load();
    // FA-DB2: re-run the same load() on a steady interval so provider/DB
    // status stays fresh while the page is mounted (replaces the dead WS
    // subscriptions removed below). One interval, cleaned up on unmount.
    const pollTimer = setInterval(load, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(pollTimer);
  }, []);

  // Subscribe to live log events
  useEffect(() => {
    const unsub = subscribe('log:entry', (event: WsEvent) => {
      const e = event as LogEntryEvent;
      setLogs((prev) => [...prev.slice(-199), e.entry]);
    });
    return unsub;
  }, [subscribe]);

  // FA-DB2: the former 'system:health' and 'provider:status' WS subscriptions
  // lived here. Neither event is ever emitted server-side, so they never fired
  // and the page silently showed a stale snapshot. They were removed and the
  // mount-effect poll above now keeps health + provider status fresh. (The
  // 'system:health' / 'provider:status' members of the shared WsEvent union are
  // now unreferenced; union cleanup is owned by FA-G6/FA-DB6, not this fix.)

  // Subscribe to resource warning events. Unlike the two removed above, this
  // one IS emitted server-side (resource-monitor), so it stays as a live push.
  useEffect(() => {
    const unsub = subscribe('resource:warning' as string, async () => {
      const result = await api.getResources();
      if (result.ok) setResources(result.data);
    });
    return unsub;
  }, [subscribe]);

  const refreshLogs = useCallback(async () => {
    const result = await api.getLogs(
      levelFilter || undefined,
      componentFilter || undefined,
      100,
    );
    if (result.ok) setLogs(result.data);
  }, [levelFilter, componentFilter]);

  // Refresh when filters change
  useEffect(() => {
    refreshLogs();
  }, [refreshLogs]);

  const filteredLogs = logs.filter((log) => {
    if (levelFilter && log.level !== levelFilter) return false;
    if (componentFilter && log.component !== componentFilter) return false;
    return true;
  });

  const components = Array.from(new Set(logs.map((l) => l.component))).sort();

  const handleSendTest = async () => {
    if (!testMsg.trim()) return;
    setSendingTest(true);
    await api.sendTestIMessage(testMsg.trim());
    setTestMsg('');
    setSendingTest(false);
  };

  if (loading) return <div className="stub"><p className="stub__line">Loading...</p></div>;

  const memUsedMb = resources ? resources.memory.used : health ? health.memory.used : null;
  const memTotalMb = resources ? resources.memory.total : health ? health.memory.total : null;
  const memPct = resources?.memory?.percentage
    ?? (health ? (health.memory.used / Math.max(health.memory.total, 1)) * 100 : 0);
  const cpuPct = resources?.cpu?.usage ?? null;

  // Overall posture for the header pill: down if DB is errored or any
  // provider is unhealthy, else nominal.
  const anyProviderDown = providerStatuses.some(p => !p.healthy);
  const dbDown = health?.db === 'error';
  const overallDown = dbDown || anyProviderDown;
  const overallLabel = overallDown
    ? (dbDown ? 'Database error' : 'Provider issue')
    : 'All systems nominal';

  return (
    <>
      {/* Header */}
      <header className="phead">
        <h2 className="phead__title">Vitals</h2>
        <span className="phead__meta">System health</span>
        <div className="phead__actions">
          <span className={`pill ${overallDown ? 'pill--down' : 'pill--ok'}`}>
            <i className="dot" />{overallLabel}
          </span>
        </div>
      </header>

      {/* Stat tiles */}
      <div className="stats">
        <div className="tile anim" style={{ ['--ci' as string]: '0ms' }}>
          <div className="stat__label">Uptime</div>
          <div className="stat__value">{health ? formatUptime(health.uptime) : '--'}</div>
        </div>
        <div className="tile anim" style={{ ['--ci' as string]: '30ms' }}>
          <div className="stat__label">Memory</div>
          <div className="stat__value">
            {memUsedMb != null && memTotalMb != null
              ? `${formatBytes(memUsedMb * 1024 * 1024)} / ${formatBytes(memTotalMb * 1024 * 1024)}`
              : '--'}
          </div>
        </div>
        <div className="tile anim" style={{ ['--ci' as string]: '60ms' }}>
          <div className="stat__label">Database</div>
          <div className={`stat__value ${health?.db === 'ok' ? 'is-ok' : ''}`}>
            {health?.db === 'ok' ? 'OK' : health ? 'Error' : '--'}
          </div>
        </div>
        <div className="tile anim" style={{ ['--ci' as string]: '90ms' }}>
          <div className="stat__label">Agents</div>
          <div className="stat__value">{health ? String(health.agents) : '--'}</div>
        </div>
      </div>

      {/* Healer Vitals (preserved) */}
      <HealerVitals />

      {/* Email & Teams Watchers */}
      <WatcherCards />

      {/* Resources */}
      <section className="group">
        <div className="group__head">
          <div><div className="group__title">Resources</div></div>
        </div>
        <div className="tile anim" style={{ ['--ci' as string]: '90ms', marginTop: 14 }}>
          <div className="rows" style={{ marginTop: 0 }}>
            <div>
              <span className="k">
                Memory{memUsedMb != null ? ` · ${formatBytes(memUsedMb * 1024 * 1024)} used` : ''}
              </span>
              <span className="v">
                {memTotalMb != null ? `${formatBytes(memTotalMb * 1024 * 1024)} total · ` : ''}{memPct.toFixed(0)}%
              </span>
            </div>
          </div>
          <div className="bar" style={{ margin: '9px 0 14px' }}>
            <i className="is-green" style={{ width: `${Math.min(100, Math.max(0, memPct))}%` }} />
          </div>

          {cpuPct != null && (
            <>
              <div className="rows" style={{ marginTop: 0 }}>
                <div>
                  <span className="k">CPU</span>
                  <span className="v">{cpuPct.toFixed(0)}%</span>
                </div>
              </div>
              <div className="bar" style={{ margin: '9px 0 14px' }}>
                <i className="is-blue" style={{ width: `${Math.min(100, Math.max(0, cpuPct))}%` }} />
              </div>
            </>
          )}

          {resources?.ollama && (
            <div className="rows" style={{ marginTop: 0 }}>
              <div>
                <span className="k">Ollama</span>
                <span className="v" style={{ color: resources.ollama.running ? 'var(--dojo3-green-ink)' : 'var(--dojo3-rust)' }}>
                  {resources.ollama.running ? 'Running' : 'Stopped'}
                  {resources.ollama.running && resources.ollama.models.length > 0
                    ? ` · ${resources.ollama.models.length} model${resources.ollama.models.length !== 1 ? 's' : ''} installed`
                    : ''}
                </span>
              </div>
              {resources.ollamaLock && resources.ollamaLock.slots.length > 0 && (
                <div>
                  <span className="k">Loaded</span>
                  <span className="v">
                    {resources.ollamaLock.slots.map(s => `${s.modelName} · ${s.activeRequests} active`).join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}

          {resources?.ollamaLock && resources.ollamaLock.queuedRequests > 0 && (
            <div className="note--warn" style={{ marginTop: 12, marginBottom: 0 }}>
              {resources.ollamaLock.queuedRequests} request{resources.ollamaLock.queuedRequests !== 1 ? 's' : ''} queued
              {resources.ollamaLock.queuedModels.length > 0 && <> for {resources.ollamaLock.queuedModels.join(', ')}</>}
              . Multiple local models in use, consider consolidating to one.
            </div>
          )}
        </div>
      </section>

      {/* Provider Health */}
      <section className="group">
        <div className="group__head">
          <div><div className="group__title">Provider Health</div></div>
        </div>
        <ProviderHealth providers={providerStatuses} />
      </section>

      {/* Remote Access */}
      <RemoteAccessCard />

      {/* Google Workspace (preserved) */}
      <GoogleWorkspaceCard />

      {/* Watchdog + iMessage status (preserved) */}
      <section className="group">
        <div className="group__head">
          <div><div className="group__title">Watchdog &amp; iMessage</div></div>
        </div>
        <div className="cards" style={{ marginTop: 14 }}>
          {/* Watchdog */}
          <article className="tile">
            <div className="tech__head">
              <div className="tech__title">Watchdog</div>
              {watchdog && (
                <span className={`pill ${watchdog.running ? 'pill--ok' : 'pill--down'}`}>
                  <i className="dot" />{watchdog.running ? 'Running' : 'Stopped'}
                </span>
              )}
            </div>
            {watchdog ? (
              <div className="rows">
                <div><span className="k">Last check</span><span className="v">{formatTimestamp(watchdog.lastCheck)}</span></div>
                <div><span className="k">Last alert</span><span className="v">{formatTimestamp(watchdog.lastAlert)}</span></div>
              </div>
            ) : (
              <div className="rows"><div><span className="k">Status</span><span className="v">Unavailable</span></div></div>
            )}
          </article>

          {/* iMessage bridge */}
          <article className="tile">
            <div className="tech__head">
              <div className="tech__title">iMessage Bridge</div>
              {imBridge && (
                <span className={`pill ${imBridge.connected ? 'pill--ok' : imBridge.enabled ? 'pill--draft' : 'pill--down'}`}>
                  <i className="dot" />{imBridge.connected ? 'Connected' : imBridge.enabled ? 'Disconnected' : 'Disabled'}
                </span>
              )}
            </div>
            {imBridge ? (
              <>
                <div className="rows">
                  <div><span className="k">Last received</span><span className="v">{formatTimestamp(imBridge.lastReceived)}</span></div>
                  <div><span className="k">Last sent</span><span className="v">{formatTimestamp(imBridge.lastSent)}</span></div>
                </div>
                {imBridge.enabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                    <input
                      type="text"
                      value={testMsg}
                      onChange={(e) => setTestMsg(e.target.value)}
                      placeholder="Test message..."
                      className="field"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={handleSendTest}
                      disabled={sendingTest || !testMsg.trim()}
                      className="btn btn--primary btn--sm"
                    >
                      {sendingTest ? '...' : 'Send'}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="rows"><div><span className="k">Status</span><span className="v">Unavailable</span></div></div>
            )}
          </article>
        </div>
      </section>

      {/* Logs (preserved) */}
      <section className="group">
        <div className="group__head">
          <div><div className="group__title">Logs</div></div>
          <div className="group__side">
            <span>{filteredLogs.length} entries</span>
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
          <span className="toolbar__label">Level</span>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="field field--select"
          >
            <option value="">All Levels</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <span className="toolbar__label">Component</span>
          <select
            value={componentFilter}
            onChange={(e) => setComponentFilter(e.target.value)}
            className="field field--select"
          >
            <option value="">All Components</option>
            {components.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="tile" style={{ marginTop: 14, padding: 0, overflow: 'hidden' }}>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {filteredLogs.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                <span className="phead__meta">No log entries</span>
              </div>
            ) : (
              filteredLogs.map((log, i) => (
                <LogRow key={`${log.timestamp}-${i}`} log={log} />
              ))
            )}
          </div>
        </div>
      </section>
    </>
  );
};

const LogRow = ({ log }: { log: LogEntry }) => {
  const [expanded, setExpanded] = useState(false);
  const hasMeta = log.meta && Object.keys(log.meta).length > 0;

  return (
    <div style={{ borderTop: '1px solid rgba(140,116,84,.14)' }}>
      <div
        onClick={() => hasMeta && setExpanded(!expanded)}
        style={{
          display: 'grid',
          gridTemplateColumns: '150px 64px 130px 1fr',
          gap: 12,
          alignItems: 'baseline',
          padding: '8px 16px',
          cursor: hasMeta ? 'pointer' : 'default',
        }}
      >
        <span className="v" style={{ maxWidth: 'none' }}>{formatDate(log.timestamp)}</span>
        <span className={`pill ${levelPill[log.level] ?? ''}`} style={{ justifySelf: 'start' }}>{log.level}</span>
        <span className="v" style={{ maxWidth: 'none' }}>{log.component}</span>
        <span className="k" style={{ color: 'var(--dojo3-ink-2)' }}>
          {log.message}
          {hasMeta && !expanded && <span className="phead__meta" style={{ marginLeft: 6 }}>[+]</span>}
        </span>
      </div>
      {expanded && hasMeta && (
        <pre
          style={{
            margin: 0,
            padding: '8px 16px 12px',
            font: '500 11px/1.5 var(--dojo3-font-mono)',
            color: 'var(--dojo3-ink-3)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 192,
            overflowY: 'auto',
          }}
        >
          {JSON.stringify(log.meta, null, 2)}
        </pre>
      )}
    </div>
  );
};
