// The owner deleting a card calls off what the card was before the row goes: his agent's own only card (never moved)
// ends the whole request and stops its helper; a middle helper's job ends the work it handed on, and the second
// helper's late answer is still refused through its kept piece.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { delegated, expectEndedAsHis, boardDelete, handedOn, lateReply, pieceOf, settled, stateOf, stopped, task, ASK, HELPER } from './helpers/call-off-world.js';

describe('deleting a card calls off what the card was', () => {
  it("his agent's own only card, deleted: the request, the helper's piece and job end as his, the helper stops", async () => {
    delegated();
    expect(await boardDelete(task('card-own'))).toBe(200);
    await settled();
    expect(stateOf('card-own')).toBeUndefined();
    expectEndedAsHis(ASK, pieceOf(), 'task-helper-1');
    expect(stopped(HELPER)).toBe(true);
  });

  it("a middle helper's job, deleted: the job it handed on ends as his, its helper stops, and its late answer is refused", async () => {
    delegated();
    const third = await handedOn();
    expect(await boardDelete('task-helper-1')).toBe(200);
    await settled();
    expectEndedAsHis(ASK, pieceOf(), pieceOf('thread-3'), third);
    expect(stopped('agent-third')).toBe(true);
    expect(await lateReply('agent-third', 'thread-3', HELPER)).toBe(false);
  });
});
