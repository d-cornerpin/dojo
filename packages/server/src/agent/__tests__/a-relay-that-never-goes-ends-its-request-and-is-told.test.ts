// A helper's answer that cannot reach the person after all five tries ends the request failed, with its reason; the
// owner gets one dashboard card and the agent one notice. Nothing calls it stuck afterwards.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverDueReplies } from '../v2/channel-sender.js';
import { servedOwnerNotices } from '../../healer/owner-notice-kinds.js';
import { imessage, testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, delegatedTextRequest, helperAnswers, relayRows, requestState, ASK } from './helpers/text-relay.js';

const MIN = 60_000;

beforeEach(() => delegatedTextRequest());

describe('a relay that never goes ends its request and is told', () => {
  it('five failed tries: the request is failed, one card, one notice, and no stood-down card', async () => {
    await helperAnswers('The venue is free on the 14th.');
    await agentStaysSilent();
    imessage.send.mockResolvedValue(false);
    let now = Date.now();
    for (const wait of [30_000, 2 * MIN, 10 * MIN, 30 * MIN, MIN]) {
      await deliverDueReplies(now);
      now += wait;
    }
    expect(imessage.send).toHaveBeenCalledTimes(5);
    expect(relayRows().map((r) => r.outcome)).toEqual(['failed']);
    expect(requestState()).toBe('failed');
    const reason = testDb().prepare("SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1").get(ASK) as { r: string };
    expect(reason.r).toMatch(/could not be sent/);
    expect(servedOwnerNotices().filter((c) => c.cardKey === `undelivered:${AGENT}`)).toHaveLength(1);
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '[SOURCE: AGENT NOTICE%' AND content LIKE '%did NOT reach them%'").get()).toEqual({ n: 1 });
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'").get(ASK)).toEqual({ n: 0 });
  });
});
