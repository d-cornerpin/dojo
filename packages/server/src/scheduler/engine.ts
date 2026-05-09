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

  // Calculate next run from last run (or from scheduled_start if never run)
  const baseTime = task.last_run_at
    ? new Date(task.last_run_at)
    : new Date(task.scheduled_start);

  if (isNaN(baseTime.getTime())) return null;

  const next = new Date(baseTime);

  advanceByUnit(next, task.repeat_interval, task.repeat_unit);
  if (task.repeat_unit !== 'minutes' && task.repeat_unit !== 'hours' &&
      task.repeat_unit !== 'days' && task.repeat_unit !== 'weeks' &&
      task.repeat_unit !== 'months' && task.repeat_unit !== 'years' &&
      task.repeat_unit !== 'weekdays') {
    return null;
  }

  // If the computed next run is in the past (e.g., server was down), advance until future
  const now = new Date();
  while (next <= now && task.repeat_interval && task.repeat_unit) {
    advanceByUnit(next, task.repeat_interval, task.repeat_unit);
  }

  return next.toISOString();
}

/**
 * Advance `d` in place by `interval` of `unit`. For 'weekdays', advance
 * `interval` calendar days and then skip past Saturday/Sunday to Monday —
 * so an interval of 1 means "every business day."
 */
function advanceByUnit(d: Date, interval: number, unit: string): void {
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
  }
}

export function formatRepeatPattern(interval: number | null, unit: string | null): string {
  if (!interval || !unit) return '';
  if (unit === 'weekdays') {
    return interval === 1 ? 'Every weekday' : `Every ${interval} weekdays`;
  }
  if (interval === 1) return `Every ${unit.replace(/s$/, '')}`;
  return `Every ${interval} ${unit}`;
}
