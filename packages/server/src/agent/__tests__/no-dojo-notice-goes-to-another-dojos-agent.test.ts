// A Dojo notice that carries no answer (here: the delegated question was never answered) is never sent to another
// Dojo's agent: it is recorded held, stays on the dashboard, and the agent is told it was not sent.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { imessage, testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, relayRows, served, ASK } from './helpers/text-relay.js';

const toldRows = () => testDb().prepare("SELECT content FROM messages WHERE origin_intent = 'fanout_join'").all() as Array<{ content: string }>;

/** The helper took the request and its turn ended with no answer; then the next look. */
async function deadlinePasses(): Promise<void> {
  served();
  testDb().prepare('UPDATE work SET ttl_at = ? WHERE id = ?').run(Date.now() - 1, ASK);
  await sweepExpiredJoins();
  await deliverDueReplies(Date.now());
}

describe('no Dojo notice goes to another Dojo\'s agent', () => {
  it('the never-answered notice is held, not sent, and the agent is told so', async () => {
    delegatedTextRequest({ senderIsAgent: true });
    await deadlinePasses();
    expect(imessage.send).not.toHaveBeenCalled();
    expect(relayRows().map((r) => [r.tool, r.outcome])).toEqual([['a2a-join-failed', 'held']]);
    expect(toldRows()).toHaveLength(1);
    expect(toldRows()[0].content).toMatch(/did NOT send .* another Dojo's agent/);
  });

  it('CONTROL: a person is sent the notice', async () => {
    delegatedTextRequest();
    await deadlinePasses();
    expect(imessage.send).toHaveBeenCalledTimes(1);
    expect(relayRows().map((r) => [r.tool, r.outcome])).toEqual([['a2a-join-failed', 'delivered']]);
  });
});
