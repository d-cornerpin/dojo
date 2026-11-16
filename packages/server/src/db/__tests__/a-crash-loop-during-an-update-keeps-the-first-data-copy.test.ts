// An update whose starts keep failing records, on its episode, the data copy taken before its first
// migration ran; later starts take newer copies of the half-changed data and never replace that record.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations, migrationFileNames } from '../migrations.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { markPendingUpdate, markBootingNew, recordBootAttempt, readMarker, UPDATE_STATE_PATH } from '../../update-state.js';
import { boxBefore901, FILE } from './helpers/a-box-before-901.js';

const LAST = migrationFileNames().at(-1)!;
const appliedIn = (file: string): string[] => {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name); } finally { db.close(); }
};

/** One start of the platform, launchd's ten seconds after the last. */
function start(n: number): void {
  vi.setSystemTime(new Date(Date.parse('2026-11-16T10:00:00.000Z') + n * 10_000));
  recordBootAttempt();
  runMigrations();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  boxBefore901();
  fs.rmSync(path.join(path.dirname(doneDb().name), 'backups'), { recursive: true, force: true });
  fs.rmSync(UPDATE_STATE_PATH, { force: true });
  markPendingUpdate({ targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: '/s' });
  markBootingNew();
});

afterEach(() => { vi.useRealTimers(); });

describe('a crash loop during an update keeps the first data copy', () => {
  it('the copy on the episode is the one from before the first migration', () => {
    // Start 1: 901 commits, then the process dies before the last step runs.
    doneDb().prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(LAST);
    start(0);
    const first = readMarker()?.dataBackup;
    expect(first).toBeTruthy();
    // Starts 2 and 3: the last step is still owed; each start snapshots the half-changed data first.
    for (const n of [1, 2]) {
      doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(LAST);
      start(n);
    }
    expect(readMarker()?.dataBackup).toBe(first);
    expect(readMarker()?.migrationsRanDuringEpisode).toBe(true);
    expect(fs.existsSync(first!)).toBe(true);
    expect(appliedIn(first!)).not.toContain(FILE);
  });
});
