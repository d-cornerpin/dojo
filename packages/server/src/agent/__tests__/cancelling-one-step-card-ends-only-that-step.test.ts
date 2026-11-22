// A request worked in step cards: the owner cancelling one card ends that step only. The request, its helper and the
// other steps go on; when his agent relays the cancel, the result names the one door that ends all of it.
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
import { boardCancel, call, delegated, endedBy, expectEndedAsHis, ownerTurn, pieceOf, settled, stateOf, task, ASK, AGENT } from './helpers/call-off-world.js';

describe('cancelling one step card ends only that step', () => {
  it('his tap on the board ends the first of three steps; the request, the helper and the other two go on', async () => {
    delegated();
    const [one, two, three] = [task('card-1'), task('card-2'), task('card-3')];
    expect(await boardCancel(one)).toBe(200);
    await settled();
    expectEndedAsHis(one);
    expect([stateOf(ASK), stateOf(pieceOf()), stateOf('task-helper-1'), stateOf(two), stateOf(three)]).toEqual(['blocked', 'open', 'claimed', 'claimed', 'claimed']);
  });

  it('his agent relays the cancel of one step: the result says the request goes on and how to end all of it', async () => {
    delegated();
    task('card-1'); task('card-2');
    ownerTurn('m-2', 'Skip the first step.');
    const r = await call(AGENT, 'work_validate', { action: 'decide', task_id: 'card-1', verdict: 'cancel', reason: 'He skipped it', user_quote: 'Skip the first step.' });
    expect(String(r.content)).toContain(`work_close_request(id="${ASK}", disposition="dropped"`);
    expect([endedBy('card-1'), stateOf(ASK)]).toEqual([{ state: 'abandoned', by: 'owner' }, 'blocked']);
    expect(testDb().prepare("SELECT state FROM work WHERE id = 'card-2'").get()).toEqual({ state: 'claimed' });
  });
});
