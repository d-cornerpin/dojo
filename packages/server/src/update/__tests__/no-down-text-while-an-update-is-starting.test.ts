// While an update's first start (the new build, or the restored one after a rollback) is inside its
// allowed window, the generic outage texts wait; an ordinary outage is texted as always.
import { describe, it, expect } from 'vitest';
import { emptyState, outageTexts } from '../../../../../watchdog/src/alert-ledger.js';
import { FAIL_WALL_CLOCK_MS, type UpdateMarker } from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const LONG_DOWN = { failures: 6, sinceRestart: 2, restarts: 1 };
const starting = (startedMsAgo: number, phase: UpdateMarker['phase'] = 'booting-new'): UpdateMarker => ({
  phase, targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 1, firstBootAt: new Date(NOW - startedMsAgo).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 0, migrationsRanDuringEpisode: false, dataBackup: null, failedReason: null, writeSeq: 1,
  updatedAt: new Date(NOW).toISOString(),
});
const keys = (marker: UpdateMarker | null) => outageTexts(emptyState(), marker, NOW, LONG_DOWN).map(([key]) => key);

describe('no down text while an update is starting', () => {
  it('holds the texts during the first start of the new build and of a restored build', () => {
    expect(keys(starting(10 * 60_000))).toEqual([]);
    expect(keys(starting(4 * 60_000, 'rolled-back'))).toEqual([]);
  });

  it('texts once the first start has run past the window, however old the marker', () => {
    expect(keys(starting(FAIL_WALL_CLOCK_MS + 60_000))).toEqual(['platform_down', 'platform_restart_failed']);
    expect(keys(starting(30 * 86_400_000, 'rolled-back'))).toEqual(['platform_down', 'platform_restart_failed']);
  });

  it('an ordinary outage, or a start that already came up healthy, is texted', () => {
    expect(keys(null)).toEqual(['platform_down', 'platform_restart_failed']);
    const healthy = { ...starting(60_000, 'rolled-back'), confirmedHealthyAt: new Date(NOW).toISOString() };
    expect(keys(healthy)).toEqual(['platform_down', 'platform_restart_failed']);
  });
});
