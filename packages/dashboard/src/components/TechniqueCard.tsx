import { useState } from 'react';
import type { CSSProperties } from 'react';
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

// State -> pill primitive. The prototype only shows Published/Draft, but the
// data model carries more states; map each onto the closest .pill--* variant.
const stateBadge: Record<string, { cls: string; label: string }> = {
  published: { cls: 'pill--ok', label: 'Published' },
  draft: { cls: 'pill--draft', label: 'Draft' },
  review: { cls: 'pill--norm', label: 'Review' },
  disabled: { cls: 'pill--down', label: 'Disabled' },
  archived: { cls: 'pill--norm', label: 'Archived' },
  needs_setup: { cls: 'pill--draft', label: 'Needs setup' },
};

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

export const TechniqueCard = ({
  technique,
  onToggle,
  index = 0,
}: {
  technique: TechniqueData;
  onToggle?: (id: string, enabled: boolean) => void;
  /** Stagger index for the card-entry animation (sets --ci). */
  index?: number;
}) => {
  const navigate = useNavigate();
  const toast = useToast();
  const badge = stateBadge[technique.state] ?? stateBadge.draft;
  const [sharing, setSharing] = useState(false);

  const cardStyle = {
    '--ci': `${index * 40}ms`,
    cursor: 'pointer',
  } as CSSProperties;

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

  const uses = `${technique.usageCount} use${technique.usageCount !== 1 ? 's' : ''}`;
  const age = technique.lastUsedAt ? formatRelative(technique.lastUsedAt) : 'never';
  const overflow = technique.tags.length - 4;

  return (
    <article
      onClick={() => navigate(`/techniques/${technique.id}`)}
      className="tile anim"
      style={cardStyle}
    >
      <div className="tech__head">
        <div className="tech__title">{technique.name}</div>
        <button
          type="button"
          onClick={handleShare}
          disabled={sharing}
          title={sharing ? 'Packaging…' : 'Share this technique (downloads a .dojo.zip)'}
          aria-label="Share technique"
          className="link"
          style={{ background: 'transparent', border: 0, flexShrink: 0, cursor: sharing ? 'wait' : 'pointer', opacity: sharing ? 0.5 : 1, display: 'inline-flex' }}
        >
          {sharing ? (
            <svg width="14" height="14" className="animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" y1="2" x2="12" y2="15" />
            </svg>
          )}
        </button>
        <span className={`pill ${badge.cls}`}>{badge.label}</span>
      </div>

      <div className="tech__desc">{technique.description ?? 'No description'}</div>

      {technique.tags.length > 0 && (
        <div className="tagrow">
          {technique.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="tag">{tag}</span>
          ))}
          {overflow > 0 && <span className="tag">+{overflow}</span>}
        </div>
      )}

      <div className="tech__meta">
        <span>{technique.authorAgentName ?? 'Unknown'}</span>
        <span>{uses} &middot; {age} &middot; v{technique.version}</span>
      </div>

      {/* Enable/Disable toggle for published */}
      {technique.state === 'published' && onToggle && (
        <div className="tech__foot">
          <span>Enabled</span>
          <button
            type="button"
            aria-label="Enabled"
            onClick={(e) => { e.stopPropagation(); onToggle(technique.id, !technique.enabled); }}
            className={`switch ${technique.enabled ? 'is-on' : ''}`}
          />
        </div>
      )}

      {technique.state === 'needs_setup' && (
        <div className="tech__foot" style={{ justifyContent: 'flex-start' }}>
          Open this technique to finish setup with your trainer.
        </div>
      )}
    </article>
  );
};
