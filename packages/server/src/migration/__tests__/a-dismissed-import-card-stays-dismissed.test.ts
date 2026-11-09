// The import card's truth is a marker beside ~/.dojo, outside the database an import swaps. Dismissing the card removes
// the marker, so a restart (onto any database) does not raise it again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';

const DIR = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'import-card-'));
const MARKER = path.join(DIR, '.dojo-import-stuck.json');
const BACKUP = path.join(DIR, '.dojo-backup-x');
const freshDb = (): void => { mockDb.current?.close(); mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); };

beforeEach(() => { fs.mkdirSync(BACKUP, { recursive: true }); freshDb(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; fs.rmSync(MARKER, { force: true }); });

describe('a dismissed import card', () => {
  it('does not come back after a restart onto another database', async () => {
    const first = await import('../import-recovery.js');
    first.bindImportCardMarker(fs, MARKER);
    first.noteBackupStuck(BACKUP);
    const { dismissOwnerNotice } = await import('../../healer/owner-notices.js');
    const { standingOwnerNotices } = await import('../../healer/owner-notice-kinds.js');
    expect(standingOwnerNotices().map((c) => c.cardKey)).toEqual(['import-failed-not-running']);
    dismissOwnerNotice('import-failed-not-running');
    expect(fs.existsSync(MARKER)).toBe(false);

    vi.resetModules();
    freshDb();   // the restart, on a database with no record of the dismissal
    const fresh = await import('../import-recovery.js');
    fresh.bindImportCardMarker(fs, MARKER);
    expect(fresh.importCardStands()).toBe(false);
    expect((await import('../../healer/owner-notice-kinds.js')).standingOwnerNotices()).toEqual([]);
  });
});
