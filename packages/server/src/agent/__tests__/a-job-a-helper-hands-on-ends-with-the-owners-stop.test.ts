// A job a helper hands on ends with the owner's Stop, as lived: the owner asks, the main agent hands the job to a helper,
// the helper's own response hands part of it to an existing agent by `send_to_agent`, then Stop. Nothing is seeded: each
// hand-on goes through the real execute step. The second agent's job ends, its turn stops, nothing wakes it, and its
// late answer reaches nobody; at three levels the Stop reaches the third agent too. While the work is live, the second
// agent's answer wakes the first and counts nothing down. A helper's message back to its maker (a BLOCK on the job's
// thread, a QUESTION on a new one) is no hand-on: it opens no piece, so the job's end never stops the maker.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner, getAgentRuntime } from '../runtime.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { nextOwed } from '../v2/owed.js';
import { activeRuns, isStopFenced } from '../shared-state.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { runLadder, LADDER_ENTRY } from '../../work/done/ladder.js';
import { imessage, testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { endedBy, settled } from './helpers/call-off-world.js';
import { AGENT, ASK, BOT, CORA, THIRD, agentTurnOnItsRequest, assign, jobOf, ownerAsks, piecesUnder, respond, turnEnds, world } from './helpers/hand-on-world.js';

const wake = vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const woken = (): string[] => wake.mock.calls.map((c) => c[0] as string);
const hinted = (task: string): number => (testDb().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') = ?")
  .get(task, LADDER_ENTRY.hint) as { n: number }).n;

/** The owner's request, the main agent's hand-over to Cora, and Cora's hand-on to BehaviorBot; returns the hand-on thread. */
async function handedOnTwice(): Promise<string> {
  ownerAsks('Get a helper to plan a lake picnic menu, and have it get its own helper to price the food.');
  expect(await respond(AGENT, [assign(CORA, 'Plan a lake picnic menu; get your own helper to price the food.')], { reply: 'Cora is on it.' }))
    .toMatchObject({ directive: 'exit' });
  turnEnds(AGENT);
  agentTurnOnItsRequest(CORA);
  const out = await respond(CORA, [assign(BOT, 'Price the food on this picnic menu.')]);
  expect(out).toMatchObject({ directive: 'exit', reason: 'a2a-reply-sent' });
  const [piece] = piecesUnder(jobOf(CORA).id);
  expect(piece, 'the hand-on is a piece of her job').toMatchObject({ state: 'open', assignee_agent: BOT });
  turnEnds(CORA);
  wake.mockClear();
  return (testDb().prepare('SELECT root_id AS t FROM work WHERE id = ?').get(piece!.id) as { t: string }).t;
}

beforeEach(() => { world(); wake.mockClear(); });

describe("a job a helper hands on ends with the owner's Stop", () => {
  it('Stop while the second agent works: its job ends as his, its turn stops, nothing wakes it, and its answer reaches nobody', async () => {
    const thread = await handedOnTwice();
    agentTurnOnItsRequest(BOT);
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    await settled();
    expect(endedBy(jobOf(BOT).id)).toEqual({ state: 'abandoned', by: 'owner' });
    expect(isStopFenced(BOT)).toBe(true);
    turnEnds(BOT);
    expect(nextOwed(BOT)).toEqual([]);
    expect(await deliverA2AMessage({ intent: 'COMPLETE', threadId: thread, requiresResponse: true, payload: 'About forty dollars.', toAgent: CORA, fromAgent: BOT } as never))
      .toMatchObject({ delivered: false, reason: 'REQUEST_ENDED' });
    await settled();
    expect(woken()).not.toContain(CORA);
    await runLadder(Date.now() + 3_600_000);
    expect(hinted(jobOf(BOT).id)).toBe(0);
  });

  it('Stop with nothing running: the second agent\'s job ends and is never served to it', async () => {
    await handedOnTwice();
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    await settled();
    expect([endedBy(ASK)?.state, endedBy(jobOf(CORA).id)?.state, endedBy(jobOf(BOT).id)]).toEqual(['abandoned', 'abandoned', { state: 'abandoned', by: 'owner' }]);
    expect(nextOwed(BOT)).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("while the work is live the second agent's answer lands on its piece, wakes the first helper, and counts nothing down", async () => {
    const thread = await handedOnTwice();
    expect(await deliverA2AMessage({ intent: 'COMPLETE', threadId: thread, requiresResponse: true, payload: 'About forty dollars.', toAgent: CORA, fromAgent: BOT } as never))
      .toMatchObject({ delivered: true });
    await settled();
    expect(piecesUnder(jobOf(CORA).id).map((p) => p.state)).toEqual(['done']);
    expect(woken()).toContain(CORA);
    const join = (id: string): unknown => testDb().prepare('SELECT remaining_children AS left, compile_pending AS compile FROM work WHERE id = ?').get(id);
    expect([join(jobOf(CORA).id), join(ASK)]).toEqual([{ left: null, compile: 0 }, { left: 1, compile: 0 }]);
    expect(imessage.sent).toEqual([]);
  });

  it('three levels: the second agent hands on to a third, and the Stop reaches the third', async () => {
    await handedOnTwice();
    agentTurnOnItsRequest(BOT);
    expect(await respond(BOT, [assign(THIRD, 'Check the shop prices for the menu.')])).toMatchObject({ reason: 'a2a-reply-sent' });
    turnEnds(BOT);
    agentTurnOnItsRequest(THIRD);
    expect(piecesUnder(jobOf(BOT).id)).toHaveLength(1);
    stopByOwner(AGENT);
    await settled();
    expect([endedBy(jobOf(BOT).id)?.state, endedBy(jobOf(THIRD).id)?.state, isStopFenced(THIRD)]).toEqual(['abandoned', 'abandoned', true]);
  });

  it("a helper's BLOCK and QUESTION back to its maker open no piece, and its job's end leaves the maker's turn running", async () => {
    ownerAsks('Get a helper to plan a lake picnic menu.');
    await respond(AGENT, [assign(CORA, 'Plan a lake picnic menu.')], { reply: 'Cora is on it.' });
    turnEnds(AGENT);
    const thread = agentTurnOnItsRequest(CORA);
    expect(await respond(CORA, [
      ['send_to_agent', { agent: AGENT, intent: 'BLOCK', thread_id: thread, payload: 'Which lake? I need it to plan the menu.' }],
      ['send_to_agent', { agent: AGENT, intent: 'QUESTION', payload: 'Any allergies I should know about?' }],
    ])).toMatchObject({ directive: 'exit', reason: 'a2a-reply-sent' });
    turnEnds(CORA);
    expect(piecesUnder(jobOf(CORA).id)).toEqual([]);
    liveTurn(AGENT, { turnNumber: 2, kind: 'a2a', root: { kind: 'a2a', id: thread, sourceMessageId: null } });   // the main agent reads the BLOCK
    activeRuns.add(AGENT);
    expect((await trackerRouter.request(`/tasks/${jobOf(CORA).id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'owner_done', reason: 'Good enough' }) })).status).toBe(200);
    await settled();
    expect(isStopFenced(AGENT)).toBe(false);
  });
});
