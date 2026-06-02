// ════════════════════════════════════════
// Schedule Calculation Engine (Phase 6)
// Computes next run times for scheduled/recurring tasks
// ════════════════════════════════════════

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

export function calculateNextRun(task: ScheduledTask): string | null {
  if (!task.scheduled_start) return null;
  if (task.is_paused) return null;

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
    const endDate = new Date(task.repeat_end_value);
    if (!isNaN(endDate.getTime()) && new Date() >= endDate) return null;
  }

  // If task has never run, first run IS the scheduled_start — don't add interval
  if (!task.last_run_at && task.run_count === 0) {
    return task.scheduled_start;
  }

  // v2.5.45 — base every recurring run on anchor_time, not on the
  // completion timestamp. Falls back to scheduled_start when anchor is
  // unset (pre-migration tasks). The "advance until future" loop below
  // then walks the anchor forward by whole intervals, so the wall-clock
  // alignment (e.g. "Monday at 06:00") is preserved even if past runs
  // took variable time to complete.
  // SQLite's `datetime('now')` writes UTC timestamps in `YYYY-MM-DD
  // HH:MM:SS` form (space separator, no `Z`). The space-separator variant
  // is parsed as LOCAL time by V8, which yields a 7-hour drift for any
  // anchor that came in via a raw SQL path instead of the tracker tools
  // (which normalize via .toISOString()). Be defensive: if the string is
  // missing an explicit timezone marker, treat it as UTC.
  const rawAnchor = task.anchor_time ?? task.scheduled_start;
  const anchorIso = rawAnchor.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(rawAnchor)
    ? rawAnchor
    : rawAnchor.replace(' ', 'T') + 'Z';
  const baseTime = new Date(anchorIso);

  if (isNaN(baseTime.getTime())) return null;

  if (task.repeat_unit !== 'minutes' && task.repeat_unit !== 'hours' &&
      task.repeat_unit !== 'days' && task.repeat_unit !== 'weeks' &&
      task.repeat_unit !== 'months' && task.repeat_unit !== 'years' &&
      task.repeat_unit !== 'weekdays' &&
      task.repeat_unit !== 'specific_days') {
    return null;
  }

  const next = new Date(baseTime);

  // Walk the anchor forward by whole intervals until we land strictly
  // after now. The previous run's slot also has to be passed (we don't
  // re-fire the same slot the agent just finished).
  const now = new Date();
  const lastSlot = task.last_run_at ? new Date(task.last_run_at) : null;
  // Bound the loop — prevents infinite spin on a misconfigured interval.
  // For specific_days the inner advancer is already bounded; for other
  // units one decade of catch-up runs is far more than any real scenario.
  const MAX_ADVANCE_STEPS = 10_000;
  let steps = 0;
  while (
    steps < MAX_ADVANCE_STEPS &&
    (next <= now || (lastSlot && next <= lastSlot))
  ) {
    advanceByUnit(next, task.repeat_interval, task.repeat_unit, task.repeat_days_of_week ?? null);
    steps++;
  }
  if (steps >= MAX_ADVANCE_STEPS) return null;

  return next.toISOString();
}

/**
 * Parse a comma-separated day-of-week string like "1,3" into a Set of
 * day numbers (0=Sun..6=Sat). Returns null if the string is empty or
 * has no valid entries (caller decides what to do).
 */
function parseDaysOfWeek(s: string | null): Set<number> | null {
  if (!s) return null;
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out.size > 0 ? out : null;
}

/**
 * Advance `d` in place by `interval` of `unit`. For 'weekdays', advance
 * `interval` calendar days and then skip past Saturday/Sunday to Monday —
 * so an interval of 1 means "every business day."
 *
 * For 'specific_days', `daysCSV` selects which day-of-week the task
 * fires on (e.g. "1,3" = Mon+Wed). `interval` is ignored — the next
 * matching day after `d` is chosen. If `daysCSV` is empty/invalid, the
 * date is unchanged (caller should treat this as a config error).
 */
function advanceByUnit(d: Date, interval: number, unit: string, daysCSV: string | null = null): void {
  switch (unit) {
    case 'minutes':
      d.setMinutes(d.getMinutes() + interval);
      break;
    case 'hours':
      d.setHours(d.getHours() + interval);
      break;
    case 'days':
      d.setDate(d.getDate() + interval);
      break;
    case 'weeks':
      d.setDate(d.getDate() + interval * 7);
      break;
    case 'months':
      d.setMonth(d.getMonth() + interval);
      break;
    case 'years':
      d.setFullYear(d.getFullYear() + interval);
      break;
    case 'weekdays': {
      d.setDate(d.getDate() + interval);
      const dow = d.getDay(); // 0=Sun, 6=Sat
      if (dow === 6) d.setDate(d.getDate() + 2);
      else if (dow === 0) d.setDate(d.getDate() + 1);
      break;
    }
    case 'specific_days': {
      // v2.5.2 — advance to the next allowed day-of-week. Bounded loop
      // (max 7 iterations) so a misconfigured empty set can't spin.
      const allowed = parseDaysOfWeek(daysCSV);
      if (!allowed) {
        // No valid days configured — leave date unchanged. Caller's
        // outer while-loop in calculateNextRun would otherwise spin
        // forever; calculateNextRun's "advance until future" guard
        // also relies on this returning bounded behavior.
        return;
      }
      for (let i = 0; i < 7; i++) {
        d.setDate(d.getDate() + 1);
        if (allowed.has(d.getDay())) return;
      }
      break;
    }
  }
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
