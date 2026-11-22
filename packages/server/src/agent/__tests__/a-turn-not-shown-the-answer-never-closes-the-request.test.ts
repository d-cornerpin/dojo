// A turn that was not shown a request's newest put-back never closes it with its own reply: the request goes back,
// due now, and the turn that is shown the pieces answers it once. Shown means the steer reached a model call.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, stampClaimingTurn, transition } from '../../work/store.js';
import { newestPutBack, owedAtTurnEnd, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { resolveJoinsAtBoot } from '../a2a-transport.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, delegatedTextRequest, helperAnswers, relayed, relayRows, requestState, textsSent, ASK, CONV } from './helpers/text-relay.js';
import { queueReply } from '../v2/deliveries.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { turnReplies } from './helpers/turn-reply.js';
import { turnRow } from '../v2/__tests__/helpers/live-turn.js';

const due = (): number | null => (testDb().prepare('SELECT next_attempt_at AS d FROM work WHERE id = ?').get(ASK) as { d: number | null }).d;
const putBacks = (): number => (testDb().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' AND json_extract(payload, '$.kind') IS NOT NULL",
).get(ASK) as { n: number }).n;

beforeEach(() => delegatedTextRequest());

describe('a turn not shown the answer never closes the request', () => {
  it('a same-conversation turn in flight ("thanks") closes its own message, not the request', async () => {
    insertMessage({ id: 'm-2', agentId: AGENT, role: 'user', content: 'thanks!', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    claimAsk('ask:m-2', AGENT);
    stampClaimingTurn('ask:m-2', 2);
    await helperAnswers('The venue is free on the 14th.');
    turnReplies(2, 'm-2');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 2, assembled: [{ workId: ASK, rowid: 1 }] });
    expect((testDb().prepare('SELECT state FROM work WHERE id = ?').get('ask:m-2') as { state: string }).state).toBe('done');
    expect(requestState()).toBe('open');
    expect(due()).not.toBeNull();
  });

  it('a turn holding the request when the answer lands owes no forced reply, and is handed it back at its end', async () => {
    transition(ASK, { to: 'claimed', by: 'agent', reason: 'a turn holds it, as the delegating turn does', expectedState: 'blocked' });
    stampClaimingTurn(ASK, 3);
    await helperAnswers('The venue is free on the 14th.');
    expect(owedAtTurnEnd(AGENT, 3)).toEqual([]);
    expect(requestState()).toBe('claimed');
    turnReplies(3, 'm-ask');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 3 });
    expect([requestState(), due() !== null]).toEqual(['open', true]);
  });

  it('the delegating turn\'s own reply still on its way when the answer lands: the answer goes back, and reaches the person once', async () => {
    transition(ASK, { to: 'claimed', by: 'agent', reason: 'the delegating turn holds it', expectedState: 'blocked' });
    stampClaimingTurn(ASK, 3);
    turnRow(AGENT, 3, { kind: 'ask', id: 'm-ask' });
    await queueReply({ agentId: AGENT, turnNumber: 3, root: { kind: 'ask', id: 'm-ask', sourceMessageId: 'm-ask', conversationId: CONV }, text: 'I\'ve asked the helper', address: { channel: 'imessage', to: PERSON } });
    await helperAnswers('The venue is free on the 14th.');
    await deliverDueReplies(Date.now());
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 3 });
    expect([requestState(), due() !== null, putBacks()]).toEqual(['open', true, 1]);
    await agentStaysSilent(4);
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual(['I\'ve asked the helper', relayed('The venue is free on the 14th.')]);
  });

  it('a turn shown the pieces mid-turn answers once, and that answer closes the request', async () => {
    await helperAnswers('The venue is free on the 14th.');
    claimAsk(ASK, AGENT);
    stampClaimingTurn(ASK, 4);
    recordPiecesShown(ASK, AGENT, 4, newestPutBack(ASK)!.id);
    expect(owedAtTurnEnd(AGENT, 4)).toEqual([ASK]);
    turnReplies(4, 'm-ask');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    expect(requestState()).toBe('done');
    expect(relayRows()).toEqual([]);
  });

  it('a restart in between puts the answer back once: the start-up passes find nothing more to do', async () => {
    await helperAnswers('The venue is free on the 14th.');
    await resolveJoinsAtBoot();
    await resolveJoinsAtBoot();
    expect(putBacks()).toBe(1);
    expect([requestState(), due() !== null]).toEqual(['open', true]);
  });
});
