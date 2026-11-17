// A new build that dies while loading never runs its own boot sentinel, so the marker keeps no first-boot
// time. The watchdog then measures the update's window from when the update was marked.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideAutoRollback, updateIsStarting, readMarker, type UpdateMarker } from '../../../../../watchdog/src/auto-rollback.js';

const MARKED = Date.parse('2026-11-16T12:00:00.000Z');
const MIN = 60_000;
const neverRan: UpdateMarker = {
  phase: 'booting-new', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 0, firstBootAt: null, lastBootAt: null, confirmedHealthyAt: null, rollbackCount: 0,
  migrationsRanDuringEpisode: false, dataBackup: null, failedReason: null, writeSeq: 3,
  updatedAt: new Date(MARKED).toISOString(),
};

describe('a build that crashes while loading is still rolled back', () => {
  it('16 minutes after the update was marked, never healthy: roll back; at 5 minutes: wait, and hold the down texts', () => {
    expect(decideAutoRollback(neverRan, MARKED + 16 * MIN)).toEqual({ action: 'rollback' });
    expect(decideAutoRollback(neverRan, MARKED + 5 * MIN)).toEqual({ action: 'none' });
    expect(updateIsStarting(neverRan, MARKED + 5 * MIN)).toBe(true);
    expect(updateIsStarting(neverRan, MARKED + 16 * MIN)).toBe(false);
  });

  it('a marker that carries no time is measured from when its file was written', () => {
    const file = path.join(fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'wd-marker-')), 'update-state.json');
    const { updatedAt: _dropped, ...noTime } = neverRan;
    fs.writeFileSync(file, JSON.stringify(noTime));
    fs.utimesSync(file, new Date(MARKED), new Date(MARKED));
    expect(decideAutoRollback(readMarker(file), MARKED + 16 * MIN)).toEqual({ action: 'rollback' });
    expect(decideAutoRollback(readMarker(file), MARKED + 5 * MIN)).toEqual({ action: 'none' });
  });
});
