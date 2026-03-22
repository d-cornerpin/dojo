import type { VaultStats as VaultStatsType } from '../lib/api';
import { formatRelative } from '../lib/dates';

interface VaultStatsProps {
  stats: VaultStatsType | null;
  loading?: boolean;
}

export const VaultStats = ({ stats, loading }: VaultStatsProps) => {
  if (loading || !stats) {
    return (
      <div className="flex items-center gap-4 px-4 py-2 text-xs text-white/30 border-b border-white/[0.06]">
        Loading vault stats...
      </div>
    );
  }

  const typeEntries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex items-center gap-4 px-4 py-2 text-[11px] border-b border-white/[0.06] bg-white/[0.02] overflow-x-auto">
      <StatItem label="Total" value={stats.totalEntries} />
      <StatItem label="Pinned" value={stats.pinnedCount} color="text-amber-400" />
      <StatItem label="Permanent" value={stats.permanentCount} color="text-emerald-400" />
      <StatItem label="Confidence" value={`${(stats.avgConfidence * 100).toFixed(0)}%`} />
      <StatItem label="Retrieved Today" value={stats.retrievedToday} />
      <StatItem label="Unprocessed" value={stats.unprocessedArchives} color={stats.unprocessedArchives > 0 ? 'text-yellow-400' : undefined} />
      {stats.lastDreamAt && (
        <StatItem label="Last Dream" value={formatRelative(stats.lastDreamAt)} />
      )}
      <div className="border-l border-white/[0.06] h-4 mx-1" />
      {typeEntries.map(([type, count]) => (
        <span key={type} className="text-white/30">
          <span className="text-white/50">{count}</span> {type}s
        </span>
      ))}
    </div>
  );
};

const StatItem = ({ label, value, color }: { label: string; value: string | number; color?: string }) => (
  <span className="text-white/40 whitespace-nowrap">
    {label}: <span className={color ?? 'text-white/70'}>{value}</span>
  </span>
);

