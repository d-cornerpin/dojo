// However many helpers answer, the agent is woken once, by its request: each reply the join owns carries no wake
// of its own, and the request goes back to the person's queue once, when the last piece is in.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handleMessage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverA2AMessage } from '../a2a-transport.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, requestState, ASK, HELPER } from './helpers/text-relay.js';

const THREADS = ['thread-n-1', 'thread-n-2', 'thread-n-3'];
const putBacks = (): number => (testDb().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' AND json_extract(payload, '$.kind') IS NOT NULL",
).get(ASK) as { n: number }).n;

beforeEach(() => { handleMessage.mockClear(); delegatedTextRequest({}, THREADS); });

describe('n pieces wake the agent once', () => {
  it('three answers wake nobody; the request is put back once, due now', async () => {
    for (const [i, threadId] of THREADS.entries()) {
      const r = await deliverA2AMessage({
        intent: 'COMPLETE', threadId, requiresResponse: true, payload: `part ${i + 1} done`, toAgent: AGENT, fromAgent: HELPER,
      } as never);
      expect(r.delivered).toBe(true);
      expect(putBacks()).toBe(i === THREADS.length - 1 ? 1 : 0);
    }
    expect(handleMessage).not.toHaveBeenCalled();
    expect(testDb().prepare('SELECT SUM(a2a_requires_response) AS w FROM messages WHERE agent_id = ? AND a2a_thread_id IS NOT NULL').get(AGENT)).toEqual({ w: 0 });
    const due = (testDb().prepare('SELECT next_attempt_at AS d FROM work WHERE id = ?').get(ASK) as { d: number | null }).d;
    expect([requestState(), due !== null]).toEqual(['open', true]);
  });
});
