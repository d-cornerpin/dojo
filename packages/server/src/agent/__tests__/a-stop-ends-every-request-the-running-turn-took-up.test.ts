// Stop while a turn runs ends every request that turn took up: the poem it was started on and the older bicycle
// request it revived, held on its picture since. The request waiting on a helper is left alone, the message queued behind the turn is answered
// next, and each ended request's row says so in every later view.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner, getAgentRuntime } from '../runtime.js';
import { executeTool } from '../tools/index.js';
import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, stampClaimingTurn, transition } from '../../work/store.js';
import { endTurnContext } from '../turn-context.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { activeRuns, stoppedAgents, stopFencedRuns } from '../shared-state.js';
import { assembleContext } from '../../memory/assembler.js';
import { delegatedTextRequest, helperTask, requestState, HELPER, CONV, ASK } from './helpers/text-relay.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
beforeEach(() => {
  endTurnContext(HELPER); activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear();
  delegatedTextRequest();
  helperTask();
});
const stateOf = (id: string): string => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

describe('a stop ends every request the running turn took up', () => {
  it('the poem and the revived bicycle request end; the helper\'s request stays; the queued message is answered next', async () => {
    const pieceBefore = (testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state;
    for (const [id, content] of [['m-bike', 'Make me a picture of a red bicycle'], ['m-quick', 'Write me a poem about autumn']]) {
      insertMessage({ id, agentId: AGENT, role: 'user', content, channel: 'imessage', senderId: PERSON, conversationId: CONV });
      claimAsk(`ask:${id}`, AGENT);
    }
    insertMessage({ id: 'm-next', agentId: AGENT, role: 'user', content: 'What time is it in Tokyo?', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    liveTurn(AGENT, { turnNumber: 2, root: { kind: 'ask', id: 'm-quick', sourceMessageId: 'm-quick' } });
    stampClaimingTurn('ask:m-bike', 2);   // the turn revived the older bicycle request, and started its picture
    transition('ask:m-bike', { to: 'blocked', by: 'agent', actorId: AGENT, expectedState: 'claimed', reason: 'held: its picture is still being made' });
    await executeTool(AGENT, { id: 'tc-own', name: 'work_open', arguments: { kind: 'task', title: 'Autumn poem', goal: 'The person has the poem' } });
    expect(stopByOwner(AGENT)).toMatchObject({ ended: 2 });
    expect([stateOf('ask:m-bike'), stateOf('ask:m-quick'), requestState()]).toEqual(['abandoned', 'abandoned', 'blocked']);
    expect((testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state).toBe(pieceBefore);
    expect(stateOf('ask:m-next'), 'the queued message is answered next').toBe('open');
    testDb().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
    testDb().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
    await assembleContext(AGENT, 'm');   // the stopped turn was still before its first call: its own late assembly
    endTurnContext(AGENT);
    await vi.dynamicImportSettled(); await vi.dynamicImportSettled();
    expect(testDb().prepare("SELECT state, hold_kind AS hold FROM work WHERE kind = 'task' AND source_message_id = 'm-quick'").get(), 'its own task is cancelled, not paused')
      .toEqual({ state: 'abandoned', hold: null });
    for (let call = 0; call < 2; call++) {   // every call of the next turn sees it
      const text = JSON.stringify((await assembleContext(AGENT, 'm')).messages);
      expect(text).toMatch(/ended: do not do this\][^[]*Write me a poem about autumn/);
      expect(text).not.toMatch(/ended: do not do this\][^[]*What time is it in Tokyo/);
    }
  });

  it('pressed just after that turn ended, Stop ends the same requests, and with nothing running the waiting one too', async () => {
    for (const [id, content] of [['m-bike', 'Make me a picture of a red bicycle'], ['m-quick', 'Write me a poem about autumn']]) {
      insertMessage({ id, agentId: AGENT, role: 'user', content, channel: 'imessage', senderId: PERSON, conversationId: CONV });
      claimAsk(`ask:${id}`, AGENT);
    }
    liveTurn(AGENT, { turnNumber: 2, root: { kind: 'ask', id: 'm-quick', sourceMessageId: 'm-quick' } });
    stampClaimingTurn('ask:m-bike', 2);
    transition('ask:m-bike', { to: 'blocked', by: 'agent', actorId: AGENT, expectedState: 'claimed', reason: 'held: its picture is still being made' });
    endTurnContext(AGENT);
    testDb().prepare("UPDATE turns SET ended_at = datetime('now'), exit_reason = 'answered' WHERE agent_id = ? AND turn_number = 2").run(AGENT);
    stopByOwner(AGENT);
    expect([stateOf('ask:m-bike'), stateOf('ask:m-quick'), requestState()]).toEqual(['abandoned', 'abandoned', 'abandoned']);
  });
});
