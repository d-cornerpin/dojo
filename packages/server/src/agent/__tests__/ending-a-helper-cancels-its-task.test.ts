// The main agent ending its helper (round three, S08 step 6) calls off the helper's piece as a plain end: the helper's
// job is cancelled with it, so no stall hint chases it, and the request is answered without it as before.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { runLadder, LADDER_ENTRY } from '../../work/done/ladder.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { call, delegated, endedBy, pieceOf, settled, AGENT, HELPER } from './helpers/call-off-world.js';

describe('ending a helper cancels its task', () => {
  it('kill_agent on the helper: its piece and its job end as a plain end, the ladder stays quiet', async () => {
    delegated();
    const r = await call(AGENT, 'kill_agent', { agent_id: HELPER });
    expect(r.isError, String(r.content)).toBeFalsy();
    await settled();
    expect([endedBy(pieceOf()), endedBy('task-helper-1')]).toEqual([{ state: 'abandoned', by: 'agent' }, { state: 'abandoned', by: 'agent' }]);
    await runLadder(Date.now() + 3_600_000);
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM work_events WHERE json_extract(payload, '$.entry_kind') = ?").get(LADDER_ENTRY.hint)).toEqual({ n: 0 });
  });
});
