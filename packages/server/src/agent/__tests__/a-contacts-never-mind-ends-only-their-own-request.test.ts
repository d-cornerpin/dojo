// A contact's "never mind" (round three, S08 step 9) is a plain end of the contact's own request, never the owner's
// cancel: the request, its piece, its helper's job and the agent's own card for it end as the agent's.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { call, delegated, endedBy, ownerTurn, pieceOf, settled, task, ASK, AGENT } from './helpers/call-off-world.js';

describe("a contact's never mind ends only their own request", () => {
  it('dropped on their words: every part ends, none of it as the owner\'s', async () => {
    delegated('known_contact');
    task('card-own');
    ownerTurn('m-2', 'Never mind, forget the camping list.', 'known_contact');
    const r = await call(AGENT, 'work_close_request', { id: ASK, disposition: 'dropped', note: 'Never mind, forget the camping list.' });
    expect(r.isError, String(r.content)).toBeFalsy();
    await settled();
    for (const id of [ASK, pieceOf(), 'task-helper-1', 'card-own']) expect(endedBy(id), id).toEqual({ state: 'abandoned', by: 'agent' });
  });
});
