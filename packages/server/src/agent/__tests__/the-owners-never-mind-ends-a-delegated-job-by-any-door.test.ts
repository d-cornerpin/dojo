// The owner's "never mind" on a job his agent handed to a helper ends it by whichever door his agent takes: dropping the
// request with his words, or cancelling the card on his words, moved to the helper or still its own only card. Each
// time the request, the piece, the helper's job and the card end as his, the helper stops, its late answer is
// refused and nothing reaches him.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
import { endTurnContext } from '../turn-context.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { relayRows, textsSent } from './helpers/text-relay.js';
import { call, delegated, expectEndedAsHis, lateReply, ownerTurn, pieceOf, settled, stopped, task, ASK, AGENT, HELPER } from './helpers/call-off-world.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const WORDS = 'Never mind, forget the camping list.';

/** After the door: everything ended as his, the helper stopped, its late answer refused, nothing sent. */
async function allOfItEnded(card: string): Promise<void> {
  endTurnContext(AGENT);
  await settled();
  expectEndedAsHis(ASK, pieceOf(), 'task-helper-1', card);
  expect(stopped(HELPER)).toBe(true);
  endTurnContext(HELPER);
  expect(await lateReply()).toBe(false);
  expect([relayRows(), textsSent()]).toEqual([[], []]);
}

describe("the owner's never mind ends a delegated job by any door", () => {
  it('his agent drops the request, by the id OPEN WORK shows, with his words', async () => {
    delegated();
    const card = task('card-own');
    ownerTurn('m-2', WORDS);
    const r = await call(AGENT, 'work_close_request', { id: ASK, disposition: 'dropped', note: WORDS });
    expect(r.isError, String(r.content)).toBeFalsy();
    await allOfItEnded(card);
  });

  it('his agent cancels the card fix A moved to the helper, on his words', async () => {
    delegated();
    testDb().prepare("UPDATE work SET requester_id = ?, source_message_id = 'm-ask' WHERE id = 'task-helper-1'").run(AGENT);
    ownerTurn('m-2', WORDS);
    const r = await call(AGENT, 'work_validate', { action: 'decide', task_id: 'task-helper-1', verdict: 'cancel', reason: 'He called it off', user_quote: WORDS });
    expect(r.isError, String(r.content)).toBeFalsy();
    await allOfItEnded('task-helper-1');
  });

  it("his agent cancels its own only card, never moved, on his words: it stands for the whole request", async () => {
    delegated();
    const card = task('card-own');
    ownerTurn('m-2', WORDS);
    const r = await call(AGENT, 'work_validate', { action: 'decide', task_id: card, verdict: 'cancel', reason: 'He called it off', user_quote: WORDS });
    expect(r.isError, String(r.content)).toBeFalsy();
    await allOfItEnded(card);
  });
});
