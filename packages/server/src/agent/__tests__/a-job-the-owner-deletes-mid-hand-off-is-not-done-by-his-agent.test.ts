// The owner deletes the helper's task a moment after his agent handed the job off, while both turns run: the helper's
// turn stops, the request ends as his, the agent's turn on it stops, its "she's on it" line is not pushed into doing
// the job itself, and nothing reaches the owner.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));
vi.mock('../../services/presence.js', () => ({ getPresence: () => 'away' }));

import { getAgentRuntime } from '../runtime.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';
import { endTurn, modelSays, steered } from '../v2/steps/post-call-classify/__tests__/post-call-kit.js';
import { AGENT, testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';
import { delegatedTextRequest, helperTask, relayRows, requestState, textsSent, CONV, THREAD, HELPER } from './helpers/text-relay.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const settled = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await vi.dynamicImportSettled(); await new Promise((r) => setImmediate(r)); } };
const serving = { root: { kind: 'ask', id: 'm-ask', sourceMessageId: 'm-ask', conversationId: CONV } };

beforeEach(() => {
  for (const id of [AGENT, HELPER]) endTurnContext(id);
  activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear();
  delegatedTextRequest({ relation: 'owner' });
  helperTask();
});

describe('a job the owner deletes mid hand-off is not done by his agent', () => {
  it('both turns stop, the request is his to end, the promise is not pushed, and nothing reaches him', async () => {
    Object.assign(openTurnContext(AGENT), { turnNumber: 1, ...serving });
    activeRuns.add(AGENT);
    Object.assign(openTurnContext(HELPER), { turnNumber: 1, root: { kind: 'a2a', id: THREAD, sourceMessageId: null } });
    activeRuns.add(HELPER);
    expect((await trackerRouter.request('/tasks/task-helper-1', { method: 'DELETE' })).status).toBe(200);
    await settled();
    expect(requestState()).toBe('abandoned');
    expect([isStopFenced(HELPER), isStopFenced(AGENT)]).toEqual([true, true]);
    testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'the agent', 'idle', 'sensei')").run(FXID.n4);   // the kit's turn
    modelSays({ only_promises_to_start: true });
    expect(steered(await endTurn("Helper's on it, I'll bring you the five tips.", [], undefined, serving))).not.toContain('promise-floor');
    expect([relayRows(), textsSent()]).toEqual([[], []]);
  });
});
