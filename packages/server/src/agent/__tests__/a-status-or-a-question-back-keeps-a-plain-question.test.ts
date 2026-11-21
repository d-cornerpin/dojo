// A helper's status line or question back on a plain question is not its answer: the request is kept, and a final
// reply settles it once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverA2AMessage, sweepExpiredJoins } from '../a2a-transport.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { agentRequests } from '../v2/owed.js';
import { delegatedTextRequest, failedNotices, helperAnswers, requestState, HELPER, THREAD } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

describe('a status or a question back keeps a plain question', () => {
  it('a status line keeps it; the question stays owed; the final reply settles it', async () => {
    await deliverA2AMessage({ intent: 'QUESTION', threadId: THREAD, requiresResponse: true, payload: 'When is the venue free?', toAgent: HELPER, fromAgent: AGENT } as never);
    await deliverA2AMessage({ intent: 'STATUS', threadId: THREAD, requiresResponse: false, payload: 'Still checking.', toAgent: AGENT, fromAgent: HELPER } as never);
    vi.setSystemTime(Date.now() + 3 * 3_600_000);
    await sweepExpiredJoins();
    expect([requestState(), failedNotices(), agentRequests(HELPER).length]).toEqual(['blocked', 0, 1]);
    await helperAnswers('The 14th.');
    expect(testDb().prepare('SELECT state FROM work WHERE parent_id IS NOT NULL').get()).toEqual({ state: 'done' });
  });
});
