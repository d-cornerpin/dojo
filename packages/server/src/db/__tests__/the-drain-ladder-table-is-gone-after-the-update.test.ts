// After the update the drain ladder table is gone, also on a box whose table still holds rows.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations, migrationFileNames } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const STEP = migrationFileNames().find((f) => f.includes('drop_drain_state'))!;
const tableExists = (): boolean =>
  doneDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drain_state'").get() !== undefined;

beforeEach(() => {
  freshDoneDb();
  runMigrations();
});

describe('the drain ladder table is gone after the update', () => {
  it('a fresh box has no drain ladder table', () => {
    expect(tableExists()).toBe(false);
  });

  it('a lived-in box whose ladders hold rows loses the table and keeps its agents', () => {
    doneDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES ('agent-a', 'agent-a', 'idle', 'standard')").run();
    doneDb().exec(`CREATE TABLE drain_state (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      drain TEXT NOT NULL, head TEXT NOT NULL, stuck INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, drain))`);
    doneDb().prepare("INSERT INTO drain_state VALUES ('agent-a', 'human_conversation', '12', 3, 1)").run();
    doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(STEP);
    runMigrations();
    expect(tableExists()).toBe(false);
    expect(doneDb().prepare("SELECT id FROM agents WHERE id = 'agent-a'").get()).toEqual({ id: 'agent-a' });
  });
});
