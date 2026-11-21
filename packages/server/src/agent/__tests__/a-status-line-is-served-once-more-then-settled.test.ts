// A helper's status line on a plain question is not its answer and does not keep it: the question is served once
// more; if that turn ends with no final reply and nothing in flight, it is settled once. A final reply settles it as answered.
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
  it('status then silence: one more serve, then settled once', async () => {
    served();
    await status();
    expect([await looked(), owes()]).toEqual([['blocked', 0], true]);
    testDb().prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, 2, datetime('now', '+2 seconds'), datetime('now', '+2 seconds'), 0, 'answered')").run(HELPER);
    testDb().prepare('UPDATE messages SET served_by_turn = 2 WHERE agent_id = ? AND a2a_thread_id = ?').run(HELPER, THREAD);
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
