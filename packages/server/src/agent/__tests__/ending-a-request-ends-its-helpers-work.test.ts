// A request that ends ends its helpers' work with it: called off ("never mind" in the person's words, or Stop),
// its pieces are abandoned, a helper's turn on that work is stopped, its task is cancelled (in the owner's name only
// for his Stop) so the stall ladder never chases it, no note wakes a helper, and a later answer relays nothing; failed
// for want of an answer, its pieces end,
// nobody is touched, and a late answer still goes back to the agent for the person.
// Stop with nothing running ends a request waiting on a helper even when a later turn served something else.
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
import { trackerHandlers } from '../tools/cat/tracker.js';
import { insertMessage } from '../../memory/message-store.js';
import { newestPutBack } from '../../work/ask-settlement.js';
import { endTurnContext } from '../turn-context.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';
import { runLadder, LADDER_ENTRY } from '../../work/done/ladder.js';
import { delegatedTextRequest, helperAnswers, helperTask, relayRows, requestState, HELPER, CONV, ASK, THREAD } from './helpers/text-relay.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
beforeEach(() => {
  endTurnContext(HELPER); activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear();
  delegatedTextRequest();
  helperTask();
});

const pieceState = (): string => (testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state;
const helperTaskState = (): string => (testDb().prepare("SELECT state FROM work WHERE id = 'task-helper-1'").get() as { state: string }).state;
const helperPrompts = (): number => (testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND lane = 'events'").get(HELPER) as { n: number }).n;
const cancelledByOwner = (): boolean => !!testDb().prepare(
  "SELECT 1 FROM work_events WHERE work_id = 'task-helper-1' AND kind = 'decided' AND actor = 'user' AND json_extract(payload, '$.verdict') = 'cancel'").get();
/** The helper is in a turn on the request's thread. */
const helperMidTurn = (): void => { liveTurn(HELPER, { turnNumber: 1, root: { kind: 'a2a', id: THREAD, sourceMessageId: null } }); activeRuns.add(HELPER); };
const settled = async (): Promise<void> => { await vi.dynamicImportSettled(); await vi.dynamicImportSettled(); };

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
