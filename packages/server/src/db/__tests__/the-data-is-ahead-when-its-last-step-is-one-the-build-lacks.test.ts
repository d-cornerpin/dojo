// One rule for "has a newer program changed this data": the last step applied to it is a step the build
// does not have. The cases are shared with rollback.sh's test (fixtures/data-ahead-cases.json).
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrationAheadOfBuild } from '../migrations.js';
import CASES from './fixtures/data-ahead-cases.json' with { type: 'json' };

describe('the data is ahead when its last step is one the build lacks', () => {
  for (const c of CASES) {
    it(c.case, () => {
      const db = new Database(':memory:');
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), checksum TEXT)");
      for (const n of c.applied) db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(n);
      expect(migrationAheadOfBuild(db, c.build) !== null).toBe(c.ahead);
      db.close();
    });
  }
});
