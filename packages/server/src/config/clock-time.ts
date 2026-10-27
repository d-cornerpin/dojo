/** A daily run time as the dashboard saves it: "H:MM" or "HH:MM", hours 0-23, minutes 0-59. */
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/;

export const CLOCK_TIME_SETTING_KEYS = ['healer_time', 'dreaming_time'];

/** Null when `value` is a valid daily run time; otherwise the refusal to send back. */
export function refuseBadClockTime(value: unknown): string | null {
  const m = typeof value === 'string' ? CLOCK_TIME.exec(value) : null;
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return null;
  return `"${String(value)}" is not a time of day. Use HH:MM on a 24-hour clock, for example 04:00 or 23:30.`;
}
