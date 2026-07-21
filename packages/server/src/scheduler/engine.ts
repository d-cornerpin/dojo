// ════════════════════════════════════════
// Schedule Calculation Engine (Phase 6)
// Computes next run times for scheduled/recurring tasks
// ════════════════════════════════════════
//
// D21 (timezone/DST cadence): calendar-unit occurrences (days, weeks, months,
// years, weekdays, specific_days) are computed in the BOX's IANA timezone via
// Intl, holding the anchor's wall-clock time fixed across DST transitions.
// "8am daily" stays 8am wall clock on both sides of a transition, and a
// 02:30 anchor no longer drifts permanently to 03:30 after spring-forward
// (the old Date#setDate walk normalized the gap-day occurrence and then kept
// stepping from the normalized time). Time-based units (minutes, hours) step
// the absolute instant instead: "every 2 hours" means 2 real hours, so DST
// wall-clock identity deliberately does not apply to them.
//
// DST policy, proven in the D21 verification harness:
//   * spring-forward gap (e.g. 02:30 does not exist): the occurrence fires at
//     the next valid instant (02:30 -> 03:30), and the NEXT day returns to the
//     anchor's own wall time (02:30) because the walk carries wall-clock
//     components, never the normalized instant.
//   * fall-back ambiguity (e.g. 01:30 exists twice): the FIRST occurrence
//     (pre-transition offset) is chosen, so the task fires once, not twice.

export interface ScheduledTask {
  id: string;
  scheduled_start: string | null;
  repeat_interval: number | null;
  repeat_unit: string | null;
  repeat_end_type: string | null;
  repeat_end_value: string | null;
  run_count: number;
  is_paused: number;
  last_run_at: string | null;
  next_run_at: string | null;
  schedule_status: string;
  // v2.5.2 — comma-separated day numbers (0=Sun..6=Sat) used when
  // repeat_unit='specific_days'. e.g. '1,3' = Mon+Wed. Nullable.
  repeat_days_of_week?: string | null;
  // v2.5.45 — full ISO timestamp that anchors all future runs of a
  // recurring task. Computed forward from anchor instead of from
  // last_run_at, so a run that takes 5 minutes to complete doesn't
  // drift the schedule by 5 minutes every cycle. Nullable for
  // backwards compatibility; when null, falls back to scheduled_start.
  anchor_time?: string | null;
}

// ── Box timezone + wall-clock helpers (D21) ──

/** The single box's IANA timezone (follows the process/system TZ). */
export function getBoxTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Normalize a DB timestamp string to an unambiguous ISO instant. SQLite's
 * `datetime('now')` writes UTC in `YYYY-MM-DD HH:MM:SS` form (space
 * separator, no `Z`). The space-separator variant is parsed as LOCAL time
 * by V8, which yields a multi-hour drift for any value that came in via a
 * raw SQL path instead of the tracker tools (which normalize via
 * .toISOString()). Be defensive: if the string is missing an explicit
 * timezone marker, treat it as UTC.
 */
export function normalizeDbTimestamp(raw: string): string {
  return raw.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : raw.replace(' ', 'T') + 'Z';
}

/** Wall-clock components in some timezone (month is 1-12). */
export interface WallClock {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

/** The wall-clock reading of a UTC instant in the given timezone. */
export function instantToWall(instantMs: number, timeZone: string): WallClock {
  const parts = getDtf(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'), month: get('month'), day: get('day'),
    // hourCycle h23 should never emit 24, but normalize defensively.
    hour: get('hour') % 24, minute: get('minute'), second: get('second'),
  };
}

/** Wall-clock components read as if they were UTC (calendar arithmetic base). */
function wallAsUtcMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Offset (ms) such that wall = instant + offset, at the given instant. */
function offsetAt(instantMs: number, timeZone: string): number {
  return wallAsUtcMs(instantToWall(instantMs, timeZone)) - instantMs;
}

/**
 * The UTC instant at which the given wall clock is shown in the given
 * timezone. DST-transition handling:
 *   * ambiguous wall times (fall-back, the clock shows them twice) resolve
 *     to the FIRST occurrence (earliest instant);
 *   * non-existent wall times (spring-forward gap) resolve using the
 *     pre-transition offset, which lands on the next valid instant
 *     (02:30 in a 02:00->03:00 gap becomes 03:30).
 */
export function wallToInstant(w: WallClock, timeZone: string): Date {
  const target = wallAsUtcMs(w);
  // Probe the offset on both sides of the target so any transition near it
  // contributes its offset as a candidate.
  const offsets = new Set<number>([
    offsetAt(target - 86_400_000, timeZone),
    offsetAt(target, timeZone),
    offsetAt(target + 86_400_000, timeZone),
  ]);
  const valid: number[] = [];
  for (const o of offsets) {
    const t = target - o;
    if (offsetAt(t, timeZone) === o) valid.push(t);
  }
  if (valid.length > 0) return new Date(Math.min(...valid));
  // No candidate round-trips: the wall time falls in a spring-forward gap.
  // The pre-transition offset is always the smaller one (clocks jumped
  // forward), and target - min(offsets) is the first instant past the gap.
  return new Date(target - Math.min(...offsets));
}

/** Normalize overflowed wall components (day 32, month 13, ...) in pure calendar space. */
function normalizeWall(w: WallClock): WallClock {
  const d = new Date(wallAsUtcMs(w));
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
}

/** Day-of-week (0=Sun..6=Sat) of a wall-clock date. */
function wallDayOfWeek(w: WallClock): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

/**
 * Advance a wall clock by `interval` of a CALENDAR `unit`, holding the
 * time-of-day fixed. For 'weekdays', advance `interval` calendar days and
 * then skip past Saturday/Sunday to Monday, so an interval of 1 means
 * "every business day". For 'specific_days', `daysCSV` selects which
 * day-of-week the task fires on (e.g. "1,3" = Mon+Wed); `interval` is
 * ignored, the next matching day after `w` is chosen. If `daysCSV` is
 * empty/invalid the input is returned unchanged (caller treats this as a
 * config error).
 */
function advanceWallByUnit(w: WallClock, interval: number, unit: string, daysCSV: string | null): WallClock {
  switch (unit) {
    case 'days':
      return normalizeWall({ ...w, day: w.day + interval });
    case 'weeks':
      return normalizeWall({ ...w, day: w.day + interval * 7 });
    case 'months':
      return normalizeWall({ ...w, month: w.month + interval });
    case 'years':
      return normalizeWall({ ...w, year: w.year + interval });
    case 'weekdays': {
      let next = normalizeWall({ ...w, day: w.day + interval });
      const dow = wallDayOfWeek(next);
      if (dow === 6) next = normalizeWall({ ...next, day: next.day + 2 });
      else if (dow === 0) next = normalizeWall({ ...next, day: next.day + 1 });
      return next;
    }
    case 'specific_days': {
      const allowed = parseDaysOfWeek(daysCSV);
      if (!allowed) return w; // config error: unchanged, caller detects no progress
      let next = w;
      for (let i = 0; i < 7; i++) {
        next = normalizeWall({ ...next, day: next.day + 1 });
        if (allowed.has(wallDayOfWeek(next))) return next;
      }
      return next;
    }
    default:
      return w;
  }
}

export function calculateNextRun(task: ScheduledTask, timeZone?: string): string | null {
  if (!task.scheduled_start) return null;
  if (task.is_paused) return null;

  const tz = timeZone ?? getBoxTimeZone();

  // One-time task
  if (!task.repeat_interval || !task.repeat_unit) {
    return task.run_count === 0 ? task.scheduled_start : null;
  }

  // Check end conditions
  if (task.repeat_end_type === 'after_count' && task.repeat_end_value) {
    const maxRuns = parseInt(task.repeat_end_value, 10);
    if (!isNaN(maxRuns) && task.run_count >= maxRuns) return null;
  }
  if (task.repeat_end_type === 'on_date' && task.repeat_end_value) {
    // D21 discipline: resolve the end boundary in the BOX timezone, not via a
    // bare `new Date(...)`. A DATE-ONLY value ("2026-07-10", the shape the
    // dashboard date picker sends) parsed raw lands on UTC midnight, so on a
    // UTC-minus box it cuts the task's final local-day occurrences hours
    // early. The user picked a calendar DAY, so a date-only end value means
    // "through the end of that local day": end-of-day (23:59:59) wall clock in
    // the box timezone. A value that CARRIES a time-of-day (ISO `T` form or the
    // SQLite space form, with or without an explicit offset) is an explicit
    // instant: normalize the space/no-offset form to UTC exactly as
    // scheduled_start and anchor_time are normalized, and honor it as given
    // with no end-of-day rounding.
    const rawEnd = task.repeat_end_value.trim();
    const endMs = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
      ? wallToInstant({
          year: Number(rawEnd.slice(0, 4)),
          month: Number(rawEnd.slice(5, 7)),
          day: Number(rawEnd.slice(8, 10)),
          hour: 23, minute: 59, second: 59,
        }, tz).getTime()
      : new Date(normalizeDbTimestamp(rawEnd)).getTime();
    if (!isNaN(endMs) && Date.now() >= endMs) return null;
  }

  // If task has never run, first run IS the scheduled_start (don't add
  // interval). D21 exception: a specific_days schedule whose start falls on
  // a disallowed weekday must have its FIRST run land on the next allowed
  // day (same wall time), not fire on the disallowed day.
  if (!task.last_run_at && task.run_count === 0) {
    if (task.repeat_unit === 'specific_days') {
      const allowed = parseDaysOfWeek(task.repeat_days_of_week ?? null);
      if (allowed) {
        const start = new Date(normalizeDbTimestamp(task.scheduled_start));
        if (!isNaN(start.getTime())) {
          let wall = instantToWall(start.getTime(), tz);
          if (!allowed.has(wallDayOfWeek(wall))) {
            for (let i = 0; i < 7 && !allowed.has(wallDayOfWeek(wall)); i++) {
              wall = normalizeWall({ ...wall, day: wall.day + 1 });
            }
            return wallToInstant(wall, tz).toISOString();
          }
        }
      }
    }
    // Weekdays parity with the D21 specific_days exception above: a weekday
    // repeat whose scheduled_start lands on a weekend first-runs on Monday at
    // the same wall time instead of firing on the weekend.
    if (task.repeat_unit === 'weekdays') {
      const start = new Date(normalizeDbTimestamp(task.scheduled_start));
      if (!isNaN(start.getTime())) {
        let wall = instantToWall(start.getTime(), tz);
        const dow = wallDayOfWeek(wall);
        if (dow === 6 || dow === 0) {
          wall = normalizeWall({ ...wall, day: wall.day + (dow === 6 ? 2 : 1) });
          return wallToInstant(wall, tz).toISOString();
        }
      }
    }
    return task.scheduled_start;
  }

  // v2.5.45: base every recurring run on anchor_time, not on the
  // completion timestamp. Falls back to scheduled_start when anchor is
  // unset (pre-migration tasks). The "advance until future" walk below
  // then moves the anchor forward by whole intervals, so the wall-clock
  // alignment (e.g. "Monday at 06:00") is preserved even if past runs
  // took variable time to complete.
  const rawAnchor = task.anchor_time ?? task.scheduled_start;
  const baseTime = new Date(normalizeDbTimestamp(rawAnchor));

  if (isNaN(baseTime.getTime())) return null;

  if (task.repeat_unit !== 'minutes' && task.repeat_unit !== 'hours' &&
      task.repeat_unit !== 'days' && task.repeat_unit !== 'weeks' &&
      task.repeat_unit !== 'months' && task.repeat_unit !== 'years' &&
      task.repeat_unit !== 'weekdays' &&
      task.repeat_unit !== 'specific_days') {
    return null;
  }

  // Walk the anchor forward by whole intervals until we land strictly
  // after now. The previous run's slot also has to be passed (we don't
  // re-fire the same slot the agent just finished).
  const now = new Date();
  const lastSlot = task.last_run_at ? new Date(normalizeDbTimestamp(task.last_run_at)) : null;
  const notAfterMs = Math.max(
    now.getTime(),
    lastSlot && !isNaN(lastSlot.getTime()) ? lastSlot.getTime() : Number.NEGATIVE_INFINITY,
  );

  // Time-based units: step the absolute instant. "Every N hours" means N
  // real hours; DST wall-clock identity does not apply. Closed-form
  // fast-forward, so a long-idle minute-cadence anchor can't exhaust a
  // step bound.
  if (task.repeat_unit === 'minutes' || task.repeat_unit === 'hours') {
    const stepMs = task.repeat_interval * (task.repeat_unit === 'minutes' ? 60_000 : 3_600_000);
    if (stepMs <= 0) return null;
    let t = baseTime.getTime();
    if (t <= notAfterMs) {
      t += (Math.floor((notAfterMs - t) / stepMs) + 1) * stepMs;
    }
    return new Date(t).toISOString();
  }

  // Calendar units: walk wall-clock components in the box timezone.
  // Bounded loop, prevents infinite spin on a misconfigured interval;
  // 10k steps of daily catch-up is over 27 years, far more than any real
  // scenario.
  const MAX_ADVANCE_STEPS = 10_000;
  let wall = instantToWall(baseTime.getTime(), tz);
  let candidate = wallToInstant(wall, tz);
  let steps = 0;
  while (steps < MAX_ADVANCE_STEPS && candidate.getTime() <= notAfterMs) {
    const advanced = advanceWallByUnit(wall, task.repeat_interval, task.repeat_unit, task.repeat_days_of_week ?? null);
    if (advanced === wall) return null; // specific_days with no valid days configured
    wall = advanced;
    candidate = wallToInstant(wall, tz);
    steps++;
  }
  if (steps >= MAX_ADVANCE_STEPS) return null;

  // Weekday-result guarantee (2026-07-21, unit-suite root-cause find): the
  // weekend skip lived ONLY inside the advance step, so the zero-advance path
  // (anchor already past now/lastSlot after the v2.5.45 anchor rebase) could
  // return a weekend instant for an every-business-day schedule, and did, the
  // suite had been failing about it since 2026-05-16. Enforce the constraint
  // on the RESULT, not just the step: a weekdays schedule never yields Sat/Sun.
  if (task.repeat_unit === 'weekdays') {
    const dow = wallDayOfWeek(wall);
    if (dow === 6) { wall = normalizeWall({ ...wall, day: wall.day + 2 }); candidate = wallToInstant(wall, tz); }
    else if (dow === 0) { wall = normalizeWall({ ...wall, day: wall.day + 1 }); candidate = wallToInstant(wall, tz); }
  }

  return candidate.toISOString();
}

/**
 * Parse a comma-separated day-of-week string like "1,3" into a Set of
 * day numbers (0=Sun..6=Sat). Returns null if the string is empty or
 * has no valid entries (caller decides what to do).
 */
export function parseDaysOfWeek(s: string | null): Set<number> | null {
  if (!s) return null;
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out.size > 0 ? out : null;
}

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatRepeatPattern(
  interval: number | null,
  unit: string | null,
  daysCSV: string | null = null,
): string {
  if (!interval || !unit) return '';
  if (unit === 'weekdays') {
    return interval === 1 ? 'Every weekday' : `Every ${interval} weekdays`;
  }
  if (unit === 'specific_days') {
    const allowed = parseDaysOfWeek(daysCSV);
    if (!allowed || allowed.size === 0) return 'Every (no days selected)';
    if (allowed.size === 7) return 'Every day';
    if (allowed.size === 5 && [1, 2, 3, 4, 5].every((n) => allowed.has(n))) return 'Every weekday';
    if (allowed.size === 2 && allowed.has(0) && allowed.has(6)) return 'Every weekend';
    const names = [...allowed].sort().map((n) => DAY_NAMES_SHORT[n]);
    return `Every ${names.join(', ')}`;
  }
  if (interval === 1) return `Every ${unit.replace(/s$/, '')}`;
  return `Every ${interval} ${unit}`;
}
