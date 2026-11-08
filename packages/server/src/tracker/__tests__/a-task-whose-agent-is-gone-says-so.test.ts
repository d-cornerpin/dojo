// A task row says its assignee is gone when the agent is missing or terminated, from the same lookup that names it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { getTask } from '../schema.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT)');
  db.prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?), (?, ?, ?)')
    .run(FXID.n1, FX.n1, 'idle', FXID.n2, FX.n2, 'terminated');
  mockDb.current = db;
});

describe('a task whose agent is gone says so', () => {
  it('is not gone while its agent exists', () => {
    seedTrackerTask(mockDb.current!, { id: 't-live', agentId: FXID.n1 });
    expect(getTask('t-live')).toMatchObject({ assignedToName: FX.n1, assigneeGone: false });
  });

  it('is gone when its agent is terminated or missing', () => {
    seedTrackerTask(mockDb.current!, { id: 't-ended', agentId: FXID.n2 });
    seedTrackerTask(mockDb.current!, { id: 't-missing', agentId: FXID.n3 });
    expect(getTask('t-ended')!.assigneeGone).toBe(true);
    expect(getTask('t-missing')!.assigneeGone).toBe(true);
  });

  it('keys on the worker the ladder drives, not only the name shown', () => {
    seedTrackerTask(mockDb.current!, { id: 't-handed', agentId: FXID.n1, assignee_agent: FXID.n2 });
    expect(getTask('t-handed')).toMatchObject({ assignedToName: FX.n1, assigneeGone: true });
  });
});
