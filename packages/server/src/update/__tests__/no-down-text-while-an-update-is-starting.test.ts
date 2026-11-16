// While an update's first start is still inside its allowed window, the generic "DOWN" text waits;
// an ordinary outage is texted as always.
import { describe, it, expect } from 'vitest';
import { updateOwnsOutage, FAIL_WALL_CLOCK_MS, type UpdateMarker } from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const starting = (startedMsAgo: number): UpdateMarker => ({
  phase: 'booting-new', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 1, firstBootAt: new Date(NOW - startedMsAgo).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 0, migrationsRanDuringEpisode: false, dataBackup: null, failedReason: null, writeSeq: 1,
  updatedAt: new Date(NOW).toISOString(),
});

describe('no down text while an update is starting', () => {
  it('holds the text during the first start', () => {
    expect(updateOwnsOutage(starting(10 * 60_000), {}, NOW)).toBe(true);
  });

  it('texts once the first start has run past the window', () => {
    expect(updateOwnsOutage(starting(FAIL_WALL_CLOCK_MS + 60_000), {}, NOW)).toBe(false);
  });

  it('an ordinary outage, or a start that already came up healthy, is texted', () => {
    expect(updateOwnsOutage(null, {}, NOW)).toBe(false);
    expect(updateOwnsOutage({ ...starting(60_000), phase: 'healthy', confirmedHealthyAt: new Date(NOW).toISOString() }, {}, NOW)).toBe(false);
  });
});
