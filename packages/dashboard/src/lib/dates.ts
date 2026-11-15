/** SQLite's datetime('now') has no timezone suffix and new Date() reads that as LOCAL time,
 *  so append 'Z' when the string carries no zone of its own and parse the instant as UTC. */
export function parseUtc(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  if (dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }
  return new Date(dateStr + 'Z');
}

/** Server UTC string to a localized date+time display; '' for nothing or an unparseable value. */
export function formatDate(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/** Date only, no time. */
export function formatDateShort(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

/** "Aug 10, 7:00 PM": the kanban card's "Next:" and "Paused until" lines. */
export function formatShortDateTime(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "45s ago" / "3m ago" / "2h ago" / "5d ago"; unlike formatRelative, never says "just now". */
export function formatTimeSince(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Time only, e.g. "7:00:00 PM" - activity-log rows. */
export function formatTimeOnly(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

/** Coarse "when did this last happen" for the Health page's status rows:
 *  a row's honest answer to a value it cannot read is the same as its answer to no value at all. */
export function formatTimestamp(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return 'Never';
  const diffMins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString();
}

/** Relative time ("3m ago", "2h ago", "5d ago"), then a plain date past 30 days. */
export function formatRelative(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

/** Local calendar day "YYYY-MM-DD"; toISOString() gives the UTC date, wrong late evenings behind UTC. */
export function localDateStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
