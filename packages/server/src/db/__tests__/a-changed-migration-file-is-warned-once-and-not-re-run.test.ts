// A migration file that differs from the one this database applied is said once at boot, in one
// warning line, and is never run again.
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null as Database.Database | null, warns: [] as Array<{ msg: string; data: unknown }> }));
vi.mock('../connection.js', () => ({ getDb: () => h.db!, closeDb: () => {}, getDbPath: () => ':memory:' }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, debug: () => {}, error: () => {}, warn: (msg: string, data: unknown) => { h.warns.push({ msg, data }); } }),
}));

import { runMigrations, migrationFileNames } from '../migrations.js';

afterEach(() => { h.db?.close(); h.db = null; h.warns.length = 0; });

describe('a changed migration file is warned once and not re-run', () => {
  it('names the changed file in one warning, and the next boot runs nothing', () => {
    h.db = new Database(':memory:');
    runMigrations();
    expect(h.warns.filter((w) => /differ from the ones this database applied/.test(w.msg))).toEqual([]);
    const [first] = migrationFileNames();
    h.db.prepare('UPDATE _migrations SET checksum = ? WHERE name = ?').run('0'.repeat(64), first);
    const applied = h.db.prepare('SELECT COUNT(*) AS n FROM _migrations').get();

    runMigrations();

    const said = h.warns.filter((w) => /differ from the ones this database applied/.test(w.msg));
    expect(said).toEqual([{ msg: expect.any(String), data: { files: [first] } }]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM _migrations').get()).toEqual(applied);
  });
});
