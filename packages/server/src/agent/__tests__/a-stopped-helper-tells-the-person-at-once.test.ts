// When a helper's work stops by an event the Dojo already records (its task cancelled or deleted, its project
// deleted, the helper ended), the person waiting is told at that moment, once, with no sweep, however old the request.
// Until then the request is kept however long the task is open. A stop the Dojo missed while it was down is caught
// by the boot pass from the rows. A later answer reaches the person once, as an Update. A plain question (no task) is
// kept while its helper is in a run, has not yet been served it (whatever its age, a restart or a pause), or said it is
// still on it or asked something back; once served, with its turn ended and no final reply, it is settled once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverA2AMessage, resolveJoinsAtBoot, sweepExpiredJoins } from '../a2a-transport.js';
import { activeRuns } from '../shared-state.js';
import { agentRequests } from '../v2/owed.js';
import { sweepBootStaleness } from '../../work/work-reaper.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { writeAgentStatus } from '../agent-status.js';
import { decide } from '../../work/done/decide.js';
import { deleteTrackerRow } from '../../work/tracker-store.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import {
  agentLines, agentStaysSilent, delegatedTextRequest, failedNotices, helperAnswers, helperTask, passesRun, requestState, relayRows, served, textsSent, ASK, HELPER, THREAD,
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
    served();
    deleteTrackerRow(helperTask());
    expect(await told()).toEqual(['failed', 1, 1]);
  });

  it('the project holding its task deleted', async () => {
    testDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
      VALUES ('proj-1', 'project', ?, 'agent', 'tracker', 'proj-1', 'open', 'project', 0, 0, 'Venue', ?, ?)`).run(HELPER, Date.now(), Date.now());
    helperTask('proj-1');
    served();
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

const HOUR = 3_600_000;
/** The main agent's question reaches the helper on `thread` (the seed already sent it on its own threads). */
async function asked(thread = THREAD): Promise<void> {
  const sent = testDb().prepare('SELECT 1 FROM messages WHERE agent_id = ? AND a2a_thread_id = ?').get(HELPER, thread);
  if (!sent) await deliverA2AMessage({ intent: 'QUESTION', threadId: thread, requiresResponse: true, payload: 'When is the venue free?', toAgent: HELPER, fromAgent: AGENT } as never);
}
/** A sweep `hours` later. */
async function looked(hours: number): Promise<[string, number, number]> {
  vi.setSystemTime(Date.now() + hours * HOUR);
  await sweepExpiredJoins();
  return told();
}
const owes = (): boolean => agentRequests(HELPER).some((r) => r.threadId === THREAD);
const asksBack = (): Promise<unknown> => deliverA2AMessage({ intent: 'QUESTION', threadId: THREAD, requiresResponse: true, payload: 'The hall or the garden?', toAgent: AGENT, fromAgent: HELPER } as never);

describe('a plain question waits for its helper', () => {
  it('a slow helper in one long turn is never ended; served once and silent, it is settled at the next look, once', async () => {
    await asked();
    served(null);
    activeRuns.add(HELPER);
    expect(await looked(5)).toEqual(['blocked', 0, 0]);
    activeRuns.delete(HELPER);
    testDb().prepare("UPDATE turns SET ended_at = datetime('now'), exit_reason = 'answered' WHERE agent_id = ?").run(HELPER);
    expect([await looked(1), owes()]).toEqual([['failed', 1, 1], false]);
    expect(await looked(1)).toEqual(['failed', 1, 1]);
  });

  it('a question back keeps it until answered, with no extra serve meanwhile; the answer makes it owed; a final reply settles it', async () => {
    await asked();
    served();
    await asksBack();
    expect([await looked(3), owes()]).toEqual([['blocked', 0, 0], false]);
    await deliverA2AMessage({ intent: 'ANSWER', threadId: THREAD, requiresResponse: false, payload: 'The hall.', toAgent: HELPER, fromAgent: AGENT } as never);
    expect([await looked(1), owes()]).toEqual([['blocked', 0, 0], true]);
    await helperAnswers('The hall is free on the 14th.');
    expect([await looked(1), testDb().prepare('SELECT state FROM work WHERE parent_id = ?').get(ASK)]).toEqual([[requestState(), 0, 0], { state: 'done' }]);
  });

  it('a helper paused 25 hours is still owed the question it never saw, and keeps the request', async () => {
    await asked();
    testDb().prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(HELPER);
    expect(await looked(25)).toEqual(['blocked', 0, 0]);
    testDb().prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(HELPER);
    expect([await looked(1), owes()]).toEqual([['blocked', 0, 0], true]);
  });

  it('a restart keeps it: the serving turn lost at boot and the queued question older than 30 minutes', async () => {
    await asked();
    vi.setSystemTime(Date.now() + HOUR);
    sweepBootStaleness();
    expect(owes()).toBe(true);
    served('terminated');
    await resolveJoinsAtBoot();
    expect(await told()).toEqual(['blocked', 0, 0]);
  });

  it('a serving turn that crashed unclassified is served again, not settled', async () => {
    served('unknown');
    expect([await looked(1), owes()]).toEqual([['blocked', 0, 0], true]);
  });

  it('twenty earlier requests to the helper do not push this one out', async () => {
    for (let i = 0; i < 20; i++) await asked(`thread-other-${i}`);
    await asked();
    expect(await looked(2)).toEqual(['blocked', 0, 0]);
  });

  it('two pieces to the same helper: the one it owes is kept when the other ends', async () => {
    delegatedTextRequest({}, [THREAD, 'thread-relay-0002']);
    served('answered', 1, THREAD);
    await resolveJoinsAtBoot();
    expect((testDb().prepare('SELECT state FROM work WHERE parent_id = ? ORDER BY root_id').all(ASK) as Array<{ state: string }>).map((r) => r.state)).toEqual(['abandoned', 'open']);
  });

  it('a request eight days old, looked at since, is found when its helper errs; the notice claims no clean run', async () => {
    await asked();
    testDb().prepare('UPDATE work SET opened_at = ? WHERE id = ? OR parent_id = ?').run(Date.now() - 8 * 24 * HOUR, ASK, ASK);
    testDb().prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(HELPER);
    expect(await looked(2)).toEqual(['failed', 1, 1]);
    expect(JSON.stringify(relayRows())).not.toContain('nothing errored');
  });

  it('a restart keeps a request with two pieces out, one closed as history at the update, and both are served again', async () => {
    delegatedTextRequest({}, [THREAD, 'thread-relay-0002']);
    for (const t of [THREAD, 'thread-relay-0002']) await asked(t);
    testDb().prepare("UPDATE messages SET swept_at = created_at WHERE agent_id = ? AND a2a_thread_id = 'thread-relay-0002'").run(HELPER);
    await resolveJoinsAtBoot();
    expect([await told(), agentRequests(HELPER).map((r) => r.threadId).sort()]).toEqual([['blocked', 0, 0], [THREAD, 'thread-relay-0002']]);
    testDb().prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, 1, datetime('now'), datetime('now'), 0, 'answered')").run(HELPER);
    testDb().prepare('UPDATE messages SET served_by_turn = 1 WHERE agent_id = ? AND a2a_thread_id IS NOT NULL').run(HELPER);
    expect(await looked(1)).toEqual(['failed', 1, 1]);
    expect(await looked(1)).toEqual(['failed', 1, 1]);
  });
});
