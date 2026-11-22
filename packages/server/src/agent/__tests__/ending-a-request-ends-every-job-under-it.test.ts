// Ending a request ends every job under it, at any depth: the helper's own hand-off opens a piece under its task, so
// the owner's Stop ends the helper's task, the job it handed on and that second helper's turn. While the work is live
// the second helper's answer still wakes the first helper and tells no person anything.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner, getAgentRuntime } from '../runtime.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { nextOwed } from '../v2/owed.js';
import { initState } from '../v2/state.js';
import { runDelegationTurnEnd } from '../v2/steps/execute/delegation-exit.js';
import { endTurnContext, turnContext } from '../turn-context.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';
import { runLadder, LADDER_ENTRY } from '../../work/done/ladder.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperTask, relayRows, textsSent, HELPER, THREAD } from './helpers/text-relay.js';

const SECOND = 'agent-helper-two';
const THREAD2 = 'thread-second-0002';
const wake = vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
/** The second helper's task, which the transport opened on the ASSIGN. */
const secondTask = (): string => (testDb().prepare('SELECT id FROM work WHERE agent_id = ? AND a2a_thread_id = ?').get(SECOND, THREAD2) as { id: string }).id;
const stateOf = (id: string): string => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const settled = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await vi.dynamicImportSettled(); await new Promise((r) => setImmediate(r)); } };

/** The helper's turn on the request hands a job on to the second helper, through the real send and the real turn end. */
async function helperHandsOn(): Promise<void> {
  liveTurn(HELPER, { turnNumber: 1, kind: 'a2a', root: { kind: 'a2a', id: THREAD, sourceMessageId: null } });
  activeRuns.add(HELPER);
  const sent = await deliverA2AMessage({ intent: 'ASSIGN', threadId: THREAD2, requiresResponse: true, payload: 'Check the hall too', toAgent: SECOND, fromAgent: HELPER } as never);
  testDb().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at)
    VALUES ('d-hand-on', ?, 1, 'send_to_agent', 'a2a', ?, 'delivered', datetime('now'))`).run(HELPER, sent.messageId);
  const step = runDelegationTurnEnd(initState({ agentId: HELPER, turnNumber: 1 } as never), {
    agentId: HELPER, turnNumber: 1, db: testDb(), counterparty: { kind: 'agent' }, turnCtx: turnContext(HELPER),
    result: { toolCalls: [{ id: 'tc-1', name: 'send_to_agent', arguments: { intent: 'ASSIGN' } }] },
    triggerRow: null, triggerWorkId: null, triggerConversationId: null, persistedContent: null, deferredDeliveredByAck: false,
  } as never);
  expect(step.directive, 'the helper goes on with its own work').toBe('proceed');
  endTurnContext(HELPER); activeRuns.delete(HELPER);
  liveTurn(SECOND, { turnNumber: 1, kind: 'a2a', root: { kind: 'a2a', id: THREAD2, sourceMessageId: null } });
  activeRuns.add(SECOND);
}

beforeEach(() => {
  for (const id of [HELPER, SECOND]) endTurnContext(id);
  activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear(); wake.mockClear();
  delegatedTextRequest();
  testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Second', 'idle', 'standard')").run(SECOND);
  helperTask();
});

describe('ending a request ends every job under it', () => {
  it("the owner's Stop ends the helper's task, the job it handed on, and the second helper's turn", async () => {
    await helperHandsOn();
    expect(stateOf(`piece:task-helper-1:${THREAD2}`)).toBe('open');
    expect(stopByOwner('agent-main')).toMatchObject({ ended: 1 });
    await settled();
    expect([stateOf('task-helper-1'), stateOf(`piece:task-helper-1:${THREAD2}`), stateOf(secondTask())]).toEqual(['abandoned', 'abandoned', 'abandoned']);
    expect(isStopFenced(SECOND)).toBe(true);
    endTurnContext(SECOND); activeRuns.delete(SECOND);
    expect(nextOwed(SECOND)).toEqual([]);
    expect(await deliverA2AMessage({ intent: 'COMPLETE', threadId: THREAD2, requiresResponse: false, payload: 'The hall is free.', toAgent: HELPER, fromAgent: SECOND } as never))
      .toMatchObject({ delivered: false, reason: 'REQUEST_ENDED' });
    await runLadder(Date.now() + 3_600_000);
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') = ?").get(secondTask(), LADDER_ENTRY.hint)).toEqual({ n: 0 });
  });

  it('while the work is live the second helper\'s answer wakes the first helper and tells no person', async () => {
    await helperHandsOn();
    wake.mockClear();
    expect(await deliverA2AMessage({ intent: 'COMPLETE', threadId: THREAD2, requiresResponse: true, payload: 'The hall is free.', toAgent: HELPER, fromAgent: SECOND } as never))
      .toMatchObject({ delivered: true });
    await settled();
    expect(stateOf(`piece:task-helper-1:${THREAD2}`)).toBe('done');
    expect(wake.mock.calls.map((c) => c[0])).toContain(HELPER);
    expect([relayRows(), textsSent()]).toEqual([[], []]);
  });
});
