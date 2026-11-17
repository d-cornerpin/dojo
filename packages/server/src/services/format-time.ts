// Single source of truth for how times are rendered for agents. An unlabeled ISO string read as local time is the
// agent's biggest timezone failure, so every emitted time carries BOTH the localized form (with zone abbreviation)
// and the canonical UTC ISO. All-day events are date-only.
// Used by every agent-facing time render (calendar, mail, tracker, convert_time).

import { normalizeDbTimestamp, wallToInstant, type WallClock } from '../scheduler/engine.js';

const SYSTEM_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
})();

// A tz-naive string is UTC (`normalizeDbTimestamp` is imported, not restated); a bare `new Date` on the DB's
// space-separated, Z-less shape would read it as LOCAL. The time-of-day gate is load-bearing: that function appends
// `Z` to anything without an offset, which would break a date-only value the all-day branch must parse as it is.
const HAS_TIME_OF_DAY = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Parse an agent-facing time input, reading any tz-naive instant as UTC. */
function toInstant(input: Date | string | number): Date {
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  const raw = input.trim();
  return new Date(HAS_TIME_OF_DAY.test(raw) ? normalizeDbTimestamp(raw) : raw);
}

export interface FormatTimeOptions {
  /** IANA timezone for the localized side. Defaults to the host's system tz. */
  timezone?: string;
  allDay?: boolean;
  /** false: the localized side alone, for the owner's eyes. */
  utc?: boolean;
}

/** Short timezone abbreviation for the moment in the zone; falls back to the IANA zone name. */
function tzAbbreviation(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const abbrev = parts.find(p => p.type === 'timeZoneName')?.value;
    if (abbrev) return abbrev;
  } catch { /* fall through */ }
  return timezone;
}

/** Format a Date as BOTH the localized form and the absolute UTC ISO; all-day events return just the date. */
export function formatTimeForAgent(input: Date | string | number, opts: FormatTimeOptions = {}): string {
  const tz = opts.timezone || SYSTEM_TZ;
  const date = toInstant(input);

  if (isNaN(date.getTime())) return `(invalid time: ${String(input)})`;

  if (opts.allDay) {
    // All-day strings are calendar dates, not moments: format in UTC so a negative-offset zone cannot shift the day.
    const datePart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }).format(date);
    return `All day, ${datePart}`;
  }

  const localPart = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);

  const abbrev = tzAbbreviation(date, tz);
  return opts.utc === false ? `${localPart} ${abbrev}` : `${localPart} ${abbrev} (${date.toISOString()})`;
}

/** Format a start/end pair: a same-day pair shares one date; all-day events print "All day, <date>" or a range. */
export function formatTimeRangeForAgent(
  start: Date | string | number,
  end: Date | string | number,
  opts: FormatTimeOptions = {},
): string {
  const tz = opts.timezone || SYSTEM_TZ;
  const startDate = toInstant(start);
  const endDate = toInstant(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return `${formatTimeForAgent(start, opts)} to ${formatTimeForAgent(end, opts)}`;
  }

  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
  const sameDay = dayFmt.format(startDate) === dayFmt.format(endDate);

  if (opts.allDay) {
    const dayFmtUtc = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const startDay = dayFmtUtc.format(startDate);
    // Google and Microsoft emit an exclusive end date for all-day events, so an end exactly one day after the start
    // is a single-day all-day.
    const msInDay = 86_400_000;
    const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / msInDay);
    if (diffDays <= 1) return `All day, ${startDay}`;
    const endDay = dayFmtUtc.format(new Date(endDate.getTime() - msInDay));
    return `All day, ${startDay} → ${endDay}`;
  }

  if (!sameDay) {
    return `${formatTimeForAgent(startDate, opts)} to ${formatTimeForAgent(endDate, opts)}`;
  }

  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(startDate);
  const startTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(startDate);
  const endTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(endDate);
  const abbrev = tzAbbreviation(startDate, tz);
  return `${datePart}, ${startTime} – ${endTime} ${abbrev} (${startDate.toISOString()} / ${endDate.toISOString()})`;
}

/** Parse a flexible time input (ISO, epoch s/ms, RFC 2822, human); `fromTz` reads an offset-less ISO in that zone. */
export function parseFlexibleTime(input: string | number, fromTz?: string): Date | null {
  if (typeof input === 'number') {
    const ms = input < 1e12 ? input * 1000 : input;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  const s = input.trim();
  if (!s) return null;

  if (/^\d{10,13}$/.test(s)) {
    return parseFlexibleTime(parseInt(s, 10));
  }

  const isoNoZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  if (isoNoZone && fromTz) {
    return interpretLocalAsTz(s, fromTz);
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Interpret a naive ISO datetime as wall-clock time in the zone through `wallToInstant` (scheduler/engine.ts), so DST
// days resolve as everywhere else.
function interpretLocalAsTz(isoNaive: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(isoNaive);
  if (!m) return null;
  // Refuse an impossible date or time (month 13): wallToInstant would normalize it to a wrong instant.
  const [mo, dd, hh, mi, ss] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0];
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const wall: WallClock = {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: m[6] ? Number(m[6]) : 0,
  };
  let instant: Date;
  try {
    instant = wallToInstant(wall, tz);
  } catch {
    // A non-IANA zone name makes Intl throw RangeError: return null so the caller's parse-failure path runs.
    return null;
  }
  const fracMs = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(instant.getTime() + fracMs);
}

export { SYSTEM_TZ };
