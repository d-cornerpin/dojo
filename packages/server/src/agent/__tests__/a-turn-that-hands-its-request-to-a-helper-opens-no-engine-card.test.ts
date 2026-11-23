// A turn that hands its request to a helper opens no engine "Multi-step task" card, even when the hand-over comes in the
// same response as five work calls (C7). The floor still opens one for a request the agent works itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
import { AGENT, CORA, assign, engineCards, ownerAsks, respond, world } from './helpers/hand-on-world.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const reads = (n: number): Array<[string, Record<string, unknown>]> => Array.from({ length: n }, (_, i) => ['file_read', { path: `/tmp/dojo-no-such-list-${i}.md` }]);

beforeEach(() => world());

describe('a turn that hands its request to a helper opens no engine card', () => {
  it('C7: five work calls and the hand-over in one response: the turn ends delegated, with no card', async () => {
    ownerAsks('End that helper yourself and give the job to another helper.');
    const out = await respond(AGENT, [...reads(5), assign(CORA, 'Write the sandcastle tips.')], { reply: 'A new helper is on it.' });
    expect(out).toMatchObject({ directive: 'exit', reason: 'delegation-send-async-exit' });
    expect(engineCards()).toBe(0);
  });

  it('a request the agent works itself: six work calls open the card', async () => {
    ownerAsks('Sort my downloads folder.');
    await respond(AGENT, reads(6));
    expect(engineCards()).toBe(1);
  });
});
