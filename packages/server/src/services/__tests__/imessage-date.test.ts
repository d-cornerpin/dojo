// Pure unit tests for the chat.db date conversion behind the iMessage
// offline-replay age floor. The nanosecond-vs-second detection and the 2001 epoch
// offset are easy to get wrong, and getting them wrong either silently drops live
// texts (floor too aggressive) or fails to suppress a long-offline replay.

import { describe, it, expect } from 'vitest';
import { appleMessageDateToUnixMs, APPLE_CORE_DATA_EPOCH_MS } from '../imessage-date.js';

describe('appleMessageDateToUnixMs', () => {
  it('converts a nanosecond (High Sierra+) value to the correct Unix ms', () => {
    const expectedUnixMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const secondsAfterEpoch = (expectedUnixMs - APPLE_CORE_DATA_EPOCH_MS) / 1000;
    const rawNanos = secondsAfterEpoch * 1e9;
    expect(appleMessageDateToUnixMs(rawNanos)).toBe(expectedUnixMs);
  });

  it('converts a legacy second-encoded value to the correct Unix ms', () => {
    const expectedUnixMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const secondsAfterEpoch = (expectedUnixMs - APPLE_CORE_DATA_EPOCH_MS) / 1000; // same instant, seconds encoding
    expect(appleMessageDateToUnixMs(secondsAfterEpoch)).toBe(expectedUnixMs);
  });

  it('anchors the 2001 reference epoch (date 0 in second encoding = 2001-01-01Z)', () => {
    // A tiny positive second value maps just past the 2001 epoch, never to 1970.
    expect(appleMessageDateToUnixMs(1)).toBe(APPLE_CORE_DATA_EPOCH_MS + 1000);
  });

  it('returns null for missing/nonpositive values (age is UNKNOWN, do not skip)', () => {
    expect(appleMessageDateToUnixMs(0)).toBeNull();
    expect(appleMessageDateToUnixMs(-1)).toBeNull();
    expect(appleMessageDateToUnixMs(Number.NaN)).toBeNull();
    expect(appleMessageDateToUnixMs(Infinity)).toBeNull();
  });

  it('a recent nanosecond timestamp is NOT older than the 48h floor', () => {
    const FLOOR_MS = 48 * 60 * 60 * 1000;
    const nowSecondsAfterEpoch = (Date.now() - APPLE_CORE_DATA_EPOCH_MS) / 1000;
    const rawNanos = nowSecondsAfterEpoch * 1e9;
    const unixMs = appleMessageDateToUnixMs(rawNanos)!;
    expect(Date.now() - unixMs).toBeLessThan(FLOOR_MS);
  });

  it('a 3-day-old nanosecond timestamp IS older than the 48h floor', () => {
    const FLOOR_MS = 48 * 60 * 60 * 1000;
    const threeDaysAgoMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const secondsAfterEpoch = (threeDaysAgoMs - APPLE_CORE_DATA_EPOCH_MS) / 1000;
    const rawNanos = secondsAfterEpoch * 1e9;
    const unixMs = appleMessageDateToUnixMs(rawNanos)!;
    expect(Date.now() - unixMs).toBeGreaterThan(FLOOR_MS);
  });
});
