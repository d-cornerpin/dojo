import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
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

const stateBadge: Record<string, { cls: string; label: string }> = {
  published: { cls: 'glass-badge-teal', label: 'Published' },
  draft: { cls: 'glass-badge-amber', label: 'Draft' },
  review: { cls: 'glass-badge-blue', label: 'Review' },
  disabled: { cls: 'glass-badge-gray', label: 'Disabled' },
  archived: { cls: 'text-white/20 bg-white/[0.03]', label: 'Archived' },
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

  if (loading) return <div className="flex-1 flex items-center justify-center"><p className="text-white/40">Loading...</p></div>;
  if (!technique) return <div className="flex-1 flex items-center justify-center"><p className="text-red-400">Technique not found</p></div>;

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
    <div className="flex-1 flex flex-col min-h-0 p-4 md:p-6 overflow-y-auto">
      {/* Back link */}
      <Link to="/techniques" className="text-xs text-white/40 hover:text-white/70 mb-4 inline-flex items-center gap-1">
        {'\u2190'} Back to Techniques
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-white">{technique.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className={`glass-badge ${badge.cls}`}>{badge.label}</span>
            <span className="text-xs text-white/30">v{technique.version}</span>
            {technique.authorAgentName && <span className="text-xs text-white/30">by {technique.authorAgentName}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePublishToggle}
            className={isPublished ? 'glass-btn glass-btn-secondary text-sm' : 'glass-btn glass-btn-primary text-sm'}
          >
            {isPublished ? 'Unpublish' : 'Publish'}
          </button>
          <button
            onClick={() => navigate(`/techniques/${id}/edit`)}
            className="glass-btn glass-btn-secondary text-sm"
          >
            Edit
          </button>
          <button
            onClick={handleDelete}
            className="glass-btn glass-btn-destructive text-sm"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-white/[0.06] pb-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-white/[0.08] text-white font-medium'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content — all read-only */}
      {activeTab === 'overview' && <OverviewTab technique={technique} />}
      {activeTab === 'instructions' && <InstructionsTab technique={technique} />}
      {activeTab === 'files' && <FilesTab technique={technique} />}
      {activeTab === 'usage' && <UsageTab techniqueId={technique.id} />}
      {activeTab === 'versions' && <VersionsTab techniqueId={technique.id} />}
    </div>
  );
};

// ── Overview Tab (read-only) ──

const OverviewTab = ({ technique }: { technique: TechniqueData }) => (
  <div className="space-y-4 max-w-2xl">
    <div className="glass-card p-4 space-y-2">
      <h3 className="text-sm font-medium text-white/70">Description</h3>
      <p className="text-sm text-white/80">{technique.description || <span className="text-white/30 italic">No description</span>}</p>
    </div>

    {technique.tags.length > 0 && (
      <div className="glass-card p-4 space-y-2">
        <h3 className="text-sm font-medium text-white/70">Tags</h3>
        <div className="flex flex-wrap gap-1.5">
          {technique.tags.map(tag => (
            <span key={tag} className="glass-badge glass-badge-blue text-xs">{tag}</span>
          ))}
        </div>
      </div>
    )}

    <div className="glass-card p-4 space-y-2">
      <h3 className="text-sm font-medium text-white/70">Stats</h3>
      <div className="grid grid-cols-2 gap-2 text-xs text-white/50">
        <div>Usage count: <span className="text-white/80">{technique.usageCount}</span></div>
        <div>Last used: <span className="text-white/80">{technique.lastUsedAt ? formatDate(technique.lastUsedAt) : 'Never'}</span></div>
        <div>Created: <span className="text-white/80">{formatDate(technique.createdAt)}</span></div>
        <div>Updated: <span className="text-white/80">{formatDate(technique.updatedAt)}</span></div>
        {technique.publishedAt && <div>Published: <span className="text-white/80">{formatDate(technique.publishedAt)}</span></div>}
        {technique.buildProjectId && <div>Build project: <Link to={`/tracker?project=${technique.buildProjectId}`} className="text-cp-blue hover:underline">{technique.buildProjectId.slice(0, 8)}</Link></div>}
      </div>
    </div>
  </div>
);

// ── Instructions Tab (read-only) ──

const InstructionsTab = ({ technique }: { technique: TechniqueData }) => (
  <div className="glass-card p-4">
    {technique.instructions ? (
      <pre className="text-sm text-white/80 font-mono whitespace-pre-wrap overflow-auto max-h-[600px]">
        {technique.instructions}
      </pre>
    ) : (
      <p className="text-white/30 text-sm italic">No instructions yet.</p>
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
      <div className="w-64 shrink-0 glass-card p-3 overflow-y-auto">
        {dirs.map(d => (
          <div key={d.path} className="text-xs text-white/40 py-1 pl-1">{'\u{1F4C1}'} {d.path}/</div>
        ))}
        {files.map(f => (
          <button
            key={f.path}
            onClick={() => loadFile(f.path)}
            className={`w-full text-left text-xs py-1.5 px-2 rounded transition-colors ${
              selectedFile === f.path ? 'bg-white/[0.08] text-white' : 'text-white/60 hover:text-white/80 hover:bg-white/[0.04]'
            }`}
          >
            {'\u{1F4C4}'} {f.path} <span className="text-white/30 ml-1">({f.size}B)</span>
          </button>
        ))}
        {files.length === 0 && <p className="text-xs text-white/30 py-2">No files</p>}
      </div>

      <div className="flex-1 glass-card p-4">
        {selectedFile ? (
          loadingFile ? (
            <p className="text-white/40 text-sm">Loading...</p>
          ) : (
            <div>
              <div className="text-xs text-white/40 mb-2">{selectedFile}</div>
              <pre className="text-xs text-white/80 font-mono whitespace-pre-wrap overflow-auto max-h-[500px]">{fileContent}</pre>
            </div>
          )
        ) : (
          <p className="text-white/30 text-sm">Select a file to view</p>
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

  if (loading) return <p className="text-white/40">Loading usage...</p>;
  if (usage.length === 0) return <p className="text-white/30 text-sm">No usage recorded yet.</p>;

  return (
    <div className="glass-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-white/40 border-b border-white/[0.06]">
            <th className="text-left p-3">Agent</th>
            <th className="text-left p-3">When</th>
            <th className="text-left p-3">Notes</th>
          </tr>
        </thead>
        <tbody>
          {usage.map(u => (
            <tr key={u.id} className="border-b border-white/[0.04]">
              <td className="p-3 text-white/80">{u.agentName ?? u.agentId.slice(0, 8)}</td>
              <td className="p-3 text-white/50">{formatDate(u.usedAt)}</td>
              <td className="p-3 text-white/40">{u.notes ?? '-'}</td>
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

  if (loading) return <p className="text-white/40">Loading versions...</p>;

  return (
    <div className="flex gap-4 min-h-[400px]">
      <div className="w-72 shrink-0 space-y-1.5">
        {versions.map(v => (
          <button
            key={v.id}
            onClick={() => setSelectedVersion(v)}
            className={`w-full text-left glass-nested p-3 rounded-lg transition-colors ${
              selectedVersion?.id === v.id ? 'ring-1 ring-cp-amber/40' : 'hover:bg-white/[0.04]'
            }`}
          >
            <div className="text-sm text-white/80">Version {v.versionNumber}</div>
            <div className="text-xs text-white/40 mt-0.5">{v.changeSummary ?? 'No description'}</div>
            <div className="text-[10px] text-white/30 mt-0.5">
              {v.changedBy ?? 'system'} &middot; {formatDate(v.createdAt)}
            </div>
          </button>
        ))}
      </div>

      <div className="flex-1 glass-card p-4">
        {selectedVersion ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-white/70">Version {selectedVersion.versionNumber}</span>
            </div>
            <pre className="text-xs text-white/70 font-mono whitespace-pre-wrap overflow-auto max-h-[500px]">
              {selectedVersion.techniqueMd}
            </pre>
          </>
        ) : (
          <p className="text-white/30 text-sm">Select a version to preview</p>
        )}
      </div>
    </div>
  );
};
