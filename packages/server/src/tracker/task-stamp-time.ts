// The two ages a ticket stamp prints, split out of task-stamps.ts: relative to now, or the recorded instant.
export function relAgoFromNow(sqliteUtc: string | null): string {
  if (!sqliteUtc) return '';
  const ms = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The recorded instant, minute precision, UTC: no clock in it, so the prompt prefix stays cache-stable. */
export function absInstant(sqliteUtc: string | null): string {
  if (!sqliteUtc) return '';
  const ms = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return '';
  return `at ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
