// A request handed to two helpers: the owner cancelling the second helper's own job ends that part only. That helper
// stops and its late answer is refused by its piece's own state, while the first helper's answer still goes back to
// the agent; cancelling the card that stands for the request ends all of it as his.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { newestPutBack } from '../../work/ask-settlement.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { helperAnswers } from './helpers/text-relay.js';
import { boardCancel, delegated, expectEndedAsHis, lateReply, pieceOf, settled, stateOf, stopped, ASK, HELPER, SECOND, T2 } from './helpers/call-off-world.js';

describe("a cancel of one helper's part ends only that part", () => {
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
});
