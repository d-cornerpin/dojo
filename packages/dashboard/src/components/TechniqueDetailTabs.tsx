import { useState, useEffect, useRef } from 'react';
import { formatDate } from '../lib/dates';
import { request } from '../lib/api';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string, options?: RequestInit): Promise<any> {
  return request(`/techniques${path}`, options);
}

const LoadFailed = ({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) => (
  <div className="tile">
    <p className="text-cp-coral text-sm">Could not load {what}: {error}</p>
    <button type="button" className="btn btn--sm" onClick={onRetry}>Retry</button>
  </div>
);

// ── Files Tab (read-only) ──

export const FilesTab = ({ technique }: { technique: { id: string; files: Array<{ path: string; size: number; isDirectory: boolean }> } }) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Only the newest click may draw: an older read that answers last is dropped.
  const latest = useRef(0);

  const loadFile = async (filePath: string) => {
    const mine = ++latest.current;
    setLoadingFile(true);
    setSelectedFile(filePath);
    setFileContent('');
    setFileError(null);
    const data = await api(`/${technique.id}/files/${filePath}`);
    if (mine !== latest.current) return;
    if (data.ok) setFileContent(data.data.content);
    else setFileError(data.error ?? 'The file could not be read.');
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
              {fileError ? (
                <p className="text-cp-coral text-sm">Could not read the file: {fileError}</p>
              ) : (
                <pre className="text-xs text-ui/70 font-mono whitespace-pre-wrap overflow-auto max-h-[500px]">{fileContent}</pre>
              )}
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

export const UsageTab = ({ techniqueId }: { techniqueId: string }) => {
  const [usage, setUsage] = useState<UsageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api(`/${techniqueId}/usage`).then(data => {
      if (!active) return;
      if (data.ok) setUsage(data.data);
      else { setUsage([]); setError(data.error ?? 'unknown error'); }
      setLoading(false);
    });
    return () => { active = false; };
  }, [techniqueId, attempt]);

  if (loading) return <p className="text-ui/40">Loading usage...</p>;
  if (error) return <LoadFailed what="usage" error={error} onRetry={() => setAttempt(n => n + 1)} />;
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

export const VersionsTab = ({ techniqueId }: { techniqueId: string }) => {
  const [versions, setVersions] = useState<VersionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<VersionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setSelectedVersion(null);
    api(`/${techniqueId}/versions`).then(data => {
      if (!active) return;
      if (data.ok) setVersions(data.data);
      else { setVersions([]); setError(data.error ?? 'unknown error'); }
      setLoading(false);
    });
    return () => { active = false; };
  }, [techniqueId, attempt]);

  if (loading) return <p className="text-ui/40">Loading versions...</p>;
  if (error) return <LoadFailed what="versions" error={error} onRetry={() => setAttempt(n => n + 1)} />;

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
