// chat.db `message.date` conversion, isolated as a pure, dependency-free helper
// so the offline-replay age floor's date math is unit-testable without pulling in
// the whole iMessage bridge graph.
//
// `message.date` is Apple Core Data time, offset from the 2001-01-01 UTC reference
// epoch: nanoseconds on High Sierra+ (older macOS stored seconds).
export const APPLE_CORE_DATA_EPOCH_MS = 978_307_200_000; // 2001-01-01T00:00:00Z in Unix ms

/**
 * Convert a chat.db `message.date` to a Unix-epoch millisecond timestamp,
 * tolerating BOTH the nanosecond (High Sierra+) and legacy second encodings.
 * Returns null when the raw value is missing/nonpositive: the caller then treats
 * the age as UNKNOWN and must NOT skip on it (dropping a real text is worse than a
 * rare stale reply).
 */
export function appleMessageDateToUnixMs(rawDate: number): number | null {
  if (!Number.isFinite(rawDate) || rawDate <= 0) return null;
  // Present-day nanosecond values are ~1e18; the legacy second values are ~8e8.
  const offsetMs = rawDate > 1e12 ? rawDate / 1e6 : rawDate * 1000;
  return offsetMs + APPLE_CORE_DATA_EPOCH_MS;
}
