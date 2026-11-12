/** A daily run time as the dashboard saves it: "H:MM" or "HH:MM", hours 0-23, minutes 0-59. */
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/;

export const CLOCK_TIME_SETTING_KEYS = ['healer_time', 'dreaming_time'];

/** Null when `value` is a valid daily run time; otherwise the refusal to send back. */
export function refuseBadClockTime(value: unknown): string | null {
  const m = typeof value === 'string' ? CLOCK_TIME.exec(value) : null;
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return null;
  return `"${String(value)}" is not a time of day. Use HH:MM on a 24-hour clock, for example 04:00 or 23:30.`;
}

// Delay to the next local daily run strictly after `now`; an invalid stored text uses `fallbackText`.
export function nextDailyRunDelayMs(
  timeText: unknown,
  fallbackText: string,
  now: Date,
): { delayMs: number; usedFallback: boolean } {
  const usedFallback = refuseBadClockTime(timeText) !== null;
  const [h, m] = (usedFallback ? fallbackText : (timeText as string)).split(':').map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return { delayMs: next.getTime() - now.getTime(), usedFallback };
}
