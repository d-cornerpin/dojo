// A helper's result for a request the owner stopped is kept in the history and starts nothing; a result for a
// later, live request on the same thread still drives its turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner, getAgentRuntime } from '../runtime.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { findUnservedTerminalWake } from '../v2/counterparty.js';
import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, openDelegationJoin } from '../../work/store.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, requestState, HELPER, THREAD, CONV, ASK } from './helpers/text-relay.js';

const handleMessage = vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
beforeEach(() => {
  handleMessage.mockClear();
  delegatedTextRequest();
  testDb().prepare("INSERT INTO turns (agent_id, turn_number, root_kind, root_id, answered, effectful_calls) VALUES (?, 1, 'ask', 'm-ask', 0, 0)").run(AGENT);
});

const helperDelivers = () => deliverA2AMessage({ intent: 'DELIVERABLE', threadId: THREAD, requiresResponse: true, payload: 'The venue is free on the 14th.', toAgent: AGENT, fromAgent: HELPER } as never);
const resultRows = () => testDb().prepare("SELECT 1 FROM messages WHERE agent_id = ? AND a2a_intent = 'DELIVERABLE'").all(AGENT).length;

describe("a helper's result for a stopped request starts no turn", () => {
  it('the request and its piece end; the result is stored, wakes nobody and is owed to nobody', async () => {
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    expect(requestState()).toBe('abandoned');
    expect((testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state).toBe('abandoned');
    expect((await helperDelivers()).delivered).toBe(true);
    expect(resultRows()).toBe(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(findUnservedTerminalWake(AGENT)).toBeNull();
  });

  it('a later request sent on the same thread is live: its result drives its turn', async () => {
    stopByOwner(AGENT);
    vi.setSystemTime(Date.now() + 60_000);
    insertMessage({ id: 'm-2', agentId: AGENT, role: 'user', content: 'Go ahead and ask after all', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    claimAsk('ask:m-2', AGENT);
    openDelegationJoin({ parentWorkId: 'ask:m-2', agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 3_600_000,
      threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }] });
    await helperDelivers();
    expect(handleMessage.mock.calls.map((c: unknown[]) => c[0])).toEqual([AGENT]);
  });
});
