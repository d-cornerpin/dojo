// The agent that gave a job hears back: when its worker hands the job's task in without ever replying on
// the job's thread, the hand-in note goes at once to the agent that sent the job's ASSIGN, on that thread,
// even when the task was created by someone else. A worker that did reply there is not relayed over.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const relay = vi.hoisted(() => vi.fn(async () => ({ delivered: true, threadId: 'thr-relay-1' })));
vi.mock('../../../agent/a2a-transport.js', async (orig) => ({ ...(await orig<typeof import('../../../agent/a2a-transport.js')>()), deliverA2AMessage: relay }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { handIn } from '../hand-in.js';
import { freshBoard, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

/** The task was created by OTHER and handed to WORKER by MAIN's ASSIGN on the job's thread. */
function assignedOnAThread(): void {
  freshBoard();
  doneDb().prepare("UPDATE work SET requester = 'agent', requester_id = ?, a2a_thread_id = 'thr-relay-1' WHERE id = ?").run(OTHER, TASK);
  doneDb().prepare(
    "INSERT INTO messages (id, agent_id, lane, role, content, source_agent_id, a2a_thread_id, a2a_intent, created_at) VALUES ('m-assign', ?, 'a2a', 'user', 'Write the report', ?, 'thr-relay-1', 'ASSIGN', ?)",
  ).run(WORKER, MAIN, Date.now());
}
function handTheTaskIn(): void {
  expect(handIn({
    workId: TASK, by: { kind: 'worker', agentId: WORKER }, outcome: 'cant_be_done', note: 'The archive has no 2019 folder.',
    items: [{ kind: 'remainder', ref: 'the 2019 figures', facts: { reason: 'the archive holds no 2019 folder at all' } }],
  }).kind).toBe('handed_in');
}

afterEach(() => { relay.mockClear(); });

describe('an assigner who never heard back is relayed the hand-in', () => {
  it('no reply on the thread: the hand-in note reaches the agent that gave the job, on that thread, at once', async () => {
    assignedOnAThread();
    handTheTaskIn();
    await vi.dynamicImportSettled();
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0][0]).toMatchObject({
      toAgent: MAIN, fromAgent: WORKER, threadId: 'thr-relay-1', intent: 'FAIL', payload: 'The archive has no 2019 folder.',
    });
  });

  it('a worker that replied on the thread is not relayed over', async () => {
    assignedOnAThread();
    doneDb().prepare(
      "INSERT INTO messages (id, agent_id, lane, role, content, source_agent_id, a2a_thread_id, sent_at, created_at) VALUES ('m-reply', ?, 'a2a', 'user', 'Here it is', ?, 'thr-relay-1', ?, ?)",
    ).run(MAIN, WORKER, Date.now(), Date.now());
    handTheTaskIn();
    await vi.dynamicImportSettled();
    expect(relay).not.toHaveBeenCalled();
  });
});
