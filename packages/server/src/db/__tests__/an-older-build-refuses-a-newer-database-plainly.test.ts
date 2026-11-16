// The runner refuses a database that a newer build changed, in plain words, and changes nothing. A name it
// does not carry but whose number it has reached (a development sibling such as `200z`) is not "newer".
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000 });

import { runMigrations } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

function boxWith(names: string[]): void {
  freshDoneDb();
  doneDb().exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), checksum TEXT)");
  for (const n of names) doneDb().prepare('INSERT INTO _migrations (name) VALUES (?)').run(n);
}
const applied = (): number => (doneDb().prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number }).c;

describe('an older build refuses a newer database plainly', () => {
  it('stops before any step runs and names what it found', () => {
    boxWith(['9999_from_a_newer_dojo.sql']);
    expect(() => runMigrations()).toThrow(/newer version of Dojo.*9999_from_a_newer_dojo\.sql/);
    expect(applied()).toBe(1);
  });

  it('starts a database holding a development sibling of a step it has', () => {
    boxWith(['200z_development_only.sql']);
    expect(() => runMigrations()).not.toThrow();
    expect(applied()).toBeGreaterThan(1);
  });
});
