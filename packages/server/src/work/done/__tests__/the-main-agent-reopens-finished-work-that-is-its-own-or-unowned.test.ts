// The main agent may reopen finished work it holds, or whose holder is gone; a helper may not reopen its own,
// and a live helper's finished work stays behind the takeover block.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/agent-notice.js', () => ({ redriveWithoutReply: async () => true }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { doneDb } from './helpers/done-db.js';
import { freshBoard, handedIn, call, stateOf, PM, MAIN, WORKER, TASK } from './helpers/decision-world.js';

async function finishedBoard(holder: string): Promise<void> {
  freshBoard(holder);
  doneDb().prepare('UPDATE work SET repeat_interval = 3600000 WHERE id = ?').run(TASK);   // a reopened task waits on deck only when it recurs
  await handedIn(holder);
  await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
  const d = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report meets the goal.' });
  expect(d.isError, d.content).toBe(false);
  expect(stateOf()).toBe('done');
}

const reopenAs = (as: string) => call(as, 'work_update', { action: 'status', task_id: TASK, status: 'on_deck', notes: 'A section is missing.' });

describe('who may reopen finished work', () => {
  it('the main agent reopens a finished task it holds itself', async () => {
    await finishedBoard(MAIN);
    const r = await reopenAs(MAIN);
    expect(r.isError, r.content).toBe(false);
    expect(stateOf()).not.toBe('done');
  });

  it('the main agent reopens a finished task whose holder has been shut down', async () => {
    await finishedBoard(WORKER);
    doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    const r = await reopenAs(MAIN);
    expect(r.isError, r.content).toBe(false);
    expect(stateOf()).not.toBe('done');
  });

  it('the main agent is refused, in the takeover block\'s words, for a finished task a live helper holds', async () => {
    await finishedBoard(WORKER);
    const r = await reopenAs(MAIN);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`is held by agent ${WORKER}, a live agent, and only`);
    expect(stateOf()).toBe('done');
  });

  it('a helper still cannot reopen finished work, even its own', async () => {
    await finishedBoard(WORKER);
    const r = await reopenAs(WORKER);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('needs the owner, the PM or the main agent');
    expect(stateOf()).toBe('done');
  });

  it('the main agent retasks finished work whose holder is gone', async () => {
    await finishedBoard(WORKER);
    doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    const r = await call(MAIN, 'work_validate', { action: 'retask', task_id: TASK, directive: 'The totals page is missing; add it and send the report again.', target_status: 'on_deck' });
    expect(r.isError, r.content).toBe(false);
    expect(stateOf()).not.toBe('done');
  });
});
