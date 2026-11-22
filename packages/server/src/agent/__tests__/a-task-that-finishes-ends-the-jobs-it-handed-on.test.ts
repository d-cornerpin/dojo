// A helper's job that finishes leaves nothing it handed on open: the piece under it ends and the second helper's job is
// cancelled with it, so that helper stops and its late answer reaches nobody.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { trackerRouter } from '../../gateway/routes/tracker.js';
import { delegated, endedBy, handedOn, lateReply, pieceOf, settled, stopped, HELPER } from './helpers/call-off-world.js';

describe('a task that finishes ends the jobs it handed on', () => {
  it("the middle helper's job closed done by the owner: the job it handed on ends, its helper stops", async () => {
    delegated();
    handedOn('task-helper-1', HELPER, 'agent-third', 'thread-3', 'task-third');
    expect((await trackerRouter.request('/tasks/task-helper-1/decision', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'owner_done', reason: 'Good enough' }) })).status).toBe(200);
    await settled();
    expect([endedBy('task-helper-1')?.state, endedBy(pieceOf('thread-3'))?.state, endedBy('task-third')?.state]).toEqual(['done', 'abandoned', 'abandoned']);
    expect(stopped('agent-third')).toBe(true);
    expect(await lateReply('agent-third', 'thread-3', HELPER)).toBe(false);
  });
});
