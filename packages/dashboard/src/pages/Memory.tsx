import { useState, useEffect, useCallback } from 'react';
import type { Summary } from '@dojo/shared';
import * as api from '../lib/api';
import type { VaultEntry, VaultStats as VaultStatsType } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { DagTree } from '../components/DagTree';
import { SummaryDetail } from '../components/SummaryDetail';
import { MemorySearch } from '../components/MemorySearch';
import { BriefingView } from '../components/BriefingView';
import { VaultEntryCard } from '../components/VaultEntryCard';
import { VaultStats } from '../components/VaultStats';
import { formatDate } from '../lib/dates';

type RightPanel = 'detail' | 'search' | 'briefing' | 'none';
type MainTab = 'dag' | 'vault' | 'dreams';

export const Memory = () => {
  // Agent selection — default to 'primary' alias (server resolves to actual ID)
  const [agentId, setAgentId] = useState('primary');
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);

  // DAG state
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [links, setLinks] = useState<{ summaryId: string; parentIds: string[] }[]>([]);
  const [dagLoading, setDagLoading] = useState(true);

  // Selection and panels
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>('none');

  // Tab state
  const [mainTab, setMainTab] = useState<MainTab>('vault');

  // Vault state
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const [vaultStats, setVaultStats] = useState<VaultStatsType | null>(null);
  const [vaultLoading, setVaultLoading] = useState(true);
  const [vaultTypeFilter, setVaultTypeFilter] = useState<string>('');
  const [vaultSearch, setVaultSearchText] = useState('');
  const [dreaming, setDreaming] = useState(false);
  const [dreamReports, setDreamReports] = useState<api.DreamReport[]>([]);

  // Action states
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<string | null>(null);
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectContent, setInjectContent] = useState('');
  const [injecting, setInjecting] = useState(false);

  const { subscribe } = useWebSocket();

  // Load agents list and set default to primary agent
  useEffect(() => {
    const load = async () => {
      const [agentResult, primaryResult] = await Promise.all([
        api.getAgents(),
        api.getSetting('primary_agent_id'),
      ]);
      if (agentResult.ok) {
        setAgents(agentResult.data.map((a) => ({ id: a.id, name: a.name })));
        const primaryId = primaryResult.ok ? primaryResult.data.value : null;
        if (!agentId && primaryId && agentResult.data.find(a => a.id === primaryId)) {
          setAgentId(primaryId);
        } else if (!agentId && agentResult.data.length > 0) {
          setAgentId(agentResult.data[0].id);
        }
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load DAG
  const loadDag = useCallback(async () => {
    setDagLoading(true);
    const result = await api.getMemoryDag(agentId);
    if (result.ok) {
      setSummaries(result.data.summaries);
      setLinks(result.data.links);
    }
    setDagLoading(false);
  }, [agentId]);

  useEffect(() => {
    loadDag();
    setSelectedId(null);
    setRightPanel('none');
  }, [loadDag]);

  // Subscribe to real-time memory events
  useEffect(() => {
    const unsubCompaction = subscribe('memory:compaction', (event) => {
      if ('agentId' in event && event.agentId === agentId) {
        loadDag();
      }
    });
    const unsubBriefing = subscribe('memory:briefing', (event) => {
      if ('agentId' in event && event.agentId === agentId && rightPanel === 'briefing') {
        // The briefing view will handle its own refresh
      }
    });
    const unsubDream = subscribe('dream:complete', () => {
      loadVault();
      loadDreamReports();
    });
    return () => {
      unsubCompaction();
      unsubBriefing();
      unsubDream();
    };
  }, [subscribe, agentId, loadDag, rightPanel]);

  // Load vault entries
  const loadVault = useCallback(async () => {
    setVaultLoading(true);
    const [entriesResult, statsResult] = await Promise.all([
      api.getVaultEntries({
        type: vaultTypeFilter || undefined,
        search: vaultSearch || undefined,
        limit: 100,
      }),
      api.getVaultStats(),
    ]);
    if (entriesResult.ok) setVaultEntries(entriesResult.data);
    if (statsResult.ok) setVaultStats(statsResult.data);
    setVaultLoading(false);
  }, [vaultTypeFilter, vaultSearch]);

  const loadDreamReports = useCallback(async () => {
    const result = await api.getDreamHistory(5);
    if (result.ok) setDreamReports(result.data);
  }, []);

  useEffect(() => {
    if (mainTab === 'vault') loadVault();
    if (mainTab === 'dreams') loadDreamReports();
  }, [mainTab, loadVault, loadDreamReports]);

  const handleDreamNow = async () => {
    setDreaming(true);
    await api.triggerDream();
    setDreaming(false);
    loadVault();
    loadDreamReports();
  };

  const handleSelectSummary = (id: string) => {
    setSelectedId(id);
    setRightPanel('detail');
  };

  const handleSearchSelect = (id: string, type: 'message' | 'summary') => {
    if (type === 'summary') {
      setSelectedId(id);
      setRightPanel('detail');
    }
  };

  const handleDeleted = () => {
    setSelectedId(null);
    setRightPanel('none');
    loadDag();
  };

  const handleUpdated = () => {
    loadDag();
  };

  const handleCompact = async () => {
    setCompacting(true);
    setCompactResult(null);
    const result = await api.triggerCompaction(agentId);
    if (result.ok) {
      setCompactResult(
        `Created ${result.data.leafSummariesCreated} leaf, ${result.data.condensedCreated} condensed summaries`,
      );
      loadDag();
    } else {
      setCompactResult(`Error: ${result.error}`);
    }
    setCompacting(false);
    setTimeout(() => setCompactResult(null), 5000);
  };

  const handleInject = async () => {
    if (!injectContent.trim()) return;
    setInjecting(true);
    const result = await api.injectMemory(agentId, injectContent);
    if (result.ok) {
      setInjectContent('');
      setInjectOpen(false);
      loadDag();
    }
    setInjecting(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-white">Vault</h2>
          {/* Tabs */}
          <div className="flex items-center gap-1 bg-white/[0.03] rounded-lg p-0.5">
            {(['vault', 'dag', 'dreams'] as MainTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setMainTab(tab)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  mainTab === tab
                    ? 'bg-white/[0.1] text-white'
                    : 'text-white/40 hover:text-white/70'
                }`}
              >
                {tab === 'vault' ? 'Entries' : tab === 'dag' ? 'DAG' : 'Dreams'}
              </button>
            ))}
          </div>
          {mainTab === 'dag' && (
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mainTab === 'vault' && (
            <>
              <select
                value={vaultTypeFilter}
                onChange={(e) => setVaultTypeFilter(e.target.value)}
                className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-white/70"
              >
                <option value="">All types</option>
                <option value="fact">Facts</option>
                <option value="preference">Preferences</option>
                <option value="decision">Decisions</option>
                <option value="procedure">Procedures</option>
                <option value="relationship">Relationships</option>
                <option value="event">Events</option>
                <option value="note">Notes</option>
              </select>
              <input
                type="text"
                placeholder="Search vault..."
                value={vaultSearch}
                onChange={(e) => setVaultSearchText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadVault()}
                className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-1 text-xs text-white/90 w-48 placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </>
          )}
          {mainTab === 'dag' && (
            <button
              onClick={() =>
                setRightPanel(rightPanel === 'search' ? 'none' : 'search')
              }
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                rightPanel === 'search'
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'bg-white/[0.05] text-white/55 hover:text-white/90'
              }`}
            >
              Search
            </button>
          )}
        </div>
      </div>

      {/* Stats bar (vault tab only) */}
      {mainTab === 'vault' && <VaultStats stats={vaultStats} loading={vaultLoading} />}

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Vault Entries Tab */}
        {mainTab === 'vault' && (
          <div className="flex-1 overflow-y-auto p-4">
            {vaultLoading ? (
              <div className="text-center text-white/40 text-sm py-8">Loading vault entries...</div>
            ) : vaultEntries.length === 0 ? (
              <div className="text-center text-white/40 text-sm py-8">
                No vault entries yet. Agents will populate the vault as they learn, or the dreaming cycle will extract knowledge from conversations.
              </div>
            ) : (
              <div className="space-y-2 max-w-4xl mx-auto">
                {vaultEntries.map((entry) => (
                  <VaultEntryCard
                    key={entry.id}
                    entry={entry}
                    onUpdated={loadVault}
                    onDeleted={loadVault}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* DAG Tab */}
        {mainTab === 'dag' && (
          <>
            <div className="w-80 border-r border-white/[0.06] flex flex-col bg-white/[0.02]">
              <div className="px-4 py-2 border-b border-white/[0.06] flex items-center justify-between">
                <span className="text-xs font-medium text-white/40 uppercase tracking-wider">
                  Summary DAG
                </span>
                <span className="text-[10px] text-white/30">
                  {summaries.length} nodes
                </span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {dagLoading ? (
                  <div className="p-4 text-center text-white/40 text-sm">Loading...</div>
                ) : (
                  <DagTree
                    summaries={summaries}
                    links={links}
                    selectedId={selectedId}
                    onSelect={handleSelectSummary}
                  />
                )}
              </div>
            </div>
            <div className="flex-1 flex flex-col bg-transparent min-w-0">
              {rightPanel === 'detail' && selectedId && (
                <SummaryDetail
                  summaryId={selectedId}
                  agentId={agentId}
                  onDeleted={handleDeleted}
                  onUpdated={handleUpdated}
                  onSelect={handleSelectSummary}
                />
              )}
              {rightPanel === 'search' && (
                <MemorySearch agentId={agentId} onSelectResult={handleSearchSelect} />
              )}
              {rightPanel === 'briefing' && <BriefingView agentId={agentId} />}
              {rightPanel === 'none' && (
                <div className="flex items-center justify-center h-full text-white/30 text-sm">
                  Select a summary from the DAG or use search
                </div>
              )}
            </div>
          </>
        )}

        {/* Dreams Tab */}
        {mainTab === 'dreams' && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-3xl mx-auto space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-white/70">Dream Reports</h3>
                <button
                  onClick={handleDreamNow}
                  disabled={dreaming}
                  className="px-3 py-1.5 text-xs rounded-lg bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 transition-colors disabled:opacity-50"
                >
                  {dreaming ? 'Dreaming...' : 'Dream Now'}
                </button>
              </div>
              {dreamReports.length === 0 ? (
                <div className="text-center text-white/30 text-sm py-8">
                  No dream reports yet. The dreaming cycle runs nightly at the configured time, or you can trigger it manually.
                </div>
              ) : (
                dreamReports.map((report) => (
                  <div key={report.id} className="border border-white/[0.06] rounded-lg p-4 bg-white/[0.02]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-white/50">
                        {formatDate(report.createdAt)}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                        {report.dreamMode}
                      </span>
                    </div>
                    <pre className="text-xs text-white/70 whitespace-pre-wrap font-mono leading-relaxed">
                      {report.reportText}
                    </pre>
                    {report.durationMs && (
                      <div className="text-[10px] text-white/30 mt-2">
                        Duration: {(report.durationMs / 1000).toFixed(1)}s
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-white/[0.06] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          {mainTab === 'dag' && (
            <>
              <button
                onClick={() => setInjectOpen(!injectOpen)}
                className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.05] text-white/70 hover:bg-white/[0.08] transition-colors"
              >
                Inject Memory
              </button>
              <button
                onClick={handleCompact}
                disabled={compacting}
                className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.05] text-white/70 hover:bg-white/[0.08] transition-colors disabled:opacity-50"
              >
                {compacting ? 'Compacting...' : 'Compact Now'}
              </button>
              <button
                onClick={() =>
                  setRightPanel(rightPanel === 'briefing' ? 'none' : 'briefing')
                }
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  rightPanel === 'briefing'
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'bg-white/[0.05] text-white/70 hover:bg-white/[0.08]'
                }`}
              >
                View Briefing
              </button>
            </>
          )}
          {mainTab === 'vault' && (
            <button
              onClick={loadVault}
              className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.05] text-white/70 hover:bg-white/[0.08] transition-colors"
            >
              Refresh
            </button>
          )}
        </div>
        {compactResult && (
          <span
            className={`text-xs ${
              compactResult.startsWith('Error')
                ? 'text-red-400'
                : 'text-green-400'
            }`}
          >
            {compactResult}
          </span>
        )}
      </div>

      {/* Inject Memory modal */}
      {injectOpen && (
        <div className="glass-modal-backdrop">
          <div className="glass-modal w-full max-w-lg mx-4 shadow-2xl">
            <div className="px-5 py-4 border-b white/[0.06]">
              <h3 className="text-sm font-medium text-white">Inject Memory</h3>
              <p className="text-xs white/40 mt-1">
                Add content directly into the agent's memory store.
              </p>
            </div>
            <div className="p-5">
              <textarea
                value={injectContent}
                onChange={(e) => setInjectContent(e.target.value)}
                placeholder="Enter memory content to inject..."
                className="w-full h-40 bg-white/[0.05] border white/[0.08] rounded-lg p-3 text-sm white/90 font-mono placeholder-gray-500 resize-y focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t white/[0.06]">
              <button
                onClick={() => {
                  setInjectOpen(false);
                  setInjectContent('');
                }}
                className="px-4 py-2 text-xs rounded-lg bg-white/[0.05] white/70 hover:bg-white/[0.08] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleInject}
                disabled={injecting || !injectContent.trim()}
                className="px-4 py-2 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {injecting ? 'Injecting...' : 'Inject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
