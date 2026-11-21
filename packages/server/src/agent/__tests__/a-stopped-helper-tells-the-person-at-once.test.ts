// When a helper's work stops by an event the Dojo already records (its task cancelled or deleted, its project
// deleted, the helper ended), the person waiting is told at that moment, once, with no sweep, however old the request.
// Until then the request is kept however long the task is open. A stop the Dojo missed while it was down is caught
// by the boot pass from the rows. A later answer reaches the person once, as an Update.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { resolveJoinsAtBoot, sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { writeAgentStatus } from '../agent-status.js';
import { decide } from '../../work/done/decide.js';
import { deleteTrackerRow } from '../../work/tracker-store.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import {
  agentLines, agentStaysSilent, delegatedTextRequest, failedNotices, helperAnswers, helperTask, passesRun, requestState, textsSent, ASK, HELPER,
} from './helpers/text-relay.js';

/** The request, the person's notices and the agent's lines, once the passes an event started and the sends ran. */
async function told(): Promise<[string, number, number]> {
  await passesRun();
  await deliverDueReplies(Date.now());
  return [requestState(), failedNotices(), agentLines()];
}

beforeEach(() => delegatedTextRequest());

describe('a stopped helper tells the person at once', () => {
  it('kept past its deadline while the task is open; told once at the cancel; the late answer is an Update', async () => {
    helperTask();
    vi.setSystemTime(Date.now() + 5 * 3_600_000);
    await sweepExpiredJoins();
    expect(await told()).toEqual(['blocked', 0, 0]);
    expect(decide({ workId: 'task-helper-1', deciderAgentId: null, verdict: 'cancel', reason: 'The venue closed for good' }).kind).toBe('decided');
    expect(await told()).toEqual(['failed', 1, 1]);
    await sweepExpiredJoins();
    await resolveJoinsAtBoot();
    expect(await told()).toEqual(['failed', 1, 1]);
    await helperAnswers('It reopens on the 14th after all.');
    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    expect(textsSent().filter((t) => t.startsWith('Dojo: Update:'))).toEqual(['Dojo: Update: Helper answered after all. It reopens on the 14th after all.']);
  });

  it('its task deleted', async () => {
    deleteTrackerRow(helperTask());
    expect(await told()).toEqual(['failed', 1, 1]);
  });

  it('the project holding its task deleted', async () => {
    testDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
      VALUES ('proj-1', 'project', ?, 'agent', 'tracker', 'proj-1', 'open', 'project', 0, 0, 'Venue', ?, ?)`).run(HELPER, Date.now(), Date.now());
    helperTask('proj-1');
    deleteTrackerRow('proj-1');
    expect(await told()).toEqual(['failed', 1, 1]);
  });

  it('the helper ended, on a request eight days old; a second end tells nobody', async () => {
    helperTask();
    testDb().prepare('UPDATE work SET opened_at = ? WHERE id = ? OR parent_id = ?').run(Date.now() - 8 * 24 * 3_600_000, ASK, ASK);
    writeAgentStatus(HELPER, 'terminated');
    expect(await told()).toEqual(['failed', 1, 1]);
    writeAgentStatus(HELPER, 'terminated');
    expect(await told()).toEqual(['failed', 1, 1]);
  });

  it('a task that ended while the Dojo was down: one notice at the first start, none at the second', async () => {
    helperTask();
    testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'task-helper-1'").run(Date.now());   // written, never judged
    await resolveJoinsAtBoot();
    expect(await told()).toEqual(['failed', 1, 1]);
    await resolveJoinsAtBoot();
    expect(await told()).toEqual(['failed', 1, 1]);
  });
});
