interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const statusConfig: Record<string, { dot: string; badge: string }> = {
  idle: { dot: 'status-dot-healthy', badge: 'glass-badge-teal' },
  ok: { dot: 'status-dot-healthy', badge: 'glass-badge-teal' },
  working: { dot: 'status-dot-warning status-dot-pulse', badge: 'glass-badge-amber' },
  paused: { dot: 'status-dot-idle', badge: 'glass-badge-gray' },
  error: { dot: 'status-dot-error', badge: 'glass-badge-coral' },
  terminated: { dot: 'status-dot-error', badge: 'glass-badge-coral' },
};

export const StatusBadge = ({ status, size = 'md' }: StatusBadgeProps) => {
  const config = statusConfig[status] ?? { dot: 'status-dot-idle', badge: 'glass-badge-gray' };
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs';

  const displayLabels: Record<string, string> = {
    idle: 'Ready',
    working: 'Working',
    paused: 'Resting',
    error: 'Injured',
    terminated: 'Dismissed',
  };
  const displayLabel = displayLabels[status] ?? status;

  return (
    <span className={`glass-badge ${config.badge} ${textSize}`}>
      <span className={`status-dot ${config.dot}`} style={{ width: size === 'sm' ? 6 : 8, height: size === 'sm' ? 6 : 8 }} />
      <span className="capitalize">{displayLabel}</span>
    </span>
  );
};
