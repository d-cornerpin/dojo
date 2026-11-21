// A plain question, with no task, is kept past its deadline while its helper is in a run or still owes it the reply;
// once the helper was served it, its turn ended unanswered and nothing is coming, the person is told once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverA2AMessage, sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { activeRuns } from '../shared-state.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, failedNotices, requestState, ASK, HELPER, THREAD } from './helpers/text-relay.js';

const HOUR = 3_600_000;
async function lookAtTheDeadline(): Promise<[string, number]> {
  vi.setSystemTime(Date.now() + 2 * HOUR);
  await sweepExpiredJoins();
  await deliverDueReplies(Date.now());
  return [requestState(), failedNotices()];
}

beforeEach(() => delegatedTextRequest());

describe('a plain question to a live helper is kept', () => {
  it('in a run, then owing the reply, it is kept; served and silent, it is told once', async () => {
    activeRuns.add(HELPER);
    expect(await lookAtTheDeadline()).toEqual(['blocked', 0]);
    activeRuns.delete(HELPER);
    await deliverA2AMessage({ intent: 'QUESTION', threadId: THREAD, requiresResponse: true, payload: 'When is the venue free?', toAgent: HELPER, fromAgent: AGENT } as never);
    expect(await lookAtTheDeadline()).toEqual(['blocked', 0]);
    testDb().prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, 1, ?, ?, 0, 'answered')")
      .run(HELPER, new Date(Date.now() - HOUR).toISOString(), new Date(Date.now() - HOUR).toISOString());
    testDb().prepare("UPDATE messages SET served_by_turn = 1 WHERE agent_id = ? AND a2a_thread_id = ?").run(HELPER, THREAD);
    expect(await lookAtTheDeadline()).toEqual(['failed', 1]);
    expect(await lookAtTheDeadline()).toEqual(['failed', 1]);
    expect(testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK)).toEqual({ state: 'abandoned' });
  });
});
