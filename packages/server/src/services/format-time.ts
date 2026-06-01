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

const SYSTEM_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
})();

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
  const date = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;

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
  const startDate = typeof start === 'string' || typeof start === 'number' ? new Date(start) : start;
  const endDate = typeof end === 'string' || typeof end === 'number' ? new Date(end) : end;

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
 * We do this by: parse as UTC, then compute the offset between UTC and
 * the target zone at THAT moment, then shift. One iteration is enough
 * for any zone whose offset doesn't depend on the wall-clock minute
 * (which is all real-world zones — DST transitions snap to hour boundaries).
 */
function interpretLocalAsTz(isoNaive: string, tz: string): Date | null {
  // Treat the naive string as if it were UTC first.
  const asUtc = new Date(isoNaive.endsWith('Z') ? isoNaive : isoNaive + 'Z');
  if (isNaN(asUtc.getTime())) return null;
  // Format that UTC moment in the target tz, parse back, compute offset.
  //
  // v2.7.26 — defensive try/catch around the Intl call. Some providers
  // hand back non-IANA timezone names (Microsoft Graph used to return
  // Windows zone names like "Pacific Standard Time" before we added the
  // Prefer: outlook.timezone="UTC" header). Intl.DateTimeFormat throws
  // RangeError on those. Without this catch, the throw propagated up
  // through parseFlexibleTime into the calendar tools and made events
  // render as "(invalid time: Invalid Date)" — confusing both the agent
  // and the user. Return null on any failure so the caller's truthy
  // check fails and a graceful "(could not parse)" fallback is used.
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      // v2.7.26 — day MUST be '2-digit', not 'numeric'. `numeric` returns
      // "1" rather than "01" for single-digit days, which then made the
      // reconstructed ISO string "YYYY-MM-1T..." (not valid ISO),
      // `new Date()` returned Invalid Date, and the whole event time
      // surfaced as "(invalid time: Invalid Date)". This was the primary
      // cause of the recurring-calendar-event report — events on June 1-9,
      // July 1-9, etc. broke; days 10-31 happened to work because the
      // formatter emits two digits naturally. Hour/minute/second were
      // already '2-digit'; only day was wrong.
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(asUtc);
  } catch {
    return null;
  }
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const asLocalStr = `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}:${lookup.second}Z`;
  const asLocal = new Date(asLocalStr);
  if (isNaN(asLocal.getTime())) return null;
  const offsetMs = asLocal.getTime() - asUtc.getTime();
  // The wall-clock time we want is the naive input. To get the absolute
  // moment whose wall-clock-in-tz equals that input, subtract the offset.
  return new Date(asUtc.getTime() - offsetMs);
}

export { SYSTEM_TZ };
