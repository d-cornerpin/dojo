import { useNavigate } from 'react-router-dom';
import { formatRelative } from '../lib/dates';

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

const tagColors = ['glass-badge-purple', 'glass-badge-blue', 'glass-badge-teal', 'glass-badge-amber', 'glass-badge-coral'];


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
            <span key={tag} className={`glass-badge ${tagColors[i % tagColors.length]}`}>
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
          {technique.lastUsedAt && <span>{formatRelative(technique.lastUsedAt)}</span>}
          <span>v{technique.version}</span>
        </div>
      </div>

      {/* Enable/Disable toggle for published */}
      {technique.state === 'published' && onToggle && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-xs text-white/40">Enabled</span>
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(technique.id, !technique.enabled); }}
            className={`toggle-switch ${technique.enabled ? 'toggle-on' : ''}`}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
    </div>
  );
};
