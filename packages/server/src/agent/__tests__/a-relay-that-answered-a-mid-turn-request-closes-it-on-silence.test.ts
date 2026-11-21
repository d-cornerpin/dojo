// A second request B, arriving mid-turn, was delegated by that turn after the model was pointed at it; the Dojo's
// relay of the helper's answer reached B's conversation. When B is served again and the model deliberately says
// nothing, B settles on that relay instead of being answered twice.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { recordOwedInterruptSubjects, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { recordOwedAskShown } from '../../work/delegated-relay-evidence.js';
import { recordDelivery } from '../v2/deliveries.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { startTurn, finalizeTurn } from '../v2/turn-record.js';
import { asTurn } from '../turn-context.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, delegatedTextRequest, helperAnswers, relayRows, CONV, HELPER, THREAD } from './helpers/text-relay.js';

const ASK_B = 'ask:m-b';
const stateOf = (id: string): { state: string; result_delivery_id: string | null } =>
  testDb().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(id) as never;

beforeEach(() => {
  delegatedTextRequest();
  // Turn 1 also owed B, pointed the model at it, and the model's delegation went out after that.
  insertMessage({ id: 'm-b', agentId: AGENT, role: 'user', content: 'and ask it about parking too', channel: 'imessage', senderId: PERSON, conversationId: CONV });
  recordOwedAskShown(AGENT, ['m-b'], 1);
  insertMessage({ id: 'm-send', agentId: HELPER, role: 'user', lane: 'a2a', content: '[A2A:QUESTION] parking?', sourceAgentId: AGENT, a2aThreadId: THREAD, a2aIntent: 'QUESTION', a2aRequiresResponse: true });
  asTurn(AGENT, { turnNumber: 1, root: null, convKey: null }, () => recordDelivery({ agentId: AGENT, tool: 'send_to_agent', channel: 'a2a', messageId: 'm-send', outcome: 'delivered' }));
  recordOwedInterruptSubjects(AGENT, ['m-b'], 1);
});

describe('a relay that answered a mid-turn request closes it on silence', () => {
  it('B served again, the model silent: B settles on the Dojo\'s relay', async () => {
    await helperAnswers('Parking is free after six.');
    await agentStaysSilent(2);
    await deliverDueReplies(Date.now());
    const relay = relayRows().find((r) => r.outcome === 'delivered');
    expect(relay).toBeDefined();

    claimAsk(ASK_B, AGENT);
    const turn = startTurn({ agentId: AGENT, kind: 'user', subjectKind: 'conv', subjectId: CONV, rootKind: 'ask', rootId: 'm-b', sourceMessageId: 'm-b', convKey: CONV });
    stampClaimingTurn(ASK_B, turn);
    finalizeTurn(AGENT, turn, 'no_reply_intended', false, null);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
    expect(stateOf(ASK_B)).toEqual({ state: 'done', result_delivery_id: relay!.id });
  });
});
