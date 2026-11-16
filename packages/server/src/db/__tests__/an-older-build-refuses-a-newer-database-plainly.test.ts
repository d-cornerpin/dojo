// The runner refuses a database whose last step is one it does not have, in plain words, and changes nothing.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000 });

import { runMigrations } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

describe('an older build refuses a newer database plainly', () => {
  it('stops before any step runs and names what it found', () => {
    freshDoneDb();
    doneDb().exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), checksum TEXT)");
    doneDb().prepare('INSERT INTO _migrations (name) VALUES (?)').run('903_from_a_newer_dojo.sql');
    expect(() => runMigrations()).toThrow(/newer version of Dojo.*903_from_a_newer_dojo\.sql/);
    expect((doneDb().prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number }).c).toBe(1);
  });
});
