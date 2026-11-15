// One formatter for every block that says WHEN. It renders the recorded instant, never "3 hours ago", so the bytes
// do not change with the clock (cache prefix). Its own module: importing it from the assembler closes a cycle.

/** `messages.created_at` is epoch-ms INTEGER while `deliveries.created_at` is TEXT; both convert here, once. */
export function normalizeCreatedAtUtc(createdAt: string | number): string | null {
  if (typeof createdAt === 'number') {
    return Number.isFinite(createdAt) && createdAt >= 1600000000000
      ? new Date(createdAt).toISOString() : null;
  }
  let s = createdAt.trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return s;
}

/** Same en-US 12-hour format as `renderCurrentTimeMessage` so the model compares like with like; the offset is
 *  the one in force at that instant, so a stamp never moves once written. Null when unparseable. */
export function renderMessageTimeStamp(createdAt: string | number | null | undefined): string | null {
  const instant = renderInstant(createdAt);
  return instant === null ? null : `[${instant}]`;
}

/** A stamp the model echoed at the start of its reply: the shape `renderMessageTimeStamp` writes (month-name with an
 *  optional UTC offset, or ISO date and time), a leading run of them. A bracket with no clock time is real content. */
const LEADING_TIME_STAMP_RE =
  /^\s*\[(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}[\s\u202F\u00A0]?(?:AM|PM)(?: UTC[+-]\d{2}:\d{2})?|\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?[\s\u202F\u00A0]?(?:AM|PM|UTC|Z)?)\]\s*/;

export function stripLeadingTimeStamp(text: string): string {
  let out = text;
  while (LEADING_TIME_STAMP_RE.test(out)) out = out.replace(LEADING_TIME_STAMP_RE, '');
  return out;
}

export function renderInstant(createdAt: string | number | null | undefined): string | null {
  if (!createdAt) return null;
  const iso = normalizeCreatedAtUtc(createdAt);
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStr = d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${localStr} ${utcOffset(d, tz)}`;
}

/** `UTC±HH:MM` at `d` in `tz` (`longOffset` prints `GMT-07:00`, or bare `GMT` at zero). */
function utcOffset(d: Date, tz: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
  return m ? `UTC${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}` : 'UTC+00:00';
}

/** A fixed fallback string, so the degraded path is byte-stable too. */
export function recordedInstant(createdAt: string | number | null | undefined): string {
  return renderMessageTimeStamp(createdAt) ?? '[time not recorded]';
}
