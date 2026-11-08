// The test database for the proof check (work/done/*): a real file under the worker's own DOJO_HOME
// (vitest.setup.ts), behind the `db/connection.js` mock:
//
//   vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
//
// This module never imports `db/connection.js` itself, so the mock factory can load it.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state: { db: Database.Database | null; file: string | null } = { db: null, file: null };
let counter = 0;

/** The shape `db/connection.js` exports, served from the current test database. */
export function connectionMock(): { getDb: () => Database.Database; closeDb: () => void; getDbPath: () => string } {
  return {
    getDb: () => {
      if (!state.db) throw new Error('done-db: test DB not initialized (call freshDoneDb first)');
      return state.db;
    },
    closeDb: () => {},
    getDbPath: () => state.file ?? path.join(os.tmpdir(), 'done-db-unset.db'),
  };
}

function open(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}

/** A new, empty database file. The caller runs `runMigrations()` on it. */
export function freshDoneDb(): Database.Database {
  state.db?.close();
  const dir = path.join(process.env.DOJO_HOME ?? os.tmpdir(), 'done-db');
  fs.mkdirSync(dir, { recursive: true });
  counter += 1;
  state.file = path.join(dir, `done-${process.pid}-${counter}.db`);
  for (const f of [state.file, `${state.file}-wal`, `${state.file}-shm`]) fs.rmSync(f, { force: true });
  state.db = open(state.file);
  return state.db;
}

/** The current connection, for direct SQL in a test. */
export function doneDb(): Database.Database {
  if (!state.db) throw new Error('done-db: test DB not initialized');
  return state.db;
}

/** One board task row, the minimum the `work` CHECKs accept. Returns its id. */
export function seedTask(id: string, agentId: string): string {
  const at = Date.now();
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes,
                       closes_thread, title, goal, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, 'Write the report',
             'The report is in the shared folder', ?, ?)`,
  ).run(id, agentId, id, at, at);
  return id;
}
