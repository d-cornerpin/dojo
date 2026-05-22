import { useState } from 'react';
import * as api from '../lib/api';

// Forensic memory search panel — substring search across vault, summaries,
// projects, tasks, and scratchpads. Operator-grade cleanup tool for the
// self-reinforcing-memory failure mode: an agent embeds a wrong string in
// vault/summary "don't do this" reminders, then keeps reading and
// reproducing it on every turn. The agent's own vault_search uses semantic
// embeddings and is structurally blind to exact substrings, so the
// operator needs a separate path.

type Kind = 'vault' | 'summary' | 'project' | 'task' | 'scratchpad';

interface ForensicHit {
  kind: Kind;
  id: string;
  agentId: string | null;
  title: string | null;
  preview: string;
  createdAt: string | null;
}

interface PurgeResult {
  kind: Kind;
  id: string;
  deleted: boolean;
  error?: string;
}

const KIND_LABELS: Record<Kind, string> = {
  vault: 'Vault',
  summary: 'Summary',
  project: 'Project',
  task: 'Task',
  scratchpad: 'Scratchpad',
};

const KIND_ORDER: Kind[] = ['vault', 'summary', 'scratchpad', 'project', 'task'];

export const ForensicSearchPanel = () => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<ForensicHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  const [lastPurge, setLastPurge] = useState<{ deleted: number; total: number; failures: PurgeResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    const q = query.trim();
    if (q.length < 2) {
      setError('Query must be at least 2 characters.');
      return;
    }
    setError(null);
    setSearching(true);
    setLastPurge(null);
    try {
      const result = await api.request<{ query: string; total: number; hits: ForensicHit[] }>(
        `/memory/forensic-search?q=${encodeURIComponent(q)}`,
      );
      if (result.ok) {
        setHits(result.data.hits);
        setSelected(new Set());
        setSearched(true);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const handleToggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelected(new Set(hits.map(h => `${h.kind}:${h.id}`)));
  };
  const handleSelectNone = () => setSelected(new Set());

  const handlePurge = async () => {
    if (selected.size === 0) return;
    const items = hits
      .filter(h => selected.has(`${h.kind}:${h.id}`))
      .map(h => ({ kind: h.kind, id: h.id }));
    const confirmed = confirm(
      `Permanently delete ${items.length} item${items.length === 1 ? '' : 's'}? This cannot be undone. Vault entries, summaries, and tracker rows will be deleted; scratchpads will be cleared.`,
    );
    if (!confirmed) return;

    setPurging(true);
    setError(null);
    try {
      const result = await api.request<{ deleted: number; total: number; results: PurgeResult[] }>(
        '/memory/forensic-purge',
        { method: 'POST', body: JSON.stringify({ items }) },
      );
      if (result.ok) {
        setLastPurge({
          deleted: result.data.deleted,
          total: result.data.total,
          failures: result.data.results.filter(r => !r.deleted),
        });
        // Re-run the search so the table reflects the deletions.
        await handleSearch();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPurging(false);
    }
  };

  // Group hits by kind for the display, preserving KIND_ORDER.
  const grouped = KIND_ORDER.map(kind => ({
    kind,
    rows: hits.filter(h => h.kind === kind),
  })).filter(g => g.rows.length > 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-ui/[0.06] space-y-3">
        <div>
          <h3 className="text-sm font-medium text-ui">Forensic substring search</h3>
          <p className="text-xs text-ui/40 mt-0.5">
            Exact substring match across vault entries, summaries, tracker projects/tasks, and per-agent scratchpads.
            Use this to find and purge a wrong string that an agent has embedded across its own persistent memory
            (e.g. a typo it keeps reproducing because it keeps reading itself reminded "don't do X").
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="exact substring to search for"
            className="glass-input flex-1"
          />
          <button
            onClick={handleSearch}
            disabled={searching || query.trim().length < 2}
            className="px-4 py-1.5 glass-btn-primary text-xs rounded-lg disabled:opacity-30"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
        {error && <div className="alert-banner alert-error text-xs">{error}</div>}
        {lastPurge && (
          <div className="alert-banner alert-success text-xs">
            Purged {lastPurge.deleted} of {lastPurge.total}.
            {lastPurge.failures.length > 0 && ` ${lastPurge.failures.length} failed.`}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!searched && (
          <p className="text-center text-ui/30 text-sm py-12">
            Enter a string above to scan persistent memory across every agent.
          </p>
        )}
        {searched && hits.length === 0 && (
          <p className="text-center text-ui/40 text-sm py-12">
            No matches for "{query}" in vault, summaries, tracker, or scratchpads.
          </p>
        )}
        {hits.length > 0 && (
          <>
            <div className="flex items-center justify-between sticky top-0 bg-bg/95 backdrop-blur-sm py-2 -mx-4 px-4 border-b border-ui/[0.06]">
              <div className="flex items-center gap-3 text-xs text-ui/55">
                <span>{hits.length} match{hits.length === 1 ? '' : 'es'}</span>
                <button onClick={handleSelectAll} className="text-ui/40 hover:text-ui/70">Select all</button>
                <button onClick={handleSelectNone} className="text-ui/40 hover:text-ui/70">Clear</button>
              </div>
              <button
                onClick={handlePurge}
                disabled={selected.size === 0 || purging}
                className="px-3 py-1.5 bg-cp-coral/10 hover:bg-cp-coral/20 text-cp-coral text-xs rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {purging ? 'Purging...' : `Purge ${selected.size} selected`}
              </button>
            </div>

            {grouped.map(group => (
              <div key={group.kind} className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-ui/40">
                  {KIND_LABELS[group.kind]} ({group.rows.length})
                </h4>
                <div className="space-y-2">
                  {group.rows.map(hit => {
                    const key = `${hit.kind}:${hit.id}`;
                    const isSelected = selected.has(key);
                    return (
                      <label
                        key={key}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          isSelected
                            ? 'border-cp-amber/40 bg-cp-amber/[0.06]'
                            : 'border-ui/[0.06] bg-ui/[0.02] hover:bg-ui/[0.04]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggle(key)}
                          className="mt-1 rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs">
                            {hit.title && <span className="text-ui/70 font-medium">{hit.title}</span>}
                            {hit.agentId && <span className="text-ui/40">{hit.agentId}</span>}
                            {hit.createdAt && (
                              <span className="text-ui/25">{new Date(hit.createdAt).toLocaleString()}</span>
                            )}
                            <span className="text-ui/25 ml-auto truncate" title={hit.id}>
                              {hit.id.slice(0, 12)}…
                            </span>
                          </div>
                          <p className="text-xs text-ui/55 mt-1 break-words whitespace-pre-wrap">
                            {hit.preview}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};
