// The task row's lastMovedAt is the task's own last movement, so an activity event counts even when the row was not written.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { getTask } from '../schema.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const ROW_WRITTEN = Date.UTC(2026, 9, 1);
const ACTIVITY = Date.UTC(2026, 10, 7, 9, 30);

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT)');
  mockDb.current = db;
  seedTrackerTask(db, { id: 't1', opened_at: ROW_WRITTEN, updated_at: ROW_WRITTEN });
});

describe('a dormant working task says so on its card', () => {
  it('is the row write when nothing newer happened', () => {
    expect(getTask('t1')!.lastMovedAt).toBe('2026-10-01 00:00:00');
  });

  it('is the newest activity event when the row was not written', () => {
    mockDb.current!.prepare(`INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES ('t1', 'activity', 'engine', '{}', ?)`).run(ACTIVITY);
    expect(getTask('t1')).toMatchObject({ updatedAt: '2026-10-01 00:00:00', lastMovedAt: '2026-11-07 09:30:00' });
  });
});
