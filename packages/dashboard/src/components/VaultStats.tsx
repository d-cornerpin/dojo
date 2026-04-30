import { useState } from 'react';
import type { VaultStats as VaultStatsType } from '../lib/api';
import { bulkDiscardArchives } from '../lib/api';
import { formatRelative } from '../lib/dates';
import { useToast } from '../hooks/useToast';

interface VaultStatsProps {
  stats: VaultStatsType | null;
  loading?: boolean;
  onArchivesDiscarded?: () => void;
}

export const VaultStats = ({ stats, loading, onArchivesDiscarded }: VaultStatsProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  if (loading || !stats) {
    return (
      <div className="flex items-center gap-4 px-4 py-2 text-xs text-white/30 border-b border-white/[0.06]">
        Loading vault stats...
      </div>
    );
  }

  const typeEntries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);

  const runDiscard = async (filter: { all?: boolean; olderThanDays?: number }, label: string) => {
    if (busy) return;
    if (!confirm(`Discard ${label}? This permanently deletes those raw conversation archives without extracting any vault entries from them. Already-processed archives are not affected.`)) return;
    setBusy(true);
    setMenuOpen(false);
    const res = await bulkDiscardArchives(filter);
    setBusy(false);
    if (res.ok) {
      toast.success(`Discarded ${res.data.deleted} archive(s)`);
      onArchivesDiscarded?.();
    } else {
      toast.error(res.error ?? 'Discard failed');
    }
  };

  return (
    <div className="flex items-center gap-4 px-4 py-2 text-[11px] border-b border-white/[0.06] bg-white/[0.02] overflow-x-auto">
      <StatItem label="Total" value={stats.totalEntries} />
      <StatItem label="Pinned" value={stats.pinnedCount} color="text-amber-400" />
      <StatItem label="Permanent" value={stats.permanentCount} color="text-emerald-400" />
      <StatItem label="Confidence" value={`${(stats.avgConfidence * 100).toFixed(0)}%`} />
      <StatItem label="Retrieved Today" value={stats.retrievedToday} />
      <span className="text-white/40 whitespace-nowrap relative">
        Unprocessed: <span className={stats.unprocessedArchives > 0 ? 'text-yellow-400' : 'text-white/70'}>{stats.unprocessedArchives}</span>
        {stats.unprocessedArchives > 0 && (
          <>
            <button
              onClick={() => setMenuOpen(v => !v)}
              disabled={busy}
              className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] text-white/50 hover:text-white/80 hover:bg-white/[0.06] disabled:opacity-40"
              title="Bulk-discard unprocessed archives"
            >
              {busy ? '…' : 'discard ▾'}
            </button>
            {menuOpen && (
              <div className="absolute top-full left-0 mt-1 z-20 bg-[#1a1a2e] border border-white/[0.1] rounded shadow-lg py-1 min-w-[200px]">
                <button onClick={() => runDiscard({ olderThanDays: 30 }, 'archives older than 30 days')} className="w-full text-left px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/[0.05]">Older than 30 days</button>
                <button onClick={() => runDiscard({ olderThanDays: 7 }, 'archives older than 7 days')} className="w-full text-left px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/[0.05]">Older than 7 days</button>
                <button onClick={() => runDiscard({ olderThanDays: 1 }, 'archives older than 1 day')} className="w-full text-left px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/[0.05]">Older than 1 day</button>
                <div className="border-t border-white/[0.06] my-1" />
                <button onClick={() => runDiscard({ all: true }, 'ALL unprocessed archives')} className="w-full text-left px-3 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10">Discard all unprocessed</button>
              </div>
            )}
          </>
        )}
      </span>
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

