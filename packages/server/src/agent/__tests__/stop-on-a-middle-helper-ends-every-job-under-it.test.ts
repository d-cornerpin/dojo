// The owner pressing Stop on a helper that handed its job on ends every job under it as his: its own job, the second
// helper's piece and job (that helper stops too), and the request it served, with no "no answer" notice to anyone.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { stopByOwner } from '../runtime.js';
import { failedNotices } from './helpers/text-relay.js';
import { delegated, expectEndedAsHis, handedOn, lateReply, pieceOf, settled, stopped, ASK, HELPER } from './helpers/call-off-world.js';

describe('stop on a middle helper ends every job under it', () => {
  it('Stop on the helper while its turn runs: its job, the job it handed on and the request end as his', async () => {
    delegated();
    handedOn('task-helper-1', HELPER, 'agent-third', 'thread-3', 'task-third');
    stopByOwner(HELPER);
    await settled();
    expectEndedAsHis(pieceOf(), 'task-helper-1', pieceOf('thread-3'), 'task-third', ASK);
    expect([stopped('agent-third'), failedNotices()]).toEqual([true, 0]);
    expect(await lateReply('agent-third', 'thread-3', HELPER)).toBe(false);
  });
});
