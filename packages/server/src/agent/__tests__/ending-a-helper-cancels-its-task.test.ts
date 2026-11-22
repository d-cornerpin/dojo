// The main agent ending its helper (round three, S08 step 6) calls off the helper's piece as a plain end: the helper's
// job is cancelled with it, in the termination itself, and the request is answered without it as before.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { call, delegated, endedBy, pieceOf, settled, AGENT, HELPER } from './helpers/call-off-world.js';

describe('ending a helper cancels its task', () => {
  it('kill_agent on the helper: its piece and its job end with the termination, as a plain end', async () => {
    delegated();
    const r = await call(AGENT, 'kill_agent', { agent_id: HELPER });
    expect(r.isError, String(r.content)).toBeFalsy();
    // Ended with the termination itself, before anything after it runs: a stop of the Dojo here leaves nothing open.
    expect([endedBy(pieceOf()), endedBy('task-helper-1')]).toEqual([{ state: 'abandoned', by: 'agent' }, { state: 'abandoned', by: 'agent' }]);
    await settled();
  });
});
