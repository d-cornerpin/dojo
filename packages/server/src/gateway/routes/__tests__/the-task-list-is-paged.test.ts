// v3.5 field fix 3, re-review 2 S4: THE TASK LIST IS PAGED.
//
// `GET /tracker/tasks` returned every task the box ever made, with no paging, and the board fetches it on
// load. The live columns (everything not finished) stay whole: they are bounded by the work still open.
// The finished ones (complete, fallen, cancelled) come newest first, a page at a time, with a cursor for
// the page before (`closedBefore` + `closedBeforeId`) and `closedHasOlder` saying whether one exists. The
// page is the chat history's own page size (the dashboard's existing "load older" pattern).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import { join } from 'node:path';

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: vi.fn().mockResolvedValue([]),
}));
const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => mockDb.current,
  getDbPath: () => join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-task-paging', 'platform.db'),
  closeDb: () => { mockDb.current?.close(); mockDb.current = null; },
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { trackerRouter } from '../tracker.js';
import { TASK_CLOSED_PAGE } from '../../../tracker/schema.js';

const T0 = 1_760_000_000_000;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('w1', 'Worker', 'idle')").run();
  for (let i = 0; i < 3; i += 1) seedTrackerTask(mockDb.current, { id: `open-${i}`, agentId: 'w1', status: 'in_progress', title: `open ${i}`, opened_at: T0, updated_at: T0 } as never);
  for (let i = 0; i < TASK_CLOSED_PAGE + 7; i += 1) {
    seedTrackerTask(mockDb.current, { id: `done-${String(i).padStart(3, '0')}`, agentId: 'w1', status: 'cancelled', title: `done ${i}`,
      opened_at: T0, updated_at: T0 + i * 1000, closed_at: T0 + i * 1000 } as never);
  }
});

type Page = { ok: boolean; data: Array<{ id: string; status: string; completedAt: string | null }>; closedHasOlder?: boolean };
const get = async (q = ''): Promise<Page> => (await trackerRouter.request(`/tasks${q}`)).json() as Promise<Page>;
const closedOf = (p: Page) => p.data.filter((t) => ['complete', 'fallen', 'cancelled'].includes(t.status));

describe('S4: GET /tracker/tasks pages the finished tasks', () => {
  it('the first page: every open task, the newest finished page, and closedHasOlder', async () => {
    const p = await get();
    expect(p.data.filter((t) => t.status === 'in_progress')).toHaveLength(3);
    expect(closedOf(p)).toHaveLength(TASK_CLOSED_PAGE);
    expect(closedOf(p)[0].id).toBe(`done-${String(TASK_CLOSED_PAGE + 6).padStart(3, '0')}`);   // newest first
    expect(p.closedHasOlder).toBe(true);
  });

  it('the cursor returns the page before, and says when there is none', async () => {
    const first = await get();
    const oldest = closedOf(first)[closedOf(first).length - 1];
    const older = await get(`?closedBefore=${encodeURIComponent(oldest.completedAt!)}&closedBeforeId=${oldest.id}`);
    expect(older.data.filter((t) => t.status === 'in_progress')).toHaveLength(0);   // the live columns are not re-sent
    expect(closedOf(older).map((t) => t.id)).toEqual(['done-006', 'done-005', 'done-004', 'done-003', 'done-002', 'done-001', 'done-000']);
    expect(older.closedHasOlder).toBe(false);
  });

  it('the filters still apply (a status filter on a finished status pages too)', async () => {
    const p = await get('?status=cancelled');
    expect(p.data).toHaveLength(TASK_CLOSED_PAGE);
    expect(p.closedHasOlder).toBe(true);
  });
});

// Re-review 3 (M3). Walk the finished pages the way the board does: the cursor is the oldest finished
// task the caller holds, sent back for the page before.
async function walkFinished(): Promise<string[]> {
  const seen: string[] = [];
  let p = await get();
  for (let guard = 0; guard < 20; guard += 1) {
    const closed = closedOf(p);
    seen.push(...closed.map((t) => t.id));
    if (!p.closedHasOlder) return seen;
    const oldest = closed[closed.length - 1];
    if (!oldest) throw new Error('closedHasOlder with no finished task to page from: the button would do nothing');
    p = await get(`?closedBefore=${encodeURIComponent(oldest.completedAt!)}&closedBeforeId=${oldest.id}`);
  }
  throw new Error('paging did not end');
}

describe('re-review 3 (M3): hidden tasks are filtered before the page is cut, and the cursor is strict', () => {
  it('a whole page of a system agent\'s finished tasks still reaches the older visible ones', async () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('pm1', 'Overseer', 'idle')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_id', 'pm1')").run();
    // Newer than every visible finished task, and more than a page of them.
    for (let i = 0; i < TASK_CLOSED_PAGE + 3; i += 1) {
      seedTrackerTask(db, { id: `sys-${String(i).padStart(3, '0')}`, agentId: 'pm1', status: 'cancelled', title: `sys ${i}`,
        opened_at: T0, updated_at: T0 + 10_000_000 + i * 1000, closed_at: T0 + 10_000_000 + i * 1000 } as never);
    }
    const seen = await walkFinished();
    expect(seen.some((id) => id.startsWith('sys-'))).toBe(false);
    expect(seen).toHaveLength(TASK_CLOSED_PAGE + 7);   // every visible finished task, none lost
  });

  it('tasks closed within the same second, in the opposite order to their ids, lose nothing at a page edge', async () => {
    const db = mockDb.current!;
    db.prepare("DELETE FROM work WHERE id LIKE 'done-%'").run();
    // One second holds them all; the ms order runs against the id order.
    for (let i = 0; i < TASK_CLOSED_PAGE + 4; i += 1) {
      seedTrackerTask(db, { id: `tie-${String(i).padStart(3, '0')}`, agentId: 'w1', status: 'cancelled', title: `tie ${i}`,
        opened_at: T0, updated_at: T0, closed_at: T0 + 900 - (i % 900) } as never);
    }
    const seen = await walkFinished();
    expect(new Set(seen).size).toBe(seen.length);   // nothing twice
    expect(seen).toHaveLength(TASK_CLOSED_PAGE + 4);   // nothing skipped
  });
});
