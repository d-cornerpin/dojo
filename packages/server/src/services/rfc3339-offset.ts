// Google's freeBusy timeMin/timeMax require an RFC3339 timestamp WITH a UTC offset; offset-less and date-only
// strings 400. An offset-less value is parsed as host-local time and re-emitted as UTC, matching the calendar
// write tools' host-timezone convention (Intl.DateTimeFormat().resolvedOptions()).
export function toRfc3339WithOffset(value: string): string {
  const t = value.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(t)) return t; // already carries an offset
  const local = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00` : t;
  const d = new Date(local); // parsed as host-local time
  return isNaN(d.getTime()) ? t : d.toISOString();
}
