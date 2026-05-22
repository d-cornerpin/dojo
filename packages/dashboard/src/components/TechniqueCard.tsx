import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatRelative } from '../lib/dates';
import { useToast } from '../hooks/useToast';

interface TechniqueData {
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

const stateBadge: Record<string, { cls: string; label: string }> = {
  published: { cls: 'glass-badge-teal', label: 'Published' },
  draft: { cls: 'glass-badge-amber', label: 'Draft' },
  review: { cls: 'glass-badge-blue', label: 'Review' },
  disabled: { cls: 'glass-badge-gray', label: 'Disabled' },
  archived: { cls: 'text-ui/25 bg-ui/[0.03]', label: 'Archived' },
  needs_setup: { cls: 'glass-badge-coral', label: 'Needs setup' },
};

const tagColors = ['glass-badge-purple', 'glass-badge-blue', 'glass-badge-teal', 'glass-badge-amber', 'glass-badge-coral'];

interface ExportResolution {
  ref: string;
  source: string;
  action: 'bundled' | 'declared_as_manual_step';
  detail: string;
}

async function exportTechniqueToBrowser(id: string): Promise<{ resolutions: ExportResolution[] }> {
  const token = localStorage.getItem('dojo_token');
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  const csrf = csrfMatch ? csrfMatch[1] : null;

  const res = await fetch(`/api/techniques/${id}/export`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
  });

  if (!res.ok) {
    let message = `Export failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch { /* response wasn't JSON */ }
    throw new Error(message);
  }

  // Pick up the auto-resolver's log before consuming the body. Server
  // base64-encodes the JSON to keep the header value ASCII-safe (some
  // detail strings contain non-Latin characters like the file-path
  // arrows used in stub messages).
  let resolutions: ExportResolution[] = [];
  const resolutionsHeader = res.headers.get('X-Dojo-Export-Resolutions');
  if (resolutionsHeader) {
    try {
      const json = atob(resolutionsHeader);
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) resolutions = parsed as ExportResolution[];
    } catch { /* malformed header — ignore, still deliver the zip */ }
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : `${id}.dojo.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  return { resolutions };
}

export const TechniqueCard = ({ technique, onToggle }: { technique: TechniqueData; onToggle?: (id: string, enabled: boolean) => void }) => {
  const navigate = useNavigate();
  const toast = useToast();
  const badge = stateBadge[technique.state] ?? stateBadge.draft;
  const [sharing, setSharing] = useState(false);

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (sharing) return;
    setSharing(true);
    try {
      const { resolutions } = await exportTechniqueToBrowser(technique.id);
      // Auto-resolver ran when TECHNIQUE.md referenced files we
      // couldn't drop straight into the zip. Summarize: how many got
      // bundled (we found the file and shipped it) vs how many got
      // added as manual_steps (couldn't fetch — receiver's user
      // supplies). Non-blocking toast; the zip already downloaded.
      if (resolutions.length > 0) {
        const bundled = resolutions.filter(r => r.action === 'bundled').length;
        const manual = resolutions.filter(r => r.action === 'declared_as_manual_step').length;
        const parts: string[] = [];
        if (bundled > 0) parts.push(`${bundled} file${bundled === 1 ? '' : 's'} auto-bundled`);
        if (manual > 0) parts.push(`${manual} reference${manual === 1 ? '' : 's'} added as manual setup steps`);
        const summary = `Technique exported with ${parts.join(' and ')}. Receiving trainer will walk the user through any manual steps on import.`;
        if (manual > 0) toast.warning(summary);
        else toast.info(summary);
      }
    } catch (err) {
      // Hard failures (technique not found, IO error, etc.) — error
      // toast. Validator refusals no longer reach this path; they're
      // auto-resolved server-side and never throw.
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  };

  return (
    <div
      onClick={() => navigate(`/techniques/${technique.id}`)}
      className="glass-card glass-card-hover p-5 cursor-pointer group"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ui truncate">{technique.name}</h3>
          <p className="text-xs text-ui/40 mt-0.5 line-clamp-2">{technique.description ?? 'No description'}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <button
            type="button"
            onClick={handleShare}
            disabled={sharing}
            title={sharing ? 'Packaging…' : 'Share this technique (downloads a .dojo.zip)'}
            aria-label="Share technique"
            className="p-1 rounded-md text-ui/40 hover:text-ui hover:bg-ui/[0.06] transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            {sharing ? (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            )}
          </button>
          <span className={`glass-badge ${badge.cls}`}>{badge.label}</span>
        </div>
      </div>

      {/* Tags */}
      {technique.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {technique.tags.slice(0, 4).map((tag, i) => (
            <span key={tag} className={`glass-badge ${tagColors[i % tagColors.length]}`}>
              {tag}
            </span>
          ))}
          {technique.tags.length > 4 && (
            <span className="text-[10px] text-ui/25">+{technique.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-ui/40">
        <span>{technique.authorAgentName ?? 'Unknown'}</span>
        <div className="flex items-center gap-3">
          <span>{technique.usageCount} use{technique.usageCount !== 1 ? 's' : ''}</span>
          {technique.lastUsedAt && <span>{formatRelative(technique.lastUsedAt)}</span>}
          <span>v{technique.version}</span>
        </div>
      </div>

      {/* Enable/Disable toggle for published */}
      {technique.state === 'published' && onToggle && (
        <div className="mt-3 pt-3 border-t border-ui/[0.06] flex items-center justify-between">
          <span className="text-xs text-ui/40">Enabled</span>
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(technique.id, !technique.enabled); }}
            className={`toggle-switch ${technique.enabled ? 'toggle-on' : ''}`}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}

      {technique.state === 'needs_setup' && (
        <div className="mt-3 pt-3 border-t border-ui/[0.06] text-xs text-ui/55">
          Open this technique to finish setup with your trainer.
        </div>
      )}
    </div>
  );
};
