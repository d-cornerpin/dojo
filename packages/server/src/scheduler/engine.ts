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

  switch (task.repeat_unit) {
    case 'minutes':
      next.setMinutes(next.getMinutes() + task.repeat_interval);
      break;
    case 'hours':
      next.setHours(next.getHours() + task.repeat_interval);
      break;
    case 'days':
      next.setDate(next.getDate() + task.repeat_interval);
      break;
    case 'weeks':
      next.setDate(next.getDate() + task.repeat_interval * 7);
      break;
    case 'months':
      next.setMonth(next.getMonth() + task.repeat_interval);
      break;
    case 'years':
      next.setFullYear(next.getFullYear() + task.repeat_interval);
      break;
    default:
      return null;
  }

  // If the computed next run is in the past (e.g., server was down), advance until future
  const now = new Date();
  while (next <= now && task.repeat_interval && task.repeat_unit) {
    switch (task.repeat_unit) {
      case 'minutes': next.setMinutes(next.getMinutes() + task.repeat_interval); break;
      case 'hours': next.setHours(next.getHours() + task.repeat_interval); break;
      case 'days': next.setDate(next.getDate() + task.repeat_interval); break;
      case 'weeks': next.setDate(next.getDate() + task.repeat_interval * 7); break;
      case 'months': next.setMonth(next.getMonth() + task.repeat_interval); break;
      case 'years': next.setFullYear(next.getFullYear() + task.repeat_interval); break;
    }
  }

  return next.toISOString();
}

export function formatRepeatPattern(interval: number | null, unit: string | null): string {
  if (!interval || !unit) return '';
  if (interval === 1) return `Every ${unit.replace(/s$/, '')}`;
  return `Every ${interval} ${unit}`;
}
