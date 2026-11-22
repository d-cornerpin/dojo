// The owner's "never mind" on a job his agent opened a task for and handed to a helper ends all of it: the agent's
// relayed cancel of its own task on his words ends the request, the piece, the helper's task and turn, and nothing
// chases any of them later. A contact's dropped request ends the agent's own task for it the same way.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { executeTool, toolResultOf } from '../tools/index.js';
import { insertMessage } from '../../memory/message-store.js';
import { inboundIMessageText } from '../../tools/inbound-fences.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { claimAsk } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';
import { runLadder } from '../../work/done/ladder.js';
import { testDb, AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperTask, relayRows, CONV, ASK, THREAD, HELPER } from './helpers/text-relay.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const NEVER_MIND = 'Never mind, forget the camping list.';
const call = async (name: string, args: Record<string, unknown>) => toolResultOf(await executeTool(AGENT, { id: `tc-${name}`, name, arguments: args }));
const settled = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await vi.dynamicImportSettled(); await new Promise((r) => setImmediate(r)); } };
const endedBy = (id: string): unknown => testDb().prepare(`SELECT state, json_extract(e.payload, '$.by') AS by FROM work w JOIN work_events e ON e.work_id = w.id
  AND e.kind = 'transition' AND json_extract(e.payload, '$.to') = w.state WHERE w.id = ? ORDER BY e.id DESC LIMIT 1`).get(id);

/** The request came from `relation`; the agent opened its own task for it in turn 1, and the helper is mid-turn on it. */
async function delegatedWithItsOwnTask(relation: 'owner' | 'known_contact'): Promise<string> {
  delegatedTextRequest({ relation });
  testDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  clearPlatformConfigCache();
  Object.assign(openTurnContext(AGENT), { turnNumber: 1, root: { kind: 'ask', id: 'm-ask', sourceMessageId: 'm-ask', conversationId: CONV } });
  const opened = await call('work_open', { kind: 'task', title: 'Camping list for the trip', goal: 'The owner has a camping list for the trip' });
  endTurnContext(AGENT);
  const own = (testDb().prepare("SELECT id FROM work WHERE kind = 'task' AND agent_id = ? AND source_message_id = 'm-ask'").get(AGENT) as { id: string } | undefined)?.id;
  expect(own, String(opened.content)).toBeTruthy();
  helperTask();
  Object.assign(openTurnContext(HELPER), { turnNumber: 1, root: { kind: 'a2a', id: THREAD, sourceMessageId: null } });
  activeRuns.add(HELPER);
  const content = inboundIMessageText(relation === 'owner', PERSON, NEVER_MIND);   // as the bridge writes it
  insertMessage({ id: 'm-2', agentId: AGENT, role: 'user', content, channel: 'imessage', senderId: PERSON, conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON, relation }) });
  claimAsk('ask:m-2', AGENT);
  Object.assign(openTurnContext(AGENT), { turnNumber: 2, root: { kind: 'ask', id: 'm-2', sourceMessageId: 'm-2', conversationId: CONV } });
  return own!;
}

beforeEach(() => { for (const id of [AGENT, HELPER]) endTurnContext(id); activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear(); });

describe("the owner's never mind on a delegated job ends it", () => {
  it('the agent cancels its own task on his words: the request, piece, helper task and turn all end, and nothing chases them', async () => {
    const own = await delegatedWithItsOwnTask('owner');
    const r = await call('work_validate', { action: 'decide', task_id: own, verdict: 'cancel', reason: 'The owner called it off', user_quote: NEVER_MIND });
    expect(r.isError, String(r.content)).toBeFalsy();
    endTurnContext(AGENT);
    await settled();
    for (const id of [ASK, `piece:${ASK}:${THREAD}`, 'task-helper-1', own]) expect(endedBy(id), id).toEqual({ state: 'abandoned', by: 'owner' });
    expect(isStopFenced(HELPER)).toBe(true);
    endTurnContext(HELPER); activeRuns.delete(HELPER);
    expect(await deliverA2AMessage({ intent: 'COMPLETE', threadId: THREAD, requiresResponse: false, payload: 'Tent, stove, sleeping bags.', toAgent: AGENT, fromAgent: HELPER } as never))
      .toMatchObject({ delivered: false, reason: 'REQUEST_ENDED' });
    await runLadder(Date.now() + 600_000);
    await runLadder(Date.now() + 3_600_000);
    expect(testDb().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id IN (?, 'task-helper-1')
      AND (kind = 'validation_escalated' OR json_extract(payload, '$.entry_kind') IS NOT NULL)`).get(own)).toEqual({ n: 0 });
    expect(relayRows()).toEqual([]);
  });

  it("a contact's dropped request ends the agent's own task for it too", async () => {
    const own = await delegatedWithItsOwnTask('known_contact');
    const r = await call('work_close_request', { id: ASK, disposition: 'dropped', note: NEVER_MIND });
    expect(r.isError, String(r.content)).toBeFalsy();
    endTurnContext(AGENT);
    await settled();
    expect([endedBy(ASK), endedBy(own)]).toEqual([{ state: 'abandoned', by: 'agent' }, { state: 'abandoned', by: 'agent' }]);
  });
});
