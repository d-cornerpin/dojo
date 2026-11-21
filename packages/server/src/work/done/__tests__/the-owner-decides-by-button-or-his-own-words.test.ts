// The owner decides by dashboard button or by his own verified words. A made-up quote, or one he wrote to another
// agent, is refused; his real reply to the relaying agent after he was asked is applied, and the decision records who
// relayed it and the quote. Cancel without his words, and a direct close, are his alone.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { freshBoard, handedIn, call, stateOf, ownerSays, ownerAsked, relayAnswering, MAIN, WORKER, OTHER, TASK, type OwnerRow } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

/** A worker's hand-in the owner was asked about. */
async function ownersToDecide(): Promise<void> {
  freshBoard();
  await handedIn();
  ownerAsked();
}

/** The owner writes `words` (as `over` says), and the main agent relays `quote` answering that message. */
const relay = (words: string, quote = words, verdict = 'approve', over: OwnerRow = {}) =>
  relayAnswering(ownerSays(words, over), quote, verdict);

describe('the owner decides by button or by his own words', () => {
  it('approve with a made-up owner quote is refused, nothing changes', async () => {
    await ownersToDecide();
    const r = await relay('Something else entirely.', 'Yes, the report is fine.');
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/could not be verified/);
    expect(stateOf()).toBe('handed_in');
  });

  for (const [why, over] of [
    ['an agent\'s own reply', { role: 'assistant', inbound_meta: null }],
    ['a row the engine wrote (no channel)', { channel: null, inbound_meta: null, lane: 'events' }],
    ['an A2A message from another agent', { source_agent_id: 'some-agent', lane: 'a2a', inbound_meta: null }],
    ['a contact who is not the owner', { channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550100', authorized: true }) }],
    ['the owner\'s own message from before he was asked', { at: -120_000 }],
    ['the owner\'s words to another agent', { agent: OTHER }],
  ] as const) {
    it(`approve quoting ${why} is refused`, async () => {
      await ownersToDecide();
      expect((await relay('Yes, the report is fine.', undefined, 'approve', over as OwnerRow)).isError).toBe(true);
      expect(stateOf()).toBe('handed_in');
    });
  }

  it('approve with the owner\'s real reply after the ask is applied', async () => {
    await ownersToDecide();
    const r = await relay('Yes, the report is fine.', 'yes, the report is fine');
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('done');
  });

  it('a relayed decision records who relayed it and the quote, and the trail shows both', async () => {
    await ownersToDecide();
    expect((await relay('Yes, the report is fine.')).isError).toBe(false);
    const decided = doneDb().prepare("SELECT actor, payload FROM work_events WHERE work_id = ? AND kind = 'decided'").get(TASK) as { actor: string; payload: string };
    expect(decided.actor).toBe('user');
    expect(JSON.parse(decided.payload)).toMatchObject({ verdict: 'approve', relayedBy: MAIN, quote: 'Yes, the report is fine.' });
    const log = await (await trackerRouter.request(`/tasks/${TASK}/log`)).json() as { data: Array<{ entryKind: string; note: string | null }> };
    expect(log.data.find((e) => e.entryKind === 'decided')?.note).toBe(`relayed by ${MAIN}, quoting the owner: "Yes, the report is fine."`);
  });

  it('a worker relaying the owner\'s "Thanks" on its own open task is refused: there is no hand-in and no ask', async () => {
    freshBoard();
    ownerSays('Thanks');
    for (const verdict of ['owner_done', 'approve']) {
      const r = await call(WORKER, 'work_validate', { action: 'decide', task_id: TASK, verdict, reason: 'The owner said thanks', user_quote: 'Thanks' });
      expect(r.isError).toBe(true);
    }
    expect(stateOf()).toBe('claimed');
  });

  it('the owner\'s relayed words never close a task outright; that is his dashboard button', async () => {
    await ownersToDecide();
    const r = await relay('Close it.', undefined, 'owner_done');
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('handed_in');
  });

  it('cancel by an agent without the owner\'s words is refused', async () => {
    freshBoard();
    const r = await call(MAIN, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'cancel', reason: 'Not needed any more' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only the owner/);
    expect(stateOf()).toBe('claimed');
  });

  it('cancel by the owner from the dashboard is applied', async () => {
    freshBoard();
    const res = await trackerRouter.request(`/tasks/${TASK}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'cancel', reason: 'Not needed any more' }),
    });
    expect(res.status).toBe(200);
    expect(stateOf()).toBe('abandoned');
  });

  it('the owner approves a hand-in from the dashboard without opening it', async () => {
    freshBoard();
    await handedIn();
    const res = await trackerRouter.request(`/tasks/${TASK}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approve', reason: 'I have the report' }),
    });
    expect(res.status).toBe(200);
    expect(stateOf()).toBe('done');
  });
});
