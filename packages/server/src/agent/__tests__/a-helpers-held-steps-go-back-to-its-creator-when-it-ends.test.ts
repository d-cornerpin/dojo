// A helper that ends, blocked, given up or ended by its creator, hands its held steps to the agent
// that made it; the hold and its reason stay on each step and each move is recorded with its cause. A Working
// task it did not hold stays with it, held paused, and the person's request kept on it ends, so they are told.
// Driven through the real completeAgent and terminateAgent on the real migration chain.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../browser.js', () => ({ closeSession: async () => {} }));
vi.mock('../../vault/archive.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), archiveAgentConversation: () => null }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { completeAgent, terminateAgent } from '../spawner.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { freshBoard, MAIN as PARENT, WORKER as HELPER, TASK } from '../../work/done/__tests__/helpers/decision-world.js';
import { keptRequest, keptState, resetLadderWorld } from '../../work/done/__tests__/helpers/ladder-world.js';

/** The helper holds two steps; `TASK` is its Working task, not held. */
function seed(parentStatus = 'idle'): void {
  const db = doneDb();
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(parentStatus, PARENT);
  db.prepare("UPDATE agents SET status = 'working', parent_agent = ?, classification = 'apprentice' WHERE id = ?").run(PARENT, HELPER);
  const now = Date.now();
  const step = db.prepare(
    `INSERT INTO work (id, agent_id, assignee_agent, kind, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at, hold_kind, hold_reason, hold_at)
     VALUES (?, ?, ?, 'task', 'agent', ?, 'tracker', ?, 'claimed', 'action', 1, 0, ?, ?, ?, ?, ?, ?)`,
  );
  step.run('step-1', HELPER, HELPER, HELPER, 'step-1', 'Read the first ledger', now, now, 'paused', 'waiting on a login code', now);
  step.run('step-2', HELPER, HELPER, HELPER, 'step-2', 'Read the second ledger', now, now, 'blocked', 'the export is corrupt', now);
}

const row = (id: string) => doneDb().prepare('SELECT agent_id, assignee_agent, hold_kind, hold_reason FROM work WHERE id = ?').get(id);
const moves = (id: string): string[] => (doneDb().prepare(
  `SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') = 'reassignment'`,
).all(id) as Array<{ r: string }>).map((m) => m.r);

beforeEach(() => { freshBoard(); resetLadderWorld(); });

describe("a helper's held steps go back to its creator when it ends", () => {
  it('a helper that ends blocked hands both held steps to its creator, hold and reason kept, each move recorded', async () => {
    seed();
    await completeAgent(HELPER, 'blocked', 'Stuck on the login.');
    expect(row('step-1')).toEqual({ agent_id: PARENT, assignee_agent: PARENT, hold_kind: 'paused', hold_reason: 'waiting on a login code' });
    expect(row('step-2')).toEqual({ agent_id: PARENT, assignee_agent: PARENT, hold_kind: 'blocked', hold_reason: 'the export is corrupt' });
    expect(moves('step-1')).toEqual([expect.stringContaining('cause=assignee_gone')]);
    expect(moves('step-2')).toEqual([expect.stringContaining('cause=assignee_gone')]);
  });

  it('a helper its creator ended hands back only its held steps; its Working task stays with it, held, and the request ends', async () => {
    seed();
    const ask = await keptRequest(HELPER, TASK, PARENT);
    terminateAgent(HELPER, 'no longer needed');
    expect(row('step-1')).toMatchObject({ agent_id: PARENT, hold_kind: 'paused', hold_reason: 'waiting on a login code' });
    expect(moves('step-2')).toEqual([expect.stringContaining('cause=assignee_gone')]);
    expect(row(TASK)).toMatchObject({ agent_id: HELPER, hold_kind: 'paused' });
    expect(await keptState(ask), 'the person is told: the request and its piece end').toEqual(['failed', 'abandoned']);
  });

  it('a creator that is itself gone takes nothing: the steps stay where they were', async () => {
    seed('terminated');
    await completeAgent(HELPER, 'fallen', 'Gave up.');
    expect(row('step-1')).toMatchObject({ agent_id: HELPER, hold_kind: 'paused' });
    expect(moves('step-1')).toEqual([]);
  });
});
