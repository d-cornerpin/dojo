// A helper ended by the owner calls off every piece it was given as his: on the dashboard (round two, S08), by his
// texted kill, or by the main agent on his quoted words. Its jobs end with them, the request it was the only part of
// ends as his, and nobody is told "no answer". The main agent's kill without his words stays a plain end.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { agentsRouter } from '../../gateway/routes/agents.js';
import { failedNotices } from './helpers/text-relay.js';
import { handleConfirmedOwnerEmailWords } from '../../services/imessage-commands.js';
import { call, delegated, endedBy, expectEndedAsHis, ownerTurn, pieceOf, settled, ASK, AGENT, HELPER } from './helpers/call-off-world.js';

describe("removing a helper calls off its pieces as the owner's", () => {
  it('his removal: the piece, its job and the request end as his, with no notice', async () => {
    delegated();
    expect((await agentsRouter.request(`/${HELPER}`, { method: 'DELETE' })).status).toBe(200);
    await settled();
    expectEndedAsHis(pieceOf(), 'task-helper-1', ASK);
    expect(failedNotices()).toBe(0);
  });

  it('his texted kill: the same as his removal', async () => {
    delegated();
    expect(await handleConfirmedOwnerEmailWords('kill helper')).toContain('Terminated agent');
    await settled();
    expectEndedAsHis(pieceOf(), 'task-helper-1', ASK);
    expect(failedNotices()).toBe(0);
  });

  it('the main agent ends it on his words: his end; with no words of his, a plain end', async () => {
    delegated();
    ownerTurn('m-kill', 'Kill the helper, we do not need it.');
    const r = await call(AGENT, 'kill_agent', { agent_id: HELPER, user_quote: 'Kill the helper, we do not need it.' });
    expect(r.isError, String(r.content)).toBeFalsy();
    await settled();
    expectEndedAsHis(pieceOf(), 'task-helper-1', ASK);
    expect(failedNotices()).toBe(0);
    delegated();
    ownerTurn('m-other', 'What is on my calendar?');
    await call(AGENT, 'kill_agent', { agent_id: HELPER, user_quote: 'Kill the helper, we do not need it.' });
    await settled();
    expect(endedBy(pieceOf())).toEqual({ state: 'abandoned', by: 'agent' });
  });

  it('the main agent ends it with no words (round three, S08 step 6): piece and job end in the termination itself, a plain end', async () => {
    delegated();
    const r = await call(AGENT, 'kill_agent', { agent_id: HELPER });
    expect(r.isError, String(r.content)).toBeFalsy();
    expect([endedBy(pieceOf()), endedBy('task-helper-1')]).toEqual([{ state: 'abandoned', by: 'agent' }, { state: 'abandoned', by: 'agent' }]);
    await settled();
  });
});
