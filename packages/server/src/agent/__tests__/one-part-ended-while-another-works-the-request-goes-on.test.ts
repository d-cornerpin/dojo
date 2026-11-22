// When the owner ends one part of a request (cancels a helper's job, removes the helper) while another part still works
// (his agent's own card, a picture), the request is never failed and nobody is told "no answer": it goes back to his
// agent with the rest. His end of the last working part ends it quietly as his.
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
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { failedNotices } from './helpers/text-relay.js';
import { boardCancel, delegated, endedBy, expectEndedAsHis, settled, stateOf, task, ASK, HELPER } from './helpers/call-off-world.js';

/** The request back with its agent, nobody told, the card still worked. */
const goesOn = async (...cards: string[]): Promise<void> => {
  await settled();
  expect([stateOf(ASK), failedNotices(), ...cards.map(stateOf)]).toEqual(['open', 0, ...cards.map(() => 'claimed')]);
};

describe('one part ended while another works: the request goes on', () => {
  it('his agent holds its own card and the owner removes the helper (P2b); then he cancels the card: ended quietly as his', async () => {
    delegated();
    task('card-own');
    expect((await agentsRouter.request(`/${HELPER}`, { method: 'DELETE' })).status).toBe(200);
    await goesOn('card-own');
    expect(await boardCancel('card-own')).toBe(200);
    await settled();
    expect([endedBy(ASK), failedNotices()]).toEqual([{ state: 'abandoned', by: 'owner' }, 0]);
  });

  it("two step cards, and the owner cancels the helper's own job card (P1b)", async () => {
    delegated();
    task('card-1'); task('card-2');
    expect(await boardCancel('task-helper-1')).toBe(200);
    await goesOn('card-1', 'card-2');
  });

  it('two step cards, and the owner cancels the one fix A moved to the helper (P1)', async () => {
    delegated();
    testDb().prepare("UPDATE work SET requester_id = 'agent-main', source_message_id = 'm-ask' WHERE id = 'task-helper-1'").run();
    task('card-2');
    expect(await boardCancel('task-helper-1')).toBe(200);
    expectEndedAsHis('task-helper-1');
    await goesOn('card-2');
  });
});
