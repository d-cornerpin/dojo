// A send-back reaches someone who can act on it, as an event the one clock serves: the worker, or, when the
// worker was a helper that has ended, the agent that spawned it, else the main agent. That agent becomes the
// row's worker. The owner's send-back reaches it as his, never as a message from the project manager.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { workerOf } from '../record.js';
import { decide } from '../decide.js';
import { freshBoard, handedIn, call, stateOf, PM, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const hintTo = (agentId: string): string | undefined => (doneDb().prepare(
  "SELECT content FROM messages WHERE agent_id = ? AND source_agent_id = ? AND lane = 'events' AND content LIKE '%was sent back%'",
).get(agentId, PM) as { content: string } | undefined)?.content;

async function sendBack(): Promise<void> {
  const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'The totals page is missing' });
  expect(r.isError, r.content).toBe(false);
  expect(stateOf()).toBe('sent_back');
}

describe('a send-back reaches the worker of record', () => {
  it('a live worker gets the hint itself', async () => {
    freshBoard();
    await handedIn();
    await sendBack();
    await vi.waitFor(() => expect(hintTo(WORKER)).toContain('The totals page is missing'));
    expect(workerOf(TASK)).toBe(WORKER);
  });

  it('an ended helper\'s send-back goes to the agent that spawned it, which now works the row', async () => {
    freshBoard();
    await handedIn();
    doneDb().prepare("UPDATE agents SET status = 'terminated', parent_agent = ? WHERE id = ?").run(OTHER, WORKER);
    await sendBack();
    await vi.waitFor(() => expect(hintTo(OTHER)).toContain('it is yours now'));
    expect(hintTo(WORKER)).toBeUndefined();
    expect(workerOf(TASK)).toBe(OTHER);
  });

  it('the owner\'s send-back says it is his, and the project manager sends nothing', async () => {
    freshBoard();
    await handedIn();
    expect(decide({ workId: TASK, deciderAgentId: null, verdict: 'send_back', reason: 'The totals page is missing' }).kind).toBe('decided');
    await vi.waitFor(() => expect(doneDb().prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND source_agent_id IS NULL AND content LIKE '%was sent back by the owner: The totals page is missing%'",
    ).get(WORKER)).toBeTruthy());
    expect(hintTo(WORKER)).toBeUndefined();
  });

  it('an ended helper with no parent: the main agent gets it', async () => {
    freshBoard();
    await handedIn();
    doneDb().prepare("UPDATE agents SET status = 'terminated', parent_agent = NULL WHERE id = ?").run(WORKER);
    await sendBack();
    await vi.waitFor(() => expect(hintTo(MAIN)).toContain('The totals page is missing'));
    expect(workerOf(TASK)).toBe(MAIN);
  });
});
