// Two quick questions to one helper, on one thread, from two messages of the same person: each answer lands on its
// own question, and the turn that serves the first is shown both answers, so its one reply closes both requests and
// nothing is owed after it (no handed-back request, no required reply that would repeat an answer).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, stampClaimingTurn, openDelegationJoin } from '../../work/store.js';
import { owedAtTurnEnd, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { withHandBackFacts } from '../v2/steps/assemble/hand-back-steer.js';
import { getWaitingHumanConversations } from '../v2/counterparty.js';
import { initState } from '../v2/state.js';
import { markSteerDelivered, nextSteer } from '../v2/steer-queue.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, ASK, CONV, HELPER, THREAD } from './helpers/text-relay.js';
import { turnReplies } from './helpers/turn-reply.js';

const TOWELS = 'ask:m-towels';
const asks = () => testDb().prepare('SELECT id, state, result_delivery_id AS answer FROM work WHERE id IN (?, ?) ORDER BY id')
  .all(ASK, TOWELS) as Array<{ id: string; state: string; answer: string | null }>;

beforeEach(async () => {
  delegatedTextRequest();   // the first question, asked of the helper on THREAD by turn 1
  insertMessage({ id: 'm-towels', agentId: AGENT, role: 'user', content: 'And ask her how many towels', channel: 'imessage', senderId: PERSON, conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON, relation: 'known_contact' }) });
  claimAsk(TOWELS, AGENT);
  stampClaimingTurn(TOWELS, 2);
  await helperAnswers('1. Sunscreen 2. A hat 3. Water');   // lands on the first question while turn 2 runs
  const asked = await deliverA2AMessage({ intent: 'QUESTION', threadId: THREAD, requiresResponse: true, payload: 'How many towels?', toAgent: HELPER, fromAgent: AGENT });
  expect(asked.delivered).toBe(true);
  openDelegationJoin({ parentWorkId: TOWELS, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 3_600_000,
    threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }] });
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 2 });
  await helperAnswers('Six towels, one each.');   // lands on the towel question
});

describe('two quick questions to one helper', () => {
  for (const [root, other] of [['m-ask', TOWELS], ['m-towels', ASK]] as const) {
    it(`the turn serving ${root} is shown both answers, and its one reply closes both`, () => {
      vi.advanceTimersByTime(60_000);   // the turn starts a minute later, after both texts and both answers
      // The turn's conversation key, read as the turn start reads it, before its own claim.
      const convKey = getWaitingHumanConversations(AGENT)[0]!.key;
      claimAsk(`ask:${root}`, AGENT);
      stampClaimingTurn(`ask:${root}`, 3);
      const turnCtx = { root: { kind: 'ask', id: root, sourceMessageId: root, conversationId: CONV }, convKey } as never;
      const steered = withHandBackFacts(initState({ agentId: AGENT } as never), turnCtx, AGENT, 3);
      const entry = nextSteer(steered.steerQueue)!;
      expect(entry.content).toContain('Sunscreen');
      expect(entry.content).toContain('Six towels');
      // The steer reaches the model call: each request it carries is recorded as shown, as the call does.
      for (const s of markSteerDelivered(steered.steerQueue, entry).delivered.flatMap((e) => e.shown ?? [])) recordPiecesShown(s.askId, AGENT, 3, s.putBackId);

      turnReplies(3, root);
      const otherRow = (testDb().prepare('SELECT rowid FROM messages WHERE id = ?').get(other.slice('ask:'.length)) as { rowid: number }).rowid;
      settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 3, assembled: [{ workId: other, rowid: otherRow }] });
      const [first, towels] = asks();
      expect([first.state, towels.state]).toEqual(['done', 'done']);
      expect(towels.answer).toBe(first.answer);
      expect(owedAtTurnEnd(AGENT, 3), 'nothing is owed, so no required reply repeats an answer').toEqual([]);
    });
  }
});
