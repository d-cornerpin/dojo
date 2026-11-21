// A relayed owner decision counts only from the message the agent answers: an approval only as his whole message and
// never a question, only while one of his cards is open, never from the worker itself; the main agent cancels on his words.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, handedIn, stateOf, ownerSays, ownerAsked, relayAnswering, WORKER, MAIN, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

async function ownersToDecide(): Promise<void> {
  freshBoard();
  await handedIn();
  ownerAsked();
}

describe('a relayed owner decision counts only from the message answered', () => {
  it('an approval is his whole message: one sentence of a longer message, or a question, does not approve', async () => {
    await ownersToDecide();
    expect((await relayAnswering(ownerSays('Yes. But redo page 3 first.'), 'Yes')).isError).toBe(true);
    expect((await relayAnswering(ownerSays('Is it good?'), 'Is it good?')).isError).toBe(true);
    expect(stateOf()).toBe('handed_in');
    expect((await relayAnswering(ownerSays('Yes, approve it.'), 'Yes, approve it.')).isError).toBe(false);
    expect(stateOf()).toBe('done');
  });

  it('a send back may quote one sentence of his message', async () => {
    await ownersToDecide();
    const r = await relayAnswering(ownerSays('Thanks. Send it back, page 3 is wrong.'), 'Send it back, page 3 is wrong', 'send_back');
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('sent_back');
  });

  it('a message written before he was asked is not his answer', async () => {
    freshBoard();
    await handedIn();
    const early = ownerSays('Yes, approve it.', { at: -5_000 });
    ownerAsked();
    expect((await relayAnswering(early, 'Yes, approve it.')).content).toMatch(/before he was asked/);
    expect(stateOf()).toBe('handed_in');
  });

  it('a yes with two of his cards open is refused', async () => {
    await ownersToDecide();
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
       VALUES ('task-other', 'task', ?, 'owner', 'tracker', 'task-other', 'handed_in', 'task', 1, 0, 'Book the table', ?, ?)`,
    ).run(WORKER, Date.now(), Date.now());
    doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES ('task-other', 'handed_in', ?, '{}', ?)").run(WORKER, Date.now());
    ownerAsked('task-other');
    const r = await relayAnswering(ownerSays('Yes, approve it.'), 'Yes, approve it.');
    expect(r.content).toMatch(/two of his questions are open/);
    expect(stateOf()).toBe('handed_in');
  });

  it('the worker cannot pass on his decision of its own work', async () => {
    await ownersToDecide();
    const r = await relayAnswering(ownerSays('Yes, approve it.', { agent: WORKER }), 'Yes, approve it.', 'approve', WORKER);
    expect(r.content).toMatch(/you worked this/);
    expect(stateOf()).toBe('handed_in');
  });

  it('the main agent cancels a task on the owner\'s words, with no card; another agent cannot', async () => {
    freshBoard();
    const theirs = ownerSays('Cancel the report, I do not need it.', { agent: OTHER });
    expect((await relayAnswering(theirs, 'Cancel the report, I do not need it', 'cancel', OTHER)).content).toMatch(/only the main agent/);
    const words = ownerSays('Cancel the report, I do not need it.');
    expect((await relayAnswering(words, 'Cancel the report, I do not need it', 'cancel', MAIN)).isError).toBe(false);
    expect(stateOf()).toBe('abandoned');
    const decided = doneDb().prepare("SELECT actor, payload FROM work_events WHERE work_id = ? AND kind = 'decided'").get(TASK) as { actor: string; payload: string };
    expect(decided.actor).toBe('user');
    expect(JSON.parse(decided.payload)).toMatchObject({ verdict: 'cancel', relayedBy: MAIN });
  });
});
