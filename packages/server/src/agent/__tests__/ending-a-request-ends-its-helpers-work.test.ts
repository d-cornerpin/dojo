// A request that ends ends its helpers' work with it: called off ("never mind" in the person's words, or Stop),
// its pieces are abandoned, a helper's turn on that work is stopped, the owner's Stop cancels the helper's task in
// his name, no note wakes a helper, and a later answer relays nothing; failed for want of an answer, its pieces end,
// nobody is touched, and a late answer still goes back to the agent for the person.
// Stop with nothing running ends a request waiting on a helper even when a later turn served something else; Stop
// while a turn runs ends only that turn's request.
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { sweepExpiredJoins } from '../a2a-transport.js';
import { trackerHandlers } from '../tools/cat/tracker.js';
import { insertMessage } from '../../memory/message-store.js';
import { newestPutBack } from '../../work/ask-settlement.js';
import { claimAsk } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';
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
const helperMidTurn = (): void => { Object.assign(openTurnContext(HELPER), { turnNumber: 1, root: { kind: 'a2a', id: THREAD, sourceMessageId: null } }); activeRuns.add(HELPER); };
const settled = async (): Promise<void> => { await vi.dynamicImportSettled(); await vi.dynamicImportSettled(); };

describe("ending a request ends its helpers' work", () => {
  it('never mind in the person\'s words: the piece ends, the helper mid-turn on it is stopped, and its answer relays nothing', async () => {
    helperMidTurn();
    insertMessage({ id: 'm-2', agentId: AGENT, role: 'user', content: 'Never mind, we booked it already.', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    const r = await trackerHandlers['work_close_request:commitment']({
      agentId: AGENT, args: { id: ASK, disposition: 'dropped', note: 'Never mind, we booked it already.' }, toolCallId: 'tc-1', turnNumber: 2,
    } as never) as { content: string; isError?: boolean };
    expect(r.isError, r.content).toBeFalsy();
    expect([requestState(), pieceState()]).toEqual(['abandoned', 'abandoned']);
    await settled();
    expect(isStopFenced(HELPER)).toBe(true);
    expect([cancelledByOwner(), helperPrompts()]).toEqual([false, 0]);   // a contact's words are not the owner's cancel
    await helperAnswers('The venue is free on the 14th.');
    expect(relayRows()).toEqual([]);
  });

  it('Stop while the helper works on it: the owner\'s Stop cancels its task and stops its turn, and nothing wakes it', async () => {
    helperMidTurn();
    testDb().prepare("INSERT INTO turns (agent_id, turn_number, root_kind, root_id, answered, effectful_calls) VALUES (?, 1, 'ask', 'm-ask', 0, 0)").run(AGENT);
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    expect(pieceState()).toBe('abandoned');
    await settled();
    expect([helperTaskState(), cancelledByOwner(), isStopFenced(HELPER), helperPrompts()]).toEqual(['abandoned', true, true, 0]);
  });

  // The delegating turn, then a later turn on a quick question that is over; nothing is running when Stop comes.
  const laterTurnOnSomethingElse = (): void => {
    insertMessage({ id: 'm-quick', agentId: AGENT, role: 'user', content: 'What time is it in Tokyo?', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    expect(testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'ask:m-quick'").run(Date.now()).changes).toBe(1);
    testDb().prepare(`INSERT INTO turns (agent_id, turn_number, root_kind, root_id, answered, effectful_calls)
      VALUES (?, 1, 'ask', 'm-ask', 0, 0), (?, 2, 'ask', 'm-quick', 1, 0)`).run(AGENT, AGENT);
  };
  const helperToldOwnerEnded = async (): Promise<void> => {
    expect([requestState(), pieceState()]).toEqual(['abandoned', 'abandoned']);
    await settled();
    expect([helperTaskState(), cancelledByOwner(), isStopFenced(HELPER), helperPrompts()]).toEqual(['abandoned', true, false, 0]);
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

  it('Stop while a turn runs on a quick question leaves the request waiting on a helper alone', async () => {
    const before = [requestState(), pieceState()];
    insertMessage({ id: 'm-quick', agentId: AGENT, role: 'user', content: 'What time is it in Tokyo?', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    claimAsk('ask:m-quick', AGENT);
    Object.assign(openTurnContext(AGENT), { turnNumber: 2, root: { kind: 'ask', id: 'm-quick' } });
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
    endTurnContext(AGENT);
    expect([requestState(), pieceState()]).toEqual(before);
    await settled();
    expect(helperTaskState()).toBe('claimed');
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
