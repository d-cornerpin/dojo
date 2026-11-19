// A repeated-success pattern already sent to the Trainer is not sent again the next night while it stays inside the
// lookback window; a refused batch records nothing, so the pattern is offered again.

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
let delivered = true;
const deliver = vi.fn(async () => ({ delivered, threadId: 't' }));
vi.mock('../../agent/a2a-notice.js', () => ({ deliverA2ANotice: () => deliver() }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../../memory/vector-search.js', () => ({ vectorSearch: async () => [] }));

import { runMigrations } from '../../db/migrations.js';
import { runDistillationCycle } from '../distillation.js';

const DAY = 24 * 60 * 60 * 1000;
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

beforeEach(() => {
  deliver.mockClear();
  delivered = true;
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const [i, d] of ['6/3', '6/10', '6/17'].entries()) doneWork(`w${i}`, `Send weekly status email ${d}`);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a pattern sent to the Trainer is not sent again', () => {
  it('a delivered pattern is not offered again the next night', async () => {
    await runDistillationCycle();
    await runDistillationCycle();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a pattern sent more than seven days ago is offered again', async () => {
    await runDistillationCycle();
    const old = JSON.stringify({ 'send weekly status email': Date.now() - 8 * DAY });
    mockDb.current!.prepare("UPDATE config SET value = ? WHERE key = 'trainer.patterns_sent'").run(old);
    await runDistillationCycle();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('a refused batch records nothing, so the pattern is offered again', async () => {
    delivered = false;
    await runDistillationCycle();
    await runDistillationCycle();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
