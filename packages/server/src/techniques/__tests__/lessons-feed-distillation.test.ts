// The Trainer's distillation reads the Dreamer's technique lessons as candidates, beside repeated successes;
// older rows of other components are not candidates; a lesson is fed once the Trainer took its batch up.

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
const deliver = vi.fn(async (n: { threadId: string }, _label: string, _meta?: unknown) => ({ delivered: true, threadId: n.threadId }));
vi.mock('../../agent/a2a-notice.js', () => ({ deliverA2ANotice: (n: { threadId: string }, l: string, m?: unknown) => deliver(n, l, m) }));
const notice = vi.fn();
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: (a: unknown) => notice(a) }));

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

beforeEach(() => {
  deliver.mockClear(); notice.mockClear();
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('distillation reads lessons', () => {
  it('a technique-component lesson reaches the Trainer as a candidate with no repeated success at all', async () => {
    lesson('l1', 'technique', 'moving mail to junk');
    await runDistillationCycle();
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = (deliver.mock.calls[0][0] as { payload: string }).payload;
    expect(payload).toContain('moving mail to junk');
    expect(payload).toContain('do the better thing for moving mail to junk');
  });

  it('door_text, soul and engine lessons are not technique candidates', async () => {
    lesson('l2', 'door_text', 'a confusing refusal');
    lesson('l3', 'soul', 'a soul gap');
    lesson('l4', 'engine', 'an engine fault');
    await runDistillationCycle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('an expired lesson is not a candidate', async () => {
    lesson('l5', 'technique', 'stale cue', 100);
    await runDistillationCycle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a lesson is fed once its batch was taken up; a renewal feeds it again', async () => {
    lesson('l6', 'technique', 'moving mail to junk');
    await runDistillationCycle();
    mockDb.current!.prepare("INSERT INTO agents (id, name, status) VALUES ('trainer', 'trainer', 'idle')").run();
    mockDb.current!.prepare("INSERT INTO messages (id, agent_id, role, content, created_at, a2a_thread_id, served_by_turn) VALUES ('batch-1', 'trainer', 'user', 'batch', ?, ?, 1)").run(Date.now(), (deliver.mock.calls[0][0] as { threadId: string }).threadId);
    await runDistillationCycle();
    expect(deliver).toHaveBeenCalledTimes(1);
    mockDb.current!.prepare("UPDATE lessons SET expires_at = expires_at + 1000, renewed_count = 1 WHERE id = 'l6'").run();
    await runDistillationCycle();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('lessons alone do not send the main agent anything', async () => {
    lesson('l7', 'technique', 'moving mail to junk');
    await runDistillationCycle();
    expect(notice).not.toHaveBeenCalled();
  });
});
