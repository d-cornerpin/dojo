import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../lib/dates';

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

interface VersionData {
  id: string;
  versionNumber: number;
  techniqueMd: string;
  changedBy: string | null;
  changeSummary: string | null;
  createdAt: string;
}

interface UsageData {
  id: string;
  agentId: string;
  agentName: string | null;
  usedAt: string;
  success: boolean | null;
  notes: string | null;
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

function getToken(): string | null { return localStorage.getItem('dojo_token'); }

async function api(path: string, options?: RequestInit) {
  const token = getToken();
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  const csrf = csrfMatch ? csrfMatch[1] : null;
  const method = options?.method?.toUpperCase() ?? 'GET';
  const needsCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  const res = await fetch(`/api/techniques${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(needsCsrf && csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...options?.headers,
    },
  });
  return res.json();
}

type Tab = 'overview' | 'instructions' | 'files' | 'usage' | 'versions';

export const TechniqueDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [technique, setTechnique] = useState<TechniqueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const load = async () => {
    if (!id) return;
    const data = await api(`/${id}`);
    if (data.ok) setTechnique(data.data);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  if (loading) {
    return <div className="stub"><p className="stub__line">Loading technique...</p></div>;
  }
  if (!technique) {
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
    if (isPublished) {
      await api(`/${id}`, { method: 'PUT', body: JSON.stringify({ state: 'draft' }) });
    } else {
      await api(`/${id}/publish`, { method: 'POST' });
    }
    load();
  };

  const handleDelete = async () => {
    if (!confirm('Delete this technique? This cannot be undone.')) return;
    await api(`/${id}`, { method: 'DELETE' });
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

      {/* Tab strip — same .tabs pill rail as the rest of the redesign. */}
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

// ── Files Tab (read-only) ──

const FilesTab = ({ technique }: { technique: TechniqueData }) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);

  const loadFile = async (filePath: string) => {
    setLoadingFile(true);
    setSelectedFile(filePath);
    const data = await api(`/${technique.id}/files/${filePath}`);
    if (data.ok) setFileContent(data.data.content);
    setLoadingFile(false);
  };

  const files = technique.files.filter(f => !f.isDirectory);
  const dirs = technique.files.filter(f => f.isDirectory);

  return (
    <div className="flex gap-4 min-h-[400px]">
      <div className="tile w-64 shrink-0 overflow-y-auto" style={{ padding: 10 }}>
        {dirs.map(d => (
          <div key={d.path} className="text-xs text-ui/40 py-1 pl-1">{'\u{1F4C1}'} {d.path}/</div>
        ))}
        {files.map(f => (
          <button
            key={f.path}
            type="button"
            onClick={() => loadFile(f.path)}
            className={`w-full text-left text-xs py-1.5 px-2 rounded transition-colors ${
              selectedFile === f.path ? 'bg-ui/[0.08] text-ui' : 'text-ui/55 hover:text-ui/70 hover:bg-ui/[0.05]'
            }`}
          >
            {'\u{1F4C4}'} {f.path} <span className="text-ui/25 ml-1">({f.size}B)</span>
          </button>
        ))}
        {files.length === 0 && <p className="text-xs text-ui/25 py-2">No files</p>}
      </div>

      <div className="tile flex-1">
        {selectedFile ? (
          loadingFile ? (
            <p className="text-ui/40 text-sm">Loading...</p>
          ) : (
            <div>
              <div className="text-xs text-ui/40 mb-2">{selectedFile}</div>
              <pre className="text-xs text-ui/70 font-mono whitespace-pre-wrap overflow-auto max-h-[500px]">{fileContent}</pre>
            </div>
          )
        ) : (
          <p className="text-ui/25 text-sm">Select a file to view</p>
        )}
      </div>
    </div>
  );
};

// ── Usage Tab ──

const UsageTab = ({ techniqueId }: { techniqueId: string }) => {
  const [usage, setUsage] = useState<UsageData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api(`/${techniqueId}/usage`).then(data => {
      if (data.ok) setUsage(data.data);
      setLoading(false);
    });
  }, [techniqueId]);

  if (loading) return <p className="text-ui/40">Loading usage...</p>;
  if (usage.length === 0) {
    return <div className="tile"><div className="scard__desc" style={{ marginBottom: 0 }}>No usage recorded yet.</div></div>;
  }

  return (
    <div className="tile overflow-hidden" style={{ padding: 0 }}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-ui/40 border-b border-ui/[0.06]">
            <th className="text-left p-3">Agent</th>
            <th className="text-left p-3">When</th>
            <th className="text-left p-3">Notes</th>
          </tr>
        </thead>
        <tbody>
          {usage.map(u => (
            <tr key={u.id} className="border-b border-ui/[0.06]">
              <td className="p-3 text-ui/70">{u.agentName ?? u.agentId.slice(0, 8)}</td>
              <td className="p-3 text-ui/55">{formatDate(u.usedAt)}</td>
              <td className="p-3 text-ui/40">{u.notes ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ── Versions Tab ──

const VersionsTab = ({ techniqueId }: { techniqueId: string }) => {
  const [versions, setVersions] = useState<VersionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<VersionData | null>(null);

  useEffect(() => {
    api(`/${techniqueId}/versions`).then(data => {
      if (data.ok) setVersions(data.data);
      setLoading(false);
    });
  }, [techniqueId]);

  if (loading) return <p className="text-ui/40">Loading versions...</p>;

  return (
    <div className="flex gap-4 min-h-[400px]">
      <div className="w-72 shrink-0 space-y-1.5">
        {versions.map(v => (
          <button
            key={v.id}
            type="button"
            onClick={() => setSelectedVersion(v)}
            className={`tile w-full text-left transition-colors ${
              selectedVersion?.id === v.id ? 'ring-1 ring-cp-amber/40' : 'hover:bg-ui/[0.05]'
            }`}
            style={{ padding: 12 }}
          >
            <div className="text-sm text-ui/70">Version {v.versionNumber}</div>
            <div className="text-xs text-ui/40 mt-0.5">{v.changeSummary ?? 'No description'}</div>
            <div className="text-[10px] text-ui/25 mt-0.5">
              {v.changedBy ?? 'system'} &middot; {formatDate(v.createdAt)}
            </div>
          </button>
        ))}
      </div>

      <div className="tile flex-1">
        {selectedVersion ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-ui/70">Version {selectedVersion.versionNumber}</span>
            </div>
            <pre className="text-xs text-ui/70 font-mono whitespace-pre-wrap overflow-auto max-h-[500px]">
              {selectedVersion.techniqueMd}
            </pre>
          </>
        ) : (
          <p className="text-ui/25 text-sm">Select a version to preview</p>
        )}
      </div>
    </div>
  );
};
