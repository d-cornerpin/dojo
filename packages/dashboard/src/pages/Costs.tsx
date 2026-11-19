import { useState, useEffect, useCallback, useRef } from 'react';
import type { WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatDate } from '../lib/dates';
import { useGuardedLoad } from '../lib/load-guard';
import { formatUsd } from '../lib/money';

type Period = '24h' | '7d' | '30d' | 'all';

interface CostSummary {
  totalSpend: number;
  dailyAvg: number;
  byModel: Array<Record<string, unknown>>;
  byAgent: Array<Record<string, unknown>>;
  byTier: Array<Record<string, unknown> & { tier: string }>;
}

interface BudgetData {
  global: { limitUsd: number; spentUsd: number } | null;
  agents: Array<{
    agentId: string;
    agentName: string;
    limitUsd: number;
    period: string;
    spentUsd: number;
  }>;
}

interface AgentOption {
  id: string;
  name: string;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const spendOf = (r: Record<string, unknown>): number => num(r.spend ?? r.totalCost ?? 0);

// ── Spend breakdown rows (.brow shape) ──

const BrowList = ({
  rows,
  barClass,
  formatVal,
}: {
  rows: Array<{ label: string; value: number }>;
  barClass?: string;
  formatVal: (v: number) => string;
}) => {
  if (rows.length === 0) return <p className="text-tertiary" style={{ fontSize: 12 }}>No data</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <>
      {rows.map((r) => (
        <div className="brow" key={r.label}>
          <span className="brow__label" title={r.label}>{r.label}</span>
          <span className="bar">
            <i className={barClass} style={{ width: `${Math.max((r.value / max) * 100, 1)}%` }} />
          </span>
          <span className="brow__val">{formatVal(r.value)}</span>
        </div>
      ))}
    </>
  );
};

// The warning threshold is read through the shared load guard: a failed read is "could not load", never
// the default "5", because Save writes whatever the box shows.
const useWarningThreshold = (path: string) => {
  const load = useGuardedLoad<string>(path, async (p) => {
    const r = await api.request<{ value: string }>(p);
    return r.ok ? { ok: true as const, data: r.data?.value || '5' } : r;
  });
  const [threshold, setThreshold] = useState('');
  useEffect(() => { if (load.status === 'ready' && load.data !== null) setThreshold(load.data); }, [load.status, load.data]);
  return { threshold, setThreshold, failed: load.status === 'failed', retry: load.reload };
};

// ── OpenRouter Balance (.tile + .tech__head + .tech__foot) ──

export const OpenRouterBudget = () => {
  const [credits, setCredits] = useState<{ total_credits: number; total_usage: number; balance: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const { threshold, setThreshold, failed: thresholdFailed, retry: retryThreshold } = useWarningThreshold('/config/openrouter/threshold');
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [savedThreshold, setSavedThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api.request<{ total_credits: number; total_usage: number; balance: number }>('/config/openrouter/credits')
      .then(res => {
        if (mounted && res.ok && res.data) {
          setCredits(res.data);
          setVisible(true);
        }
      })
      .catch(() => { /* silently hide if anything fails */ });
    return () => { mounted = false; };
  }, []);

  const handleSaveThreshold = async () => {
    const val = parseFloat(threshold);
    if (isNaN(val) || val < 0) { setThresholdError('Enter 0 or more.'); return; }
    setThresholdError(null);
    setSavingThreshold(true);
    const res = await api.request('/config/openrouter/threshold', {
      method: 'POST',
      body: JSON.stringify({ threshold: val }),
    });
    setSavingThreshold(false);
    if (!res.ok) {
      setThresholdError(res.error);
      return;
    }
    setSavedThreshold(true);
    setTimeout(() => setSavedThreshold(false), 2000);
  };

  if (!visible || !credits) return null;

  const balance = Math.round((credits.balance ?? 0) * 100) / 100;
  const totalUsage = Math.round((credits.total_usage ?? 0) * 100) / 100;
  const balanceColor = balance >= 100 ? 'var(--dojo3-green-ink)' : balance >= 25 ? 'var(--dojo3-amber-ink)' : 'var(--dojo3-rust)';

  return (
    <div className="tile anim" style={{ marginTop: 14 }}>
      <div className="tech__head">
        <div className="scard__title" style={{ margin: 0 }}>OpenRouter Balance</div>
        <span className="stat__value" style={{ color: balanceColor, fontSize: 17 }}>{formatUsd(balance)}</span>
        <a
          href="https://openrouter.ai/settings/credits"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
          title="Open OpenRouter credits page in a new tab"
        >
          Add &#8599;
        </a>
      </div>
      <div className="rows">
        <div><span className="k">Lifetime spend</span><span className="v">{formatUsd(totalUsage)}</span></div>
      </div>
      <div className="tech__foot">
        <span>Warning threshold</span>
        {thresholdFailed ? (
          <span className="srow">
            <span className="link" style={{ color: 'var(--dojo3-rust)' }}>Could not load the warning threshold, so it can&apos;t be changed right now.</span>
            <button type="button" className="btn btn--sm" onClick={retryThreshold}>Retry</button>
          </span>
        ) : (
        <span className="srow">
          <input
            className="finput"
            type="number"
            step="1"
            min="0"
            value={threshold}
            onChange={(e) => { setThreshold(e.target.value); setThresholdError(null); }}
            placeholder="e.g., 10"
            aria-label="Warning threshold"
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={handleSaveThreshold}
            disabled={savingThreshold || !threshold}
          >
            {savingThreshold ? '...' : 'Save'}
          </button>
          {savedThreshold && <span className="link" style={{ color: 'var(--dojo3-green-ink)' }}>Saved</span>}
          {thresholdError && <span className="link" style={{ color: 'var(--dojo3-rust)' }}>{thresholdError}</span>}
        </span>
        )}
      </div>
    </div>
  );
};

export const DeepSeekBudget = () => {
  const [credits, setCredits] = useState<{ currency: string; balance: number; granted_balance: number; topped_up_balance: number; is_available: boolean } | null>(null);
  const [visible, setVisible] = useState(false);
  const { threshold, setThreshold, failed: thresholdFailed, retry: retryThreshold } = useWarningThreshold('/config/deepseek/threshold');
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [savedThreshold, setSavedThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api.request<{ currency: string; balance: number; granted_balance: number; topped_up_balance: number; is_available: boolean }>('/config/deepseek/balance')
      .then(res => {
        if (mounted && res.ok && res.data) {
          setCredits(res.data);
          setVisible(true);
        }
      })
      .catch(() => { /* silently hide if anything fails */ });
    return () => { mounted = false; };
  }, []);

  const handleSaveThreshold = async () => {
    const val = parseFloat(threshold);
    if (isNaN(val) || val < 0) { setThresholdError('Enter 0 or more.'); return; }
    setThresholdError(null);
    setSavingThreshold(true);
    const res = await api.request('/config/deepseek/threshold', {
      method: 'POST',
      body: JSON.stringify({ threshold: val }),
    });
    setSavingThreshold(false);
    if (!res.ok) {
      setThresholdError(res.error);
      return;
    }
    setSavedThreshold(true);
    setTimeout(() => setSavedThreshold(false), 2000);
  };

  if (!visible || !credits) return null;

  const balance = Math.round((credits.balance ?? 0) * 100) / 100;
  const granted = Math.round((credits.granted_balance ?? 0) * 100) / 100;
  const toppedUp = Math.round((credits.topped_up_balance ?? 0) * 100) / 100;
  const balanceColor = balance >= 100 ? 'var(--dojo3-green-ink)' : balance >= 25 ? 'var(--dojo3-amber-ink)' : 'var(--dojo3-rust)';

  return (
    <div className="tile anim" style={{ marginTop: 14 }}>
      <div className="tech__head">
        <div className="scard__title" style={{ margin: 0 }}>DeepSeek Balance</div>
        <span className="stat__value" style={{ color: balanceColor, fontSize: 17 }}>{formatUsd(balance)}</span>
        <a
          href="https://platform.deepseek.com/top_up"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
          title="Open DeepSeek top-up page in a new tab"
        >
          Add &#8599;
        </a>
      </div>
      <div className="rows">
        <div>
          <span className="k">Topped up</span>
          <span className="v">{formatUsd(toppedUp)}{granted > 0 ? ` · Granted ${formatUsd(granted)}` : ''}</span>
        </div>
      </div>
      <div className="tech__foot">
        <span>Warning threshold</span>
        {thresholdFailed ? (
          <span className="srow">
            <span className="link" style={{ color: 'var(--dojo3-rust)' }}>Could not load the warning threshold, so it can&apos;t be changed right now.</span>
            <button type="button" className="btn btn--sm" onClick={retryThreshold}>Retry</button>
          </span>
        ) : (
        <span className="srow">
          <input
            className="finput"
            type="number"
            step="1"
            min="0"
            value={threshold}
            onChange={(e) => { setThreshold(e.target.value); setThresholdError(null); }}
            placeholder="e.g., 10"
            aria-label="Warning threshold"
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={handleSaveThreshold}
            disabled={savingThreshold || !threshold}
          >
            {savingThreshold ? '...' : 'Save'}
          </button>
          {savedThreshold && <span className="link" style={{ color: 'var(--dojo3-green-ink)' }}>Saved</span>}
          {thresholdError && <span className="link" style={{ color: 'var(--dojo3-rust)' }}>{thresholdError}</span>}
        </span>
        )}
      </div>
    </div>
  );
};

// ── Pricing index hygiene banner (.tile.hygiene) ──

const PricingSyncBadge = () => {
  const [status, setStatus] = useState<api.LitellmSyncStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.getPricingSyncStatus();
    if (result.ok) setStatus(result.data);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    const result = await api.runPricingSync();
    if (result.ok) setStatus(result.data);
    else setRefreshError(result.error);
    setRefreshing(false);
  };

  const ok = status?.lastStatus === 'success';
  const failed = status?.lastStatus === 'failure';
  const when = status?.lastRunAt ? formatDate(status.lastRunAt) : null;
  const count = status?.lastUpdatedCount;

  return (
    <div className="tile hygiene anim" style={{ '--ci': '0ms' } as React.CSSProperties}>
      <span className="hygiene__title">
        {ok && <span className="pill pill--ok"><i className="dot" />OK</span>}
        {failed && <span className="pill pill--down"><i className="dot" />FAIL</span>}
        {!ok && !failed && <span className="pill pill--norm"><i className="dot" />--</span>}
        Pricing Index
      </span>
      <span className="hygiene__stats" style={{ textTransform: 'none', letterSpacing: '.02em' }}>
        {ok && when && <span>Updated {when}{count !== null && count !== undefined ? ` · ${count} model${count === 1 ? '' : 's'} refreshed` : ''}</span>}
        {failed && when && <span className="bad">Failed {when}{status?.lastError ? ` · ${status.lastError}` : ''}</span>}
        {!ok && !failed && <span>Has not run yet</span>}
      </span>
      {refreshError && <span className="bad">Refresh failed: {refreshError}</span>}
      <button
        type="button"
        className="btn btn--sm"
        style={{ marginLeft: 'auto' }}
        onClick={handleRefresh}
        disabled={refreshing}
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  );
};

/** What the owner typed as a limit: a number above 0, null for "no limit" (blank or 0), or undefined when unreadable. */
function typedLimit(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const val = parseFloat(text);
  if (isNaN(val) || val < 0) return undefined;
  return val === 0 ? null : val;
}

// ── Budget Configuration (.tile + .rows + .bar + .srow) ──

const BudgetConfigTile = ({
  budgets,
  agents,
  onUpdateGlobal,
  onUpdateAgent,
}: {
  budgets: BudgetData;
  agents: AgentOption[];
  onUpdateGlobal: (limitUsd: number | null) => Promise<string | null>;
  onUpdateAgent: (agentId: string, limitUsd: number | null, period: string) => Promise<string | null>;
}) => {
  const [globalLimit, setGlobalLimit] = useState(budgets.global?.limitUsd?.toString() ?? '');
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savedGlobal, setSavedGlobal] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);

  const handleSaveGlobal = async () => {
    const val = typedLimit(globalLimit);
    if (val === undefined) {
      setGlobalError('Enter an amount, or leave it blank for no limit.');
      return;
    }
    setGlobalError(null);
    setSavingGlobal(true);
    const err = await onUpdateGlobal(val);
    setSavingGlobal(false);
    if (err !== null) {
      setGlobalError(err);
      return;
    }
    setSavedGlobal(true);
    setTimeout(() => setSavedGlobal(false), 2000);
  };

  const spent = budgets.global?.spentUsd ?? 0;
  const limit = budgets.global?.limitUsd ?? 0;
  const pct = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;

  // Agents not yet given an explicit budget still get a row, so every agent is budgetable here.
  const explicitIds = new Set(budgets.agents.map((a) => a.agentId));
  const extraAgents = agents.filter((a) => !explicitIds.has(a.id));

  return (
    <div className="tile anim" style={{ marginTop: 14 }}>
      <div className="scard__title">Budget Configuration</div>
      <div className="rows" style={{ marginTop: 6 }}>
        <div>
          <span className="k">Global daily budget &middot; spent today {formatUsd(spent)}</span>
          <span className="v">{budgets.global ? <>Limit: {formatUsd(limit)} &middot; {pct.toFixed(0)}%</> : 'No limit'}</span>
        </div>
      </div>
      <div className="bar" style={{ margin: '10px 0 14px' }}>
        <i className="is-green" style={{ width: `${Math.max(pct, 0)}%` }} />
      </div>
      <div className="srow">
        <input
          className="finput"
          type="number"
          step="0.01"
          min="0"
          value={globalLimit}
          onChange={(e) => { setGlobalLimit(e.target.value); setGlobalError(null); }}
          placeholder="e.g., 300"
          aria-label="Daily budget"
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={handleSaveGlobal}
          disabled={savingGlobal}
        >
          {savingGlobal ? '...' : 'Save'}
        </button>
        {savedGlobal && <span className="link" style={{ color: 'var(--dojo3-green-ink)' }}>Saved</span>}
        {globalError && <span className="link" style={{ color: 'var(--dojo3-rust)' }}>{globalError}</span>}
        <span className="toolbar__spacer" />
        <span className="toolbar__label">Per-agent budgets</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setAgentsOpen((o) => !o)}
          aria-expanded={agentsOpen}
        >
          {agentsOpen ? '−' : '+'}
        </button>
      </div>

      {agentsOpen && (
        <div className="rows" style={{ marginTop: 14 }}>
          {budgets.agents.length === 0 && extraAgents.length === 0 ? (
            <div><span className="k">No agents configured.</span></div>
          ) : (
            <>
              {budgets.agents.map((ab) => (
                <AgentBudgetRow
                  key={ab.agentId}
                  agentId={ab.agentId}
                  agentName={ab.agentName}
                  limitUsd={ab.limitUsd}
                  period={ab.period}
                  spentUsd={ab.spentUsd}
                  onSave={onUpdateAgent}
                />
              ))}
              {extraAgents.map((a) => (
                <AgentBudgetRow
                  key={a.id}
                  agentId={a.id}
                  agentName={a.name}
                  limitUsd={0}
                  period="daily"
                  spentUsd={0}
                  onSave={onUpdateAgent}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const AgentBudgetRow = ({
  agentId,
  agentName,
  limitUsd,
  period,
  spentUsd,
  onSave,
}: {
  agentId: string;
  agentName: string;
  limitUsd: number;
  period: string;
  spentUsd: number;
  onSave: (agentId: string, limitUsd: number | null, period: string) => Promise<string | null>;
}) => {
  const [limit, setLimit] = useState(limitUsd > 0 ? limitUsd.toString() : '');
  const [selectedPeriod, setSelectedPeriod] = useState(period);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const val = typedLimit(limit);
    if (val === undefined) {
      setError('Enter an amount, or leave it blank for no limit.');
      return;
    }
    setError(null);
    setSaving(true);
    const err = await onSave(agentId, val, selectedPeriod);
    setSaving(false);
    if (err !== null) {
      setError(err);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className="k" style={{ minWidth: 120 }} title={agentName}>
        {agentName}
        {limitUsd > 0 ? <span className="text-tertiary"> &middot; {formatUsd(spentUsd)} used</span> : null}
      </span>
      <span className="srow">
        <input
          className="finput"
          type="number"
          step="0.01"
          min="0"
          value={limit}
          onChange={(e) => { setLimit(e.target.value); setError(null); }}
          placeholder="--"
          aria-label={`${agentName} budget`}
        />
        <select
          className="field field--select"
          value={selectedPeriod}
          onChange={(e) => setSelectedPeriod(e.target.value)}
          style={{ height: 34 }}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '...' : 'Set'}
        </button>
        {saved && <span className="link" style={{ color: 'var(--dojo3-green-ink)' }}>OK</span>}
        {error && <span className="link" style={{ color: 'var(--dojo3-rust)' }}>{error}</span>}
      </span>
    </div>
  );
};

// ── Main page ──

export const Costs = () => {
  const [period, setPeriod] = useState<Period>('24h');
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [budgets, setBudgets] = useState<BudgetData | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  const latestLoad = useRef(0);

  const loadData = useCallback(async () => {
    const mine = ++latestLoad.current;
    try {
      const [summaryRes, budgetRes, agentsRes] = await Promise.all([
        api.getCostSummary(period),
        api.getBudgets(),
        api.getAgents(),
      ]);
      if (mine !== latestLoad.current) return;
      if (summaryRes.ok) {
        setSummary(summaryRes.data as CostSummary);
        setLoadError(null);
      } else {
        // A failed answer must not leave the old period's figures under the new tab.
        setSummary(null);
        setLoadError(summaryRes.error);
      }
      if (budgetRes.ok) {
        const bd = budgetRes.data as Record<string, unknown>;
        const globalRaw = bd.global as Record<string, unknown> | null;
        // The budget's spent figure is the server's own, not the summary's period
        // spend (the two disagree once a tab other than the default is selected).
        const globalSpent = Number.isFinite(Number(globalRaw?.spentUsd)) ? Number(globalRaw?.spentUsd) : 0;
        const agents = (bd.agents ?? []) as Array<Record<string, unknown>>;
        setBudgets({
          global: globalRaw
            ? { limitUsd: globalRaw.limitUsd as number, spentUsd: globalSpent }
            : null,
          agents: agents.map((a) => ({
            agentId: String(a.agentId),
            agentName: typeof a.agentName === 'string' && a.agentName ? a.agentName : String(a.agentId),
            limitUsd: Number(a.limitUsd),
            period: String(a.period),
            spentUsd: Number.isFinite(Number(a.spentUsd)) ? Number(a.spentUsd) : 0,
          })),
        });
      }
      if (agentsRes.ok) setAgents(agentsRes.data.map((a) => ({ id: a.id, name: a.name })));
    } catch (err) {
      console.error('Costs page load failed:', err);
    }
    if (mine === latestLoad.current) setLoading(false);
  }, [period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // chat:message is the highest-frequency broadcast: gate on the assistant role,
  // the only one carrying billed usage, and coalesce a burst into one trailing timer.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribe('chat:message', (event: WsEvent) => {
      if (event.type !== 'chat:message') return;
      if (event.message.role !== 'assistant') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void loadData(); }, 2000);
    });
    return () => { if (timer) clearTimeout(timer); unsub(); };
  }, [subscribe, loadData]);

  const mostExpensiveModel = summary?.byModel?.length
    ? summary.byModel.reduce((a, b) => (spendOf(a) > spendOf(b) ? a : b))
    : null;
  const mostExpensiveAgent = summary?.byAgent?.length
    ? summary.byAgent.reduce((a, b) => (spendOf(a) > spendOf(b) ? a : b))
    : null;

  if (loading) return <div className="loading-state">Loading...</div>;

  const totalSpend = summary?.totalSpend ?? 0;
  const dailyAvg = summary?.dailyAvg ?? 0;
  const budgetLimit = budgets?.global?.limitUsd ?? 0;
  const budgetSpent = budgets?.global?.spentUsd ?? 0;
  const budgetPct = budgetLimit > 0 ? Math.min((budgetSpent / budgetLimit) * 100, 100) : 0;

  const topModelName = mostExpensiveModel
    ? str(mostExpensiveModel.modelName) || str(mostExpensiveModel.modelId) || '--'
    : '--';
  const topAgentName = mostExpensiveAgent
    ? str(mostExpensiveAgent.agentName) || str(mostExpensiveAgent.agentId) || '--'
    : '--';

  const modelRows = (summary?.byModel ?? []).map((m) => ({
    label: str(m.modelName) || str(m.modelId) || 'Unknown',
    value: spendOf(m),
  }));
  const agentRows = (summary?.byAgent ?? []).map((a) => ({
    label: str(a.agentName) || str(a.agentId) || 'Unknown',
    value: spendOf(a),
  }));
  const tierRows = (summary?.byTier ?? []).map((t) => ({
    label: t.tier ? t.tier.charAt(0).toUpperCase() + t.tier.slice(1) : t.tier,
    value: spendOf(t),
  }));

  const usd = (v: number) => formatUsd(v);

  return (
    <>
      <header className="phead">
        <h2 className="phead__title">Ledger</h2>
        <span className="phead__meta">Costs</span>
        <div className="phead__actions">
          <div className="tabs" role="tablist">
            {(['24h', '7d', '30d', 'all'] as Period[]).map((p) => (
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
      </header>

      {/* Pricing-index sync status, boot-time + on-demand LiteLLM refresh */}
      <PricingSyncBadge />

      {loadError && <div className="note--warn">Could not load the costs: {loadError}</div>}

      {/* Summary stat cells */}
      <div className="stats">
        <div className="tile anim" style={{ '--ci': '40ms' } as React.CSSProperties}>
          <div className="stat__label">Total Spend</div>
          <div className="stat__value">{loadError ? '--' : usd(totalSpend)}</div>
        </div>
        <div className="tile anim" style={{ '--ci': '70ms' } as React.CSSProperties}>
          <div className="stat__label">Daily Average</div>
          <div className="stat__value">{loadError ? '--' : usd(dailyAvg)}</div>
        </div>
        <div className="tile anim" style={{ '--ci': '100ms' } as React.CSSProperties}>
          <div className="stat__label">Top Model</div>
          <div className="stat__value" title={topModelName}>{topModelName}</div>
          {mostExpensiveModel && <div className="stat__sub">{usd(spendOf(mostExpensiveModel))}</div>}
        </div>
        <div className="tile anim" style={{ '--ci': '130ms' } as React.CSSProperties}>
          <div className="stat__label">Top Agent</div>
          <div className="stat__value" title={topAgentName}>{topAgentName}</div>
          {mostExpensiveAgent && <div className="stat__sub">{usd(spendOf(mostExpensiveAgent))}</div>}
        </div>
        <div className="tile anim" style={{ '--ci': '160ms' } as React.CSSProperties}>
          <div className="stat__label">Budget</div>
          {budgetLimit > 0 ? (
            <>
              <div className="stat__value">{usd(budgetSpent)} / {usd(budgetLimit)}</div>
              <div className="bar" style={{ marginTop: 9 }}>
                <i style={{ width: `${Math.max(budgetPct, 0)}%` }} />
              </div>
            </>
          ) : (
            <div className="stat__value">No limit</div>
          )}
        </div>
      </div>

      {/* Spend breakdown cards */}
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
        <div className="tile anim" style={{ '--ci': '190ms' } as React.CSSProperties}>
          <div className="scard__title">Spend by Model</div>
          <BrowList rows={modelRows} barClass="is-blue" formatVal={usd} />
        </div>
        <div className="tile anim" style={{ '--ci': '220ms' } as React.CSSProperties}>
          <div className="scard__title">Spend by Agent</div>
          <BrowList rows={agentRows} barClass="is-green" formatVal={usd} />
        </div>
        <div className="tile anim" style={{ '--ci': '250ms' } as React.CSSProperties}>
          <div className="scard__title">Spend by Tier</div>
          <BrowList rows={tierRows} barClass="is-dim" formatVal={usd} />
        </div>
      </div>

      {/* Budget configuration */}
      {budgets && (
        <BudgetConfigTile
          budgets={budgets}
          agents={agents}
          onUpdateGlobal={async (limitUsd) => {
            const res = await api.setGlobalBudget(limitUsd);
            if (res.ok) loadData();
            return res.ok ? null : res.error;
          }}
          onUpdateAgent={async (agentId, limitUsd, agentPeriod) => {
            const res = await api.setAgentBudget(agentId, limitUsd, agentPeriod);
            if (res.ok) loadData();
            return res.ok ? null : res.error;
          }}
        />
      )}

      {/* Provider balances */}
      <OpenRouterBudget />
      <DeepSeekBudget />
    </>
  );
};
