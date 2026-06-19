// ════════════════════════════════════════
// Watcher Cards: surfaces Gmail / Outlook / Teams watcher health.
//
// Pre-2026-04-30 there was no surface for these watchers. A stuck OAuth
// token, a quietly-disabled service, or a silent poll failure left the
// user staring at an inbox with new emails their agents weren't seeing.
// This panel shows running/enabled/connected, last poll time/result,
// last error, and recent notifications, refreshed every 30s.
//
// Rebuilt onto the dojo3 panel primitives (.group / .cards / .tile +
// .tech__head + .rows). The status indicator maps onto a pill variant
// (ok / down / draft) so the same health semantics carry through.
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

type PillVariant = 'pill--ok' | 'pill--down' | 'pill--draft';

function statusInfo(status: api.WatcherStatusDto): { variant: PillVariant; label: string } {
  if (!status.enabled) return { variant: 'pill--draft', label: 'Disabled' };
  if (!status.connected) return { variant: 'pill--down', label: 'Not connected' };
  if (!status.running) return { variant: 'pill--down', label: 'Stopped' };
  if (status.consecutiveFailures >= 3) return { variant: 'pill--down', label: `Failing (${status.consecutiveFailures})` };
  if (status.lastPollOk === false) return { variant: 'pill--draft', label: 'Last poll failed' };
  if (status.lastPollOk === true) return { variant: 'pill--ok', label: 'Healthy' };
  return { variant: 'pill--draft', label: 'Initializing' };
}

const WatcherCard = ({ status, label, ci }: { status: api.WatcherStatusDto; label: string; ci: number }) => {
  const info = statusInfo(status);
  const intervalMin = Math.round(status.pollIntervalMs / 60000);
  const intervalSec = Math.round(status.pollIntervalMs / 1000);
  const intervalLabel = intervalMin >= 1 ? `${intervalMin}m` : `${intervalSec}s`;
  const notifValue = status.lastNotifiedAt
    ? `${status.totalNotifications} · last ${relativeTime(status.lastNotifiedAt)}`
    : String(status.totalNotifications);

  return (
    <article className="tile anim" style={{ ['--ci' as string]: `${ci}ms` }}>
      <div className="tech__head">
        <div className="tech__title">{label}</div>
        <span className={`pill ${info.variant}`}><i className="dot" />{info.label}</span>
      </div>
      <div className="rows">
        <div>
          <span className="k">Last poll</span>
          <span className="v">{relativeTime(status.lastPollAt)} {'·'} every {intervalLabel}</span>
        </div>
        <div>
          <span className="k">Polls</span>
          <span className="v">{status.totalPolls.toLocaleString()}</span>
        </div>
        <div>
          <span className="k">Notifications</span>
          <span className="v">{notifValue}</span>
        </div>
      </div>

      {status.lastPollError && (
        <div className="rows" style={{ marginTop: 10 }}>
          <div>
            <span className="k" style={{ color: 'var(--dojo3-rust)' }}>Last error</span>
            <span className="v" style={{ color: 'var(--dojo3-rust)', maxWidth: '62%' }}>{status.lastPollError}</span>
          </div>
        </div>
      )}

      {status.recentNotifications.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="link" style={{ cursor: 'pointer' }}>
            Recent {status.recentNotifications.length} notification{status.recentNotifications.length === 1 ? '' : 's'}
          </summary>
          <div className="rows" style={{ marginTop: 8 }}>
            {status.recentNotifications.map((n, i) => (
              <div key={i}>
                <span className="k">{relativeTime(n.at)} {'·'} {n.from}</span>
                <span className="v">{n.subject}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </article>
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
      <section className="group">
        <div className="group__head"><div><div className="group__title">Email &amp; Teams Watchers</div></div></div>
        <div className="stub" style={{ marginTop: 14 }}>
          <p className="stub__line" style={{ color: 'var(--dojo3-rust)' }}>Could not load watcher status: {error}</p>
        </div>
      </section>
    ) : null;
  }
  const anyEnabled = data.gmail.enabled || data.outlook.enabled || data.teams.enabled;
  if (!anyEnabled) return null;

  return (
    <section className="group">
      <div className="group__head">
        <div><div className="group__title">Email &amp; Teams Watchers</div></div>
      </div>
      <div className="cards" style={{ marginTop: 14 }}>
        {data.gmail.enabled && <WatcherCard status={data.gmail} label="Gmail" ci={120} />}
        {data.outlook.enabled && <WatcherCard status={data.outlook} label="Outlook" ci={150} />}
        {data.teams.enabled && <WatcherCard status={data.teams} label="Teams" ci={180} />}
      </div>
    </section>
  );
};
