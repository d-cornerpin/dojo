// A request from another Dojo box whose agent chose silence still gets the helper's answer owed to it: the silent
// turn does not settle that request as answered by silence; it is stood down and the answer alone is sent.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, requestState, textsSent, ASK } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest({ senderIsAgent: true }));

describe('a peer box\'s request gets the helper\'s answer', () => {
  it('the agent stays silent toward the peer box, and the helper\'s answer still goes, once', async () => {
    await helperAnswers('The venue is free on the 14th.');
    claimAsk(ASK, AGENT);
    stampClaimingTurn(ASK, 2);
    recordPiecesShown(ASK, AGENT, 2, newestPutBack(ASK)!.id);
    testDb().prepare("INSERT INTO turns (agent_id, turn_number, answered, effectful_calls, exit_reason, ended_at) VALUES (?, 2, 0, 0, 'no_reply_intended', datetime('now'))").run(AGENT);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 2, peerBox: true });
    expect(requestState()).toBe('blocked');
    await vi.dynamicImportSettled();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual(['The venue is free on the 14th.']);
    expect(requestState()).toBe('done');
  });
});
