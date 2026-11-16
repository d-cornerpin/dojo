// The watchdog's gate: a failing first start after the update changed the data is rolled back, data
// included, and the record of the data copy survives the watchdog's own write before rollback.sh runs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideAutoRollback, toRolledBack, readMarker, writeMarker, FAIL_BOOT_ATTEMPTS, type UpdateMarker,
} from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const failing = (over: Partial<UpdateMarker>): UpdateMarker => ({
  phase: 'booting-new', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: FAIL_BOOT_ATTEMPTS, firstBootAt: new Date(NOW).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 0, migrationsRanDuringEpisode: false, dataBackup: null, failedReason: null, writeSeq: 1,
  updatedAt: new Date(NOW).toISOString(), ...over,
});

describe('a failed first start after a migration is rolled back with its data', () => {
  it('rolls back, data included, when a migration ran', () => {
    const m = failing({ migrationsRanDuringEpisode: true, dataBackup: '/d/dojo-pre-1-of-2.db' });
    expect(decideAutoRollback(m, NOW)).toEqual({ action: 'rollback', withData: true });
  });

  it('rolls back the program only when no migration ran', () => {
    expect(decideAutoRollback(failing({}), NOW)).toEqual({ action: 'rollback', withData: false });
  });

  it('never rolls back twice', () => {
    const m = failing({ migrationsRanDuringEpisode: true, rollbackCount: 1 });
    expect(decideAutoRollback(m, NOW)).toEqual({ action: 'escalate', reason: 'exhausted' });
  });

  it('keeps the recorded data copy through the watchdog\'s write', () => {
    const file = path.join(fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'wd-marker-')), 'update-state.json');
    writeMarker(toRolledBack(failing({ migrationsRanDuringEpisode: true, dataBackup: '/d/dojo-pre-1-of-2.db' })), file);
    expect(readMarker(file)?.dataBackup).toBe('/d/dojo-pre-1-of-2.db');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
