// Calendar window helpers: UTC windows for "today / this Wednesday / the next 7 days" in a local timezone, so a
// day-scoped query keeps late-evening events that crossed midnight in UTC (calendar_agenda, calendar_search).

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Minutes that `timezone`'s wall clock is offset from UTC at `date` (positive east of UTC). */
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

/** Local-clock datetime in `timezone` as a UTC Date; two passes so a DST jump cannot skew the offset. */
function localToUTC(
  dateStr: string,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  const isoLocal = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
  let candidate = new Date(isoLocal);
  for (let i = 0; i < 2; i++) {
    const offsetMin = getTimezoneOffsetMinutes(candidate, timezone);
    candidate = new Date(Date.parse(isoLocal) - offsetMin * 60000);
  }
  return candidate;
}

function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** UTC instant of local midnight `days` days after `dateStr` (y-m-d arithmetic, so DST days stay exact). */
function addDaysLocalMidnight(dateStr: string, days: number, timezone: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const endDateStr = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  return localToUTC(endDateStr, 0, 0, 0, timezone);
}

export interface CalendarWindowInput {
  /** Days to span (1 = single day, 7 = week). Default 1. */
  days?: number;
  timezone?: string;
  /** Anchor date (YYYY-MM-DD in `timezone`); else local today if `timezone` is set, else "now" (UTC). */
  start_date?: string;
}

export interface CalendarWindow {
  /** ISO 8601 UTC instant for the window start. */
  startISO: string;
  /** ISO 8601 UTC instant for the window end (exclusive). */
  endISO: string;
  timezone: string;
  anchored: boolean;
}

/** Compute a calendar query time window; see CalendarWindowInput for the semantics. */
export function computeCalendarWindow(input: CalendarWindowInput): CalendarWindow {
  const days = Math.max(1, Math.floor(input.days ?? 1));
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;

  if (input.start_date) {
    const start = localToUTC(input.start_date, 0, 0, 0, timezone);
    const end = addDaysLocalMidnight(input.start_date, days, timezone);
    return { startISO: start.toISOString(), endISO: end.toISOString(), timezone, anchored: true };
  }

  if (input.timezone) {
    const today = todayInTimezone(timezone);
    const start = localToUTC(today, 0, 0, 0, timezone);
    const end = addDaysLocalMidnight(today, days, timezone);
    return { startISO: start.toISOString(), endISO: end.toISOString(), timezone, anchored: true };
  }

  // No timezone and no start_date: the window runs from now to now+days.
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  return { startISO: now.toISOString(), endISO: end.toISOString(), timezone, anchored: false };
}
