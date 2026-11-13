// A helper that ends, blocked, given up or ended by its creator, hands its held steps to the agent
// that made it; the hold and its reason stay on each step and each move is recorded with its cause.
// Driven through the real completeAgent and terminateAgent on the real migration chain.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../browser.js', () => ({ closeSession: async () => {} }));
vi.mock('../../vault/archive.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), archiveAgentConversation: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { completeAgent, terminateAgent } from '../spawner.js';

const PARENT = 'agent-parent';
const HELPER = 'agent-helper';

function seed(parentStatus = 'idle'): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Parent', ?)`).run(PARENT, parentStatus);
  db.prepare(`INSERT INTO agents (id, name, status, parent_agent, classification) VALUES (?, 'Helper', 'working', ?, 'apprentice')`).run(HELPER, PARENT);
  const now = Date.now();
  const step = db.prepare(
    `INSERT INTO work (id, agent_id, assignee_agent, kind, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at, hold_kind, hold_reason, hold_at)
     VALUES (?, ?, ?, 'task', 'agent', ?, 'tracker', ?, 'claimed', 'action', 1, 0, ?, ?, ?, ?, ?, ?)`,
  );
  step.run('step-1', HELPER, HELPER, HELPER, 'step-1', 'Read the first ledger', now, now, 'paused', 'waiting on a login code', now);
  step.run('step-2', HELPER, HELPER, HELPER, 'step-2', 'Read the second ledger', now, now, 'blocked', 'the export is corrupt', now);
}

const row = (id: string) => mockDb.current!.prepare('SELECT agent_id, assignee_agent, hold_kind, hold_reason FROM work WHERE id = ?').get(id);
const moves = (id: string): string[] => (mockDb.current!.prepare(
  `SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') = 'reassignment'`,
).all(id) as Array<{ r: string }>).map((m) => m.r);

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe("a helper's held steps go back to its creator when it ends", () => {
  it('a helper that ends blocked hands both held steps to its creator, hold and reason kept, each move recorded', async () => {
    seed();
    await completeAgent(HELPER, 'blocked', 'Stuck on the login.');
    expect(row('step-1')).toEqual({ agent_id: PARENT, assignee_agent: PARENT, hold_kind: 'paused', hold_reason: 'waiting on a login code' });
    expect(row('step-2')).toEqual({ agent_id: PARENT, assignee_agent: PARENT, hold_kind: 'blocked', hold_reason: 'the export is corrupt' });
    expect(moves('step-1')).toEqual([expect.stringContaining('cause=assignee_gone')]);
    expect(moves('step-2')).toEqual([expect.stringContaining('cause=assignee_gone')]);
  });

  it('a helper its creator ended hands its held steps back the same way', () => {
    seed();
    terminateAgent(HELPER, 'no longer needed');
    expect(row('step-1')).toMatchObject({ agent_id: PARENT, hold_kind: 'paused', hold_reason: 'waiting on a login code' });
    expect(moves('step-2')).toEqual([expect.stringContaining('cause=assignee_gone')]);
  });

  it('a creator that is itself gone takes nothing: the steps stay where they were', async () => {
    seed('terminated');
    await completeAgent(HELPER, 'fallen', 'Gave up.');
    expect(row('step-1')).toMatchObject({ agent_id: HELPER, hold_kind: 'paused' });
    expect(moves('step-1')).toEqual([]);
  });
});
