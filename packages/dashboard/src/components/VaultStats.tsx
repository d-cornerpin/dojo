import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // Close on outside click / escape. The portal renders the menu outside
  // the stats bar (whose `overflow-x-auto` was clipping the dropdown), so
  // we have to manage dismiss manually rather than relying on a focus-loss.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onScrollOrResize = () => setMenuOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [menuOpen]);

  if (loading || !stats) {
    return (
      <div className="vstats">
        Loading vault stats...
      </div>
    );
  }

  const typeEntries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);

  const openMenu = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
    setMenuOpen(v => !v);
  };

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
    <div className="vstats anim" style={{ '--ci': '0ms' } as React.CSSProperties}>
      <StatItem label="Total" value={stats.totalEntries} />
      <StatItem label="Pinned" value={stats.pinnedCount} />
      <StatItem label="Permanent" value={stats.permanentCount} />
      <StatItem label="Confidence" value={`${(stats.avgConfidence * 100).toFixed(0)}%`} />
      <StatItem label="Retrieved Today" value={stats.retrievedToday} />
      <span>
        Unprocessed <b>{stats.unprocessedArchives}</b>
        {stats.unprocessedArchives > 0 && (
          <button
            ref={buttonRef}
            onClick={openMenu}
            disabled={busy}
            className="link"
            style={{ marginLeft: 6 }}
            title="Bulk-discard unprocessed archives"
          >
            {busy ? '…' : 'discard ▾'}
          </button>
        )}
      </span>
      {stats.lastDreamAt && (
        <StatItem label="Last Dream" value={formatRelative(stats.lastDreamAt)} />
      )}
      <span>·</span>
      {typeEntries.map(([type, count]) => (
        <span key={type}><b>{count}</b> {type}s</span>
      ))}

      {/* Dropdown is rendered via a portal to document.body so it isn't
          clipped by the stats bar's overflow-x-auto (which forces overflow-y
          to non-visible too). Position is computed from the button rect. */}
      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 50 }}
          className="glass-modal-bg rounded py-1 min-w-[200px]"
        >
          <button onClick={() => runDiscard({ olderThanDays: 30 }, 'archives older than 30 days')} className="w-full text-left px-3 py-1.5 text-[11px] text-ui/70 hover:bg-ui/[0.05]">Older than 30 days</button>
          <button onClick={() => runDiscard({ olderThanDays: 7 }, 'archives older than 7 days')} className="w-full text-left px-3 py-1.5 text-[11px] text-ui/70 hover:bg-ui/[0.05]">Older than 7 days</button>
          <button onClick={() => runDiscard({ olderThanDays: 1 }, 'archives older than 1 day')} className="w-full text-left px-3 py-1.5 text-[11px] text-ui/70 hover:bg-ui/[0.05]">Older than 1 day</button>
          <div className="border-t border-ui/[0.06] my-1" />
          <button onClick={() => runDiscard({ all: true }, 'ALL unprocessed archives')} className="w-full text-left px-3 py-1.5 text-[11px] text-cp-coral hover:bg-cp-coral/10">Discard all unprocessed</button>
        </div>,
        document.body
      )}
    </div>
  );
};

const StatItem = ({ label, value }: { label: string; value: string | number }) => (
  <span>{label} <b>{value}</b></span>
);

