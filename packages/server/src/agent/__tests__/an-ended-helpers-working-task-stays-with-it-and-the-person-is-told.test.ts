// A helper ended while it works a task for a person's request keeps that task, held paused; the main agent is not
// handed it, and the request the task was kept for ends at once, so the person is told.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../browser.js', () => ({ closeSession: async () => {} }));
vi.mock('../../vault/archive.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), archiveAgentConversation: () => null }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { terminateAgent } from '../spawner.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { freshBoard, MAIN, WORKER, TASK } from '../../work/done/__tests__/helpers/decision-world.js';
import { keptRequest, keptState, resetLadderWorld } from '../../work/done/__tests__/helpers/ladder-world.js';

const tasksOf = (agentId: string) => doneDb().prepare("SELECT id, hold_kind FROM work WHERE kind = 'task' AND root_kind = 'tracker' AND agent_id = ?").all(agentId);

beforeEach(() => { freshBoard(); resetLadderWorld(); doneDb().prepare("UPDATE agents SET parent_agent = ? WHERE id = ?").run(MAIN, WORKER); });

describe("an ended helper's working task stays with it and the person is told", () => {
  it('the task stays held with the helper, the main agent gets nothing, and the request ends', async () => {
    const ask = await keptRequest(WORKER, TASK, MAIN);
    terminateAgent(WORKER, 'no longer needed');
    expect(tasksOf(WORKER)).toEqual([{ id: TASK, hold_kind: 'paused' }]);
    expect(tasksOf(MAIN)).toEqual([]);
    expect(await keptState(ask)).toEqual(['failed', 'abandoned']);
  });
});
