export const APPLE_CORE_DATA_EPOCH_MS = 978_307_200_000; // Core Data reference epoch, in Unix ms

/** Unix ms from a chat.db date (ns ~1e18, legacy s ~8e8, cut at 1e12); null = age unknown, never skip. */
export function appleMessageDateToUnixMs(rawDate: number): number | null {
  if (!Number.isFinite(rawDate) || rawDate <= 0) return null;
  const offsetMs = rawDate > 1e12 ? rawDate / 1e6 : rawDate * 1000;
  return offsetMs + APPLE_CORE_DATA_EPOCH_MS;
}
