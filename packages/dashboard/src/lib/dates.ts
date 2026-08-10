/**
 * Parse a date string from the server (SQLite datetime) as UTC.
 *
 * SQLite's datetime('now') returns "2026-03-22 20:30:00" with no timezone suffix.
 * JavaScript's new Date() interprets that as LOCAL time, causing a timezone offset.
 * This function ensures the string is parsed as UTC by appending 'Z' if missing.
 */
export function parseUtc(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  // If it already has timezone info (Z or +/-offset), parse as-is
  if (dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }
  // SQLite format: "2026-03-22 20:30:00" or "2026-03-22T20:30:00" -- append Z for UTC
  return new Date(dateStr + 'Z');
}

/**
 * Format a UTC date string from the server into a localized display string.
 * Correctly handles SQLite datetime('now') strings that lack a Z suffix.
 */
export function formatDate(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/**
 * Format as date only (no time).
 */
export function formatDateShort(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

/**
 * Short date + time, e.g. "Aug 10, 7:00 PM" — the kanban card's "Next:" and
 * "Paused until" lines.
 */
export function formatShortDateTime(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Elapsed since an instant, seconds-granular: "45s ago" / "3m ago" / "2h ago" / "5d ago".
 * Distinct from `formatRelative`, which says "just now" under a minute.
 */
export function formatTimeSince(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Elapsed duration with no "ago" suffix: "45s" / "3m 5s" — in-flight job timers.
 */
export function formatElapsed(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d) return '';
  const start = d.getTime();
  if (!Number.isFinite(start)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

/**
 * Format as time only (no date), e.g. "7:00:00 PM" — activity-log rows.
 */
export function formatTimeOnly(dateStr: string | null | undefined): string {
  const d = parseUtc(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

/**
 * Format as relative time ("3m ago", "2h ago", "5d ago").
 */
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
