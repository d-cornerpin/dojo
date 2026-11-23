// A helper's message back to the agent that gave it the job (a BLOCK on the job's thread, a QUESTION on a new one) is the
// job talking back, not a hand-on: it opens no piece under the helper's job, so the job's end never stops its maker.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
import { activeRuns, isStopFenced } from '../shared-state.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { settled } from './helpers/call-off-world.js';
import { AGENT, CORA, agentTurnOnItsRequest, assign, jobOf, ownerAsks, piecesUnder, respond, turnEnds, world } from './helpers/hand-on-world.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

beforeEach(async () => {
  world();
  ownerAsks('Get a helper to plan a lake picnic menu.');
  await respond(AGENT, [assign(CORA, 'Plan a lake picnic menu.')], { reply: 'Cora is on it.' });
  turnEnds(AGENT);
});

describe("a helper's message back to its maker opens no piece", () => {
  it('a BLOCK on the job thread and a QUESTION on a new thread: no piece, and the job ending leaves the maker\'s turn running', async () => {
    const thread = agentTurnOnItsRequest(CORA);
    const out = await respond(CORA, [
      ['send_to_agent', { agent: AGENT, intent: 'BLOCK', thread_id: thread, payload: 'Which lake? I need it to plan the menu.' }],
      ['send_to_agent', { agent: AGENT, intent: 'QUESTION', payload: 'Any allergies I should know about?' }],
    ]);
    expect(out).toMatchObject({ directive: 'exit', reason: 'a2a-reply-sent' });
    turnEnds(CORA);
    expect(piecesUnder(jobOf(CORA).id)).toEqual([]);
    liveTurn(AGENT, { turnNumber: 2, kind: 'a2a', root: { kind: 'a2a', id: thread, sourceMessageId: null } });   // the main agent reads the BLOCK
    activeRuns.add(AGENT);
    expect((await trackerRouter.request(`/tasks/${jobOf(CORA).id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'owner_done', reason: 'Good enough' }) })).status).toBe(200);
    await settled();
    expect(isStopFenced(AGENT)).toBe(false);
  });
});
