// One helper's answer goes back through the person's own queue: the turn serving the request is shown it and
// writes it on the channel the person asked on; that reply closes the request, and the Dojo sends nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, relayRows, requestState, ASK } from './helpers/text-relay.js';
import { turnReplies } from './helpers/turn-reply.js';

beforeEach(() => delegatedTextRequest());

describe('one helper\'s answer is written by the agent to the asker\'s channel', () => {
  it('the request is back in the queue; the shown turn\'s iMessage reply closes it; nothing is relayed', async () => {
    await helperAnswers('The venue is free on the 14th.');
    expect(requestState()).toBe('open');
    claimAsk(ASK, AGENT);
    stampClaimingTurn(ASK, 2);
    recordPiecesShown(ASK, AGENT, 2, newestPutBack(ASK)!.id);
    turnReplies(2, 'm-ask');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 2 });
    const closedOn = testDb().prepare('SELECT d.channel FROM work w JOIN deliveries d ON d.id = w.result_delivery_id WHERE w.id = ?').get(ASK);
    expect([requestState(), closedOn]).toEqual(['done', { channel: 'imessage' }]);
    expect(relayRows()).toEqual([]);
  });
});
