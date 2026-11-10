import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../lib/dates';
import { request } from '../lib/api';
import { FilesTab, UsageTab, VersionsTab } from '../components/TechniqueDetailTabs';

// ── Types ──

interface TechniqueData {
  id: string;
  name: string;
  description: string | null;
  state: string;
  authorAgentName: string | null;
  tags: string[];
  enabled: boolean;
  version: number;
  usageCount: number;
  lastUsedAt: string | null;
  buildProjectId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  instructions: string | null;
  files: Array<{ path: string; size: number; isDirectory: boolean }>;
}

// State -> dojo3 .pill variant. Mirrors TechniqueCard so the detail header
// reads the same as the grid card the user clicked.
const stateBadge: Record<string, { cls: string; label: string }> = {
  published: { cls: 'pill--ok', label: 'Published' },
  draft: { cls: 'pill--draft', label: 'Draft' },
  review: { cls: 'pill--norm', label: 'Review' },
  disabled: { cls: 'pill--down', label: 'Disabled' },
  archived: { cls: 'pill--norm', label: 'Archived' },
  needs_setup: { cls: 'pill--draft', label: 'Needs setup' },
};

// Thin wrapper over lib/api's request. Keeps the name, the /techniques prefix
// and the loose return type so the call sites below read unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string, options?: RequestInit): Promise<any> {
  return request(`/techniques${path}`, options);
}

type Tab = 'overview' | 'instructions' | 'files' | 'usage' | 'versions';

export const TechniqueDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [technique, setTechnique] = useState<TechniqueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const load = async () => {
    if (!id) return;
    const data = await api(`/${id}`);
    if (data.ok) setTechnique(data.data);
    // The envelope carries no status (shared/src/api.ts), so the server's own
    // words are the only not-found signal; any other failure is NOT "missing".
    else if (!data.error.includes('not found')) setLoadError(data.error);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  if (loading) {
    return <div className="stub"><p className="stub__line">Loading technique...</p></div>;
  }
  if (!technique) {
    // A failed read that is not a not-found must not claim the technique is
    // missing, same note the Techniques list draws for its own load failure.
    if (loadError) {
      return (
        <div className="stub">
          <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }}>
            Could not load this technique: {loadError}{' '}
            <button type="button" className="btn btn--ghost" onClick={() => { void load(); }}>Retry</button>
          </div>
        </div>
      );
    }
    return (
      <div className="stub">
        <p className="stub__line" style={{ color: 'var(--dojo3-rust)' }}>Technique not found.</p>
        <button type="button" className="btn btn--sm" style={{ marginTop: 12 }} onClick={() => navigate('/techniques')}>
          Back to Techniques
        </button>
      </div>
    );
  }

  const badge = stateBadge[technique.state] ?? stateBadge.draft;
  const isPublished = technique.state === 'published';

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'instructions', label: 'Instructions' },
    { key: 'files', label: `Files (${technique.files.length})` },
    { key: 'usage', label: 'Usage' },
    { key: 'versions', label: `Versions (v${technique.version})` },
  ];

  const handlePublishToggle = async () => {
    setActionError(null);
    const result = isPublished
      ? await api(`/${id}`, { method: 'PUT', body: JSON.stringify({ state: 'draft' }) })
      : await api(`/${id}/publish`, { method: 'POST' });
    if (!result.ok) { setActionError(result.error); return; }
    load();
  };

  const handleDelete = async () => {
    if (!confirm('Delete this technique? This cannot be undone.')) return;
    setActionError(null);
    const result = await api(`/${id}`, { method: 'DELETE' });
    if (!result.ok) { setActionError(result.error); return; }
    navigate('/techniques');
  };

  return (
    <>
      {/* Self-headered panel: the page owns its .phead. State pill + version
          sit in the meta; Edit (opens the trainer Mat) is the primary action. */}
      <header className="phead">
        <button
          type="button"
          className="link"
          style={{ background: 'transparent', border: 0, marginRight: 4 }}
          onClick={() => navigate('/techniques')}
          title="Back to all techniques"
        >
          {'‹'} Techniques
        </button>
        <h2 className="phead__title">{technique.name}</h2>
        <span className="phead__meta">
          v{technique.version}{technique.authorAgentName ? ` · by ${technique.authorAgentName}` : ''}
        </span>
        <div className="phead__actions">
          <span className={`pill ${badge.cls}`}>{badge.label}</span>
          <button type="button" className="btn btn--sm" onClick={handlePublishToggle}>
            {isPublished ? 'Unpublish' : 'Publish'}
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => navigate(`/techniques/${id}/edit`)}>
            Edit
          </button>
          <button
            type="button"
            className="btn btn--sm"
            style={{ color: 'var(--dojo3-rust)' }}
            onClick={handleDelete}
          >
            Delete
          </button>
        </div>
      </header>

      {actionError && (
        <div className="note--warn" style={{ color: 'var(--dojo3-rust)' }}>
          {actionError}
        </div>
      )}

      {/* Tab strip, same .tabs pill rail as the rest of the redesign. */}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`tab${activeTab === tab.key ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && <OverviewTab technique={technique} navigate={navigate} />}
      {activeTab === 'instructions' && <InstructionsTab technique={technique} />}
      {activeTab === 'files' && <FilesTab technique={technique} />}
      {activeTab === 'usage' && <UsageTab techniqueId={technique.id} />}
      {activeTab === 'versions' && <VersionsTab techniqueId={technique.id} />}
    </>
  );
};

// ── Overview Tab (read-only) ──

const OverviewTab = ({ technique, navigate }: { technique: TechniqueData; navigate: (to: string) => void }) => (
  <div className="scards">
    <div className="tile">
      <div className="scard__title">Description</div>
      <div className="scard__desc" style={{ marginBottom: 0 }}>
        {technique.description || 'No description.'}
      </div>
    </div>

    {technique.tags.length > 0 && (
      <div className="tile">
        <div className="scard__title">Tags</div>
        <div className="tagrow">
          {technique.tags.map((tag) => (
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      </div>
    )}

    <div className="tile">
      <div className="scard__title">Stats</div>
      <div className="brow"><span className="brow__label">Usage count</span><span className="brow__val">{technique.usageCount}</span></div>
      <div className="brow"><span className="brow__label">Last used</span><span className="brow__val">{technique.lastUsedAt ? formatDate(technique.lastUsedAt) : 'Never'}</span></div>
      <div className="brow"><span className="brow__label">Created</span><span className="brow__val">{formatDate(technique.createdAt)}</span></div>
      <div className="brow"><span className="brow__label">Updated</span><span className="brow__val">{formatDate(technique.updatedAt)}</span></div>
      {technique.publishedAt && (
        <div className="brow"><span className="brow__label">Published</span><span className="brow__val">{formatDate(technique.publishedAt)}</span></div>
      )}
      {technique.buildProjectId && (
        <div className="brow">
          <span className="brow__label">Build project</span>
          <span className="brow__val">
            <button type="button" className="link" style={{ background: 'transparent', border: 0 }} onClick={() => navigate(`/tracker?project=${technique.buildProjectId}`)}>
              {technique.buildProjectId.slice(0, 8)}
            </button>
          </span>
        </div>
      )}
    </div>
  </div>
);

// ── Instructions Tab (read-only) ──

const InstructionsTab = ({ technique }: { technique: TechniqueData }) => (
  <div className="tile">
    {technique.instructions ? (
      <pre className="text-sm text-ui/70 font-mono whitespace-pre-wrap overflow-auto max-h-[600px]">
        {technique.instructions}
      </pre>
    ) : (
      <div className="scard__desc" style={{ marginBottom: 0 }}>No instructions yet.</div>
    )}
  </div>
);
