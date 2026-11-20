// A helper that ends with complete_task sends its whole summary and results, once, to the agent that gave it
// the job (the sender of the job's ASSIGN, not the task's creator or the helper's parent), on the job's
// thread, after its hand-in is applied. A refused hand-in sends nothing and the helper works on.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {},
}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, deliveredToOwner, call, stateOf, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

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
});
