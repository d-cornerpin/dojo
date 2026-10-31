// The dashboard's schedule door has to REJECT what it cannot run, before it writes.
//
// The owner's own door for a recurring brief is `POST /api/tracker/tasks` — the form in
// TaskScheduleForm.tsx — and it had no guard on the schedule it sends: a start time the engine
// cannot parse, a negative interval, a half-number interval, or a repeat with no unit all landed
// as a "waiting" schedule that never fires, while the owner was told 201 OK. A bad schedule in the
// same Save as other fields (a PUT that also sets priority) landed AFTER those other fields were
// already written, so the refusal had to come first.
//
// The guard lives at the two write doors and returns a plain-words 400 before the first write,
// so a bad schedule refuses the whole door — create nothing, and change nothing else.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { os } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  }),
  setLogLevel: vi.fn(),
  setLogBroadcast: vi.fn(),
  readLogEntries: vi.fn().mockResolvedValue([]),
}));

// In-memory DB: each test gets a fresh one, so "no row was created" and "the other fields were
// not written" are read straight off the work table.
const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => mockDb.current,
  getDbPath: () => join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-sched-input-guard', 'platform.db'),
  closeDb: () => { mockDb.current?.close(); mockDb.current = null; },
}));

vi.mock('../../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
  stampPersistedRow: (e: unknown) => e,
}));

// The create door reads the primary agent id; give it one so a valid create can resolve its
// creator. The rest of the platform surface is the real one.
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  getPrimaryAgentId: () => 'primary',
}));

import { runMigrations } from '../../../db/migrations.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { trackerRouter } from '../tracker.js';

function db(): Database.Database {
  if (!mockDb.current) throw new Error('db not initialised');
  return mockDb.current;
}

const countWork = (): number =>
  (db().prepare('SELECT COUNT(*) AS n FROM work').get() as { n: number }).n;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('a schedule the dashboard sends is checked before any write', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    mockDb.current.pragma('foreign_keys = ON');
    runMigrations(mockDb.current);
  });

  afterEach(() => {
    mockDb.current?.close();
    mockDb.current = null;
  });

  it('a start that cannot be read as a date is refused and the task is not created', async () => {
    const before = countWork();
    const res = await trackerRouter.request('/tasks', json('POST', {
      title: 't', scheduled_start: 'not a date',
    }));
    expect(res.status).toBe(400);
    expect(countWork()).toBe(before);
  });

  it('a negative repeat interval is refused and the task is not created', async () => {
    const before = countWork();
    const res = await trackerRouter.request('/tasks', json('POST', {
      title: 't', repeat_interval: -2, repeat_unit: 'days',
    }));
    expect(res.status).toBe(400);
    expect(countWork()).toBe(before);
  });

  it('a fractional repeat interval is refused', async () => {
    const res = await trackerRouter.request('/tasks', json('POST', {
      title: 't', repeat_interval: 1.5,
    }));
    expect(res.status).toBe(400);
  });

  it('a bad schedule in the same save leaves the task\'s other fields untouched', async () => {
    seedTrackerTask(db(), {
      id: 't1', agentId: 'primary', status: 'in_progress', title: 'the task', priority: 'low',
    });
    const res = await trackerRouter.request('/tasks/t1', json('PUT', {
      priority: 'high', scheduled_start: 'garbage',
    }));
    expect(res.status).toBe(400);
    const row = db().prepare('SELECT priority FROM work WHERE id = ?').get('t1') as { priority: string | null };
    expect(row.priority).toBe('low');
  });

  it('a start and repeat that can run is accepted', async () => {
    const res = await trackerRouter.request('/tasks', json('POST', {
      title: 't', scheduled_start: '2026-11-02T00:00:00.000Z', repeat_interval: 1, repeat_unit: 'days',
    }));
    expect(res.status).toBe(201);
  });
});
