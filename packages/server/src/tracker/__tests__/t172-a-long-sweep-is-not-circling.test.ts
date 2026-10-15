// ════════════════════════════════════════════════════════════════════════════════
// t172 A — A LONG SWEEP IS NOT CIRCLING: THE EFFORT REVIEW FIRES ON REPEATS, NOT ON COUNT.
//
// WITNESS (the S1 run, a dev box): an agent walked a 599-page chain forward one page at a time,
// appending findings to its own file. Every call was a DIFFERENT page. At 150 calls the PM's
// effort review fired anyway (the meter was `effort_calls - effort_reviewed_calls`, a bare call
// count), the PM model saw a ten-row sample of "file_read, file_read, file_read" and ruled the
// job CIRCLING, and the job was poked mid-walk. CIRCLING is defined in the PM's own prompt as
// "repeating the same calls with nothing new landing"; the count never measured that.
//
// WHAT THIS FILE PINS, through the real doors (the charge site `countTrackerWorkThisIteration`,
// the queue `queueEffortReviewIfNeeded`, the pending set, the review `runEffortReview`, the
// status writer `setTrackerStatus`):
//   (i)   300 DISTINCT file_reads since the last advance request no review
//   (ii)  150 REPEATS of one call do, and the PM's prompt carries the repeat facts
//   (iii) a real status change resets the meter, as it always did
//   plus: key order does not make a call new; a re-read at the same offset is a repeat and the
//   next offset is not; the lifetime total still counts every call; and a review that is
//   waiting is not "resolved" by the agent making new calls while it waits.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));

const callModelSpy = vi.fn();
let verdictText: string | null = null;
vi.mock('../../agent/model.js', () => ({
  callModel: async (params: unknown) => {
    callModelSpy(params);
    return { content: verdictText };
  },
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: async () => ({ delivered: true }),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { queueEffortReviewIfNeeded, runEffortReview, findPendingEffortReviewTaskIds } from '../pm-agent.js';
import { EFFORT_REVIEW_DELTA_CALLS, effortDelta, chargeEffort } from '../effort-governor.js';
import { countTrackerWorkThisIteration } from '../../agent/v2/steps/execute/tracker-counting.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { initState } from '../../agent/v2/state.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import type { ExecuteContext } from '../../agent/v2/steps/execute/index.js';

const AGENT = 'agent-sweeper';
let TASK = 'unset';
let taskSeq = 0;
const PM_ID = 'pm';

type Call = { id: string; name: string; arguments: Record<string, unknown> };
let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): Call => ({ id: `tc-${callSeq++}`, name, arguments: args });
const pageRead = (n: number): Call => call('file_read', { path: `/fixtures/ledger/page-${n}.txt`, offset: 0 });

function executeCtx(calls: Call[]): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: { convKey: null, startAckSteerArmedThisTurn: false, startAckSteerRequested: false },
    counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false },
    counterpartyIsAgentSender: false,
    engineStartAckDeliveredThisTurn: true,
    result: { toolCalls: calls } as unknown as ExecuteContext['result'],
  } as unknown as ExecuteContext;
}

function freshState() {
  return initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'floor-model',
    turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
    lastUserMessageId: null, inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  });
}

/** One model iteration's worth of calls, charged through the real charge site. */
function iterate(calls: Call[]): void {
  countTrackerWorkThisIteration(freshState(), executeCtx(calls));
}

function row(id: string): { effort_calls: number; effort_reviewed_calls: number } {
  return mockDb.current!.prepare('SELECT effort_calls, effort_reviewed_calls FROM work WHERE id = ?')
    .get(id) as { effort_calls: number; effort_reviewed_calls: number };
}

function requestCount(taskId: string): number {
  return (mockDb.current!.prepare(`
    SELECT COUNT(*) AS c FROM work_events
     WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'effort_review_requested'
  `).get(taskId) as { c: number }).c;
}

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, agent_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT);
  `);
  db.prepare(`INSERT INTO agents (id, name, status, model_id) VALUES (?, 'PM', 'idle', 'test-model')`).run(PM_ID);
  db.prepare(`INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Sweeper', 'idle', 'test-model')`).run(AGENT);
  mockDb.current = db;
  // A fresh task id per test: the seen-calls ledger is per task and per process, so a reused id
  // would carry one test's history into the next (production ids are never reused).
  TASK = `sweep-${++taskSeq}`;
  seedTrackerTask(db, { id: TASK, agentId: AGENT, status: 'in_progress' });
  verdictText = null;
  callModelSpy.mockClear();
  callSeq = 0;
});

afterEach(() => { mockDb.current = null; });

describe('(i) a sweep of distinct pages is progress, not circling', () => {
  it('300 DISTINCT file_reads since the last advance leave the meter at 0 and request no review', () => {
    for (let n = 1; n <= 300; n++) iterate([pageRead(n)]);

    const r = row(TASK);
    expect(r.effort_calls, 'the lifetime total still counts every call').toBe(300);
    expect(effortDelta(r), 'a new call is progress and does not move the meter').toBe(0);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(false);
    expect(requestCount(TASK)).toBe(0);
    expect(findPendingEffortReviewTaskIds()).toEqual([]);
  });

  it('several distinct calls in ONE iteration are all new', () => {
    iterate([pageRead(1), pageRead(2), pageRead(3), pageRead(4)]);
    expect(effortDelta(row(TASK))).toBe(0);
    expect(row(TASK).effort_calls).toBe(4);
  });

  it('a re-read of the same file at the SAME offset is a repeat; the next offset is not', () => {
    iterate([call('file_read', { path: '/f/a.txt', offset: 0 })]);          // new
    iterate([call('file_read', { path: '/f/a.txt', offset: 0 })]);          // repeat
    iterate([call('file_read', { path: '/f/a.txt', offset: 4000 })]);       // new (next window)
    expect(effortDelta(row(TASK))).toBe(1);
  });

  it('argument ORDER does not make a call new', () => {
    iterate([call('file_read', { path: '/f/a.txt', offset: 0 })]);
    iterate([call('file_read', { offset: 0, path: '/f/a.txt' })]);
    expect(effortDelta(row(TASK))).toBe(1);
  });

  it('nested arguments are compared by value, key order included', () => {
    iterate([call('web_fetch', { url: 'https://example.test/a', opts: { b: 1, a: [1, 2] } })]);
    iterate([call('web_fetch', { opts: { a: [1, 2], b: 1 }, url: 'https://example.test/a' })]);
    iterate([call('web_fetch', { opts: { a: [2, 1], b: 1 }, url: 'https://example.test/a' })]); // array order matters
    expect(effortDelta(row(TASK))).toBe(1);
  });

  it('the same arguments to a DIFFERENT tool are a different call', () => {
    iterate([call('file_read', { path: '/f/a.txt' })]);
    iterate([call('file_stat', { path: '/f/a.txt' })]);
    expect(effortDelta(row(TASK))).toBe(0);
  });
});

describe('(ii) a loop of repeats is circling, and the PM is told what repeated', () => {
  it('149 repeats do not request a review; the 150th does', () => {
    iterate([pageRead(7)]); // the first is new
    for (let i = 0; i < EFFORT_REVIEW_DELTA_CALLS - 1; i++) iterate([pageRead(7)]);
    expect(effortDelta(row(TASK))).toBe(EFFORT_REVIEW_DELTA_CALLS - 1);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(false);

    iterate([pageRead(7)]);
    expect(effortDelta(row(TASK))).toBe(EFFORT_REVIEW_DELTA_CALLS);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(true);
    expect(requestCount(TASK)).toBe(1);
    expect(findPendingEffortReviewTaskIds()).toEqual([TASK]);
  });

  it('the review prompt carries distinct vs repeated and the repeated signatures with their counts', async () => {
    // 40 distinct pages (progress), then one page re-read 150 times and another 20 times.
    for (let n = 1; n <= 40; n++) iterate([pageRead(n)]);
    for (let i = 0; i < EFFORT_REVIEW_DELTA_CALLS + 1; i++) iterate([call('file_read', { path: '/fixtures/ledger/loop.txt', offset: 12 })]);
    for (let i = 0; i < 20; i++) iterate([call('file_read', { path: '/fixtures/ledger/other.txt', offset: 0 })]);
    // (150 + 19 repeats now; the queue sees >= 150)
    expect(queueEffortReviewIfNeeded(TASK)).toBe(true);

    verdictText = JSON.stringify({ advancing: false, reason: 'same page again', task_id: TASK });
    await runEffortReview(TASK);

    expect(callModelSpy).toHaveBeenCalledTimes(1);
    const prompt = (callModelSpy.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    // what the number counts, in words
    expect(prompt).toContain('REPEATED');
    expect(prompt).toContain('a call that is new is progress');
    // distinct vs repeated: 40 pages + loop.txt first read + other.txt first read = 42 new; 150 + 19 repeats
    expect(prompt).toContain('42 new (distinct) calls');
    expect(prompt).toContain('169 repeated calls');
    // the repeated signatures with their counts, most repeated first
    expect(prompt).toContain('150x file_read({"offset":12,"path":"/fixtures/ledger/loop.txt"})');
    expect(prompt).toContain('19x file_read({"offset":0,"path":"/fixtures/ledger/other.txt"})');
    expect(prompt.indexOf('150x')).toBeLessThan(prompt.indexOf('19x'));
    // a page that was only ever read once is NOT listed as repeated
    expect(prompt).not.toContain('page-3.txt');
  });

  it('the legacy whole-number charge (no call detail) still counts everything toward the meter', () => {
    chargeEffort(TASK, EFFORT_REVIEW_DELTA_CALLS);
    expect(effortDelta(row(TASK))).toBe(EFFORT_REVIEW_DELTA_CALLS);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(true);
  });

  it('a request that is waiting for the PM is not resolved by the agent making NEW calls meanwhile', () => {
    iterate([pageRead(1)]);
    for (let i = 0; i < EFFORT_REVIEW_DELTA_CALLS; i++) iterate([pageRead(1)]);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(true);
    // The model is slow to answer; the agent walks on, new pages only.
    for (let n = 100; n < 160; n++) iterate([pageRead(n)]);

    expect(queueEffortReviewIfNeeded(TASK), 'still the same request, not a second one').toBe(false);
    expect(requestCount(TASK)).toBe(1);
    expect(findPendingEffortReviewTaskIds(), 'and it is still waiting to be reviewed').toEqual([TASK]);
  });

  it('once the PM rules, a fresh run of repeats is free to queue a new review', async () => {
    iterate([pageRead(1)]);
    for (let i = 0; i < EFFORT_REVIEW_DELTA_CALLS; i++) iterate([pageRead(1)]);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(true);
    verdictText = JSON.stringify({ advancing: false, reason: 'again', task_id: TASK });
    await runEffortReview(TASK);
    expect(effortDelta(row(TASK))).toBe(0);
    expect(findPendingEffortReviewTaskIds()).toEqual([]);

    for (let i = 0; i < EFFORT_REVIEW_DELTA_CALLS + 1; i++) iterate([pageRead(1)]);
    expect(queueEffortReviewIfNeeded(TASK)).toBe(true);
    expect(requestCount(TASK)).toBe(2);
  });
});

describe('(iii) a real status change resets the meter, as it always did', () => {
  it('an applied transition zeroes the meter and what the task had "already done" starts over', () => {
    iterate([pageRead(1)]);
    for (let i = 0; i < 100; i++) iterate([pageRead(1)]);
    expect(effortDelta(row(TASK))).toBe(100);

    const r = setTrackerStatus(TASK, 'blocked', { by: 'agent', actorId: AGENT, reason: 'waiting on the owner' });

    expect(r.kind).toBe('applied');
    expect(effortDelta(row(TASK))).toBe(0);
    expect(row(TASK).effort_calls, 'lifetime total kept').toBe(101);

    // The same call after the advance is a NEW call again (the ledger started over)...
    mockDb.current!.prepare("UPDATE work SET state = 'claimed' WHERE id = ?").run(TASK); // picked back up
    iterate([pageRead(1)]);
    expect(effortDelta(row(TASK))).toBe(0);
    // ...and a repeat of it after that counts again.
    iterate([pageRead(1)]);
    expect(effortDelta(row(TASK))).toBe(1);
  });
});
