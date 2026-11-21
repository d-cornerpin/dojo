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
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { agentStaysSilent, delegatedTextRequest, failedNotices, helperAnswers, relayRows, requestState, textsSent, ASK, THREAD } from './helpers/text-relay.js';

const pieceState = (): string => (testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK) as { state: string }).state;

async function theRequestFailsForTime(): Promise<void> {
  vi.setSystemTime(Date.now() + 3_700_000);
  await sweepExpiredJoins();
  await deliverDueReplies(Date.now());
  expect([requestState(), pieceState(), failedNotices()]).toEqual(['failed', 'abandoned', 1]);
}

beforeEach(() => delegatedTextRequest());
const pieceStates = (): string[] => (testDb().prepare('SELECT state FROM work WHERE parent_id = ? ORDER BY id').all(ASK) as Array<{ state: string }>).map((r) => r.state);

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

  it('two helpers both late: the second late answer lands too, and the relay carries both texts', async () => {
    delegatedTextRequest({}, [THREAD, 'thread-relay-0002']);
    await theRequestFailsForTime();
    await helperAnswers('First: the 14th.');
    await helperAnswers('Second: parking is free.', 'thread-relay-0002');
    expect([requestState(), pieceStates()]).toEqual(['open', ['done', 'done']]);
    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    const relay = textsSent().at(-1)!;
    expect(relay).toContain('First: the 14th.');
    expect(relay).toContain('Second: parking is free.');
    expect(relay).not.toMatch(/reported a failure|in time/);
  });

  it('one late of two: the other is said to have never answered, and the late row is not called owed', async () => {
    delegatedTextRequest({}, [THREAD, 'thread-relay-0002']);
    testDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
    clearPlatformConfigCache();
    await theRequestFailsForTime();
    await helperAnswers('First: the 14th.');
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%returned a deliverable%'").get()).toEqual({ n: 0 });
    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    expect(textsSent().at(-1)).toContain('From Helper (it never answered):');
  });

  it('an empty late reply changes nothing and goes nowhere', async () => {
    await theRequestFailsForTime();
    await helperAnswers('   ');
    expect([requestState(), pieceState()]).toEqual(['failed', 'abandoned']);
    expect(relayRows()).toHaveLength(1);
  });
});
