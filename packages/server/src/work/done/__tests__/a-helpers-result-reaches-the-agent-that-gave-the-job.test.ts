// A helper that ends with complete_task sends its whole summary and results, once, to the agent that gave it
// the job (the sender of the job's ASSIGN, not the task's creator or the helper's parent), on the job's
// thread, after its hand-in is applied. A refused hand-in sends nothing and the helper works on. A note the
// engine filed goes labelled as the Dojo's, and a join piece whose helper handed in but was never heard lands
// with the hand-in note on the reaper's next pass. Only the helper's own final reply holds the words back: a
// STATUS on the thread, or the note the Dojo sent for a work_update hand-in, does not.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {},
}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, deliveredToOwner, call, handedIn, stateOf, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { engineHandIn, handIn } from '../hand-in.js';
import { latestHandIn } from '../record.js';
import { openAsk, claimAsk, openDelegationJoin, joinPieces } from '../../store.js';
import { sweepExpiredJoins } from '../../../agent/a2a-transport.js';

const THREAD = 'thr-job-1';

/** The owner asked for the task and OTHER made the helper; MAIN gave it the job by an ASSIGN on the job's thread. */
function aHelperGivenAJob(): void {
  freshBoard();
  doneDb().prepare("UPDATE agents SET classification = 'apprentice', parent_agent = ?, task_id = ? WHERE id = ?").run(OTHER, TASK, WORKER);
  doneDb().prepare('UPDATE work SET a2a_thread_id = ? WHERE id = ?').run(THREAD, TASK);
  doneDb().prepare(
    `INSERT INTO messages (id, agent_id, lane, role, content, source_agent_id, a2a_thread_id, a2a_intent, created_at)
     VALUES ('m-assign', ?, 'a2a', 'user', 'Write the report', ?, ?, 'ASSIGN', ?)`,
  ).run(WORKER, MAIN, THREAD, Date.now());
}
const wordsFromTheHelper = (): Array<{ agent_id: string; a2a_thread_id: string; a2a_intent: string; content: string }> =>
  doneDb().prepare("SELECT agent_id, a2a_thread_id, a2a_intent, content FROM messages WHERE source_agent_id = ? AND lane = 'a2a'")
    .all(WORKER) as Array<{ agent_id: string; a2a_thread_id: string; a2a_intent: string; content: string }>;

describe("a helper's result reaches the agent that gave the job", () => {
  it('the whole summary and results go once to the ASSIGN sender, on the job thread, after the hand-in', async () => {
    aHelperGivenAJob();
    deliveredToOwner();
    const r = await call(WORKER, 'complete_task', {
      status: 'complete', summary: 'The report is written.', results: 'Section totals: 12, 40, 7. Sources are in the appendix.',
    });
    expect(r.isError, r.content).toBe(false);
    expect(stateOf()).toBe('handed_in');
    const words = wordsFromTheHelper();
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ agent_id: MAIN, a2a_thread_id: THREAD, a2a_intent: 'COMPLETE' });
    expect(words[0].content).toContain('The report is written.');
    expect(words[0].content).toContain('Section totals: 12, 40, 7. Sources are in the appendix.');
  });

  it('a refused hand-in sends nothing, and the helper is not ended', async () => {
    aHelperGivenAJob();
    const r = await call(WORKER, 'complete_task', { status: 'complete', summary: 'The report is written.' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('You are not ended');
    expect(stateOf()).toBe('claimed');
    expect(wordsFromTheHelper()).toHaveLength(0);
    expect((doneDb().prepare('SELECT status FROM agents WHERE id = ?').get(WORKER) as { status: string }).status).not.toBe('terminated');
  });

  it('a STATUS on the job thread, then complete_task: the full results still go', async () => {
    aHelperGivenAJob();
    deliveredToOwner();
    await call(WORKER, 'send_to_agent', { agent: MAIN, intent: 'STATUS', thread_id: THREAD, payload: 'Halfway through the sections.' });
    const r = await call(WORKER, 'complete_task', { status: 'complete', summary: 'The report is written.', results: 'Totals: 12, 40, 7.' });
    expect(r.isError, r.content).toBe(false);
    const words = wordsFromTheHelper().filter((w) => w.a2a_intent === 'COMPLETE');
    expect(words).toHaveLength(1);
    expect(words[0].content).toContain('Totals: 12, 40, 7.');
  });

  it('a work_update hand-in, then complete_task a turn later: the full results still go', async () => {
    aHelperGivenAJob();
    await handedIn(WORKER);
    await vi.dynamicImportSettled();
    const r = await call(WORKER, 'complete_task', { status: 'complete', summary: 'The report is written.', results: 'Totals: 12, 40, 7.' });
    expect(r.isError, r.content).toBe(false);
    const words = wordsFromTheHelper().filter((w) => w.a2a_intent === 'COMPLETE');
    expect(words.some((w) => w.content.includes('Totals: 12, 40, 7.')), 'the full results reach the giver').toBe(true);
  });

  it("an engine-filed hand-in reaches the giver labelled as the Dojo's note, never as the helper's words", async () => {
    aHelperGivenAJob();
    engineHandIn(TASK, 'the helper ended and this task is not part of its work');
    await vi.dynamicImportSettled();
    const words = wordsFromTheHelper();
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ agent_id: MAIN, a2a_thread_id: THREAD, a2a_intent: 'FAIL' });
    expect(words[0].content).toContain('[Engine note: the helper ended and this task is not part of its work]');
  });

  it('an engine record with no proof says so; one the caller asked to be can\'t-be-done does not', () => {
    const reasonOf = (): string => String(latestHandIn(TASK)?.items.find((i) => i.kind === 'remainder')?.facts.reason);
    aHelperGivenAJob();
    engineHandIn(TASK, 'the run ended before the report');
    expect(reasonOf()).toBe("no proof on record, so it is handed in as can't be done: the run ended before the report");
    aHelperGivenAJob();
    engineHandIn(TASK, 'the run ended before the report', { outcome: 'cant_be_done' });
    expect(reasonOf()).toBe('the run ended before the report');
  });

  it("a join piece whose helper handed in and was never heard lands with the hand-in note on the reaper's pass", async () => {
    aHelperGivenAJob();
    doneDb().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')")
      .run(MAIN);
    doneDb().prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at)
       VALUES ('m-ask', ?, 'user', 'Get me the report', 'owner', 'dashboard', 'conv-1', ?)`,
    ).run(MAIN, Date.now() - 60_000);
    const ask = openAsk({
      agentId: MAIN, messageId: 'm-ask', conversationId: 'conv-1', requesterId: 'owner', openedAt: Date.now() - 60_000, title: 'report',
    });
    claimAsk(ask, MAIN);
    openDelegationJoin({
      parentWorkId: ask, agentId: MAIN, replyConversationId: 'conv-1', ttlAt: Date.now() - 1_000,
      threads: [{ threadId: THREAD, assigneeAgent: WORKER, intent: 'ASSIGN', hopCount: 0 }],
    });
    // The Dojo stopped between the hand-in and the words: the hand-in is applied, nothing was sent.
    const proof = deliveredToOwner();
    const r = handIn({
      workId: TASK, by: { kind: 'worker', agentId: WORKER }, outcome: 'finished',
      items: [{ kind: 'delivery', ref: proof }], note: 'The report is in the shared folder.', wordsFollow: true,
    });
    expect(r.kind).toBe('handed_in');
    expect(wordsFromTheHelper()).toHaveLength(0);
    await sweepExpiredJoins();
    const words = wordsFromTheHelper();
    expect(words).toMatchObject([{ agent_id: MAIN, a2a_thread_id: THREAD, a2a_intent: 'COMPLETE' }]);
    expect(words[0].content).toContain('The report is in the shared folder.');
    expect(joinPieces(ask)[0].state).toBe('done');
  });
});
