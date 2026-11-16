// After the watchdog rolls back a failing first start, it relays the sentence rollback.sh wrote and acts on
// its outcome word: a refused or broken rollback ends the episode and is not tried again.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideAutoRollback, readRollbackResult, afterRollbackResult, type UpdateMarker,
} from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const rolledBack: UpdateMarker = {
  phase: 'rolled-back', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 0, firstBootAt: new Date(NOW).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 1, migrationsRanDuringEpisode: true, dataBackup: '/d/dojo-pre.db', failedReason: null, writeSeq: 1,
  updatedAt: new Date(NOW).toISOString(),
};

/** The outcome as rollback.sh --auto writes it, read back the way the watchdog reads it. */
function outcome(line: string): NonNullable<ReturnType<typeof readRollbackResult>> {
  const file = path.join(fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'wd-result-')), 'rollback-result');
  fs.writeFileSync(file, `${line}\n`);
  const r = readRollbackResult(file);
  expect(fs.existsSync(file), 'the outcome stays until it has been told').toBe(true);
  return r!;
}

describe('a failed first start after a migration is rolled back with its data', () => {
  it('a restored box keeps its episode, and the owner is told the sentence the script wrote', () => {
    for (const kind of ['restored-with-data', 'restored']) {
      const r = outcome(`${kind}\tWatchdog: Dojo 3.4.1 was put back.`);
      expect(r).toEqual({ kind, text: 'Watchdog: Dojo 3.4.1 was put back.' });
      expect(afterRollbackResult(rolledBack, r)).toBeNull();
    }
  });

  it('a refused or broken rollback ends the episode and is not tried again', () => {
    for (const kind of ['unchanged', 'failed']) {
      const after = afterRollbackResult(rolledBack, outcome(`${kind}\tWatchdog: it did not work.`))!;
      expect(after.phase).toBe('failed-permanently');
      expect(decideAutoRollback(after, NOW + 3_600_000)).toEqual({ action: 'none' });
      expect(afterRollbackResult(after, outcome(`${kind}\tWatchdog: it did not work.`)), 'told again, the episode is not rewritten').toBeNull();
    }
  });

  it('no outcome on disk is nothing to tell', () => {
    expect(readRollbackResult(path.join(os.tmpdir(), 'no-such-rollback-result'))).toBeNull();
  });
});
