// When the owner ends one part of a request while another part still works, only that part ends: the request is never
// failed and nobody is told "no answer". One of two helpers' jobs cancelled: that helper stops, its late answer is
// refused by its piece's own state, and the other's answer still goes back to the agent. One of several step cards
// cancelled: that step only, and his agent's relayed cancel names the door that ends all of it. A part removed while his
// agent's own card works: the request goes back to his agent. His end of the last working part, or of the card that
// stands for the request, ends it quietly as his.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { agentsRouter } from '../../gateway/routes/agents.js';
import { newestPutBack } from '../../work/ask-settlement.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { failedNotices, helperAnswers } from './helpers/text-relay.js';
import {
  boardCancel, call, delegated, endedBy, expectEndedAsHis, lateReply, ownerTurn, pieceOf, settled, stateOf, stopped, task, ASK, AGENT, HELPER, SECOND, T2,
} from './helpers/call-off-world.js';

/** The request back with its agent, nobody told, the card still worked. */
const goesOn = async (...cards: string[]): Promise<void> => {
  await settled();
  expect([stateOf(ASK), failedNotices(), ...cards.map(stateOf)]).toEqual(['open', 0, ...cards.map(() => 'claimed')]);
};

describe('one part ended while another works: the request goes on', () => {
  it('his agent holds its own card and the owner removes the helper (P2b); then he cancels the card: ended quietly as his', async () => {
    delegated();
    task('card-own');
    expect((await agentsRouter.request(`/${HELPER}`, { method: 'DELETE' })).status).toBe(200);
    await goesOn('card-own');
    expect(await boardCancel('card-own')).toBe(200);
    await settled();
    expect([endedBy(ASK), failedNotices()]).toEqual([{ state: 'abandoned', by: 'owner' }, 0]);
  });

  it("two step cards, and the owner cancels the helper's own job card (P1b)", async () => {
    delegated();
    task('card-1'); task('card-2');
    expect(await boardCancel('task-helper-1')).toBe(200);
    await goesOn('card-1', 'card-2');
  });

  it('two step cards, and the owner cancels the one fix A moved to the helper (P1)', async () => {
    delegated();
    testDb().prepare("UPDATE work SET requester_id = 'agent-main', source_message_id = 'm-ask' WHERE id = 'task-helper-1'").run();
    task('card-2');
    expect(await boardCancel('task-helper-1')).toBe(200);
    expectEndedAsHis('task-helper-1');
    await goesOn('card-2');
  });

  it("the second helper's job cancelled: it stops, its late answer reaches nobody, the first helper's answer goes back", async () => {
    delegated('owner', ['thread-relay-0001', T2]);
    expect(await boardCancel('task-second-1')).toBe(200);
    await settled();
    expectEndedAsHis(pieceOf(T2), 'task-second-1');
    expect([stopped(SECOND), stateOf(ASK)]).toEqual([true, 'blocked']);
    expect(await lateReply(SECOND, T2)).toBe(false);
    await helperAnswers('The venue is free on the 14th.');
    await settled();
    expect([newestPutBack(ASK)?.kind, stateOf(ASK)]).toEqual(['compile', 'open']);
  });

  it('the card fix A moved to the first helper is the only card: cancelling it ends the whole request as his', async () => {
    delegated('owner', ['thread-relay-0001', T2]);
    testDb().prepare("UPDATE work SET requester_id = 'agent-main', source_message_id = 'm-ask' WHERE id = 'task-helper-1'").run();
    expect(await boardCancel('task-helper-1')).toBe(200);
    await settled();
    expectEndedAsHis(ASK, pieceOf(), pieceOf(T2), 'task-helper-1', 'task-second-1');
    expect([stopped(HELPER), stopped(SECOND)]).toEqual([true, true]);
  });

  it('his tap on the board ends the first of three steps; the request, the helper and the other two go on', async () => {
    delegated();
    const [one, two, three] = [task('card-1'), task('card-2'), task('card-3')];
    expect(await boardCancel(one)).toBe(200);
    await settled();
    expectEndedAsHis(one);
    expect([stateOf(ASK), stateOf(pieceOf()), stateOf('task-helper-1'), stateOf(two), stateOf(three)]).toEqual(['blocked', 'open', 'claimed', 'claimed', 'claimed']);
  });

  it('his agent relays the cancel of one step: the result says the request goes on and how to end all of it', async () => {
    delegated();
    task('card-1'); task('card-2');
    ownerTurn('m-2', 'Skip the first step.');
    const r = await call(AGENT, 'work_validate', { action: 'decide', task_id: 'card-1', verdict: 'cancel', reason: 'He skipped it', user_quote: 'Skip the first step.' });
    expect(String(r.content)).toContain(`work_close_request(id="${ASK}", disposition="dropped"`);
    expect([endedBy('card-1'), stateOf(ASK)]).toEqual([{ state: 'abandoned', by: 'owner' }, 'blocked']);
    expect(testDb().prepare("SELECT state FROM work WHERE id = 'card-2'").get()).toEqual({ state: 'claimed' });
  });

  it('his agent hands one of its two cards to a second agent, then the owner cancels the other: the handed card goes on', async () => {
    delegated();
    testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Second', 'idle', 'standard')").run(SECOND);
    task('card-a'); task('card-b');
    const moved = await call(AGENT, 'work_update', { action: 'reassign', task_id: 'card-b', assigned_to: SECOND, cause: 'coordination' });
    expect(moved.isError, String(moved.content)).toBeFalsy();
    await helperAnswers('The venue is free on the 14th.');
    await settled();
    expect(await boardCancel('card-a')).toBe(200);
    await settled();
    expect([stateOf(ASK) === 'abandoned', stateOf('card-b')]).toEqual([false, 'claimed']);
  });
});
