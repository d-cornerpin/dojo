import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';
import { BarChart, PercentageBar } from '../components/CostCharts';
import { BudgetConfig } from '../components/BudgetConfig';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatDate } from '../lib/dates';

type Period = '24h' | '7d' | '30d' | 'all';
type SortField = 'time' | 'agent' | 'model' | 'tier' | 'inputTokens' | 'outputTokens' | 'cost' | 'latency';
type SortDir = 'asc' | 'desc';

interface CostSummary {
  totalSpend: number;
  dailyAvg: number;
  byModel: Array<Record<string, unknown>>;
  byAgent: Array<Record<string, unknown>>;
  byTier: Array<Record<string, unknown> & { tier: string }>;
}

interface CostRecord {
  id: string;
  time: string;
  agentId: string;
  agentName: string;
  modelId: string;
  modelName: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
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

const TIER_COLORS: Record<string, string> = {
  tier1: '#a855f7',
  tier2: '#3b82f6',
  tier3: '#22c55e',
};

const MODEL_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4', '#84cc16'];

// ── OpenRouter Budget ──

const OpenRouterBudget = () => {
  const [credits, setCredits] = useState<{ total_credits: number; total_usage: number; balance: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [threshold, setThreshold] = useState('');
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [savedThreshold, setSavedThreshold] = useState(false);

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
    // Load saved threshold (default $5)
    api.request<{ value: string }>('/config/openrouter/threshold')
      .then(res => {
        if (mounted) {
          setThreshold(res.ok && res.data?.value ? res.data.value : '5');
        }
      })
      .catch(() => { if (mounted) setThreshold('5'); });
    return () => { mounted = false; };
  }, []);

  const handleSaveThreshold = async () => {
    const val = parseFloat(threshold);
    if (isNaN(val) || val < 0) return;
    setSavingThreshold(true);
    await api.request('/config/openrouter/threshold', {
      method: 'POST',
      body: JSON.stringify({ threshold: val }),
    });
    setSavingThreshold(false);
    setSavedThreshold(true);
    setTimeout(() => setSavedThreshold(false), 2000);
  };

  if (!visible || !credits) return null;

  const balance = Math.round((credits.balance ?? 0) * 100) / 100;
  const totalUsage = Math.round((credits.total_usage ?? 0) * 100) / 100;
  const balanceColor = balance >= 100 ? 'text-green-400' : balance >= 25 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="glass-card p-4 mb-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium white/70">OpenRouter Balance</h2>
        <p className={`text-lg font-semibold ${balanceColor}`}>${balance.toFixed(2)}</p>
      </div>
      <p className="text-xs white/30 mt-1">Lifetime spend: ${totalUsage.toFixed(2)}</p>
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/[0.06]">
        <span className="text-xs white/40">Warning threshold: $</span>
        <input
          type="number"
          step="1"
          min="0"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          placeholder="e.g., 10"
          className="w-20 px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={handleSaveThreshold}
          disabled={savingThreshold || !threshold}
          className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-xs font-medium rounded transition-colors"
        >
          {savingThreshold ? '...' : 'Save'}
        </button>
        {savedThreshold && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </div>
  );
};

export const Costs = () => {
  const [period, setPeriod] = useState<Period>('24h');
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [budgets, setBudgets] = useState<BudgetData | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const { subscribe } = useWebSocket();

  const loadData = useCallback(async () => {
    try {
      const [summaryRes, recordsRes, budgetRes, agentsRes] = await Promise.all([
        api.getCostSummary(period),
        api.getCostRecords({ period }),
        api.getBudgets(),
        api.getAgents(),
      ]);
      if (summaryRes.ok) setSummary(summaryRes.data as CostSummary);
      if (recordsRes.ok) {
        const rd = recordsRes.data as { records?: Array<Record<string, unknown>>; total?: number };
        setRecords((rd.records ?? []).map((r): CostRecord => ({
          id: (r.id ?? '') as string,
          time: (r.time ?? r.createdAt ?? '') as string,
          agentId: (r.agentId ?? '') as string,
          agentName: (r.agentName ?? r.agentId ?? '') as string,
          modelId: (r.modelId ?? '') as string,
          modelName: (r.modelName ?? r.modelId ?? '') as string,
          tier: (r.tier ?? r.requestType ?? '--') as string,
          inputTokens: (r.inputTokens ?? 0) as number,
          outputTokens: (r.outputTokens ?? 0) as number,
          cost: (r.cost ?? r.costUsd ?? 0) as number,
          latencyMs: (r.latencyMs ?? 0) as number,
        })));
      }
      if (budgetRes.ok) {
        const bd = budgetRes.data as Record<string, unknown>;
        const globalRaw = bd.global as Record<string, unknown> | null;
        const totalSpend = summaryRes.ok ? (summaryRes.data as CostSummary).totalSpend : 0;
        setBudgets({
          global: globalRaw ? { limitUsd: globalRaw.limitUsd as number, spentUsd: totalSpend } : null,
          agents: (bd.agents ?? []) as BudgetData['agents'],
        });
      }
      if (agentsRes.ok) setAgents(agentsRes.data.map((a) => ({ id: a.id, name: a.name })));
    } catch (err) {
      console.error('Costs page load failed:', err);
    }
    setLoading(false);
  }, [period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh on cost-related WS events
  useEffect(() => {
    const unsub = subscribe('chat:message', () => {
      // Refresh after a short delay to let cost records settle
      setTimeout(loadData, 1000);
    });
    return unsub;
  }, [subscribe, loadData]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'time' ? 'desc' : 'asc');
    }
  };

  const sortedRecords = [...records].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortField) {
      case 'time':
        return (new Date(a.time).getTime() - new Date(b.time).getTime()) * dir;
      case 'agent':
        return a.agentName.localeCompare(b.agentName) * dir;
      case 'model':
        return a.modelName.localeCompare(b.modelName) * dir;
      case 'tier':
        return a.tier.localeCompare(b.tier) * dir;
      case 'inputTokens':
        return (a.inputTokens - b.inputTokens) * dir;
      case 'outputTokens':
        return (a.outputTokens - b.outputTokens) * dir;
      case 'cost':
        return (a.cost - b.cost) * dir;
      case 'latency':
        return (a.latencyMs - b.latencyMs) * dir;
      default:
        return 0;
    }
  });

  const mostExpensiveModel = summary?.byModel?.length
    ? summary.byModel.reduce((a: Record<string, unknown>, b: Record<string, unknown>) =>
        ((a.spend ?? a.totalCost ?? 0) as number) > ((b.spend ?? b.totalCost ?? 0) as number) ? a : b)
    : null;
  const mostExpensiveAgent = summary?.byAgent?.length
    ? summary.byAgent.reduce((a: Record<string, unknown>, b: Record<string, unknown>) =>
        ((a.spend ?? a.totalCost ?? 0) as number) > ((b.spend ?? b.totalCost ?? 0) as number) ? a : b)
    : null;

  const budgetUtilPct = budgets?.global
    ? (budgets.global.limitUsd ?? 0) > 0
      ? ((budgets.global.spentUsd ?? 0) / budgets.global.limitUsd) * 100
      : 0
    : 0;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="white/40">Loading cost data...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Costs</h1>

        {/* Time range selector */}
        <div className="flex gap-1 bg-white/[0.04] rounded-lg p-1">
          {(['24h', '7d', '30d', 'all'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                period === p
                  ? 'bg-blue-600 text-white'
                  : 'white/55 hover:white/90'
              }`}
            >
              {p === 'all' ? 'All' : p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <SummaryCard
          label="Total Spend"
          value={`$${(summary?.totalSpend ?? 0).toFixed(2)}`}
        />
        <SummaryCard
          label="Daily Average"
          value={`$${(summary?.dailyAvg ?? 0).toFixed(2)}`}
        />
        <SummaryCard
          label="Top Model"
          value={((mostExpensiveModel as Record<string, unknown>)?.modelName ?? (mostExpensiveModel as Record<string, unknown>)?.modelId ?? '--') as string}
          sub={mostExpensiveModel ? `$${(((mostExpensiveModel as Record<string, unknown>).spend ?? (mostExpensiveModel as Record<string, unknown>).totalCost ?? 0) as number).toFixed(2)}` : undefined}
        />
        <SummaryCard
          label="Top Agent"
          value={((mostExpensiveAgent as Record<string, unknown>)?.agentName ?? (mostExpensiveAgent as Record<string, unknown>)?.agentId ?? '--') as string}
          sub={mostExpensiveAgent ? `$${(((mostExpensiveAgent as Record<string, unknown>).spend ?? (mostExpensiveAgent as Record<string, unknown>).totalCost ?? 0) as number).toFixed(2)}` : undefined}
        />
        <div className="glass-card p-4">
          <p className="text-xs white/40 uppercase tracking-wider mb-1">Budget</p>
          {budgets?.global && budgets.global.limitUsd > 0 ? (
            <>
              <p className="text-lg font-semibold text-white mb-1">
                ${budgets.global.spentUsd.toFixed(2)} / ${budgets.global.limitUsd.toFixed(2)}
              </p>
              <PercentageBar value={budgets.global.spentUsd} max={budgets.global.limitUsd} />
            </>
          ) : (
            <p className="text-lg font-semibold white/30">No limit</p>
          )}
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Spend by model */}
        <div className="glass-card p-4">
          <h3 className="text-sm font-medium white/70 mb-3">Spend by Model</h3>
          <BarChart
            data={(summary?.byModel ?? []).map((m: Record<string, unknown>, i: number) => ({
              label: (m.modelName ?? m.modelId ?? 'Unknown') as string,
              value: (m.spend ?? m.totalCost ?? 0) as number,
              color: MODEL_COLORS[i % MODEL_COLORS.length],
            }))}
          />
        </div>

        {/* Spend by agent */}
        <div className="glass-card p-4">
          <h3 className="text-sm font-medium white/70 mb-3">Spend by Agent</h3>
          <BarChart
            data={(summary?.byAgent ?? []).map((a: Record<string, unknown>, i: number) => ({
              label: (a.agentName ?? a.agentId ?? 'Unknown') as string,
              value: (a.spend ?? a.totalCost ?? 0) as number,
              color: MODEL_COLORS[(i + 2) % MODEL_COLORS.length],
            }))}
          />
        </div>

        {/* Tier distribution */}
        <div className="glass-card p-4">
          <h3 className="text-sm font-medium white/70 mb-3">Tier Distribution</h3>
          <div className="space-y-3">
            {(summary?.byTier ?? []).map((t) => {
              const count = (t as Record<string, unknown>).requestCount as number ?? (t as Record<string, unknown>).count as number ?? 0;
              const pct = (t as Record<string, unknown>).percentage as number ?? 0;
              return (
                <div key={t.tier}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs white/55 capitalize">{t.tier}</span>
                    <span className="text-xs white/40">
                      {count.toLocaleString()} calls{pct > 0 ? ` (${pct.toFixed(0)}%)` : ''}
                    </span>
                  </div>
                  <PercentageBar
                    value={pct > 0 ? pct : (count > 0 ? 100 : 0)}
                    max={100}
                    color={TIER_COLORS[t.tier] || '#6b7280'}
                  />
                </div>
              );
            })}
            {(summary?.byTier ?? []).length === 0 && (
              <p className="text-sm white/30">No data</p>
            )}
          </div>
        </div>
      </div>

      {/* Budget config */}
      {budgets && (
        <div className="glass-card p-4 mb-6">
          <h2 className="text-sm font-medium white/70 mb-3">Budget Configuration</h2>
            <BudgetConfig
              budgets={budgets}
              agents={agents}
              onUpdateGlobal={async (limitUsd) => {
                await api.setGlobalBudget(limitUsd);
                loadData();
              }}
              onUpdateAgent={async (agentId, limitUsd, agentPeriod) => {
                await api.setAgentBudget(agentId, limitUsd, agentPeriod);
                loadData();
              }}
            />
        </div>
      )}

      {/* OpenRouter Budget */}
      <OpenRouterBudget />

      {/* Recent API calls table */}
      <div className="glass-card overflow-hidden">
        <div className="px-4 py-3 border-b white/[0.06] flex items-center justify-between">
          <h3 className="text-sm font-medium white/70">Recent API Calls</h3>
          <span className="text-xs white/30">{records.length} records</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white/[0.04]">
              <tr className="text-left white/40 text-xs uppercase tracking-wider">
                <SortableHeader field="time" label="Time" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="agent" label="Agent" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="model" label="Model" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="tier" label="Tier" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="inputTokens" label="In Tokens" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="outputTokens" label="Out Tokens" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="cost" label="Cost" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHeader field="latency" label="Latency" current={sortField} dir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {sortedRecords.map((r) => (
                <tr key={r.id} className="border-t white/[0.04] hover:white/[0.02]">
                  <td className="px-4 py-1.5 text-xs white/40 font-mono whitespace-nowrap">
                    {r.time ? formatDate(r.time) : '--'}
                  </td>
                  <td className="px-4 py-1.5 text-xs white/70">{r.agentName || r.agentId}</td>
                  <td className="px-4 py-1.5 text-xs white/55">{r.modelName || r.modelId?.slice(0, 8)}</td>
                  <td className="px-4 py-1.5">
                    <TierBadge tier={r.tier} />
                  </td>
                  <td className="px-4 py-1.5 text-xs white/55 text-right font-mono">
                    {(r.inputTokens ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-1.5 text-xs white/55 text-right font-mono">
                    {(r.outputTokens ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-1.5 text-xs white/70 text-right font-mono">
                    ${(r.cost ?? 0).toFixed(4)}
                  </td>
                  <td className="px-4 py-1.5 text-xs white/55 text-right font-mono">
                    {(r.latencyMs ?? 0).toLocaleString()}ms
                  </td>
                </tr>
              ))}
              {sortedRecords.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center white/30 text-sm">
                    No cost records for this period
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

const SummaryCard = ({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) => (
  <div className="glass-card p-4">
    <p className="text-xs white/40 uppercase tracking-wider mb-1">{label}</p>
    <p className="text-lg font-semibold text-white truncate" title={value}>{value}</p>
    {sub && <p className="text-xs white/40 mt-0.5">{sub}</p>}
  </div>
);

const TierBadge = ({ tier }: { tier: string }) => {
  const colors: Record<string, string> = {
    tier1: 'bg-purple-600/20 text-purple-300',
    tier2: 'bg-blue-600/20 text-blue-300',
    tier3: 'bg-green-600/20 text-green-300',
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[tier] || 'bg-white/[0.08] white/70'}`}>
      {tier}
    </span>
  );
};

const SortableHeader = ({
  field,
  label,
  current,
  dir,
  onSort,
}: {
  field: SortField;
  label: string;
  current: SortField;
  dir: SortDir;
  onSort: (field: SortField) => void;
}) => (
  <th
    className="px-4 py-2 cursor-pointer hover:white/70 transition-colors select-none"
    onClick={() => onSort(field)}
  >
    <span className="inline-flex items-center gap-1">
      {label}
      {current === field && (
        <span className="text-blue-400">{dir === 'asc' ? '^' : 'v'}</span>
      )}
    </span>
  </th>
);
