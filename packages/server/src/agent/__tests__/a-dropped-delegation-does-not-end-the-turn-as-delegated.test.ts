// A turn ends as delegated only when a delegating send went out this turn, whichever tool made it, and a
// follow-up on a thread whose piece belongs to an earlier request opens no second piece. After the one status-line
// steer, a lookup tool step does not end the turn: the model sees its result and writes its line.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { insertMessage } from '../../memory/message-store.js';
import { askIdForMessage, claimAsk } from '../../work/store.js';
import { initState } from '../v2/state.js';
import { runDelegationTurnEnd } from '../v2/steps/execute/delegation-exit.js';
import { freshAgentsDb, testDb, ASKER, HELPER } from './helpers/agent-requests.js';

const TURN = 7;
const ownerAsk = (): string => {
  const id = randomUUID();
  insertMessage({ id, agentId: ASKER, role: 'user', content: 'find out for me', lane: 'owner', channel: 'dashboard', senderId: 'owner' });
  claimAsk(askIdForMessage(id), ASKER);
  return askIdForMessage(id);
};
const delivery = (turn: number, outcome: string, messageId: string | null): void => { testDb().prepare(
  `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at)
   VALUES (?, ?, ?, 'send_to_agent', 'a2a', ?, ?, datetime('now'))`).run(randomUUID(), ASKER, turn, messageId, outcome); };
/** An ASSIGN from the asker to the helper, with the delivery row the send door writes for that turn. */
const assignSent = async (threadId: string, turn = TURN, payload = 'the figure, please'): Promise<void> => {
  const sent = await deliverA2AMessage({ intent: 'ASSIGN', threadId, requiresResponse: true, payload, toAgent: HELPER, fromAgent: ASKER });
  delivery(turn, 'delivered', sent.messageId ?? null);
};
const step = (ask: string, tool: string, turn = TURN) => runDelegationTurnEnd(initState({ agentId: ASKER, turnNumber: turn } as never), {
  agentId: ASKER, turnNumber: turn, db: testDb(), counterparty: { kind: 'user' },
  result: { toolCalls: [{ id: randomUUID(), name: tool, arguments: { intent: 'ASSIGN' } }] },
  triggerRow: { rowid: 1 }, triggerWorkId: ask, triggerConversationId: null, persistedContent: 'On it.', deferredDeliveredByAck: false,
} as never);
const pieces = (ask: string): string[] =>
  (testDb().prepare('SELECT id FROM work WHERE parent_id = ? ORDER BY id').all(ask) as Array<{ id: string }>).map((r) => r.id);

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a turn ends as delegated only on a delegating send that went out', () => {
  it('a send_to_agent call that was refused does not end the turn and opens no piece', () => {
    const ask = ownerAsk();
    delivery(TURN, 'suppressed', null);
    expect(step(ask, 'send_to_agent').directive).toBe('proceed');
    expect(pieces(ask)).toEqual([]);
  });
  it("a spawn's job that went out ends the turn as delegated and opens its piece", async () => {
    const ask = ownerAsk();
    await assignSent('thread-job');
    expect(step(ask, 'spawn_agent').directive).toBe('exit');
    expect(pieces(ask)).toEqual([`piece:${ask}:thread-job`]);
  });
  it('a follow-up on a thread whose piece belongs to an earlier request opens no second piece and does not end the turn', async () => {
    const first = ownerAsk();
    await assignSent('thread-job');
    step(first, 'send_to_agent');
    // Twenty minutes later, past the re-ask cooldown, a second request sends more on the same thread.
    testDb().prepare("UPDATE a2a_threads SET updated_at = datetime('now', '-20 minutes') WHERE thread_id = 'thread-job'").run();
    const second = ownerAsk();
    await assignSent('thread-job', TURN + 1, 'also include the prices');
    expect(step(second, 'send_to_agent', TURN + 1).directive).toBe('proceed');   // nothing of the second request is out
    expect(pieces(second)).toEqual([]);
  });
  it('a delegating turn with no text is steered once for a status line, and a lookup after it does not end the turn', async () => {
    const ask = ownerAsk();
    await assignSent('thread-job');
    const ctx = (tool: string) => ({
      agentId: ASKER, turnNumber: TURN, db: testDb(), counterparty: { kind: 'user' }, turnCtx: { address: null },
      result: { toolCalls: [{ id: randomUUID(), name: tool, arguments: {} }] },
      triggerRow: { rowid: 1 }, triggerWorkId: ask, triggerConversationId: null, persistedContent: '', deferredDeliveredByAck: false,
    } as never);
    const first = runDelegationTurnEnd(initState({ agentId: ASKER, turnNumber: TURN } as never), ctx('send_to_agent'));
    expect(first.directive).toBe('continue');
    expect(runDelegationTurnEnd(first.state, ctx('list_techniques')).directive).toBe('proceed');
    expect(pieces(ask)).toEqual([`piece:${ask}:thread-job`]);
  });
  it('a second send in the same turn keeps the first piece in the countdown', async () => {
    const ask = ownerAsk();
    await assignSent('thread-one');
    step(ask, 'send_to_agent');
    await assignSent('thread-two');
    step(ask, 'send_to_agent');
    expect(testDb().prepare('SELECT remaining_children AS n FROM work WHERE id = ?').get(ask)).toEqual({ n: 2 });
  });
});
