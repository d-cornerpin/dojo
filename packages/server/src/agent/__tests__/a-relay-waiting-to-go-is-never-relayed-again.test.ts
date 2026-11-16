// A helper's answer the Dojo has queued for the person, but not yet sent, is not relayed a second time by any other
// road (the relay held for the turn's end, the compile drive, the deadline sweep); when the channel works it goes once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deferJoinRelay } from '../deferred-join-relay.js';
import { releaseDeferredJoinRelays, resolveCompilePendingJoins, sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, relayRows, requestState, textsSent, ASK } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

describe('a relay waiting to go is never relayed again', () => {
  it('one queued row whatever else runs, sent once, and the request settles when it goes', async () => {
    await helperAnswers('The venue is free on the 14th.');
    deferJoinRelay(AGENT, ASK);
    await releaseDeferredJoinRelays(AGENT);
    await resolveCompilePendingJoins(AGENT);
    await sweepExpiredJoins();
    expect(relayRows().map((r) => r.outcome)).toEqual(['pending']);
    await deliverDueReplies(Date.now());
    await deliverDueReplies(Date.now() + 3_600_000);
    expect(textsSent()).toEqual(['Dojo: Heard back from Helper: The venue is free on the 14th.']);
    expect(requestState()).toBe('done');
  });
});
