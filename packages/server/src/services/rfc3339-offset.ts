// Google's freeBusy timeMin/timeMax require an RFC3339 timestamp WITH a UTC
// offset. Offset-less strings (the format the schema example used to teach) and
// date-only strings 400. Default any offset-less value to the host timezone by
// parsing it as local time and re-emitting UTC, matching the calendar write
// tools' host-timezone convention (Intl.DateTimeFormat().resolvedOptions()).
export function toRfc3339WithOffset(value: string): string {
  const t = value.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(t)) return t; // already carries an offset
  const local = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00` : t;
  const d = new Date(local); // parsed as host-local time
  return isNaN(d.getTime()) ? t : d.toISOString();
}
