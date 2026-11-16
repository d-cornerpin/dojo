// An undelivered Trainer batch is not treated as delivered: a refused lesson batch is not marked fed
// (those lessons are offered again next cycle), and the owner is not told the Trainer was asked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
// Configurable per case: the mock returns whatever `deliverResult` currently holds.
let deliverResult: { delivered: boolean; reason?: string; threadId?: string } | undefined;
const deliver = vi.fn(async (_n: unknown, _label: string, _meta?: unknown) => deliverResult);
vi.mock('../../agent/a2a-notice.js', () => ({ deliverA2ANotice: (n: unknown, l: string, m?: unknown) => deliver(n, l, m) }));
const notice = vi.fn();
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: (a: unknown) => notice(a) }));
// Candidates are never "covered" by an existing technique here.
vi.mock('../../memory/vector-search.js', () => ({ vectorSearch: async () => [] }));

import { runMigrations } from '../../db/migrations.js';
import { runDistillationCycle } from '../distillation.js';

const DAY = 24 * 60 * 60 * 1000;
function lesson(id: string, component: string, cue: string, ageDays = 0): void {
  const at = Date.now() - ageDays * DAY;
  mockDb.current!.prepare(
    `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
     VALUES (?, 'agent-x', 'task-1', ?, ?, '[1]', 0.7, ?, ?, ?)`,
  ).run(id, cue, `do the better thing for ${cue}`, component, at, at + 90 * DAY);
}

// A `done` work row inside taskScope. state='done' needs closed_at and
// result_delivery_id (migration 135's CHECKs), so a deliveries row is seeded alongside.
function doneWork(id: string, title: string): void {
  const T = Date.now();
  mockDb.current!.prepare(
    "INSERT INTO deliveries (id, agent_id, tool, channel, outcome) VALUES (?, 'agent-x', 'send_message', 'chat', 'delivered')",
  ).run(`del-${id}`);
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at, closed_at, result_delivery_id)
     VALUES (?, 'task', 'agent-x', 'schedule', 'legacy', 'legacy', 'done', 'FYI', 0, 0, ?, ?, ?, ?, ?)`,
  ).run(id, title, T, T, T, `del-${id}`);
}

const fedRow = (): unknown =>
  mockDb.current!.prepare("SELECT value FROM config WHERE key = 'trainer.lessons_fed_ms'").get();

beforeEach(() => {
  deliver.mockClear(); notice.mockClear();
  deliverResult = undefined;
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('an undelivered Trainer batch is not treated as delivered', () => {
  it('a refused lesson batch is not marked fed (those lessons are offered again next cycle)', async () => {
    lesson('l1', 'technique', 'moving mail to junk');
    deliverResult = { delivered: false, reason: 'SEMANTIC_DUPLICATE', threadId: 't1' };
    await runDistillationCycle();
    expect(fedRow()).toBeUndefined();
  });

  it('a refused candidate batch does not tell the owner the Trainer was asked', async () => {
    doneWork('w1', 'Send weekly status email 6/3');
    doneWork('w2', 'Send weekly status email 6/10');
    doneWork('w3', 'Send weekly status email 6/17');
    deliverResult = { delivered: false, reason: 'X', threadId: 't' };
    await runDistillationCycle();
    expect(notice).not.toHaveBeenCalled();
  });

  it('CONTROL: a delivered candidate batch tells the owner the Trainer was asked', async () => {
    doneWork('w4', 'Send weekly status email 6/3');
    doneWork('w5', 'Send weekly status email 6/10');
    doneWork('w6', 'Send weekly status email 6/17');
    deliverResult = { delivered: true, threadId: 't' };
    await runDistillationCycle();
    expect(notice).toHaveBeenCalledTimes(1);
    expect((notice.mock.calls[0][0] as { brief: string }).brief).toContain('Asked the Trainer to draft 1 technique');
  });
});
