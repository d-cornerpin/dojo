import { useState, useEffect } from 'react';
import * as api from '../lib/api';

// Tier-usage chart for the Router settings tab. Reuses the established Ledger
// (Costs) visual language: a .tabs/.tab period selector and .brow/.bar rows
// (max-relative widths), wrapped to match the sibling card-header sections.
// Data comes from GET /api/router/stats, which aggregates router_log (one row
// per auto-router decision) by tier.

type Period = '24h' | '7d' | '30d' | 'all';
const PERIODS: Period[] = ['24h', '7d', '30d', 'all'];

// Logical order light -> standard -> heavy.
const TIER_ORDER = ['light', 'standard', 'heavy'] as const;
const TIER_LABEL: Record<string, string> = { light: 'Light', standard: 'Standard', heavy: 'Heavy' };

// How the tier was chosen. Order from most to least preferred path.
const METHOD_ORDER = ['semantic', 'heuristic', 'fallback', 'structural', 'legacy'] as const;
const METHOD_LABEL: Record<string, string> = {
  semantic: 'Semantic',
  heuristic: 'Heuristic',
  fallback: 'Fallback',
  structural: 'Structural',
  legacy: 'Legacy',
};

interface RouterStats {
  totalDecisions: number;
  fallbackRate: number;
  byTier: Array<{ tierId: string; count: number }>;
  byMethod: Array<{ method: string; count: number }>;
  autoRouterEnabled: boolean;
}

export const RouterUsage = () => {
  const [period, setPeriod] = useState<Period>('7d');
  const [stats, setStats] = useState<RouterStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getRouterStats(period).then((res) => {
      if (!active) return;
      if (res.ok) setStats(res.data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [period]);

  const counts: Record<string, number> = {};
  for (const t of stats?.byTier ?? []) counts[t.tierId] = t.count;
  const total = TIER_ORDER.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
  const max = Math.max(...TIER_ORDER.map((id) => counts[id] ?? 0), 1);

  const methodCounts: Record<string, number> = {};
  for (const m of stats?.byMethod ?? []) methodCounts[m.method] = m.count;
  const methodKeys = METHOD_ORDER.filter((k) => (methodCounts[k] ?? 0) > 0);
  const methodMax = Math.max(...methodKeys.map((k) => methodCounts[k] ?? 0), 1);

  const autoRouterEnabled = stats?.autoRouterEnabled ?? false;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h3 className="card-header" style={{ marginBottom: 0 }}>Tier Usage</h3>
        <div className="tabs" role="tablist">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              className={`tab${period === p ? ' is-active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p === 'all' ? 'All' : p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="glass-card" style={{ padding: 16 }}>
        {loading ? (
          <p className="text-tertiary" style={{ fontSize: 12 }}>Loading...</p>
        ) : !autoRouterEnabled && total === 0 ? (
          <p className="text-tertiary" style={{ fontSize: 12 }}>
            Auto-router is not enabled for any agent. Set an agent's model to Auto to start routing by tier.
          </p>
        ) : total === 0 ? (
          <p className="text-tertiary" style={{ fontSize: 12 }}>
            No routing decisions recorded in this period yet. The chart fills in as the auto-router runs.
          </p>
        ) : (
          <>
            {TIER_ORDER.map((id) => {
              const value = counts[id] ?? 0;
              return (
                <div className="brow" key={id}>
                  <span className="brow__label" title={TIER_LABEL[id]}>{TIER_LABEL[id]}</span>
                  <span className="bar">
                    <i className="is-dim" style={{ width: `${Math.max((value / max) * 100, 1)}%` }} />
                  </span>
                  <span className="brow__val">{value.toLocaleString()}</span>
                </div>
              );
            })}

            {methodKeys.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="text-tertiary" style={{ fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  How tiers were chosen
                </div>
                {methodKeys.map((k) => {
                  const value = methodCounts[k] ?? 0;
                  return (
                    <div className="brow" key={k}>
                      <span className="brow__label" title={METHOD_LABEL[k]}>{METHOD_LABEL[k]}</span>
                      <span className="bar">
                        <i className="is-dim" style={{ width: `${Math.max((value / methodMax) * 100, 1)}%` }} />
                      </span>
                      <span className="brow__val">{value.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="text-tertiary" style={{ fontSize: 11, marginTop: 12 }}>
              {total.toLocaleString()} routing decision{total === 1 ? '' : 's'}
              {stats && stats.fallbackRate > 0 ? ` · ${Math.round(stats.fallbackRate * 100)}% fell back to another tier` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
