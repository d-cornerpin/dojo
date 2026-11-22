// Ending a request ends every job under it, at any depth. Called off ("never mind" in the person's words) or by Stop (while
// a turn runs, with nothing running, texted, or on a middle helper), its pieces end, a helper's turn on that work stops, its
// task is cancelled (in the owner's name only for his Stop) so the ladder never chases it, and a later answer relays
// nothing. A helper's hand-off opens its piece under its task, so the second helper stops too; while the work is live, the
// second helper's answer wakes the first and tells no person. Failed for want of an answer, its pieces end, nobody is
// touched, and a late answer still goes back to the agent.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fenceExternal } from '@dojo/shared';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner, getAgentRuntime } from '../runtime.js';
import { pressStop } from '../v2/__tests__/helpers/owner-stop.js';
import { handleIMCommand } from '../../services/imessage-commands.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { sweepExpiredJoins, deliverA2AMessage } from '../a2a-transport.js';
import { executeTool, toolResultOf } from '../tools/index.js';
import { nextOwed } from '../v2/owed.js';
import { initState } from '../v2/state.js';
import { runDelegationTurnEnd } from '../v2/steps/execute/delegation-exit.js';
import { trackerHandlers } from '../tools/cat/tracker.js';
import { insertMessage } from '../../memory/message-store.js';
import { newestPutBack } from '../../work/ask-settlement.js';
import { endTurnContext, turnContext } from '../turn-context.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';
import { runLadder, LADDER_ENTRY } from '../../work/done/ladder.js';
import { delegatedTextRequest, failedNotices, helperAnswers, helperTask, relayRows, requestState, textsSent, HELPER, CONV, ASK, THREAD } from './helpers/text-relay.js';
import { delegated, expectEndedAsHis, handedOn, lateReply, pieceOf, settled, stateOf, stopped } from './helpers/call-off-world.js';

const SECOND = 'agent-helper-two';
const THREAD2 = 'thread-second-0002';
const wake = vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
beforeEach(() => {
  for (const id of [HELPER, SECOND]) endTurnContext(id);
  activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear(); wake.mockClear();
  delegatedTextRequest();
  testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Second', 'idle', 'standard')").run(SECOND);
  helperTask();
});

const pieceState = (): string => (testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state;
const helperTaskState = (): string => (testDb().prepare("SELECT state FROM work WHERE id = 'task-helper-1'").get() as { state: string }).state;
const helperPrompts = (): number => (testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND lane = 'events'").get(HELPER) as { n: number }).n;
const cancelledByOwner = (): boolean => !!testDb().prepare(
  "SELECT 1 FROM work_events WHERE work_id = 'task-helper-1' AND kind = 'decided' AND actor = 'user' AND json_extract(payload, '$.verdict') = 'cancel'").get();
/** The helper is in a turn on the request's thread. */
const helperMidTurn = (): void => { liveTurn(HELPER, { turnNumber: 1, root: { kind: 'a2a', id: THREAD, sourceMessageId: null } }); activeRuns.add(HELPER); };

describe("ending a request ends its helpers' work", () => {
  it('never mind in the person\'s words: the piece ends, the helper mid-turn on it is stopped, the ladder leaves its task, and its answer relays nothing', async () => {
    helperMidTurn();
    insertMessage({ id: 'm-2', agentId: AGENT, role: 'user', content: fenceExternal('text message', PERSON, 'Never mind, we booked it already.', { addressedToAgent: true }), channel: 'imessage', senderId: PERSON, conversationId: CONV,
      inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON, relation: 'known_contact' }) });
    const r = await trackerHandlers['work_close_request:commitment']({
      agentId: AGENT, args: { id: ASK, disposition: 'dropped', note: 'Never mind, we booked it already.' }, toolCallId: 'tc-1', turnNumber: 2,
    } as never) as { content: string; isError?: boolean };
    expect(r.isError, r.content).toBeFalsy();
    expect([requestState(), pieceState()]).toEqual(['abandoned', 'abandoned']);
    await settled();
    expect(isStopFenced(HELPER)).toBe(true);
    expect([helperTaskState(), cancelledByOwner(), helperPrompts()]).toEqual(['abandoned', false, 0]);   // a contact's words are not the owner's cancel
    endTurnContext(HELPER); activeRuns.delete(HELPER);
    await runLadder(Date.now() + 3_600_000);
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'task-helper-1' AND json_extract(payload, '$.entry_kind') = ?").get(LADDER_ENTRY.hint)).toEqual({ n: 0 });
    expect(await deliverA2AMessage({ intent: 'ANSWER', threadId: THREAD, requiresResponse: false, payload: 'Free on the 14th.', toAgent: AGENT, fromAgent: HELPER } as never))
      .toMatchObject({ delivered: false, reason: 'REQUEST_ENDED' });
    expect(relayRows()).toEqual([]);
  });

  it('Stop while the helper answers a question it holds no task for: its turn on that piece is stopped', async () => {
    testDb().prepare("DELETE FROM work WHERE id = 'task-helper-1'").run();
    helperMidTurn();
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    await settled();
    expect([pieceState(), isStopFenced(HELPER)]).toEqual(['abandoned', true]);
  });

  it('Stop while the helper works on it: the owner\'s Stop cancels its task and stops its turn, and nothing wakes it', async () => {
    helperMidTurn();
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    expect(pieceState()).toBe('abandoned');
    await settled();
    expect([helperTaskState(), cancelledByOwner(), isStopFenced(HELPER), helperPrompts()]).toEqual(['abandoned', true, true, 0]);
    // The send its turn had already made arrives: refused at the door, so the agent never sees it.
    const sent = toolResultOf(await executeTool(HELPER, { id: 'tc-h', name: 'send_to_agent', arguments: { agent: AGENT, intent: 'COMPLETE', thread_id: THREAD, payload: 'The venue is free on the 14th.' } }));
    expect(sent.content).toContain('the request this answered was called off, so nothing was passed on');
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND a2a_intent = 'COMPLETE'").get(AGENT)).toEqual({ n: 0 });
  });

  // The delegating turn, then a later turn on a quick question that is over; nothing is running when Stop comes.
  const laterTurnOnSomethingElse = (): void => {
    insertMessage({ id: 'm-quick', agentId: AGENT, role: 'user', content: 'What time is it in Tokyo?', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    expect(testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'ask:m-quick'").run(Date.now()).changes).toBe(1);
    testDb().prepare(`INSERT INTO turns (agent_id, turn_number, root_kind, root_id, answered, effectful_calls)
      VALUES (?, 2, 'ask', 'm-quick', 1, 0)`).run(AGENT);
  };
  const helperToldOwnerEnded = async (): Promise<void> => {
    expect([requestState(), pieceState()]).toEqual(['abandoned', 'abandoned']);
    await settled();
    expect([helperTaskState(), cancelledByOwner(), isStopFenced(HELPER), helperPrompts()]).toEqual(['abandoned', true, false, 0]);
    expect(nextOwed(HELPER)).toEqual([]);   // its request is no longer served to it
  };

  it('the Stop button with nothing running ends a request waiting on a helper behind a later turn', async () => {
    laterTurnOnSomethingElse();
    const { status, body } = await pressStop();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ ended: 1 });
    await helperToldOwnerEnded();
  });

  it('a texted stop with nothing running ends it the same way', async () => {
    laterTurnOnSomethingElse();
    testDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?), ('primary_agent_id', ?)")
      .run(JSON.stringify([{ address: PERSON, name: 'Owner', is_primary: true, sharing_level: 'full' }]), AGENT);
    clearPlatformConfigCache();
    expect(await handleIMCommand('stop', PERSON)).toBe('Dojo: Stopped. 1 request ended.');
    await helperToldOwnerEnded();
  });

  it('a request whose helper\'s job ended unanswered fails, tells no helper, and a late answer goes back to the agent', async () => {
    testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'task-helper-1'").run(Date.now());   // the job ended unanswered
    vi.setSystemTime(Date.now() + 3_700_000);
    await sweepExpiredJoins();
    expect([requestState(), pieceState()]).toEqual(['failed', 'abandoned']);
    await settled();
    expect([cancelledByOwner(), helperPrompts()]).toEqual([false, 0]);
    await helperAnswers('The venue is free on the 14th.');
    expect([requestState(), pieceState()]).toEqual(['open', 'done']);
    expect(newestPutBack(ASK)?.kind).toBe('late');
  });
});

/** The second helper's task, which the transport opened on the ASSIGN. */
const secondTask = (): string => (testDb().prepare('SELECT id FROM work WHERE agent_id = ? AND a2a_thread_id = ?').get(SECOND, THREAD2) as { id: string }).id;

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

describe('ending a request ends every job under it, at any depth', () => {
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

  it('Stop on the helper while its turn runs: its job, the job it handed on and the request end as his', async () => {
    delegated();
    handedOn('task-helper-1', HELPER, 'agent-third', 'thread-3', 'task-third');
    stopByOwner(HELPER);
    await settled();
    expectEndedAsHis(pieceOf(), 'task-helper-1', pieceOf('thread-3'), 'task-third', ASK);
    expect([stopped('agent-third'), failedNotices()]).toEqual([true, 0]);
    expect(await lateReply('agent-third', 'thread-3', HELPER)).toBe(false);
  });
});
