// The watchdog rolls back a failing first start, migration or not, then relays the sentence rollback.sh
// wrote and acts on its outcome word: a rollback that changed nothing is not the one rollback spent, and
// neither a refused nor a broken rollback is tried again.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideAutoRollback, takeRollbackResult, afterRollbackResult, FAIL_BOOT_ATTEMPTS, type UpdateMarker,
} from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const rolledBack: UpdateMarker = {
  phase: 'rolled-back', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 0, firstBootAt: new Date(NOW).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 1, migrationsRanDuringEpisode: true, dataBackup: '/d/dojo-pre.db', failedReason: null, writeSeq: 1,
  updatedAt: new Date(NOW).toISOString(),
};

/** The outcome as rollback.sh --auto writes it, read back the way the watchdog reads it. */
function outcome(line: string): NonNullable<ReturnType<typeof takeRollbackResult>> {
  const file = path.join(fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'wd-result-')), 'rollback-result');
  fs.writeFileSync(file, `${line}\n`);
  const r = takeRollbackResult(file);
  expect(fs.existsSync(file), 'the outcome is told once').toBe(false);
  return r!;
}

describe('a failed first start after a migration is rolled back with its data', () => {
  it('rolls back when a migration ran', () => {
    expect(decideAutoRollback({ ...rolledBack, phase: 'booting-new', rollbackCount: 0, bootAttempts: FAIL_BOOT_ATTEMPTS }, NOW))
      .toEqual({ action: 'rollback' });
  });

  it('a restored box keeps its episode, and the owner is told the sentence the script wrote', () => {
    for (const kind of ['restored-with-data', 'restored']) {
      const r = outcome(`${kind}\tWatchdog: Dojo 3.4.1 was put back.`);
      expect(r).toEqual({ kind, text: 'Watchdog: Dojo 3.4.1 was put back.' });
      expect(afterRollbackResult(rolledBack, r)).toBeNull();
    }
  });

  it('nothing changed: the rollback is not counted as spent, and is not tried again', () => {
    const after = afterRollbackResult(rolledBack, outcome('unchanged\tWatchdog: nothing was changed.'))!;
    expect(after.rollbackCount).toBe(0);
    expect(decideAutoRollback(after, NOW + 3_600_000)).toEqual({ action: 'none' });
  });

  it('undoing went wrong: the rollback stays spent, and is not tried again', () => {
    const after = afterRollbackResult(rolledBack, outcome('failed\tWatchdog: it went wrong.'))!;
    expect(after.rollbackCount).toBe(1);
    expect(decideAutoRollback(after, NOW + 3_600_000)).toEqual({ action: 'none' });
  });

  it('no outcome on disk is nothing to tell', () => {
    expect(takeRollbackResult(path.join(os.tmpdir(), 'no-such-rollback-result'))).toBeNull();
  });
});
