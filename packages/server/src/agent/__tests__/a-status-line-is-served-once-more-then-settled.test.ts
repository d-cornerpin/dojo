// A helper's status line on a plain question is not its answer and does not keep it: its first status buys exactly one
// more serve in the life of the request, a second buys nothing, and the next look settles it once. A final reply settles
// it as answered.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverA2AMessage, sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { agentRequests } from '../v2/owed.js';
import { delegatedTextRequest, failedNotices, helperAnswers, requestState, served, HELPER, THREAD } from './helpers/text-relay.js';

const owes = (): boolean => agentRequests(HELPER).some((r) => r.threadId === THREAD);
async function looked(): Promise<[string, number]> {
  vi.setSystemTime(Date.now() + 3 * 3_600_000);
  await sweepExpiredJoins();
  await deliverDueReplies(Date.now());
  return [requestState(), failedNotices()];
}
const status = (): Promise<unknown> => deliverA2AMessage({ intent: 'STATUS', threadId: THREAD, requiresResponse: false, payload: 'Still checking, more soon.', toAgent: AGENT, fromAgent: HELPER } as never);

beforeEach(() => delegatedTextRequest());

describe('a status line is served once more, then settled', () => {
  it('status, one more serve, status again: no third serve, settled once', async () => {
    // Every stamp is set from one base, so the turns and the words are in a known order.
    const base = (testDb().prepare('SELECT created_at AS at FROM messages WHERE agent_id = ? AND a2a_thread_id = ?').get(HELPER, THREAD) as { at: number }).at;
    const sec = (n: number): string => new Date(base + n * 1000).toISOString();
    const turn = (n: number, from: number): void => {
      testDb().prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, ?, ?, ?, 0, 'answered')").run(HELPER, n, sec(from), sec(from + 20));
      testDb().prepare('UPDATE messages SET served_by_turn = ? WHERE agent_id = ? AND a2a_thread_id = ?').run(n, HELPER, THREAD);
    };
    const statusAt = async (at: number): Promise<void> => {
      await status();
      testDb().prepare("UPDATE messages SET created_at = ? WHERE id = (SELECT id FROM messages WHERE agent_id = ? AND a2a_intent = 'STATUS' ORDER BY seq DESC LIMIT 1)").run(base + at * 1000, AGENT);
    };
    turn(1, 10);
    await statusAt(20);
    expect([await looked(), owes()]).toEqual([['blocked', 0], true]);
    turn(2, 40);
    await statusAt(50);
    expect([await looked(), owes()]).toEqual([['failed', 1], false]);
    expect(await looked()).toEqual(['failed', 1]);
  });

  it('status then a final reply: settled as answered', async () => {
    served();
    await status();
    await helperAnswers('The 14th.');
    expect([await looked(), testDb().prepare('SELECT state FROM work WHERE parent_id IS NOT NULL').get()]).toEqual([[requestState(), 0], { state: 'done' }]);
  });
});
