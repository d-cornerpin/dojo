import { useState } from 'react';
import { PercentageBar } from './CostCharts';

interface BudgetInfo {
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

interface BudgetConfigProps {
  budgets: BudgetInfo;
  agents: AgentOption[];
  onUpdateGlobal: (limitUsd: number) => Promise<void>;
  onUpdateAgent: (agentId: string, limitUsd: number, period: string) => Promise<void>;
}

export const BudgetConfig = ({ budgets, agents, onUpdateGlobal, onUpdateAgent }: BudgetConfigProps) => {
  const [globalLimit, setGlobalLimit] = useState(
    budgets.global?.limitUsd?.toString() ?? '',
  );
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savedGlobal, setSavedGlobal] = useState(false);
  const [agentBudgetsOpen, setAgentBudgetsOpen] = useState(false);

  const handleSaveGlobal = async () => {
    const val = parseFloat(globalLimit);
    if (isNaN(val) || val < 0) return;
    setSavingGlobal(true);
    await onUpdateGlobal(val);
    setSavingGlobal(false);
    setSavedGlobal(true);
    setTimeout(() => setSavedGlobal(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Global budget */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-medium white/70 mb-3">Global Daily Budget</h3>
        {budgets.global && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-xs white/40 mb-1">
              <span>Spent today: ${budgets.global.spentUsd.toFixed(2)}</span>
              <span>Limit: ${budgets.global.limitUsd.toFixed(2)}</span>
            </div>
            <PercentageBar value={budgets.global.spentUsd} max={budgets.global.limitUsd} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm white/55">$</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={globalLimit}
            onChange={(e) => setGlobalLimit(e.target.value)}
            placeholder="e.g., 10.00"
            className="w-32 px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSaveGlobal}
            disabled={savingGlobal || !globalLimit}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {savingGlobal ? 'Saving...' : 'Save'}
          </button>
          {savedGlobal && <span className="text-xs text-green-400">Saved!</span>}
        </div>
      </div>

      {/* Per-agent budgets (collapsible) */}
      <div className="glass-card overflow-hidden">
        <button
          onClick={() => setAgentBudgetsOpen(!agentBudgetsOpen)}
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium white/70 hover:bg-white/[0.03] transition-colors"
        >
          <span>Per-Agent Budgets</span>
          <span className="white/40">{agentBudgetsOpen ? '[-]' : '[+]'}</span>
        </button>
        {agentBudgetsOpen && (
          <div className="px-4 pb-4">
            {budgets.agents.length === 0 && agents.length === 0 ? (
              <p className="text-sm white/30">No agents configured.</p>
            ) : (
              <div className="space-y-3">
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
                {agents
                  .filter((a) => !budgets.agents.find((ab) => ab.agentId === a.id))
                  .map((a) => (
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
              </div>
            )}
          </div>
        )}
      </div>
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
  onSave: (agentId: string, limitUsd: number, period: string) => Promise<void>;
}) => {
  const [limit, setLimit] = useState(limitUsd > 0 ? limitUsd.toString() : '');
  const [selectedPeriod, setSelectedPeriod] = useState(period);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const val = parseFloat(limit);
    if (isNaN(val) || val < 0) return;
    setSaving(true);
    await onSave(agentId, val, selectedPeriod);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex items-center gap-3 py-2 border-b white/[0.04] last:border-0">
      <span className="text-sm white/70 w-32 truncate" title={agentName}>
        {agentName}
      </span>
      {limitUsd > 0 && (
        <div className="w-24">
          <PercentageBar value={spentUsd} max={limitUsd} showLabel={false} />
        </div>
      )}
      <span className="text-xs white/40 w-20">
        ${spentUsd.toFixed(2)} used
      </span>
      <div className="flex items-center gap-1 ml-auto">
        <span className="text-xs white/40">$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="--"
          className="w-20 px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/90 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <select
          value={selectedPeriod}
          onChange={(e) => setSelectedPeriod(e.target.value)}
          className="px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/70 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-xs font-medium rounded transition-colors"
        >
          {saving ? '...' : 'Set'}
        </button>
        {saved && <span className="text-xs text-green-400">OK</span>}
      </div>
    </div>
  );
};
