// The full integrity read of the live database runs once a day by the clock, whatever restarts the
// watchdog, and once more after an update's first healthy start.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, integrityDue, persistState, readState, INTEGRITY_EVERY_MS } from '../../../../../watchdog/src/alert-ledger.js';
import type { UpdateMarker } from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const marker = (phase: UpdateMarker['phase'], confirmedHealthyAt: string | null): UpdateMarker => ({
  phase, targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: null, stagingDir: null, bootAttempts: 1,
  firstBootAt: new Date(NOW - 120_000).toISOString(), lastBootAt: null, confirmedHealthyAt, rollbackCount: 0,
  migrationsRanDuringEpisode: false, dataBackup: null, failedReason: null, writeSeq: 1, updatedAt: new Date(NOW).toISOString(),
});

describe('the integrity check runs daily and after an update', () => {
  it('runs when never run or a day has passed, not before', () => {
    expect(integrityDue(null, null, NOW)).toBe(true);
    expect(integrityDue(NOW - 3_600_000, null, NOW)).toBe(false);
    expect(integrityDue(NOW - INTEGRITY_EVERY_MS, null, NOW)).toBe(true);
  });

  it('runs once after an update first came up healthy', () => {
    const healthy = marker('healthy', new Date(NOW - 60_000).toISOString());
    expect(integrityDue(NOW - 3_600_000, healthy, NOW)).toBe(true);
    expect(integrityDue(NOW - 30_000, healthy, NOW), 'already run since').toBe(false);
  });

  it('waits while an update is still starting, even with no recorded time', () => {
    expect(integrityDue(null, marker('booting-new', null), NOW)).toBe(false);
  });

  it('a recorded time in the future (the clock was set back) is due', () => {
    expect(integrityDue(NOW + 3_600_000, null, NOW)).toBe(true);
  });

  it('the time of the last check survives a watchdog restart', () => {
    const file = path.join(fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'wd-state-')), 'watchdog-state.json');
    persistState({ ...emptyState(), lastIntegrityAt: NOW }, file);
    expect(readState(file).lastIntegrityAt).toBe(NOW);
  });
});
