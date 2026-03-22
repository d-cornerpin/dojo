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
