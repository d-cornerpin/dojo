// ════════════════════════════════════════
// Time formatting for agent output
// ════════════════════════════════════════
//
// Single source of truth for how times are rendered for LLM agents. The
// agent's biggest timezone failure mode is reading an unlabeled ISO
// string like "2026-05-20T19:00:00" as local time when it's actually UTC.
// Fix: every time we emit is wrapped in a dual-format string that
// includes BOTH the localized human form (with timezone abbreviation)
// AND the canonical UTC ISO. The agent can read either one; there is no
// unlabeled time it can misread.
//
// Example output:
//   "Wed May 20, 12:00 PM PDT (2026-05-20T19:00:00Z)"
//
// All-day events use a different shape (no time, no UTC):
//   "All day, Wed May 20"
//
// Used by:
//   - calendar_agenda_ms / calendar_agenda (event start/end formatting)
//   - convert_time agent tool
//   - any future tool that surfaces a timestamp to an agent

import { normalizeDbTimestamp, wallToInstant, type WallClock } from '../scheduler/engine.js';

const SYSTEM_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
})();

// ── A tz-naive string is UTC, and this file must use the SAME rule as the rest
//    of the platform (task ANCHOR-HUNT) ──
//
// This module exists to stop an agent misreading an unlabeled instant as local
// time (see the header). It was committing that exact error itself: it took a
// bare `new Date(input)`, and the tracker hands it the DB's own text shape —
// `work/tracker-view.ts:msToText` renders every instant column through
// `strftime('%Y-%m-%d %H:%M:%S', …)`, a SPACE-separated, Z-less string. That
// shape is not valid ISO 8601, so V8 falls back to implementation-defined
// parsing and reads it as LOCAL wall clock. On a UTC−7 box
// `new Date("2026-08-07 03:00:00")` is `10:00:00Z` — the owner's reported +7h
// on `work_open`'s "Next run (local)" line, reproduced by
// `tracker/__tests__/schedule-echo-seam.test.ts` on his two literal values.
//
// The rule was already written down twice — `scheduler/engine.ts:normalizeDbTimestamp`
// (whose own doc names this V8 behaviour) and `work/tracker-view.ts:tsToMs`.
// This file is the third parser of the same shape, so it IMPORTS the rule
// rather than restating it; a fourth copy is how the two answers diverge again.
//
// The time-of-day gate is load-bearing, not caution. `normalizeDbTimestamp`
// appends `Z` to anything without an offset, so an all-day DATE-ONLY value
// ("2026-05-20") would become "2026-05-20Z" — which V8 rejects, and the
// `allDay` branch below depends on that value parsing. A date-only string is
// already UTC by specification and needs no help; only a value carrying a
// time of day can be misread, so only that is normalized.
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
  /** Date-only formatting — no time, no UTC ISO. Used for all-day events. */
  allDay?: boolean;
}

/**
 * Extract a short timezone abbreviation ("PT", "PDT", "EDT", "UTC", "CET")
 * for the given moment in the given IANA zone. Falls back to the IANA
 * zone name if the runtime can't resolve a short name.
 */
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

/**
 * Format a Date for agent consumption. Always returns BOTH the human-
 * localized form and the absolute UTC ISO, so the agent has zero
 * ambiguity about what moment in time we're talking about.
 *
 * For all-day events, returns just the date in the requested timezone
 * with no time component — agents should not see "midnight at the start
 * of the day" for events that have no time-of-day semantics.
 */
export function formatTimeForAgent(input: Date | string | number, opts: FormatTimeOptions = {}): string {
  const tz = opts.timezone || SYSTEM_TZ;
  const date = toInstant(input);

  if (isNaN(date.getTime())) return `(invalid time: ${String(input)})`;

  if (opts.allDay) {
    // All-day date strings ("2026-05-20") are calendar dates, not absolute
    // moments. If we parsed them as UTC midnight and then formatted in a
    // negative-offset zone we'd shift to the previous day. So format
    // explicitly in UTC for all-day to keep the date the user expects.
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
  const utcIso = date.toISOString();
  return `${localPart} ${abbrev} (${utcIso})`;
}

/**
 * Format a start/end pair for agent consumption. Collapses redundant
 * date info when start and end share the same calendar day:
 *   "Wed May 20, 12:00 PM – 12:30 PM PDT (2026-05-20T19:00:00Z / 2026-05-20T19:30:00Z)"
 *
 * For all-day events spanning a single day, returns "All day, Wed May 20".
 * Multi-day all-day events get "All day, Wed May 20 → Thu May 21".
 */
export function formatTimeRangeForAgent(
  start: Date | string | number,
  end: Date | string | number,
  opts: FormatTimeOptions = {},
): string {
  const tz = opts.timezone || SYSTEM_TZ;
  // Same rule as formatTimeForAgent — this pair renders through it (and must
  // agree with it about what instant a tz-naive string names).
  const startDate = toInstant(start);
  const endDate = toInstant(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return `${formatTimeForAgent(start, opts)} to ${formatTimeForAgent(end, opts)}`;
  }

  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
  const sameDay = dayFmt.format(startDate) === dayFmt.format(endDate);

  if (opts.allDay) {
    // See formatTimeForAgent — all-day inputs are calendar dates, not
    // absolute moments. Format in UTC so the date stays as written
    // regardless of the host/agent zone.
    const dayFmtUtc = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const startDay = dayFmtUtc.format(startDate);
    // Google/Microsoft both emit an exclusive end date for all-day events
    // (e.g. May 20 → May 21 means the event covers all of May 20). If end
    // is exactly one day after start, treat it as a single-day all-day.
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

/**
 * Parse a flexible time input string. Supports:
 *   - ISO 8601 with or without Z / offset ("2026-05-20T19:00:00Z", "2026-05-20T12:00:00-07:00")
 *   - Unix epoch milliseconds (13-digit number string) or seconds (10-digit)
 *   - RFC 2822 ("Wed, 20 May 2026 19:00:00 +0000")
 *   - Common human formats Date can parse ("May 20 2026 7pm")
 *
 * If `fromTz` is provided, an ISO-without-offset is interpreted in that
 * timezone instead of the host's local tz. This is critical for things
 * like Microsoft Graph which returns naked datetimes that are actually UTC.
 */
export function parseFlexibleTime(input: string | number, fromTz?: string): Date | null {
  if (typeof input === 'number') {
    // 10-digit = seconds, 13-digit = milliseconds
    const ms = input < 1e12 ? input * 1000 : input;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  const s = input.trim();
  if (!s) return null;

  // Pure digit string → unix epoch
  if (/^\d{10,13}$/.test(s)) {
    return parseFlexibleTime(parseInt(s, 10));
  }

  // ISO without explicit zone marker AND fromTz provided → interpret in fromTz
  const isoNoZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  if (isoNoZone && fromTz) {
    return interpretLocalAsTz(s, fromTz);
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Take a naive ISO datetime ("2026-05-20T19:00:00") and interpret it as
 * a wall-clock time in the given IANA zone. Returns the absolute Date
 * (a moment in time) that corresponds to that wall-clock + zone.
 *
 * The exact converter is `wallToInstant` in scheduler/engine.ts: it probes
 * the offsets on both sides of the target wall time, so a DST transition
 * day resolves the same way everywhere — a time repeated by a clock going
 * back picks the first occurrence, and a time skipped by a clock going
 * forward lands on the next valid instant. The naive string is parsed into
 * wall components and handed straight to it.
 */
function interpretLocalAsTz(isoNaive: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(isoNaive);
  if (!m) return null;
  // An impossible date or time (month 13, hour 25) is not a time at all: wallToInstant would
  // normalize the overflow into a confident wrong instant, so refuse it here as the old parse did.
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
    // v2.7.26 — defensive catch for non-IANA timezone names. Some providers
    // hand back Windows zone names ("Pacific Standard Time") — Intl throws
    // RangeError on those, and wallToInstant resolves the zone through it.
    // Return null so the caller's truthy check fails and a graceful
    // "(could not parse)" fallback is used instead of a thrown error.
    return null;
  }
  const fracMs = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(instant.getTime() + fracMs);
}

export { SYSTEM_TZ };
