// The owner decides by dashboard button or by his own verified words. A made-up quote is refused; his
// real reply after he was asked is applied. Cancel is the owner's alone.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { appendWorkEvent } from '../../store.js';
import { freshBoard, handedIn, call, stateOf, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

/** The main agent's own task, past the PM: the owner decides it, and he was asked. */
async function ownersToDecide(): Promise<void> {
  freshBoard(MAIN);
  await handedIn(MAIN);
  appendWorkEvent(TASK, 'validation_escalated', 'scheduler', { thread_id: null });
}

const OWNER_ROW = { lane: 'owner', role: 'user', channel: 'dashboard', source_agent_id: null as string | null,
  inbound_meta: JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }) as string | null, at: 1000 };

function ownerSays(content: string, over: Partial<typeof OWNER_ROW> = {}): void {
  const r = { ...OWNER_ROW, ...over };
  const at = Date.now() + r.at;
  doneDb().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel, source_agent_id, authorized, inbound_meta, sent_at, created_at)
     VALUES (?, ?, 'conv-owner', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(`m-${Math.random()}`, MAIN, r.lane, r.role, content, r.channel, r.source_agent_id, r.inbound_meta, at, at);
}

const relay = (quote: string, verdict = 'approve') =>
  call(MAIN, 'work_validate', { action: 'decide', task_id: TASK, verdict, reason: 'The owner approved the report', user_quote: quote });

describe('the owner decides by button or by his own words', () => {
  it('approve with a made-up owner quote is refused, nothing changes', async () => {
    await ownersToDecide();
    ownerSays('Something else entirely.');
    const r = await relay('Yes, the report is fine.');
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
  ] as const) {
    it(`approve quoting ${why} is refused`, async () => {
      await ownersToDecide();
      ownerSays('Yes, the report is fine.', over as Partial<typeof OWNER_ROW>);
      expect((await relay('Yes, the report is fine.')).isError).toBe(true);
      expect(stateOf()).toBe('handed_in');
    });
  }

  it('approve with the owner\'s real reply after the ask is applied', async () => {
    await ownersToDecide();
    ownerSays('Yes, the report is fine.');
    const r = await relay('yes, the report is fine');
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('done');
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

  it('the owner\'s relayed words never cancel or close a task outright; that is his dashboard button', async () => {
    await ownersToDecide();
    ownerSays('Cancel it.');
    const r = await relay('Cancel it.', 'cancel');
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('handed_in');
  });

  it('cancel by an agent is refused', async () => {
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
