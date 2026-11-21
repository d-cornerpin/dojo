// A helper's question on a delegated thread is never taken for its answer, not even by the deadline pass that
// lands replies left unlanded: the piece stays out, and while the agent owes the helper its answer it is kept.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverA2AMessage, sweepExpiredJoins } from '../a2a-transport.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, relayRows, requestState, ASK, HELPER, THREAD } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

describe('a helper\'s question never lands at the deadline', () => {
  it('the question reaches the agent as itself; at the next look the request is kept, the question unlanded', async () => {
    const r = await deliverA2AMessage({
      intent: 'QUESTION', threadId: THREAD, requiresResponse: true, payload: 'Which venue did you mean?', toAgent: AGENT, fromAgent: HELPER,
    } as never);
    expect(r.delivered).toBe(true);
    vi.setSystemTime(Date.now() + 3_700_000);
    await sweepExpiredJoins();
    const piece = testDb().prepare('SELECT state, notes FROM work WHERE parent_id = ?').get(ASK) as { state: string; notes: string | null };
    expect(piece).toEqual({ state: 'open', notes: null });
    expect(requestState()).toBe('blocked');
    expect(relayRows()).toEqual([]);
  });
});
