import { useState } from 'react';
import type { VaultEntry } from '../lib/api';
import * as api from '../lib/api';
import { formatRelative } from '../lib/dates';

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-cp-blue/20 text-cp-blue',
  preference: 'bg-cp-purple/20 text-cp-purple',
  decision: 'bg-cp-amber/20 text-cp-amber',
  procedure: 'bg-cp-teal/20 text-cp-teal',
  relationship: 'bg-cp-coral/20 text-cp-coral',
  event: 'bg-cp-teal-light/20 text-cp-teal-light',
  note: 'bg-ui/[0.05] text-ui/55',
};

interface VaultEntryCardProps {
  entry: VaultEntry;
  onUpdated: () => void;
  onDeleted: () => void;
}

export const VaultEntryCard = ({ entry, onUpdated, onDeleted }: VaultEntryCardProps) => {
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

  const typeColor = TYPE_COLORS[entry.type] ?? TYPE_COLORS.note;
  const ago = formatRelative(entry.createdAt);

  return (
    <div
      className={`border rounded-lg p-3 transition-colors cursor-pointer ${
        expanded ? 'bg-ui/[0.05] border-ui/[0.15]' : 'bg-ui/[0.03] border-ui/[0.06] hover:bg-ui/[0.05]'
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        {/* Type badge */}
        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${typeColor} shrink-0 mt-0.5`}>
          {entry.type}
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className={`text-sm text-ui/90 ${expanded ? '' : 'line-clamp-2'}`}>
            {entry.content}
          </p>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1 shrink-0">
          {entry.isPinned && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-cp-amber/20 text-cp-amber" title="Pinned">
              PIN
            </span>
          )}
          {entry.isPermanent && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-cp-teal/20 text-cp-teal" title="Permanent">
              PERM
            </span>
          )}
        </div>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-3 mt-2 text-[10px] text-ui/25">
        <span>{entry.agentName ?? 'system'}</span>
        <span>{ago}</span>
        <span>conf: {(entry.confidence * 100).toFixed(0)}%</span>
        {entry.retrievalCount > 0 && <span>used {entry.retrievalCount}x</span>}
        <span className="text-ui/25">{entry.source}</span>
      </div>

      {/* Tags */}
      {entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {entry.tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-ui/[0.05] text-ui/40">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded actions */}
      {expanded && (
        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-ui/[0.06]" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleTogglePin}
            className={`px-2 py-1 text-[10px] rounded transition-colors ${
              entry.isPinned ? 'bg-cp-amber/20 text-cp-amber' : 'bg-ui/[0.05] text-ui/55 hover:text-ui/70'
            }`}
          >
            {entry.isPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            onClick={handleTogglePermanent}
            className={`px-2 py-1 text-[10px] rounded transition-colors ${
              entry.isPermanent ? 'bg-cp-teal/20 text-cp-teal' : 'bg-ui/[0.05] text-ui/55 hover:text-ui/70'
            }`}
          >
            {entry.isPermanent ? 'Unpermanent' : 'Permanent'}
          </button>
          <button
            onClick={handleMarkObsolete}
            className="px-2 py-1 text-[10px] rounded bg-ui/[0.05] text-ui/55 hover:text-cp-amber transition-colors"
          >
            Obsolete
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-2 py-1 text-[10px] rounded bg-ui/[0.05] text-ui/55 hover:text-cp-coral transition-colors disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
};

