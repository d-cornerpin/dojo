// A relay that never went ends its request; when the helper answers again later, that new answer is relayed too, as
// its own row. The same answer is never relayed twice.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deferJoinRelay } from '../deferred-join-relay.js';
import { releaseDeferredJoinRelays } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { imessage, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, relayRows, requestState, textsSent, ASK } from './helpers/text-relay.js';

const MIN = 60_000;

beforeEach(() => delegatedTextRequest());

describe('a late answer after a relay is relayed too', () => {
  it('the same hand-in is not relayed again; a new one goes as its own row', async () => {
    await helperAnswers('Probably the 14th.');
    imessage.send.mockResolvedValue(false);
    let now = Date.now();
    for (const wait of [30_000, 2 * MIN, 10 * MIN, 30 * MIN, MIN]) {
      await deliverDueReplies(now);
      now += wait;
    }
    expect(requestState()).toBe('failed');
    deferJoinRelay(AGENT, ASK);
    await releaseDeferredJoinRelays(AGENT);
    expect(relayRows().map((r) => r.tool)).toEqual(['a2a-join-relay']);

    imessage.send.mockReset();
    imessage.send.mockResolvedValue(true);
    await helperAnswers('Confirmed: the 14th, all day.');
    await deliverDueReplies(now);
    expect(relayRows().map((r) => [r.tool, r.outcome])).toEqual([['a2a-join-relay', 'failed'], ['a2a-join-late', 'delivered']]);
    expect(textsSent()).toEqual(['Dojo: Update: Helper answered after all. Confirmed: the 14th, all day.']);
    expect(requestState()).toBe('done');
  });
});
