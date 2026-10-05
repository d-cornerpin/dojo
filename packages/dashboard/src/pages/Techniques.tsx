import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApiResponse } from '@dojo/shared';
import { TechniqueCard } from '../components/TechniqueCard';
import { useWebSocket } from '../hooks/useWebSocket';
import { request, requestForm } from '../lib/api';

interface Technique {
  id: string;
  name: string;
  description: string | null;
  state: string;
  tags: string[];
  authorAgentName: string | null;
  enabled: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  version: number;
  // v2.7.9 — included so the grid can sort newest-first. Already returned
  // by the server (store.ts:rowToTechnique); just wiring it into the
  // dashboard type so we can use it.
  createdAt: string;
}

const STATE_FILTERS = ['All', 'Published', 'Drafts', 'Disabled'] as const;

/**
 * ⚠ THIS USED TO ANSWER `Technique[]` AND SWALLOW THE FAILURE (BACKLOG line 31).
 * `data.ok ? data.data : []` made "the server is down" and "you have no
 * techniques yet" the same empty grid, and the bare `fetch` it was built on
 * escaped as an UNHANDLED REJECTION when there was no server at all. The
 * envelope is returned whole so `load` can draw the difference.
 */
const fetchTechniques = (
  state?: string,
  tag?: string,
  search?: string,
): Promise<ApiResponse<Technique[]>> => {
  const params = new URLSearchParams();
  if (state && state !== 'All') {
    const stateMap: Record<string, string> = { Published: 'published', Drafts: 'draft', Disabled: 'disabled' };
    params.set('state', stateMap[state] ?? state);
  }
  if (tag) params.set('tag', tag);
  if (search) params.set('search', search);
  return request<Technique[]>(`/techniques?${params}`);
};

async function uploadTechniquePackage(file: File): Promise<{ techniqueId: string; needsSetup: boolean; name: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  // `requestForm` leaves Content-Type to the browser so the multipart boundary
  // matches the body, and carries the auth + CSRF headers this call needs.
  const data = await requestForm<{ techniqueId: string; needsSetup: boolean; name: string }>(
    '/techniques/import', form,
  );
  if (!data.ok) throw new Error(data.error || 'Import failed');
  return data.data;
}

const toggleTechnique = (id: string, enabled: boolean): Promise<ApiResponse<unknown>> =>
  request(`/techniques/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });

export const Techniques = () => {
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();
  const [techniques, setTechniques] = useState<Technique[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<string>('All');
  const [tagFilter, setTagFilter] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const allTags = [...new Set(techniques.flatMap(t => t.tags))].sort();

  const load = async () => {
    const result = await fetchTechniques(
      stateFilter !== 'All' ? stateFilter : undefined,
      tagFilter || undefined,
      search || undefined,
    );
    setLoading(false);
    if (!result.ok) {
      // SAY SO. An empty grid is what "you have none yet" looks like, so a
      // failed load that only cleared the list told the owner the opposite of
      // the truth. The previous list is left on screen rather than blanked —
      // stale rows beat no rows while the server is coming back.
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    // v2.7.9 — newest-first by createdAt. Server sorts by usage_count
    // for agent-tool consumers (most-used surfaces first), but the
    // dashboard grid is for the human and they want the freshest
    // techniques at the top.
    const sorted = [...result.data].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    setTechniques(sorted);
  };

  useEffect(() => { load(); }, [stateFilter, tagFilter]);

  // Refresh on technique events (used, created, published, updated)
  useEffect(() => {
    const unsub1 = subscribe('technique:used', () => load());
    const unsub2 = subscribe('technique:created', () => load());
    const unsub3 = subscribe('technique:published', () => load());
    const unsub4 = subscribe('technique:updated', () => load());
    const unsub5 = subscribe('technique:state_changed', () => load());
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); };
  }, [subscribe]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => load(), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const handleToggle = async (id: string, enabled: boolean) => {
    await toggleTechnique(id, enabled);
    setTechniques(prev => prev.map(t => t.id === id ? { ...t, enabled } : t));
  };

  const handleImportClick = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still fires
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await uploadTechniquePackage(file);
      // Route to the training mat for setup. Needs_setup techniques land
      // in the trainer chat with the import context pre-loaded so the Trainer
      // walks the user through any placeholders.
      navigate(`/techniques/${result.techniqueId}/edit`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      {/* Header */}
      <header className="phead">
        <h2 className="phead__title">Techniques</h2>
        <span className="phead__meta">{techniques.length} technique{techniques.length !== 1 ? 's' : ''}</span>
        <div className="phead__actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            type="button"
            onClick={handleImportClick}
            disabled={importing}
            className="btn"
            title="Import a .dojo.zip technique package"
          >
            {importing ? 'Importing…' : 'Import Technique'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/techniques/new')}
            className="btn btn--primary"
          >
            + Create Technique
          </button>
        </div>
      </header>

      {importError && (
        <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }}>
          Import failed: {importError}
        </div>
      )}

      {loadError && (
        <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }}>
          Could not load techniques: {loadError}{' '}
          <button type="button" className="btn btn--ghost" onClick={() => { void load(); }}>Retry</button>
        </div>
      )}

      {/* Toolbar: search + state tabs + tag filter */}
      <div className="toolbar">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search techniques"
          aria-label="Search techniques"
          className="field"
        />

        <div className="tabs" role="tablist">
          {STATE_FILTERS.map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setStateFilter(f)}
              className={`tab ${stateFilter === f ? 'is-active' : ''}`}
            >
              {f}
            </button>
          ))}
        </div>

        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            aria-label="Tag filter"
            className="field field--select"
          >
            <option value="">All tags</option>
            {allTags.map(tag => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="stub">
          <p className="stub__line">Loading techniques...</p>
        </div>
      ) : techniques.length === 0 ? (
        <div className="stub">
          <p className="stub__line" style={{ fontWeight: 600, color: 'var(--dojo3-ink-2)', marginBottom: 8 }}>No techniques yet</p>
          <p className="stub__line">
            Techniques are reusable skills your agents learn and share.
            Create your first one or ask your agent to save what they learn.
          </p>
        </div>
      ) : (
        <div className="cards">
          {techniques.map((t, i) => (
            <TechniqueCard key={t.id} technique={t} onToggle={handleToggle} index={i} />
          ))}
        </div>
      )}
    </>
  );
};
