import { useState } from 'react';
import type { VaultEntry } from '../lib/api';
import * as api from '../lib/api';
import { formatRelative } from '../lib/dates';

// Map the seven real vault entry types onto the three tbadge variants the
// prototype ships (fact / procedure / event). Procedures and events keep
// their own chips; everything else (fact, preference, decision,
// relationship, note) reads as the indigo "fact" chip.
const TBADGE_BY_TYPE: Record<string, string> = {
  fact: 'tbadge--fact',
  preference: 'tbadge--fact',
  decision: 'tbadge--fact',
  relationship: 'tbadge--fact',
  note: 'tbadge--fact',
  procedure: 'tbadge--procedure',
  event: 'tbadge--event',
};

// FU-2: render an entry's source citation compactly for the meta row. Returns
// null for a missing/malformed citation so the row shows nothing. File paths
// collapse to the file name; URLs show as-is.
function formatCitation(citation: string | null): string | null {
  if (!citation) return null;
  try {
    const c = JSON.parse(citation) as { kind?: string; ref?: string; page?: number; section?: string };
    if (!c || typeof c.ref !== 'string' || c.ref.length === 0) return null;
    let ref = c.ref;
    if (c.kind === 'file') {
      const seg = ref.split(/[\\/]/).filter(Boolean).pop();
      if (seg) ref = seg;
    }
    let s = ref;
    if (typeof c.page === 'number' && Number.isFinite(c.page)) s += ` p.${c.page}`;
    if (typeof c.section === 'string' && c.section.trim().length > 0) s += ` (${c.section.trim()})`;
    return s;
  } catch {
    return null;
  }
}

interface VaultEntryCardProps {
  entry: VaultEntry;
  // Stagger index for the entrance animation (--ci on .anim).
  index?: number;
  onUpdated: () => void;
  onDeleted: () => void;
}

export const VaultEntryCard = ({ entry, index = 0, onUpdated, onDeleted }: VaultEntryCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleTogglePin = async () => {
    await api.updateVaultEntry(entry.id, { pin: !entry.isPinned });
    onUpdated();
  };

  const handleTogglePermanent = async () => {
    await api.updateVaultEntry(entry.id, { permanent: !entry.isPermanent });
    onUpdated();
  };

  const handleMarkObsolete = async () => {
    if (!confirm('Mark this entry as obsolete?')) return;
    await api.markVaultEntryObsolete(entry.id, 'Marked obsolete from dashboard');
    onUpdated();
  };

  const handleDelete = async () => {
    if (!confirm('Permanently delete this entry?')) return;
    setDeleting(true);
    await api.deleteVaultEntry(entry.id);
    onDeleted();
  };

  const tbadge = TBADGE_BY_TYPE[entry.type] ?? 'tbadge--fact';
  const ago = formatRelative(entry.createdAt);
  const citation = formatCitation(entry.citation);
  // Pinned and permanent rows get the trailing Perm pill and the matching
  // padding reservation (.vrow--pinned).
  const flagged = entry.isPinned || entry.isPermanent;

  return (
    <article
      className={`tile vrow anim${flagged ? ' vrow--pinned' : ''}`}
      style={{ '--ci': `${index * 40}ms`, cursor: 'pointer' } as React.CSSProperties}
      onClick={() => setExpanded(!expanded)}
    >
      <span className={`tbadge ${tbadge}`}>{entry.type}</span>

      <div className="vrow__body">
        <div
          className="vrow__text"
          style={expanded ? { display: 'block', WebkitLineClamp: 'unset' } : undefined}
        >
          {entry.content}
        </div>

        <div className="vrow__meta">
          <span>{entry.agentName ?? 'system'}</span>
          <span>{ago}</span>
          <span>conf: {(entry.confidence * 100).toFixed(0)}%</span>
          {entry.retrievalCount > 0 && <span>used {entry.retrievalCount}x</span>}
          <span>{entry.source}</span>
          {citation && <span title={entry.citation ?? undefined}>source: {citation}</span>}
        </div>

        {entry.tags.length > 0 && (
          <div className="tagrow">
            {entry.tags.map((tag) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
          </div>
        )}

        {expanded && (
          <div
            className="tagrow"
            style={{ marginTop: 12, gap: 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="btn btn--sm" onClick={handleTogglePin}>
              {entry.isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button type="button" className="btn btn--sm" onClick={handleTogglePermanent}>
              {entry.isPermanent ? 'Unpermanent' : 'Permanent'}
            </button>
            <button type="button" className="btn btn--sm" onClick={handleMarkObsolete}>
              Obsolete
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {flagged && <span className="pill pill--ok">Perm</span>}
    </article>
  );
};
