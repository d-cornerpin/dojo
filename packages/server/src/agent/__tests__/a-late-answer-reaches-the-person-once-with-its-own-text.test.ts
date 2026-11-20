// An answer that comes after the request failed for want of one reaches the person once, with its own text: the
// request and its piece re-open on it and the piece lands for real, so neither the next reaper pass nor a restart
// fails the request again or sends a second "no answer" notice. The agent passes it on, or the Dojo does, "Update:".
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { resolveJoinsAtBoot, sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, delegatedTextRequest, helperAnswers, relayRows, requestState, textsSent, ASK } from './helpers/text-relay.js';

const pieceState = (): string => (testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state;
const failedNotices = (): number => relayRows().filter((r) => r.tool === 'a2a-join-failed').length;

async function theRequestFailsForTime(): Promise<void> {
  vi.setSystemTime(Date.now() + 3_700_000);
  await sweepExpiredJoins();
  await deliverDueReplies(Date.now());
  expect([requestState(), pieceState(), failedNotices()]).toEqual(['failed', 'failed', 1]);
}

beforeEach(() => delegatedTextRequest());

describe('a late answer reaches the person once with its own text', () => {
  it('a reaper pass and a restart before it is passed on send no second notice; the Dojo relays the late text once', async () => {
    await theRequestFailsForTime();
    await helperAnswers('Confirmed after all: the 14th, all day.');
    expect([requestState(), pieceState()]).toEqual(['open', 'done']);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await sweepExpiredJoins();
    await resolveJoinsAtBoot();
    expect([requestState(), failedNotices()]).toEqual(['open', 1]);

    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    expect(textsSent().slice(1)).toEqual(['Dojo: Update: Helper answered after all. Confirmed after all: the 14th, all day.']);
    expect(textsSent()).toHaveLength(2);
    expect(requestState()).toBe('done');
  });

  it('an empty late reply changes nothing and goes nowhere', async () => {
    await theRequestFailsForTime();
    await helperAnswers('   ');
    expect([requestState(), pieceState()]).toEqual(['failed', 'failed']);
    expect(relayRows()).toHaveLength(1);
  });
});
