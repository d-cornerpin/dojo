// A helper's late result for a job that was called off (the owner's Stop, a contact's drop) is refused at the door by
// its piece's own record and reaches nobody; one the Dojo gave up for want of an answer is passed on once, late.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { stopByOwner } from '../runtime.js';
import { sweepExpiredJoins } from '../a2a-transport.js';
import { relayRows } from './helpers/text-relay.js';
import { call, delegated, lateReply, ownerTurn, settled, ASK, AGENT, HELPER } from './helpers/call-off-world.js';

describe('a late result of a called-off job reaches nobody', () => {
  it("after the owner's Stop with nothing running", async () => {
    delegated();
    stopByOwner(AGENT);
    await settled();
    expect([await lateReply(), relayRows()]).toEqual([false, []]);
  });

  it("after a contact's drop", async () => {
    delegated('known_contact');
    ownerTurn('m-2', 'Never mind.', 'known_contact');
    expect((await call(AGENT, 'work_close_request', { id: ASK, disposition: 'dropped', note: 'Never mind.' })).isError).toBeFalsy();
    await settled();
    expect(await lateReply()).toBe(false);
  });

  it('a piece the Dojo gave up keeps the late road: its answer reaches the agent', async () => {
    delegated();
    testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'task-helper-1'").run(Date.now());
    vi.setSystemTime(Date.now() + 5 * 3_600_000);
    await sweepExpiredJoins();
    expect(await lateReply(HELPER)).toBe(true);
  });
});
