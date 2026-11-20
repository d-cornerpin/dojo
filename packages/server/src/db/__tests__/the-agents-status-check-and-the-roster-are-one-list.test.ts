// The database's CHECK on agents.status and the shared AGENT_STATUSES roster are one fact: a status added to one
// without the other fails here, not in a swallowed catch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_STATUSES } from '@dojo/shared';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  doneDb().prepare("INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')").run();
});

describe('the agents.status CHECK and the roster are one list', () => {
  it('accepts every declared status and refuses one that is not declared', () => {
    const set = doneDb().prepare('UPDATE agents SET status = ? WHERE id = ?');
    for (const status of AGENT_STATUSES) expect(() => set.run(status, 'a1'), status).not.toThrow();
    expect(() => set.run('not_a_status', 'a1')).toThrow(/CHECK constraint failed/);
  });
});
