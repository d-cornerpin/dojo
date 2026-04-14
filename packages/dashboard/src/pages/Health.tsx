import { useState, useEffect, useCallback } from 'react';
import type { HealthData, LogEntry } from '@dojo/shared';
import type { LogEntryEvent, WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatDate } from '../lib/dates';
import { PercentageBar } from '../components/CostCharts';
import { ProviderHealth } from '../components/ProviderHealth';
import { HealerVitals } from '../components/HealerVitals';

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

const levelColors: Record<string, string> = {
  debug: 'bg-white/[0.12] white/90',
  info: 'bg-cp-blue/30 text-cp-blue',
  warn: 'bg-cp-amber/30 text-cp-amber',
  error: 'bg-cp-coral/30 text-cp-coral',
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
  const uptime = tunnel.startedAt ? Math.floor((Date.now() - tunnel.startedAt) / 60000) : 0;

  return (
    <div className="mb-6">
      <h3 className="card-header mb-3">Remote Access</h3>
      <div className="glass-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-cp-teal animate-pulse' : tunnel.status === 'starting' ? 'bg-cp-amber animate-pulse' : 'bg-cp-coral'}`} />
            <span className="text-sm white/80">{isActive ? 'Active' : tunnel.status === 'starting' ? 'Starting...' : 'Inactive'}</span>
            <span className="text-xs white/30">{tunnel.mode === 'quick' ? 'Quick Tunnel' : 'Named Tunnel'}</span>
          </div>
          {isActive && <span className="text-xs white/30">{uptime}m uptime</span>}
        </div>
        {tunnel.url && (
          <div className="mt-2 text-xs font-mono text-cp-teal truncate">{tunnel.url}</div>
        )}
      </div>
    </div>
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
    <div className="mb-6">
      <h3 className="card-header mb-3">Google Workspace</h3>
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse" />
            <span className="text-sm white/80">Connected</span>
          </div>
          <span className="text-xs white/30">{status.email}</span>
        </div>
        <div className="flex flex-wrap gap-1 mb-2">
          {enabledServices.map(svc => (
            <span key={svc} className="text-[10px] px-1.5 py-0.5 rounded bg-cp-teal/10 text-cp-teal border border-cp-teal/20">{svc}</span>
          ))}
        </div>
        <div className="flex gap-4 text-xs white/30">
          <span>Today: {status.todayActivity.reads}R / {status.todayActivity.writes}W</span>
          {status.lastActivity && (
            <span>Last: {new Date(status.lastActivity).toLocaleTimeString()}</span>
          )}
        </div>
      </div>
    </div>
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
      } catch (err) {
        console.error('Health page load failed:', err);
      }
      setLoading(false);
    };
    load();
  }, []);

  // Subscribe to live log events
  useEffect(() => {
    const unsub = subscribe('log:entry', (event: WsEvent) => {
      const e = event as LogEntryEvent;
      setLogs((prev) => [...prev.slice(-199), e.entry]);
    });
    return unsub;
  }, [subscribe]);

  // Subscribe to health updates
  useEffect(() => {
    const unsub = subscribe('system:health', (event: WsEvent) => {
      const e = event as unknown as { type: string; data: HealthData };
      setHealth(e.data);
    });
    return unsub;
  }, [subscribe]);

  // Subscribe to provider status and resource warning events
  useEffect(() => {
    const unsub1 = subscribe('provider:status' as string, async () => {
      const result = await api.getProviderHealth();
      if (result.ok) setProviderStatuses(result.data.providers);
    });
    const unsub2 = subscribe('resource:warning' as string, async () => {
      const result = await api.getResources();
      if (result.ok) setResources(result.data);
    });
    return () => {
      unsub1();
      unsub2();
    };
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

  if (loading) return <div className="flex-1 loading-state">Loading...</div>;

  const memPct = resources?.memory?.percentage
    ?? (health ? (health.memory.used / Math.max(health.memory.total, 1)) * 100 : 0);

  return (
    <div className="flex-1 p-3 sm:p-6 flex flex-col min-h-0 overflow-y-auto">
      <h1 className="text-lg sm:text-xl font-bold text-white mb-4 sm:mb-6">System Health</h1>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-6">
        <StatCard
          label="Uptime"
          value={health ? formatUptime(health.uptime) : '--'}
        />
        <StatCard
          label="Memory"
          value={
            resources
              ? `${formatBytes(resources.memory.used * 1024 * 1024)} / ${formatBytes(resources.memory.total * 1024 * 1024)}`
              : health
                ? `${formatBytes(health.memory.used * 1024 * 1024)} / ${formatBytes(health.memory.total * 1024 * 1024)}`
                : '--'
          }
        />
        <StatCard
          label="Database"
          value={health?.db === 'ok' ? 'OK' : 'Error'}
          valueColor={health?.db === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}
        />
        <StatCard
          label="Agents"
          value={health ? String(health.agents) : '--'}
        />
      </div>

      {/* Healer Vitals */}
      <HealerVitals />

      {/* Memory gauge */}
      <div className="glass-card p-4 mb-6">
        <h3 className="card-header mb-3">Memory Usage</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs white/40">
            <span>
              {resources
                ? formatBytes(resources.memory.used * 1024 * 1024)
                : health
                  ? formatBytes(health.memory.used * 1024 * 1024)
                  : '--'}{' '}
              used
            </span>
            <span>
              {resources
                ? formatBytes(resources.memory.total * 1024 * 1024)
                : health
                  ? formatBytes(health.memory.total * 1024 * 1024)
                  : '--'}{' '}
              total
            </span>
          </div>
          <PercentageBar value={memPct} max={100} />
          {resources?.cpu?.usage != null && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs white/40 mb-1">
                <span>CPU Usage</span>
                <span>{resources.cpu.usage.toFixed(0)}%</span>
              </div>
              <PercentageBar value={resources.cpu.usage} max={100} color="#3b82f6" />
            </div>
          )}
          {resources?.ollama && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs white/40">Ollama:</span>
                <span className={`text-xs ${resources.ollama.running ? 'text-cp-teal' : 'text-cp-coral'}`}>
                  {resources.ollama.running ? 'Running' : 'Stopped'}
                </span>
                {resources.ollama.running && resources.ollama.models.length > 0 && (
                  <span className="text-xs white/30">
                    ({resources.ollama.models.length} model{resources.ollama.models.length !== 1 ? 's' : ''} installed)
                  </span>
                )}
              </div>
              {resources.ollamaLock && (
                <>
                  {resources.ollamaLock.slots.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs white/40">Loaded:</span>
                      {resources.ollamaLock.slots.map((s, i) => (
                        <span key={i} className="text-xs text-cp-teal">
                          {s.modelName} <span className="white/30">({s.activeRequests} active)</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {resources.ollamaLock.queuedRequests > 0 && (
                    <div className="text-xs px-2 py-1 rounded bg-cp-amber/10 border border-cp-amber/20 text-cp-amber">
                      {resources.ollamaLock.queuedRequests} request{resources.ollamaLock.queuedRequests !== 1 ? 's' : ''} queued
                      {resources.ollamaLock.queuedModels.length > 0 && (
                        <> for {resources.ollamaLock.queuedModels.join(', ')}</>
                      )}
                      {' '}&mdash; multiple local models in use, consider consolidating to one.
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Provider health */}
      <div className="mb-6">
        <h3 className="card-header mb-3">Provider Health</h3>
        <ProviderHealth providers={providerStatuses} />
      </div>

      {/* Remote Access */}
      <RemoteAccessCard />

      {/* Google Workspace */}
      <GoogleWorkspaceCard />

      {/* Watchdog + iMessage status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Watchdog */}
        <div className="glass-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="card-header">Watchdog</h3>
            {watchdog && (
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  watchdog.running
                    ? 'bg-cp-teal/10 text-cp-teal'
                    : 'bg-cp-coral/10 text-cp-coral'
                }`}
              >
                {watchdog.running ? 'Running' : 'Stopped'}
              </span>
            )}
          </div>
          {watchdog ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs white/40">Last check</span>
                <span className="text-xs white/55">{formatTimestamp(watchdog.lastCheck)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs white/40">Last alert</span>
                <span className="text-xs white/55">{formatTimestamp(watchdog.lastAlert)}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs white/30">Unable to fetch status</p>
          )}
        </div>

        {/* iMessage bridge */}
        <div className="glass-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="card-header">iMessage Bridge</h3>
            {imBridge && (
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  imBridge.connected
                    ? 'bg-cp-teal/10 text-cp-teal'
                    : imBridge.enabled
                      ? 'bg-cp-amber/10 text-cp-amber'
                      : 'bg-white/[0.04] white/55'
                }`}
              >
                {imBridge.connected ? 'Connected' : imBridge.enabled ? 'Disconnected' : 'Disabled'}
              </span>
            )}
          </div>
          {imBridge ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs white/40">Last received</span>
                <span className="text-xs white/55">{formatTimestamp(imBridge.lastReceived)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs white/40">Last sent</span>
                <span className="text-xs white/55">{formatTimestamp(imBridge.lastSent)}</span>
              </div>
              {imBridge.enabled && (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t white/[0.06]">
                  <input
                    type="text"
                    value={testMsg}
                    onChange={(e) => setTestMsg(e.target.value)}
                    placeholder="Test message..."
                    className="glass-input flex-1"
                  />
                  <button
                    onClick={handleSendTest}
                    disabled={sendingTest || !testMsg.trim()}
                    className="px-2 py-1 glass-btn-primary text-xs font-medium rounded transition-colors"
                  >
                    {sendingTest ? '...' : 'Send'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs white/30">Unable to fetch status</p>
          )}
        </div>
      </div>

      {/* Log Viewer */}
      <div className="flex-1 flex flex-col min-h-[1200px] glass-card overflow-hidden">
        {/* Log Filters */}
        <div className="flex items-center gap-3 px-4 py-3 border-b white/[0.06]">
          <span className="text-sm font-medium white/55">Logs</span>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="glass-select"
          >
            <option value="">All Levels</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <select
            value={componentFilter}
            onChange={(e) => setComponentFilter(e.target.value)}
            className="glass-select"
          >
            <option value="">All Components</option>
            {components.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="flex-1" />
          <span className="text-xs white/30">{filteredLogs.length} entries</span>
        </div>

        {/* Log Table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white/[0.04]">
              <tr className="text-left white/40 text-xs uppercase tracking-wider">
                <th className="px-4 py-2 w-40">Timestamp</th>
                <th className="px-4 py-2 w-20">Level</th>
                <th className="px-4 py-2 w-32">Component</th>
                <th className="px-4 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log, i) => (
                <LogRow key={`${log.timestamp}-${i}`} log={log} />
              ))}
              {filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center white/30 text-sm">
                    No log entries
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const LogRow = ({ log }: { log: LogEntry }) => {
  const [expanded, setExpanded] = useState(false);
  const hasMeta = log.meta && Object.keys(log.meta).length > 0;

  return (
    <>
      <tr
        className={`border-t white/[0.04] hover:white/[0.02] ${hasMeta ? 'cursor-pointer' : ''}`}
        onClick={() => hasMeta && setExpanded(!expanded)}
      >
        <td className="px-4 py-1.5 text-xs white/40 font-mono whitespace-nowrap">
          {formatDate(log.timestamp)}
        </td>
        <td className="px-4 py-1.5">
          <span className={`text-xs px-1.5 py-0.5 rounded ${levelColors[log.level] || 'bg-white/[0.08] white/70'}`}>
            {log.level}
          </span>
        </td>
        <td className="px-4 py-1.5 text-xs white/55 font-mono">
          {log.component}
        </td>
        <td className="px-4 py-1.5 text-xs white/70">
          <span className={expanded ? '' : 'line-clamp-2'}>
            {log.message}
          </span>
          {hasMeta && !expanded && (
            <span className="ml-1 white/30">[+]</span>
          )}
        </td>
      </tr>
      {expanded && hasMeta && (
        <tr className="border-t white/[0.06]/20">
          <td colSpan={4} className="px-4 py-2 white/[0.02]">
            <pre className="text-xs white/55 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {JSON.stringify(log.meta, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
};

const StatCard = ({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) => (
  <div className="glass-card p-4">
    <p className="text-xs white/40 uppercase tracking-wider mb-1">{label}</p>
    <p className={`text-lg font-semibold ${valueColor || 'text-white'}`}>{value}</p>
  </div>
);
