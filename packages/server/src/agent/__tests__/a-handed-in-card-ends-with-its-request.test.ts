// A card already handed in, waiting for its review, ends with its request when the owner calls the request off: it is
// cancelled as his, and no review of it is left to run.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { call, delegated, expectEndedAsHis, ownerTurn, settled, task, ASK, AGENT } from './helpers/call-off-world.js';

describe('a handed-in card ends with its request', () => {
  it("the request dropped on his words: its handed-in card and its working card are cancelled as his", async () => {
    delegated();
    task('card-in', { state: 'handed_in' }); task('card-working');
    ownerTurn('m-2', 'Never mind all of it.');
    const r = await call(AGENT, 'work_close_request', { id: ASK, disposition: 'dropped', note: 'Never mind all of it.' });
    expect(r.isError, String(r.content)).toBeFalsy();
    await settled();
    expectEndedAsHis(ASK, 'card-in', 'card-working');
  });
});
