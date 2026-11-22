// The owner removing a helper on the dashboard (round two, S08) calls off every piece it was given as his: its jobs
// end with them, the request it was the only part of ends as his, and nobody is told "no answer".
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
import { failedNotices } from './helpers/text-relay.js';
import { delegated, expectEndedAsHis, pieceOf, settled, ASK, HELPER } from './helpers/call-off-world.js';

describe("removing a helper calls off its pieces as the owner's", () => {
  it('his removal: the piece, its job and the request end as his, with no notice', async () => {
    delegated();
    expect((await agentsRouter.request(`/${HELPER}`, { method: 'DELETE' })).status).toBe(200);
    await settled();
    expectEndedAsHis(pieceOf(), 'task-helper-1', ASK);
    expect(failedNotices()).toBe(0);
  });
});
