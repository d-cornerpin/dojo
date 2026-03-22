import { useNavigate } from 'react-router-dom';

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
  archived: { cls: 'text-white/20 bg-white/[0.03]', label: 'Archived' },
};

const tagColors = ['bg-purple-500/20 text-purple-300', 'bg-blue-500/20 text-blue-300', 'bg-teal-500/20 text-teal-300', 'bg-amber-500/20 text-amber-300', 'bg-pink-500/20 text-pink-300'];

function formatTimeSince(dateStr: string): string {
  const normalized = dateStr.includes('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const TechniqueCard = ({ technique, onToggle }: { technique: TechniqueData; onToggle?: (id: string, enabled: boolean) => void }) => {
  const navigate = useNavigate();
  const badge = stateBadge[technique.state] ?? stateBadge.draft;

  return (
    <div
      onClick={() => navigate(`/techniques/${technique.id}`)}
      className="glass-card glass-card-hover p-5 cursor-pointer group"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-white truncate">{technique.name}</h3>
          <p className="text-xs text-white/40 mt-0.5 line-clamp-2">{technique.description ?? 'No description'}</p>
        </div>
        <span className={`glass-badge ${badge.cls} shrink-0 ml-2`}>{badge.label}</span>
      </div>

      {/* Tags */}
      {technique.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {technique.tags.slice(0, 4).map((tag, i) => (
            <span key={tag} className={`text-[10px] px-1.5 py-0.5 rounded ${tagColors[i % tagColors.length]}`}>
              {tag}
            </span>
          ))}
          {technique.tags.length > 4 && (
            <span className="text-[10px] text-white/30">+{technique.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-white/40">
        <span>{technique.authorAgentName ?? 'Unknown'}</span>
        <div className="flex items-center gap-3">
          <span>{technique.usageCount} use{technique.usageCount !== 1 ? 's' : ''}</span>
          {technique.lastUsedAt && <span>{formatTimeSince(technique.lastUsedAt)}</span>}
          <span>v{technique.version}</span>
        </div>
      </div>

      {/* Enable/Disable toggle for published */}
      {technique.state === 'published' && onToggle && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-xs text-white/40">Enabled</span>
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(technique.id, !technique.enabled); }}
            className={`w-8 h-4 rounded-full transition-colors relative ${technique.enabled ? 'bg-cp-teal' : 'bg-white/[0.15]'}`}
          >
            <div className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-transform ${technique.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}
    </div>
  );
};
