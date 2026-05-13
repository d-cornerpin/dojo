import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { TechniqueCard } from '../components/TechniqueCard';
import { useWebSocket } from '../hooks/useWebSocket';

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
}

const STATE_FILTERS = ['All', 'Published', 'Drafts', 'Disabled'] as const;

async function fetchTechniques(state?: string, tag?: string, search?: string): Promise<Technique[]> {
  const params = new URLSearchParams();
  if (state && state !== 'All') {
    const stateMap: Record<string, string> = { Published: 'published', Drafts: 'draft', Disabled: 'disabled' };
    params.set('state', stateMap[state] ?? state);
  }
  if (tag) params.set('tag', tag);
  if (search) params.set('search', search);

  const token = localStorage.getItem('dojo_token');
  const res = await fetch(`/api/techniques?${params}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json();
  return data.ok ? data.data : [];
}

async function uploadTechniquePackage(file: File): Promise<{ techniqueId: string; needsSetup: boolean; name: string }> {
  const token = localStorage.getItem('dojo_token');
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  const csrf = csrfMatch ? csrfMatch[1] : null;

  const form = new FormData();
  form.append('file', file, file.name);

  const res = await fetch('/api/techniques/import', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: form,
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Server returned a non-JSON response.' }));
  if (!data.ok) throw new Error(data.error || `Import failed (${res.status})`);
  return data.data;
}

async function toggleTechnique(id: string, enabled: boolean): Promise<void> {
  const token = localStorage.getItem('dojo_token');
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  const csrf = csrfMatch ? csrfMatch[1] : null;
  await fetch(`/api/techniques/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({ enabled }),
  });
}

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

  const allTags = [...new Set(techniques.flatMap(t => t.tags))].sort();

  const load = async () => {
    const data = await fetchTechniques(
      stateFilter !== 'All' ? stateFilter : undefined,
      tagFilter || undefined,
      search || undefined,
    );
    setTechniques(data);
    setLoading(false);
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
      // in the trainer chat with the import context pre-loaded so Yoshi
      // walks the user through any placeholders.
      navigate(`/techniques/${result.techniqueId}/edit`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex-1 p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg sm:text-xl font-bold text-ui">Techniques</h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            onClick={handleImportClick}
            disabled={importing}
            className="glass-btn text-sm disabled:opacity-60"
            title="Import a .dojo.zip technique package"
          >
            {importing ? 'Importing…' : 'Import Technique'}
          </button>
          <button
            onClick={() => navigate('/techniques/new')}
            className="glass-btn glass-btn-primary text-sm"
          >
            + Create Technique
          </button>
        </div>
      </div>

      {importError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-cp-coral/[0.08] text-sm text-cp-coral border border-cp-coral/20">
          Import failed: {importError}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search techniques..."
          className="glass-input px-4 py-2 text-sm w-64"
        />

        <div className="flex gap-1">
          {STATE_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setStateFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                stateFilter === f
                  ? 'bg-ui/[0.12] text-ui'
                  : 'bg-ui/[0.05] text-ui/40 hover:text-ui/70'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="glass-select text-xs py-1.5 px-3"
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
        <div className="flex items-center justify-center py-12">
          <p className="text-ui/40">Loading techniques...</p>
        </div>
      ) : techniques.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-4">{'\u{1F94B}'}</div>
          <h2 className="text-lg font-semibold text-ui/55 mb-2">No techniques yet</h2>
          <p className="text-sm text-ui/40 max-w-md mx-auto">
            Techniques are reusable skills your agents learn and share.
            Create your first one or ask your agent to save what they learn.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {techniques.map(t => (
            <TechniqueCard key={t.id} technique={t} onToggle={handleToggle} />
          ))}
        </div>
      )}
    </div>
  );
};
