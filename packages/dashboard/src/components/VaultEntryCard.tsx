import { useState } from 'react';
import type { VaultEntry } from '../lib/api';
import * as api from '../lib/api';
import { formatRelative } from '../lib/dates';

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-500/20 text-blue-400',
  preference: 'bg-purple-500/20 text-purple-400',
  decision: 'bg-amber-500/20 text-amber-400',
  procedure: 'bg-green-500/20 text-green-400',
  relationship: 'bg-pink-500/20 text-pink-400',
  event: 'bg-cyan-500/20 text-cyan-400',
  note: 'bg-gray-500/20 text-gray-400',
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
        expanded ? 'bg-white/[0.04] border-white/[0.12]' : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
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
          <p className={`text-sm text-white/90 ${expanded ? '' : 'line-clamp-2'}`}>
            {entry.content}
          </p>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1 shrink-0">
          {entry.isPinned && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400" title="Pinned">
              PIN
            </span>
          )}
          {entry.isPermanent && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400" title="Permanent">
              PERM
            </span>
          )}
        </div>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-3 mt-2 text-[10px] text-white/30">
        <span>{entry.agentName ?? 'system'}</span>
        <span>{ago}</span>
        <span>conf: {(entry.confidence * 100).toFixed(0)}%</span>
        {entry.retrievalCount > 0 && <span>used {entry.retrievalCount}x</span>}
        <span className="text-white/20">{entry.source}</span>
      </div>

      {/* Tags */}
      {entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {entry.tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/40">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded actions */}
      {expanded && (
        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/[0.06]" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleTogglePin}
            className={`px-2 py-1 text-[10px] rounded transition-colors ${
              entry.isPinned ? 'bg-amber-500/20 text-amber-400' : 'bg-white/[0.05] text-white/50 hover:text-white/80'
            }`}
          >
            {entry.isPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            onClick={handleTogglePermanent}
            className={`px-2 py-1 text-[10px] rounded transition-colors ${
              entry.isPermanent ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/[0.05] text-white/50 hover:text-white/80'
            }`}
          >
            {entry.isPermanent ? 'Unpermanent' : 'Permanent'}
          </button>
          <button
            onClick={handleMarkObsolete}
            className="px-2 py-1 text-[10px] rounded bg-white/[0.05] text-white/50 hover:text-orange-400 transition-colors"
          >
            Obsolete
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-2 py-1 text-[10px] rounded bg-white/[0.05] text-white/50 hover:text-red-400 transition-colors disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
};

