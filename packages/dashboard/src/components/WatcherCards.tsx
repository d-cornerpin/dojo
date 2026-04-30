// ════════════════════════════════════════
// Watcher Cards — surfaces Gmail / Outlook / Teams watcher health.
//
// Pre-2026-04-30 there was no surface for these watchers. A stuck OAuth
// token, a quietly-disabled service, or a silent poll failure left the
// user staring at an inbox with new emails their agents weren't seeing.
// This panel shows running/enabled/connected, last poll time/result,
// last error, and recent notifications — refreshed every 30s.
// ════════════════════════════════════════

import { useEffect, useState } from 'react';
import * as api from '../lib/api';

const REFRESH_INTERVAL_MS = 30_000;

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function indicatorColor(status: api.WatcherStatusDto): { color: string; label: string } {
  if (!status.enabled) return { color: 'bg-white/20', label: 'Disabled' };
  if (!status.connected) return { color: 'bg-cp-coral', label: 'Not connected' };
  if (!status.running) return { color: 'bg-cp-coral', label: 'Stopped' };
  if (status.consecutiveFailures >= 3) return { color: 'bg-cp-coral animate-pulse', label: `Failing (${status.consecutiveFailures} in a row)` };
  if (status.lastPollOk === false) return { color: 'bg-cp-amber', label: 'Last poll failed' };
  if (status.lastPollOk === true) return { color: 'bg-cp-teal animate-pulse', label: 'Healthy' };
  return { color: 'bg-cp-amber', label: 'Initializing' };
}

const WatcherCard = ({ status, label }: { status: api.WatcherStatusDto; label: string }) => {
  const ind = indicatorColor(status);
  const intervalMin = Math.round(status.pollIntervalMs / 60000);
  const intervalSec = Math.round(status.pollIntervalMs / 1000);
  const intervalLabel = intervalMin >= 1 ? `${intervalMin}m` : `${intervalSec}s`;

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${ind.color}`} />
          <span className="text-sm text-white/80 font-medium">{label}</span>
          <span className="text-xs text-white/40">{ind.label}</span>
        </div>
        <span className="text-[10px] text-white/30">poll every {intervalLabel}</span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40 mb-2">
        <span>Last poll: <span className="text-white/60">{relativeTime(status.lastPollAt)}</span></span>
        <span>Polls: <span className="text-white/60">{status.totalPolls}</span></span>
        <span>Notifications: <span className="text-white/60">{status.totalNotifications}</span></span>
        {status.lastNotifiedAt && (
          <span>Last delivery: <span className="text-white/60">{relativeTime(status.lastNotifiedAt)}</span></span>
        )}
      </div>

      {status.lastPollError && (
        <div className="mt-2 text-[11px] px-2 py-1.5 rounded bg-cp-coral/10 border border-cp-coral/20 text-cp-coral/90 break-words">
          <span className="font-medium">Last error:</span> {status.lastPollError}
        </div>
      )}

      {status.recentNotifications.length > 0 && (
        <details className="mt-2">
          <summary className="text-[11px] text-white/40 cursor-pointer hover:text-white/60 select-none">
            Recent {status.recentNotifications.length} notification{status.recentNotifications.length === 1 ? '' : 's'}
          </summary>
          <div className="mt-1.5 space-y-1">
            {status.recentNotifications.map((n, i) => (
              <div key={i} className="text-[11px] text-white/50 truncate">
                <span className="text-white/30">{relativeTime(n.at)}</span>
                {' · '}
                <span className="text-white/70">{n.from}</span>
                {' — '}
                <span>{n.subject}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

export const WatcherCards = () => {
  const [data, setData] = useState<api.WatchersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await api.getWatcherStatus();
      if (cancelled) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else {
        setError(r.error);
      }
    };
    load();
    const t = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Hide entirely if nothing is enabled (no Google or Microsoft).
  // Pre-2026-04-30 the user couldn't see whether watchers were running;
  // now showing this section only when at least one integration is in
  // play keeps the Health page tidy for users who don't use email.
  if (!data) {
    return error ? (
      <div className="text-xs text-cp-coral mb-6">Could not load watcher status: {error}</div>
    ) : null;
  }
  const anyEnabled = data.gmail.enabled || data.outlook.enabled || data.teams.enabled;
  if (!anyEnabled) return null;

  return (
    <div className="mb-6">
      <h3 className="card-header mb-3">Email & Teams Watchers</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {data.gmail.enabled && <WatcherCard status={data.gmail} label="Gmail" />}
        {data.outlook.enabled && <WatcherCard status={data.outlook} label="Outlook" />}
        {data.teams.enabled && <WatcherCard status={data.teams} label="Teams" />}
      </div>
    </div>
  );
};
