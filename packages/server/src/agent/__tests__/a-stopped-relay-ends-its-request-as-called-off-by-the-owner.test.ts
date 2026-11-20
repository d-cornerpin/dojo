// Stop drops a helper's answer still waiting to go to the person, and ends the request it answered as called off
// by the owner; nothing is sent afterwards.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner } from '../runtime.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { imessage, testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, relayRows, requestState, ASK } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

describe('a stopped relay ends its request as called off by the owner', () => {
  it('the queued relay is dropped, the request is abandoned by the owner, and nothing goes', async () => {
    await helperAnswers('The venue is free on the 14th.');
    expect(stopByOwner(AGENT)).toEqual({ ended: 1, repliesNotSent: 1 });
    expect(relayRows().map((r) => r.outcome)).toEqual(['suppressed']);
    expect(requestState()).toBe('abandoned');
    const by = testDb().prepare("SELECT json_extract(payload, '$.by') AS by FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1").get(ASK);
    expect(by).toEqual({ by: 'owner' });
    await deliverDueReplies(Date.now());
    expect(imessage.send).not.toHaveBeenCalled();
  });
});
