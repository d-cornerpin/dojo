// ════════════════════════════════════════
// Calendar window helpers (v2.3.12)
//
// Compute UTC time windows that correspond to "today / this Wednesday /
// the next 7 days" in a specific local timezone — so a user prompt like
// "events for Wednesday" doesn't quietly miss late-evening events that
// have already crossed into Thursday in UTC.
//
// Used by calendar_agenda / calendar_search on both Google and Microsoft
// providers.
// ════════════════════════════════════════

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Minutes that `timezone`'s wall clock is offset from UTC at the instant
 * given by `date`. Returns positive for east-of-UTC, negative for west.
 *
 * Uses Intl.DateTimeFormat.formatToParts to read the wall clock in the
 * target timezone, then interprets those numbers as if they were UTC and
 * compares the difference.
 */
function getTimezoneOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): number => {
    const v = parts.find(p => p.type === type)?.value ?? '0';
    return parseInt(v, 10);
  };

  // hour can be '24' for midnight in some en-US locale builds; normalize
  let hour = get('hour');
  if (hour === 24) hour = 0;

  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Convert a local-clock datetime in `timezone` to its corresponding UTC
 * Date. e.g., localToUTC('2026-05-13', 0, 0, 0, 'America/Los_Angeles')
 * returns the UTC instant of midnight Pacific on that day.
 *
 * Iterates twice to handle DST transitions correctly: a first guess is
 * usually exact, but DST forward/back jumps can shift the offset by an
 * hour in either direction depending on which side of the transition
 * the guess landed on.
 */
function localToUTC(
  dateStr: string,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  // Treat dateStr+time as if it were UTC, then back the offset off.
  const isoLocal = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
  let candidate = new Date(isoLocal);
  for (let i = 0; i < 2; i++) {
    const offsetMin = getTimezoneOffsetMinutes(candidate, timezone);
    candidate = new Date(Date.parse(isoLocal) - offsetMin * 60000);
  }
  return candidate;
}

/**
 * Get the local YYYY-MM-DD for "today" in the given timezone.
 */
function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface CalendarWindowInput {
  /** Days to span (1 = single day, 7 = week). Default 1. */
  days?: number;
  /** IANA timezone (e.g. 'America/Los_Angeles'). Default = system. */
  timezone?: string;
  /**
   * Anchor date in YYYY-MM-DD (interpreted in `timezone`). When set, the
   * window starts at local midnight on this date. When omitted and a
   * `timezone` IS provided, the window starts at local midnight TODAY in
   * that timezone. When neither is provided, the window starts at "now"
   * (UTC) for backward compatibility with prompts that don't care about
   * day boundaries.
   */
  start_date?: string;
}

export interface CalendarWindow {
  /** ISO 8601 UTC instant for the window start. */
  startISO: string;
  /** ISO 8601 UTC instant for the window end (exclusive). */
  endISO: string;
  /** Effective timezone applied to the window. */
  timezone: string;
  /** True if the window was anchored to a local date (not "now"). */
  anchored: boolean;
}

/**
 * Compute a calendar query time window. See CalendarWindowInput for
 * exact semantics.
 */
export function computeCalendarWindow(input: CalendarWindowInput): CalendarWindow {
  const days = Math.max(1, Math.floor(input.days ?? 1));
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;

  if (input.start_date) {
    const start = localToUTC(input.start_date, 0, 0, 0, timezone);
    const endDateMs = start.getTime() + days * 86400000;
    const end = new Date(endDateMs);
    return { startISO: start.toISOString(), endISO: end.toISOString(), timezone, anchored: true };
  }

  if (input.timezone) {
    // Snap to local midnight today in the given timezone.
    const today = todayInTimezone(timezone);
    const start = localToUTC(today, 0, 0, 0, timezone);
    const end = new Date(start.getTime() + days * 86400000);
    return { startISO: start.toISOString(), endISO: end.toISOString(), timezone, anchored: true };
  }

  // No timezone, no start_date — preserve original "now → now+days" behavior.
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  return { startISO: now.toISOString(), endISO: end.toISOString(), timezone, anchored: false };
}
