// A helper's answer passed back while the agent is in another turn is no answer to that turn's request: its row
// belongs to the request it relays, in no turn, so the live turn's request stays open to be answered.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, requestState, ASK, CONV } from './helpers/text-relay.js';
import { relayPiecesWhole } from '../a2a-transport.js';

const LIVE = 'ask:m-live';
const state = (id: string) => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

beforeEach(() => {
  // The delegated request and the live one are both in the owner's dashboard chat.
  delegatedTextRequest({ channel: 'dashboard', relation: 'owner' });
  insertMessage({ id: 'm-live', agentId: AGENT, role: 'user', content: 'And what is on my calendar today?', channel: 'dashboard', senderId: 'owner', conversationId: CONV, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) });
  claimAsk(LIVE, AGENT);
  stampClaimingTurn(LIVE, 5);
});

describe('a relayed dashboard copy never closes a live turn\'s request', () => {
  it('the relay settles its own request; the live turn\'s request stays claimed', async () => {
    const ctx = openTurnContext(AGENT);
    ctx.turnNumber = 5;
    ctx.root = { kind: 'ask', id: 'm-live', sourceMessageId: 'm-live', conversationId: CONV };
    try {
      await helperAnswers('The venue is free on the 14th.');
      await relayPiecesWhole(ASK, 'compile', null);
    } finally {
      endTurnContext(AGENT);
    }
    expect(requestState()).toBe('done');
    expect(state(LIVE)).toBe('claimed');
  });
});
