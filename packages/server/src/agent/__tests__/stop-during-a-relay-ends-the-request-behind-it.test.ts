// Stop while the agent relays a helper's result (a thread-rooted turn) or drives a compile (an event-rooted turn)
// ends the person's request behind that turn, with its pieces.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { stopByOwner } from '../runtime.js';
import { openTurnContext, endTurnContext, type TurnRoot } from '../turn-context.js';
import { insertEngineEventIfAbsent } from '../../memory/message-store.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { delegatedTextRequest, requestState, THREAD, ASK } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

function stopDuring(root: TurnRoot): void {
  liveTurn(AGENT, { turnNumber: 2, root });
  expect(stopByOwner(AGENT)).toMatchObject({ ended: 1 });
  endTurnContext(AGENT);
}
const pieceState = (): string => (testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state;

describe('stop during a relay ends the request behind it', () => {
  it('a turn rooted in the helper\'s thread: the request and its piece end', () => {
    stopDuring({ kind: 'a2a', id: THREAD, sourceMessageId: null });
    expect([requestState(), pieceState()]).toEqual(['abandoned', 'abandoned']);
  });

  it('a turn rooted in a compile event for the request: the request ends', () => {
    const ev = insertEngineEventIfAbsent({ work: { taskId: ASK, runId: null, rootKind: 'ask', rootId: 'm-ask' }, id: 'ev-compile', agentId: AGENT,
      content: 'compile the answers', sourceAgentId: null, originIntent: 'fanout_join' });
    expect(ev).not.toBeNull();
    stopDuring({ kind: 'engine', id: 'ev-compile', sourceMessageId: null });
    expect(requestState()).toBe('abandoned');
  });
});
