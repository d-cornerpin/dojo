// A fan-out where the owner called one helper's job off on the board and the other helper replied FAIL: the request's
// fail-closed reason counts the FAIL and never says a helper "never answered" for the piece the owner ended.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));
import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
import { deliverA2AMessage } from '../a2a-transport.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { boardCancel, delegated, settled, AGENT, ASK, HELPER, THREAD, T2 } from './helpers/call-off-world.js';

describe('a piece the owner called off is never told as unanswered', () => {
  it('one job called off on the board, the other helper replies FAIL: the reason names the FAIL only', async () => {
    delegated('owner', [THREAD, T2]);
    expect(await boardCancel('task-second-1')).toBe(200);
    await deliverA2AMessage({ intent: 'FAIL', threadId: THREAD, requiresResponse: false, payload: 'Could not reach the venue.', toAgent: AGENT, fromAgent: HELPER } as never);
    await settled();
    const reasons = (testDb().prepare("SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND kind = 'transition'").all(ASK) as Array<{ r: string }>)
      .map((x) => x.r).join(' | ');
    expect(reasons).toContain('1 replied FAIL');
    expect(reasons).not.toContain('never answered');
  });
});
