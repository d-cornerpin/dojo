// A "booting-new" update marker that never recorded a first start and is more than a day old is old history,
// not a failing update: no rollback. A fresh one, or one whose build did start, still rolls back.
import { describe, it, expect } from 'vitest';
import { decideAutoRollback, type UpdateMarker } from '../auto-rollback.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 3_600_000;
function marker(over: Partial<UpdateMarker>): UpdateMarker {
  return {
    phase: 'booting-new', targetVersion: '9.9.9', previousVersion: '9.9.8', backupDir: null, stagingDir: null,
    bootAttempts: 0, firstBootAt: null, lastBootAt: null, confirmedHealthyAt: null, rollbackCount: 0,
    migrationsRanDuringEpisode: false, dataBackup: null, failedReason: null, writeSeq: 1,
    updatedAt: new Date(NOW - 25 * HOUR).toISOString(), ...over,
  };
}

describe('an old update marker that never started', () => {
  it('more than a day old with no first start: no rollback', () => {
    expect(decideAutoRollback(marker({}), NOW)).toEqual({ action: 'none' });
  });

  it('one hour old with no first start: still rolls back', () => {
    expect(decideAutoRollback(marker({ updatedAt: new Date(NOW - HOUR).toISOString() }), NOW)).toEqual({ action: 'rollback' });
  });

  it('a day old but its build did start and never got healthy: still rolls back', () => {
    expect(decideAutoRollback(marker({ firstBootAt: new Date(NOW - 25 * HOUR).toISOString() }), NOW)).toEqual({ action: 'rollback' });
  });
});
