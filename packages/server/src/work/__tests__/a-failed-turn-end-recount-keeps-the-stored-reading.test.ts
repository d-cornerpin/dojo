// ONE FAILED RE-COUNT KEEPS THE STORED READING (job-turn-end.ts's promise: "A count that cannot be
// read keeps the stored one (and says so on the record)"). The turn-end re-count went through the
// same `recordMeasured` as the close door's, whose NULL-on-failure is correct (an outage never
// refuses a close). So one failed count (a Gmail 429 mid-sweep) NULLed the stored reading, the next
// turn read `remaining = null` and stopped continuing the job, and a close was no longer refused.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import { writeMeasured, recordMeasured } from '../ledger-store.js';

const TASK = 'task-keep-1';

/** The stored reading, as the next turn's `jobTaskOf` and the close gate's `lastReading` read it. */
const row = () => mockDb.current!.prepare(
  'SELECT measure_initial, measure_remaining, measure_at FROM work WHERE id = ?',
).get(TASK) as { measure_initial: number | null; measure_remaining: number | null; measure_at: number | null };

/** The task's `measured` events — the record the failed reading must still stand on. */
const measuredEvents = () => mockDb.current!.prepare(
  "SELECT payload FROM work_events WHERE work_id = ? AND kind = 'measured'",
).all(TASK) as Array<{ payload: string }>;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
  seedTrackerTask(mockDb.current, { id: TASK, agentId: 'agent-k', status: 'in_progress' });
  // The stored reading: 5 left of an initial 8, read at 1000.
  writeMeasured(TASK, 5, 1000, 8);
});

describe('a failed turn-end re-count keeps the stored reading', () => {
  it('keepStoredOnFailure: the row keeps its reading, and the failed one says so on the record', () => {
    recordMeasured(TASK, { ok: false, error: 'HTTP 500' }, 2000, { keepStoredOnFailure: true });
    expect(row()).toEqual({ measure_initial: 8, measure_remaining: 5, measure_at: 1000 });
    const events = measuredEvents();
    expect(events).toHaveLength(1);
    const p = JSON.parse(events[0].payload) as { ok: boolean; error: string };
    expect(p.ok).toBe(false);
    expect(p.error).toBe('HTTP 500');
  });
  it('without the option a failed reading still NULLs the row (the close path is unchanged)', () => {
    recordMeasured(TASK, { ok: false, error: 'HTTP 500' }, 2000);
    expect(row()).toEqual({ measure_initial: 8, measure_remaining: null, measure_at: 2000 });
  });
  it('a successful reading stores normally even with the option', () => {
    recordMeasured(TASK, { ok: true, count: 3 }, 3000, { keepStoredOnFailure: true });
    expect(row()).toEqual({ measure_initial: 8, measure_remaining: 3, measure_at: 3000 });
  });
});
