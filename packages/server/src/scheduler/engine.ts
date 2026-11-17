// Schedule calculation engine: computes next run times for scheduled and recurring tasks.
// Calendar units (days, weeks, months, years, weekdays, specific_days) are computed in the BOX's IANA
// timezone via Intl, holding the anchor's wall-clock time fixed across DST ("8am daily" stays 8am).
// Minutes and hours step the absolute instant ("every 2 hours" is 2 real hours), so DST does not apply.
// DST policy, pinned by `scheduler/__tests__/the-reminder-clock-holds-its-wall-time.test.ts`:
//   * spring-forward gap (02:30 does not exist): fires at the next valid instant (03:30); the next day
//     returns to the anchor's wall time because the walk carries wall-clock components, not the instant.
//   * fall-back ambiguity (01:30 exists twice): the FIRST occurrence is chosen, so the task fires once.

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
  // Comma-separated day numbers (0=Sun..6=Sat) for repeat_unit='specific_days', e.g. '1,3' = Mon+Wed.
  repeat_days_of_week?: string | null;
  // Anchors all future runs (so slow runs do not drift); null falls back to scheduled_start.
  anchor_time?: string | null;
  /** The declared per-task IANA zone; null means the box timezone. */
  tz?: string | null;
}


// Builds a `ScheduledTask` from a `work` row's projected columns, including its own zone `tz`.
export function scheduledTaskFromRow(row: Record<string, unknown>, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: row.id as string,
    scheduled_start: row.scheduled_start as string | null,
    repeat_interval: row.repeat_interval as number | null,
    repeat_unit: row.repeat_unit as string | null,
    repeat_end_type: row.repeat_end_type as string | null,
    repeat_end_value: row.repeat_end_value as string | null,
    run_count: (row.run_count as number) ?? 0,
    is_paused: (row.is_paused as number) ?? 0,
    last_run_at: row.last_run_at as string | null,
    next_run_at: row.next_run_at as string | null,
    schedule_status: row.schedule_status as string,
    repeat_days_of_week: row.repeat_days_of_week as string | null,
    anchor_time: row.anchor_time as string | null,
    tz: row.tz as string | null,
    ...over,
  };
}

export function getBoxTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Normalize a DB timestamp to an unambiguous ISO instant. SQLite's `datetime('now')` writes UTC without a
 * `Z`, which V8 parses as LOCAL time, so a value with no timezone marker is treated as UTC.
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

export function instantToWall(instantMs: number, timeZone: string): WallClock {
  const parts = getDtf(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24, minute: get('minute'), second: get('second'),
  };
}

function wallAsUtcMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

function offsetAt(instantMs: number, timeZone: string): number {
  return wallAsUtcMs(instantToWall(instantMs, timeZone)) - instantMs;
}

/**
 * The UTC instant at which the wall clock is shown in the timezone. An ambiguous time (fall-back)
 * resolves to the FIRST occurrence; a non-existent time (spring-forward gap) uses the pre-transition
 * offset, landing on the next valid instant (02:30 in a 02:00->03:00 gap becomes 03:30).
 */
export function wallToInstant(w: WallClock, timeZone: string): Date {
  const target = wallAsUtcMs(w);
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
  // No candidate round-trips: the time is in a spring-forward gap; the pre-transition offset is the
  // smaller one, so target - min(offsets) is the first instant past the gap.
  return new Date(target - Math.min(...offsets));
}

function normalizeWall(w: WallClock): WallClock {
  const d = new Date(wallAsUtcMs(w));
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
}

function wallDayOfWeek(w: WallClock): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

/**
 * Add `totalMonths` to a wall clock, CLAMPING the day to the target month's length (Jan 31 + 1 month is
 * Feb 28). Used for months/years; the other units keep normalizeWall's overflow.
 */
function addClampedMonths(w: WallClock, totalMonths: number): WallClock {
  const month0 = w.month - 1 + totalMonths;
  const year = w.year + Math.floor(month0 / 12);
  const month = ((month0 % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { ...w, year, month, day: Math.min(w.day, lastDay) };
}

/**
 * Advance a wall clock by `interval` of a calendar `unit`, holding time-of-day fixed. 'weekdays' skips
 * Saturday/Sunday; 'specific_days' ignores `interval` and picks the next day in `daysCSV`, returning the
 * input unchanged when that is empty or invalid (the caller treats that as a config error).
 */
function advanceWallByUnit(w: WallClock, interval: number, unit: string, daysCSV: string | null): WallClock {
  switch (unit) {
    case 'days':
      return normalizeWall({ ...w, day: w.day + interval });
    case 'weeks':
      return normalizeWall({ ...w, day: w.day + interval * 7 });
    case 'months':
      return addClampedMonths(w, interval);
    case 'years':
      return addClampedMonths(w, interval * 12);
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

/** The task's next run strictly after `nowMs` (default now) and its last run. */
export function calculateNextRun(task: ScheduledTask, timeZone?: string, nowMs = Date.now()): string | null {
  if (!task.scheduled_start) return null;
  if (task.is_paused) return null;

  // The row's own zone is read here so no caller can forget it; an explicit argument still wins.
  const tz = timeZone ?? task.tz ?? getBoxTimeZone();

  if (!task.repeat_interval || !task.repeat_unit) {
    return task.run_count === 0 ? task.scheduled_start : null;
  }

  if (task.repeat_end_type === 'after_count' && task.repeat_end_value) {
    const maxRuns = parseInt(task.repeat_end_value, 10);
    if (!isNaN(maxRuns) && task.run_count >= maxRuns) return null;
  }
  let endMs: number | null = null;
  if (task.repeat_end_type === 'on_date' && task.repeat_end_value) {
    // Resolve the end boundary in the box timezone. A date-only value (what the dashboard date picker
    // sends) means through the end of that local day (23:59:59); a value carrying a time of day is an
    // explicit instant, normalized like scheduled_start and anchor_time, with no end-of-day rounding.
    const rawEnd = task.repeat_end_value.trim();
    const parsedEnd = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
      ? wallToInstant({
          year: Number(rawEnd.slice(0, 4)),
          month: Number(rawEnd.slice(5, 7)),
          day: Number(rawEnd.slice(8, 10)),
          hour: 23, minute: 59, second: 59,
        }, tz).getTime()
      : new Date(normalizeDbTimestamp(rawEnd)).getTime();
    if (!isNaN(parsedEnd)) endMs = parsedEnd;
    if (!isNaN(parsedEnd) && nowMs >= parsedEnd) return null;
  }
  const pastEnd = (iso: string): boolean => endMs !== null && new Date(iso).getTime() > endMs;

  // First run is scheduled_start itself, except a specific_days or weekdays start on a disallowed day,
  // which moves to the next allowed day at the same wall time.
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

  // Base runs on anchor_time ?? scheduled_start, not completion time, so wall-clock alignment survives.
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

  // Walk strictly past both now and the last run's slot, so a just-finished slot never re-fires.
  const lastSlot = task.last_run_at ? new Date(normalizeDbTimestamp(task.last_run_at)) : null;
  const notAfterMs = Math.max(
    nowMs,
    lastSlot && !isNaN(lastSlot.getTime()) ? lastSlot.getTime() : Number.NEGATIVE_INFINITY,
  );

  // Minutes and hours step the absolute instant in closed form, so a long-idle anchor cannot exhaust a bound.
  if (task.repeat_unit === 'minutes' || task.repeat_unit === 'hours') {
    const stepMs = task.repeat_interval * (task.repeat_unit === 'minutes' ? 60_000 : 3_600_000);
    if (stepMs <= 0) return null;
    let t = baseTime.getTime();
    if (t <= notAfterMs) {
      t += (Math.floor((notAfterMs - t) / stepMs) + 1) * stepMs;
    }
    const nextIso = new Date(t).toISOString();
    return pastEnd(nextIso) ? null : nextIso;
  }

  // Calendar units walk wall-clock components in the box timezone; the step bound stops a runaway interval.
  const MAX_ADVANCE_STEPS = 10_000;
  // Month/year candidates derive from the ANCHOR, not the previous clamped one: Jan 31 -> Feb 28 -> Mar 31.
  const anchorWall = instantToWall(baseTime.getTime(), tz);
  let wall = anchorWall;
  let candidate = wallToInstant(wall, tz);
  let steps = 0;
  while (steps < MAX_ADVANCE_STEPS && candidate.getTime() <= notAfterMs) {
    const advanced = (task.repeat_unit === 'months' || task.repeat_unit === 'years')
      ? advanceWallByUnit(anchorWall, task.repeat_interval * (steps + 1), task.repeat_unit, task.repeat_days_of_week ?? null)
      : advanceWallByUnit(wall, task.repeat_interval, task.repeat_unit, task.repeat_days_of_week ?? null);
    if (advanced === wall) return null; // specific_days with no valid days configured
    wall = advanced;
    candidate = wallToInstant(wall, tz);
    steps++;
  }
  if (steps >= MAX_ADVANCE_STEPS) return null;

  // A weekdays schedule never yields Sat/Sun: enforce it on the result (the zero-advance path skips the step).
  if (task.repeat_unit === 'weekdays') {
    const dow = wallDayOfWeek(wall);
    if (dow === 6) { wall = normalizeWall({ ...wall, day: wall.day + 2 }); candidate = wallToInstant(wall, tz); }
    else if (dow === 0) { wall = normalizeWall({ ...wall, day: wall.day + 1 }); candidate = wallToInstant(wall, tz); }
  }

  // A specific_days schedule never yields a day it may not run on, also when no step was taken.
  if (task.repeat_unit === 'specific_days' && !parseDaysOfWeek(task.repeat_days_of_week ?? null)?.has(wallDayOfWeek(wall))) {
    wall = advanceWallByUnit(wall, 1, 'specific_days', task.repeat_days_of_week ?? null); candidate = wallToInstant(wall, tz);
  }

  const candidateIso = candidate.toISOString();
  return pastEnd(candidateIso) ? null : candidateIso;
}

/** Parse a day-of-week CSV like "1,3" into a Set (0=Sun..6=Sat); null when empty or without a valid entry. */
export function parseDaysOfWeek(s: string | null): Set<number> | null {
  if (!s) return null;
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out.size > 0 ? out : null;
}
