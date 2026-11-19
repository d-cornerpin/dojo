import { useState, useEffect, useCallback, useRef } from 'react';
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
import { ForensicSearchPanel } from '../components/ForensicSearchPanel';
import { CredentialsPanel } from '../components/CredentialsPanel';
import { ContactsPanel } from '../components/ContactsPanel';
import { ModalShell } from '../components/ModalShell';
import { formatDate } from '../lib/dates';
import { isEnterNotComposing } from '../lib/enter-key';

type RightPanel = 'detail' | 'search' | 'briefing' | 'none';
type MainTab = 'dag' | 'vault' | 'dreams' | 'forensic' | 'credentials' | 'contacts';

export const Memory = () => {
  // Agent selection, default to 'primary' alias (server resolves to actual ID)
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
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [dreamNote, setDreamNote] = useState<string | null>(null);
  const dreamNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (dreamNoteTimer.current) clearTimeout(dreamNoteTimer.current); }, []);
  const [dreamReports, setDreamReports] = useState<api.DreamReport[]>([]);
  // Always points at the latest loaders, so a dream finishing reloads with the search
  // words and filter on screen now, not the ones from when the subscription was made.
  const dreamRefresh = useRef<() => void>(() => {});

  // Action states
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<string | null>(null);
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectContent, setInjectContent] = useState('');
  const [injecting, setInjecting] = useState(false);
  const [injectError, setInjectError] = useState<string | null>(null);

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
        const ids = agentResult.data.map((a) => a.id);
        const primaryId = primaryResult.ok ? primaryResult.data.value : null;
        // The box and the tree must name the same agent: an id the list does not hold is replaced.
        setAgentId((cur) => ids.includes(cur) ? cur : primaryId && ids.includes(primaryId) ? primaryId : (ids[0] ?? cur));
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load DAG. A request counter makes late answers lose: a slow answer for the
  // previous agent must not overdraw the new agent's DAG (and must not clear
  // the spinner the newest request still needs).
  const dagSeq = useRef(0);
  const loadDag = useCallback(async () => {
    const mine = ++dagSeq.current;
    setDagLoading(true);
    const result = await api.getMemoryDag(agentId);
    if (mine !== dagSeq.current) return;
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
    const unsubDream = subscribe('dream:complete', () => { dreamRefresh.current(); });
    return () => {
      unsubCompaction();
      unsubBriefing();
      unsubDream();
    };
  }, [subscribe, agentId, loadDag, rightPanel]);

  // Load vault entries, same counter: an answer for an older keystroke never
  // overdraws the newest search's entries or stats.
  const vaultSeq = useRef(0);
  const loadVault = useCallback(async () => {
    const mine = ++vaultSeq.current;
    setVaultLoading(true);
    const [entriesResult, statsResult] = await Promise.all([
      api.getVaultEntries({
        type: vaultTypeFilter || undefined,
        search: vaultSearch || undefined,
        limit: 100,
      }),
      api.getVaultStats(),
    ]);
    if (mine !== vaultSeq.current) return; // a newer search was asked; its answer wins
    if (entriesResult.ok) { setVaultEntries(entriesResult.data); setVaultError(null); }
    else { setVaultEntries([]); setVaultError(entriesResult.error); }
    if (statsResult.ok) setVaultStats(statsResult.data);
    setVaultLoading(false);
  }, [vaultTypeFilter, vaultSearch]);

  const loadDreamReports = useCallback(async () => {
    const result = await api.getDreamHistory(5);
    if (result.ok) setDreamReports(result.data);
  }, []);
  dreamRefresh.current = () => { loadVault(); loadDreamReports(); };

  useEffect(() => {
    if (mainTab === 'vault') loadVault();
    if (mainTab === 'dreams') loadDreamReports();
  }, [mainTab, loadVault, loadDreamReports]);

  const handleDreamNow = async () => {
    setDreaming(true);
    const result = await api.triggerDream();
    setDreaming(false);
    if (!result.ok) {
      setDreamNote(result.error);
      if (dreamNoteTimer.current) clearTimeout(dreamNoteTimer.current);
      dreamNoteTimer.current = setTimeout(() => setDreamNote(null), 6000);
      return;
    }
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
    setInjectError(null);
    const result = await api.injectMemory(agentId, injectContent);
    if (result.ok) {
      setInjectContent('');
      setInjectOpen(false);
      loadDag();
    } else {
      setInjectError(result.error);
    }
    setInjecting(false);
  };

  const TABS: { id: MainTab; label: string }[] = [
    { id: 'vault', label: 'Entries' },
    { id: 'dag', label: 'DAG' },
    { id: 'dreams', label: 'Dreams' },
    { id: 'forensic', label: 'Forensic' },
    { id: 'contacts', label: 'Contacts' },
    { id: 'credentials', label: 'Credentials' },
  ];

  return (
    <>
      {/* Self-headered panel: page owns its phead. The type filter and
          search input live in the header actions and only apply on the
          Entries tab. */}
      <header className="phead">
        <h2 className="phead__title">Vault</h2>
        <span className="phead__meta">
          {vaultStats ? `${vaultStats.totalEntries} entries` : 'Vault'}
        </span>
        <div className="phead__actions">
          {mainTab === 'vault' && (
            <>
              <select
                className="field field--select"
                aria-label="Type filter"
                value={vaultTypeFilter}
                onChange={(e) => setVaultTypeFilter(e.target.value)}
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
                className="field"
                type="text"
                placeholder="Search vault"
                aria-label="Search vault"
                value={vaultSearch}
                onChange={(e) => setVaultSearchText(e.target.value)}
                onKeyDown={(e) => isEnterNotComposing(e) && loadVault()}
              />
            </>
          )}
          {mainTab === 'dag' && (
            <>
              <select
                className="field field--select"
                aria-label="Agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button
                type="button"
                className={`btn btn--sm${rightPanel === 'search' ? ' btn--primary' : ''}`}
                onClick={() => setRightPanel(rightPanel === 'search' ? 'none' : 'search')}
              >
                Search
              </button>
            </>
          )}
        </div>
      </header>

      {/* Tab strip */}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mainTab === tab.id}
              className={`tab${mainTab === tab.id ? ' is-active' : ''}`}
              onClick={() => setMainTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Vault Entries Tab */}
      {mainTab === 'vault' && (
        <>
          <VaultStats stats={vaultStats} loading={vaultLoading} onArchivesDiscarded={loadVault} />
          {vaultError && <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }} role="alert">Could not load vault entries: {vaultError}{' '}<button type="button" className="btn btn--ghost" onClick={loadVault}>Retry</button></div>}
          {vaultLoading ? (
            <div className="stub"><p className="stub__line">Loading vault entries...</p></div>
          ) : vaultError ? null : vaultEntries.length === 0 ? (
            <div className="stub">
              <p className="stub__line">
                No vault entries yet. Agents will populate the vault as they learn, or the dreaming cycle will extract knowledge from conversations.
              </p>
            </div>
          ) : (
            vaultEntries.map((entry, i) => (
              <VaultEntryCard
                key={entry.id}
                entry={entry}
                index={i}
                onUpdated={loadVault}
                onDeleted={loadVault}
              />
            ))
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" className="btn btn--sm" onClick={loadVault}>Refresh</button>
          </div>
        </>
      )}

      {/* DAG Tab keeps its split-pane layout; given a fixed height so the
          internal flex-1 columns size correctly inside the scrolling body. */}
      {mainTab === 'dag' && (
        <div className="flex min-h-0" style={{ height: 560 }}>
            <div className="w-80 border-r border-ui/[0.06] flex flex-col bg-ui/[0.03]">
              <div className="px-4 py-2 border-b border-ui/[0.06] flex items-center justify-between">
                <span className="text-xs font-medium text-ui/40 uppercase tracking-wider">
                  Summary DAG
                </span>
                <span className="text-[10px] text-ui/25">
                  {summaries.length} nodes
                </span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {dagLoading ? (
                  <div className="p-4 text-center text-ui/40 text-sm">Loading...</div>
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
                <div className="flex items-center justify-center h-full text-ui/25 text-sm">
                  Select a summary from the DAG or use search
                </div>
              )}
            </div>
        </div>
      )}

      {/* DAG actions row. Inject / Compact /
          Briefing live here so the DAG view keeps its full operator set. */}
      {mainTab === 'dag' && (
        <div className="toolbar" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setInjectOpen(!injectOpen);
              setInjectError(null);
            }}
          >
            Inject Memory
          </button>
          <button type="button" className="btn btn--sm" onClick={handleCompact} disabled={compacting}>
            {compacting ? 'Compacting...' : 'Compact Now'}
          </button>
          <button
            type="button"
            className={`btn btn--sm${rightPanel === 'briefing' ? ' btn--primary' : ''}`}
            onClick={() => setRightPanel(rightPanel === 'briefing' ? 'none' : 'briefing')}
          >
            View Briefing
          </button>
          {compactResult && (
            <span
              className="toolbar__label"
              style={{
                marginLeft: 'auto',
                textTransform: 'none',
                letterSpacing: 'normal',
                color: compactResult.startsWith('Error') ? 'var(--dojo3-rust)' : 'var(--dojo3-green-ink)',
              }}
            >
              {compactResult}
            </span>
          )}
        </div>
      )}

      {/* Forensic Tab */}
      {mainTab === 'forensic' && (
        <div className="flex flex-col min-h-0" style={{ height: 560 }}>
          <ForensicSearchPanel />
        </div>
      )}

      {/* Contacts / Credentials Tabs */}
      {mainTab === 'contacts' && (
        <div className="flex flex-col min-h-0" style={{ height: 560 }}>
          <ContactsPanel />
        </div>
      )}
      {mainTab === 'credentials' && <CredentialsPanel />}

      {/* Dreams Tab */}
      {mainTab === 'dreams' && (
        <>
          <div className="toolbar">
            <span className="toolbar__label">Dream Reports</span>
            <div className="toolbar__spacer" />
            <button type="button" className="btn btn--sm" onClick={handleDreamNow} disabled={dreaming}>
              {dreaming ? 'Dreaming...' : 'Dream Now'}
            </button>
            {dreamNote && <span className="note--warn" role="status">{dreamNote}</span>}
          </div>
          {dreamReports.length === 0 ? (
            <div className="stub">
              <p className="stub__line">
                No dream reports yet. The dreaming cycle runs nightly at the configured time, or you can trigger it manually.
              </p>
            </div>
          ) : (
            dreamReports.map((report, i) => (
              <article
                key={report.id}
                className="tile anim"
                style={{ '--ci': `${i * 40}ms`, marginBottom: 12 } as React.CSSProperties}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-ui/55">{formatDate(report.createdAt)}</span>
                  <span className="pill pill--norm">{report.dreamMode}</span>
                </div>
                <pre className="text-xs text-ui/70 whitespace-pre-wrap font-mono leading-relaxed">
                  {report.reportText}
                </pre>
                {report.durationMs && (
                  <div className="text-[10px] text-ui/25 mt-2">
                    Duration: {(report.durationMs / 1000).toFixed(1)}s
                  </div>
                )}
              </article>
            ))
          )}
        </>
      )}

      {/* Inject Memory modal */}
      {injectOpen && (
        <ModalShell
          onClose={() => setInjectOpen(false)}
          label="Inject Memory"
          backdropClassName="glass-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
          panelClassName="glass-modal rounded-2xl w-full max-w-lg mx-4"
          closeOnEscape={!injecting}
          closeOnBackdrop={false}
        >
            <div className="px-5 py-4 border-b border-ui/[0.06]">
              <h3 className="text-sm font-medium text-ui">Inject Memory</h3>
              <p className="text-xs text-ui/40 mt-1">
                Add content directly into the agent's memory store.
              </p>
            </div>
            <div className="p-5">
              <textarea
                value={injectContent}
                onChange={(e) => {
                  setInjectContent(e.target.value);
                  setInjectError(null);
                }}
                placeholder="Enter memory content to inject..."
                className="glass-textarea w-full h-40 font-mono resize-y"
              />
              {injectError && (
                <p
                  role="alert"
                  className="text-xs mt-2"
                  style={{ color: 'var(--dojo3-rust)' }}
                >
                  Error: {injectError}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ui/[0.06]">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setInjectOpen(false);
                  setInjectContent('');
                  setInjectError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={handleInject}
                disabled={injecting || !injectContent.trim()}
              >
                {injecting ? 'Injecting...' : 'Inject'}
              </button>
            </div>
        </ModalShell>
      )}
    </>
  );
};
