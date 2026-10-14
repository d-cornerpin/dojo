// SLOW-INFERENCE T79d — THE PM REVIEWS EFFORT OUT OF BAND: extend or intervene.
//
// The meter (T79c) counts effort without judging it. This file pins the judge:
//   §1 `queueEffortReviewIfNeeded` — the durable, restart-proof dedupe. A task under the
//      threshold queues nothing; a task over it queues exactly ONE request no matter how
//      many times the poke sweep re-checks it, until a verdict lands (the baseline moves).
//   §2 `runEffortReview` — the verdict's wiring. `advancing=true` writes the observation and
//      moves the baseline WITHOUT ever touching the assignee (no poke, no message).
//      `advancing=false` records the verdict durably and moves the baseline, but NEVER
//      delivers directly (fix round, Finding 1) — delivery is §3's job.
//   §3 (FIX ROUND, Finding 1, CRITICAL) — the guarded poke path. A circling verdict only ever
//      reaches the assignee through the SAME guarded delivery every other poke in this file
//      uses (`assigneeStatus === 'working'`, `pmActiveRuns` busy-deferral); it is eventual by
//      construction (the sweep runs every 60s) and it embeds the PM's reason.
//   §4 (t123 REWROTE THIS SECTION) — the verdict is asked for OFF the turn plumbing, so it
//      can never reach a human lane. What §4 used to pin was a set of correlation devices
//      (`pmActiveRuns` busy-deferral, a `seq` dispatch boundary, a `task_id` echo-rejection)
//      that existed ONLY because the verdict was read back out of the `messages` table after
//      driving a real PM turn. t123 deleted that mechanism — see the tombstone in
//      `runEffortReview` — so §4 now pins the INVARIANT those devices were approximating:
//      the verdict comes from the call's own return value, it persists NOTHING, and a review
//      is never lost to a busy PM.
//
// ⚠ THE LLM SEAM MOVED (t123). It used to be `agent/runtime.js`'s
// `getAgentRuntime().handleMessage` — a stub that wrote an assistant `messages` row, because
// that is literally how the verdict travelled: `handleMessage` DISCARDS its content argument,
// the prompt reached the model as a durable events-lane row, and the reply was read back out
// of `messages`. That is exactly what published the engine's private JSON into the owner's
// chat. The seam is now `agent/model.js`'s `callModel`, the non-persisting path, and the stub
// returns the verdict as a RETURN VALUE — which is the whole point: a stub that cannot write
// a message row is a stub that cannot fake the defect.

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

/** The LLM stub seam (t123): `callModel`, the engine's non-persisting model path. Reassigned
 *  per test so each test controls what the PM's model answers. The spy records the params so
 *  the clauses can assert the CALL SHAPE — `tools: false` and the declared purpose are what
 *  make the call persist nothing, and a clause that only checked the verdict would stay green
 *  if someone put the judgment back on the turn plumbing. */
const callModelSpy = vi.fn();
let verdictText: string | null = null;
let callModelThrows: Error | null = null;
/** When `hungGate` is armed, `callModel` never settles until `releaseHungCall()` is called. This
 *  is how the single-flight clause drives "a review is still in flight" with NO sleeps and no
 *  wall clock: the hang is a promise nobody resolves, which is deterministic. */
vi.mock('../../agent/model.js', () => ({
  callModel: async (params: unknown) => {
    callModelSpy(params);
    if (hungGate) {
      await new Promise<void>((resolve) => { releaseHungCall = resolve; });
    }
    if (callModelThrows) throw callModelThrows;
    return { content: verdictText };
  },
}));
/** Armed by the single-flight clause only. */
let hungGate = false;
let releaseHungCall: () => void = () => { /* nothing hung */ };

// Still mocked, now as a pure no-op: `runEffortReview` no longer touches the runtime at all,
// but `runPMReview` (fired by §3) does.
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));

const deliverA2ASpy = vi.fn(async (_envelope?: unknown) => ({ delivered: true }));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...args: unknown[]) => deliverA2ASpy(...args),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
vi.mock('../../agent/agent-notice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/agent-notice.js')>()),
  // t143 round 3 (I2): a PM poke is a re-drive that owes no reply; this door records it in the
  // spy's envelope shape (recipient, payload) and the assertions read `requiresResponse: false`.
  redriveWithoutReply: async (o: { toAgentId: string; fromAgentId: string | null; content: string }) => {
    await deliverA2ASpy({ toAgent: o.toAgentId, fromAgent: o.fromAgentId, payload: o.content, requiresResponse: false });
    return true;
  },
}));


import { queueEffortReviewIfNeeded, runEffortReview, runPokeCheck, findPendingEffortReviewTaskIds } from '../pm-agent.js';
import { EFFORT_REVIEW_DELTA_CALLS } from '../effort-governor.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
// The REAL Set `agent/runtime.ts`'s own busy-guard reads (`agent/shared-state.ts`) — imported
// directly (not mocked) so §4's busy-PM test can arm/disarm the SAME state `runEffortReview`
// checks, exactly as `tracker/pm-agent.ts` already imports it for the poke sweep's own
// busy-deferral.
import { activeRuns as pmActiveRuns } from '../../agent/shared-state.js';

const PM_ID = 'pm'; // config/platform.ts's own fallback when no `config` row exists — unmocked here on purpose.

function effortRow(id: string): { effort_calls: number; effort_reviewed_calls: number } {
  return mockDb.current!.prepare(
    'SELECT effort_calls, effort_reviewed_calls FROM work WHERE id = ?',
  ).get(id) as { effort_calls: number; effort_reviewed_calls: number };
}

function requestCount(taskId: string, entryKind = 'effort_review_requested'): number {
  const row = mockDb.current!.prepare(`
    SELECT COUNT(*) AS c FROM work_events
     WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?
  `).get(taskId, entryKind) as { c: number };
  return row.c;
}

function interveneCount(taskId: string): number {
  return requestCount(taskId, 'effort_review_intervene');
}

function pokeCount(taskId: string): number {
  const row = mockDb.current!.prepare(
    `SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = 'poke'`,
  ).get(taskId) as { c: number };
  return row.c;
}

/** A minimal `messages` table — just the columns `runEffortReview`'s own queries touch.
 *  `seq` is the correlation boundary (Finding 2 fix; T79 FIX WAVE 2 renamed it from a bare
 *  `rowid` column to the table's REAL primary key name — PHASE-1 T10's promotion, see
 *  `133_drop_dead_stores_and_promote_seq.sql`), the same idiom `work_events.id` already uses
 *  elsewhere in this tree — an autoincrement, never a clock, so two rows landing in the same
 *  millisecond still order correctly. */
function createMessagesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Just enough of `agents` for `runPokeCheck`'s own status guard and the "no validator to
 *  ask" early return in `runPMReview` (fired harmlessly when no 'pm' row exists — §3 relies
 *  on this so its fire-and-forget `runPMReview()` call is a no-op). */
function createAgentsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT)`);
}

/** What the PM's model answers this test. t123: a RETURN VALUE, not a `messages` row. */
function pmAnswers(content: string | null): void {
  verdictText = content;
}

/** A row written directly into `messages`, used only to prove rows are NOT read or written. */
function plantAssistantRow(pmId: string, content: string): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, datetime('now'))`,
  ).run(`m-${Math.random()}`, pmId, content);
}

const assistantRowCount = (pmId: string): number => (mockDb.current!.prepare(
  `SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND role = 'assistant'`,
).get(pmId) as { c: number }).c;

/** Dynamic `import().then()` deliveries (the poke sweep's own long-standing shape) resolve on
 *  a LATER microtask than `runPokeCheck`'s own returned promise — flush it before asserting
 *  on `deliverA2ASpy`. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  createMessagesTable(db);
  createAgentsTable(db);
  // t123: `runEffortReview` resolves the PM's OWN model before asking it anything (the review
  // is the PM's judgment, so it rides the PM's configured model, not the system tier). Every
  // test that runs a review therefore needs a PM row — seeded here rather than per test, so a
  // new clause cannot accidentally assert "no verdict" when the real reason is "no PM model".
  db.prepare(`INSERT INTO agents (id, name, status, model_id) VALUES (?, 'PM', 'idle', 'test-model')`).run(PM_ID);
  mockDb.current = db;
  verdictText = null;
  callModelThrows = null;
  hungGate = false;
  releaseHungCall = () => { /* nothing hung */ };
  callModelSpy.mockClear();
  deliverA2ASpy.mockClear();
});

afterEach(() => {
  // §4's busy-PM test arms this real, shared Set — never leave it armed for another file.
  pmActiveRuns.delete(PM_ID);
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — queueEffortReviewIfNeeded: the durable, restart-proof dedupe
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 queueEffortReviewIfNeeded — the durable dedupe', () => {
  it('a task under the threshold queues nothing', () => {
    seedTrackerTask(mockDb.current!, { id: 't1', agentId: 'a1', status: 'in_progress' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS - 1, 't1');

    const queued = queueEffortReviewIfNeeded('t1');

    expect(queued).toBe(false);
    expect(requestCount('t1')).toBe(0);
  });

  it('a task at or over the threshold queues exactly one review', () => {
    seedTrackerTask(mockDb.current!, { id: 't2', agentId: 'a1', status: 'in_progress' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, 't2');

    const queued = queueEffortReviewIfNeeded('t2');

    expect(queued).toBe(true);
    expect(requestCount('t2')).toBe(1);
  });

  it('dedupe across repeated sweeps: calling it again before a verdict lands queues NOTHING more', () => {
    seedTrackerTask(mockDb.current!, { id: 't3', agentId: 'a1', status: 'in_progress' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS + 40, 't3');

    // Five simulated 60-second poke-sweep ticks, all before any verdict lands.
    for (let i = 0; i < 5; i++) queueEffortReviewIfNeeded('t3');

    expect(requestCount('t3')).toBe(1);
  });

  it('once a verdict moves the baseline, a FRESH trip is free to queue a new review', () => {
    seedTrackerTask(mockDb.current!, { id: 't4', agentId: 'a1', status: 'in_progress' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, 't4');

    expect(queueEffortReviewIfNeeded('t4')).toBe(true);
    expect(requestCount('t4')).toBe(1);

    // A verdict lands and moves the baseline to the current total (both verdict branches do
    // this in `runEffortReview`; simulated directly here since this describe block is only
    // about the queue, not the verdict wiring).
    mockDb.current!.prepare('UPDATE work SET effort_reviewed_calls = effort_calls WHERE id = ?').run('t4');
    // The old, now-resolved request must not block a fresh one.
    expect(queueEffortReviewIfNeeded('t4')).toBe(false); // delta is 0 right after the move

    mockDb.current!.prepare('UPDATE work SET effort_calls = effort_calls + ? WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, 't4');
    expect(queueEffortReviewIfNeeded('t4')).toBe(true);
    expect(requestCount('t4')).toBe(2); // the first request PLUS this genuinely new one
  });

  it('the review queue survives a simulated PM restart — dedupe is re-read from the durable store, not memory', async () => {
    seedTrackerTask(mockDb.current!, { id: 't5', agentId: 'a1', status: 'in_progress' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, 't5');

    expect(queueEffortReviewIfNeeded('t5')).toBe(true);
    expect(requestCount('t5')).toBe(1);

    // Simulate a PM process restart: throw away every module and re-import fresh. If the
    // dedupe held any module-level JS state (a Set, a Map, a cache), this fresh instance
    // would know nothing about the request just filed and would queue a duplicate. It does
    // not, because the dedupe is a query over `work_events`/`work`, both untouched by the
    // module reload — the DATABASE is what a restart actually preserves.
    vi.resetModules();
    const fresh = await import('../pm-agent.js');

    expect(fresh.queueEffortReviewIfNeeded('t5')).toBe(false);
    expect(requestCount('t5')).toBe(1); // still exactly one, from before the "restart"
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — runEffortReview: the verdict's wiring
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 runEffortReview — advancing=true extends silently, advancing=false records but never delivers', () => {
  function seedOverThreshold(id: string, agentId = 'a1'): void {
    seedTrackerTask(mockDb.current!, { id, agentId, status: 'in_progress', title: 'Sweep the mailbox' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, id);
  }

  it('advancing=true: writes the observation, moves the baseline, and sends NO poke', async () => {
    seedOverThreshold('adv-1');
    pmAnswers(JSON.stringify({ advancing: true, reason: '400-email sweep, labels are landing steadily', task_id: 'adv-1' }));

    await runEffortReview('adv-1');

    const row = effortRow('adv-1');
    expect(row.effort_reviewed_calls).toBe(row.effort_calls); // baseline moved to current
    expect(pokeCount('adv-1')).toBe(0); // the assignee is never touched on this branch
    expect(deliverA2ASpy).not.toHaveBeenCalled();

    const obs = mockDb.current!.prepare(`
      SELECT actor, json_extract(payload, '$.entry_kind') AS entry_kind,
             json_extract(payload, '$.reason') AS reason
        FROM work_events WHERE work_id = ? AND kind = 'audit'
       ORDER BY id DESC LIMIT 1
    `).get('adv-1') as { actor: string; entry_kind: string; reason: string };
    expect(obs.entry_kind).toBe('observation');
    expect(obs.actor).toBe('pm');
    expect(obs.reason).toContain('labels are landing');
  });

  it('advancing=false: records the verdict durably and moves the baseline, but delivers NOTHING directly (Finding 1 fix)', async () => {
    seedOverThreshold('circ-1');
    pmAnswers(JSON.stringify({ advancing: false, reason: 'same three calls repeated with nothing new landing', task_id: 'circ-1' }));

    await runEffortReview('circ-1');

    const row = effortRow('circ-1');
    expect(row.effort_reviewed_calls).toBe(row.effort_calls); // re-armed, does not spin every sweep

    // THE FIX: runEffortReview itself never reaches the assignee on this branch any more.
    expect(pokeCount('circ-1')).toBe(0);
    expect(deliverA2ASpy).not.toHaveBeenCalled();

    // The verdict IS on the record, for the guarded poke sweep (§3) to pick up later.
    expect(interveneCount('circ-1')).toBe(1);
    const entry = mockDb.current!.prepare(`
      SELECT actor, json_extract(payload, '$.reason') AS reason
        FROM work_events WHERE work_id = ? AND kind = 'audit'
         AND json_extract(payload, '$.entry_kind') = 'effort_review_intervene'
    `).get('circ-1') as { actor: string; reason: string };
    expect(entry.actor).toBe('pm');
    expect(entry.reason).toContain('same three calls repeated with nothing new landing');
  });

  it('a task under the threshold reviewed directly is a no-op: no verdict is asked for, nothing moves', async () => {
    seedTrackerTask(mockDb.current!, { id: 'under-1', agentId: 'a1', status: 'in_progress' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS - 1, 'under-1');
    await runEffortReview('under-1');

    // t123: "no verdict is asked for" is now literally "the model was never called", which is a
    // stronger and cheaper observation than the old stub flag it replaces.
    expect(callModelSpy).not.toHaveBeenCalled();
    expect(effortRow('under-1').effort_reviewed_calls).toBe(0);
    expect(pokeCount('under-1')).toBe(0);
  });

  it('an unparseable PM reply leaves the baseline untouched and pokes nobody — the request just retries next cycle', async () => {
    seedOverThreshold('garbled-1');
    pmAnswers('sorry, I got distracted and did not answer the question');

    await runEffortReview('garbled-1');

    const row = effortRow('garbled-1');
    expect(row.effort_reviewed_calls).toBe(0); // NOT moved — still pending, will retry
    expect(pokeCount('garbled-1')).toBe(0);
    expect(deliverA2ASpy).not.toHaveBeenCalled();
  });

  it('the assignee is never sent anything, and no steer enters its turn, on the advancing=true path', async () => {
    seedOverThreshold('adv-2');
    pmAnswers(JSON.stringify({ advancing: true, reason: 'still going, still landing real progress', task_id: 'adv-2' }));

    await runEffortReview('adv-2');

    // The ONLY door to the assignee this module has is the A2A poke transport, and it was
    // never called — proving the "never interrupted while the PM looks" property directly
    // rather than by absence-of-evidence alone.
    expect(deliverA2ASpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 (FIX ROUND, Finding 1, CRITICAL) — the guarded poke path, never a direct delivery
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 the guarded poke path delivers rung 2, eventually, once its own guards allow it', () => {
  function seedGuardedTask(id: string, assigneeStatus: string): void {
    createAgentsTable(mockDb.current!);
    mockDb.current!.prepare(
      `INSERT INTO agents (id, name, status, model_id) VALUES ('a1', 'Agent One', ?, NULL)`,
    ).run(assigneeStatus);
    // `updated_at` pinned to "now" so the idle-based ladder never independently fires a poke
    // of its own — the ONLY thing under test here is the circling-verdict pickup.
    seedTrackerTask(mockDb.current!, {
      id, agentId: 'a1', status: 'in_progress', title: 'Long sweep', updated_at: Date.now(),
    });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, id);
  }

  it('assignee WORKING: no delivery this tick; the assignee goes idle and the NEXT tick delivers rung 2 with the reason intact', async () => {
    seedGuardedTask('circ-guard-1', 'working');
    pmAnswers(JSON.stringify({
      advancing: false, reason: 'same handful of calls, nothing new landing', task_id: 'circ-guard-1',
    }));
    await runEffortReview('circ-guard-1');
    // Sanity: the verdict landed and re-armed the baseline, but nothing was sent (§2 already
    // pins this in isolation; repeated here because it is this test's own starting condition).
    expect(interveneCount('circ-guard-1')).toBe(1);
    expect(deliverA2ASpy).not.toHaveBeenCalled();

    // Tick 1 — the assignee is still 'working'. The SAME guard every other poke honors
    // (`assigneeStatus === 'working'`) must hold for this one too.
    await runPokeCheck();
    await flushMicrotasks();
    expect(deliverA2ASpy).not.toHaveBeenCalled();
    expect(pokeCount('circ-guard-1')).toBe(0);

    // The assignee goes idle.
    mockDb.current!.prepare(`UPDATE agents SET status = 'idle' WHERE id = 'a1'`).run();

    // Tick 2 — the guard now allows it, and the SAME code path every other poke uses delivers
    // rung 2 with the PM's reason embedded. Delivery is eventual by construction: nothing had
    // to be re-queued or re-reviewed, the durable verdict was just waiting for its guard.
    await runPokeCheck();
    await flushMicrotasks();

    expect(deliverA2ASpy).toHaveBeenCalledTimes(1);
    const [envelope] = deliverA2ASpy.mock.calls[0] as [{ payload: string; toAgent: string; requiresResponse: boolean }];
    expect(envelope.toAgent).toBe('a1');
    expect(envelope.requiresResponse, 'a check-in owes no reply').toBe(false);
    expect(envelope.payload).toContain('same handful of calls, nothing new landing');

    expect(pokeCount('circ-guard-1')).toBe(1);
    const poke = mockDb.current!.prepare(`
      SELECT json_extract(payload, '$.rung') AS rung, json_extract(payload, '$.poke_type') AS poke_type
        FROM work_events WHERE work_id = ? AND kind = 'poke'
    `).get('circ-guard-1') as { rung: number; poke_type: string };
    expect(poke.rung).toBe(2);
    expect(poke.poke_type).toBe('urgent');

    // A third tick delivers nothing more — this verdict has already been served.
    await runPokeCheck();
    await flushMicrotasks();
    expect(deliverA2ASpy).toHaveBeenCalledTimes(1);
  }, 15000);

  it('assignee already idle: the very first tick delivers it (no artificial extra delay)', async () => {
    seedGuardedTask('circ-guard-2', 'idle');
    pmAnswers(JSON.stringify({
      advancing: false, reason: 'circling on the same three files', task_id: 'circ-guard-2',
    }));
    await runEffortReview('circ-guard-2');

    await runPokeCheck();
    await flushMicrotasks();

    expect(deliverA2ASpy).toHaveBeenCalledTimes(1);
    const [envelope] = deliverA2ASpy.mock.calls[0] as [{ payload: string }];
    expect(envelope.payload).toContain('circling on the same three files');
  }, 15000);
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 (FIX ROUND, Finding 2, IMPORTANT) — the verdict is correlated to its own request
// ════════════════════════════════════════════════════════════════════════════════

describe('§4 the verdict is asked for OFF the turn plumbing, so it cannot reach a human', () => {
  function seedOverThreshold(id: string, agentId = 'a1'): void {
    seedTrackerTask(mockDb.current!, { id, agentId, status: 'in_progress', title: 'Sweep the mailbox' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, id);
  }

  // ⚠ THE CLAUSE THE OWNER'S SCREENSHOT IS ABOUT. He asked his PM a question and the visible
  // reply was `{"advancing": true, "reason": "...", "task_id": "..."}` — the engine's private
  // judgment, rendered as a chat bubble, reading as the answer to his question. It was never
  // addressed to him at all. This clause is the census: the verdict shape must not reach a
  // message row by ANY route, and the model must be asked on the non-persisting path.
  it('THE VERDICT NEVER BECOMES A MESSAGE ROW, and the call that asks for it persists nothing', async () => {
    seedOverThreshold('lane-1');
    const verdict = JSON.stringify({
      advancing: true, reason: 'the sweep is landing real progress', task_id: 'lane-1',
    });
    pmAnswers(verdict);

    await runEffortReview('lane-1');

    // 1. The verdict was applied, so this is not vacuously green on a review that never ran.
    expect(effortRow('lane-1').effort_reviewed_calls).toBe(effortRow('lane-1').effort_calls);

    // 2. NOTHING the PM owns is a message row. Not an assistant reply (what the owner saw),
    //    and not an events-lane prompt row either — the prompt used to be inserted as a
    //    durable row because `handleMessage` discards its content argument and the ROW was the
    //    delivery mechanism. A direct call needs no row in either direction.
    expect(assistantRowCount(PM_ID), 'the verdict was persisted as an assistant row — this is the defect the owner photographed').toBe(0);
    const anyRow = (mockDb.current!.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE agent_id = ?',
    ).get(PM_ID) as { c: number }).c;
    expect(anyRow, 'the review wrote a message row of some kind; the judgment must leave no row at all').toBe(0);

    // 3. Nowhere in the table does the verdict's own shape appear, by any route or agent.
    const shaped = (mockDb.current!.prepare(
      `SELECT COUNT(*) AS c FROM messages WHERE content LIKE '%advancing%' AND content LIKE '%task_id%'`,
    ).get() as { c: number }).c;
    expect(shaped, 'the advancing/task_id shape reached a message row').toBe(0);

    // 4. The CALL SHAPE, counted the other way: a clause that only checked for absent rows
    //    would stay green if someone asked for the verdict through the turn plumbing again and
    //    the stub simply did not write a row. `tools: false` is what makes `callModel` persist
    //    nothing, and the declared purpose is what caps the dial.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    const params = callModelSpy.mock.calls[0][0] as {
      tools: boolean; purpose: string; agentId: string; modelId: string;
    };
    expect(params.tools, 'tools:false is what makes this call non-persisting').toBe(false);
    expect(params.purpose).toBe('effort_verdict');
    expect(params.agentId).toBe(PM_ID);
    expect(params.modelId, "the review rides the PM's own configured model").toBe('test-model');
  });

  // t123 REPLACES 'a busy PM defers the review entirely'. That test asserted the OPPOSITE of
  // what this one asserts, and it was right about the old mechanism: `handleMessage` resolves
  // `void` whether it turned or merely queued a wakeup, so a review dispatched at a busy PM
  // read back a reply that was never written. Deferring was the only safe move. A direct model
  // call turns nothing and races nothing, so the deferral is not merely unnecessary — keeping
  // it would keep a whole class of SILENTLY LOST REVIEWS (every review that happened to land
  // while the PM was mid-run) for no remaining benefit.
  it('a BUSY PM no longer loses the review — it runs anyway, because a direct call races nothing', async () => {
    seedOverThreshold('busy-1');
    expect(queueEffortReviewIfNeeded('busy-1')).toBe(true); // the durable pending marker
    pmAnswers(JSON.stringify({ advancing: true, reason: 'still landing progress', task_id: 'busy-1' }));

    pmActiveRuns.add(PM_ID);
    try {
      await runEffortReview('busy-1');
    } finally {
      pmActiveRuns.delete(PM_ID);
    }

    expect(callModelSpy, 'the review was skipped because the PM was mid-run — that is the lost-review class t123 deleted').toHaveBeenCalledTimes(1);
    expect(effortRow('busy-1').effort_reviewed_calls).toBe(effortRow('busy-1').effort_calls);
    // And it still wrote no message row, mid-run or not.
    expect(assistantRowCount(PM_ID)).toBe(0);
  });

  // t123 REPLACES 'a pre-existing OLDER {advancing,...} message is NOT mistaken for this
  // request's verdict'. The old clause pinned a `seq` dispatch boundary that existed only
  // because the verdict was READ BACK OUT of `messages`. There is no read-back to mislead now,
  // which is a stronger guarantee than the boundary was — so the clause is re-pointed at it:
  // a planted row that would have fooled the old reader must be ignored completely.
  it('a planted assistant row that would have fooled the old read-back is never consulted', async () => {
    seedOverThreshold('stale-1');
    plantAssistantRow(PM_ID, JSON.stringify({
      advancing: true, reason: 'an old unrelated verdict', task_id: 'stale-1',
    }));
    // The model answers nothing usable this time. The old reader would have fallen back to
    // "whatever the newest PM assistant message happens to be" unless its boundary caught it.
    pmAnswers(null);

    await runEffortReview('stale-1');

    expect(effortRow('stale-1').effort_reviewed_calls, 'a row in the table was applied as a verdict').toBe(0);
    expect(interveneCount('stale-1')).toBe(0);
    // Counted the other way: the planted row is still sitting there untouched, so the review
    // neither read it nor deleted it.
    expect(assistantRowCount(PM_ID)).toBe(1);
  });

  // t123 REPLACES 'a verdict whose task_id does not match this request is REJECTED'. The echo-
  // rejection defended against reading a STALE PERSISTED ROW as this request's answer; with a
  // direct call, `r.content` IS this request's answer and there is no other candidate. Keeping
  // the rejection would have kept a spin: a model that echoes a wrong id never advances the
  // baseline, so the request re-fires an LLM call every 60 seconds for ever. `task_id` remains
  // a REQUIRED field of the parse — it is still a check that the model followed instructions —
  // which is what this clause now pins.
  it('task_id stays a required field of the shape, so a reply missing it is not a verdict', async () => {
    seedOverThreshold('shape-1');
    pmAnswers(JSON.stringify({ advancing: true, reason: 'no task_id at all' }));

    await runEffortReview('shape-1');

    expect(effortRow('shape-1').effort_reviewed_calls, 'a reply missing task_id was accepted as a verdict').toBe(0);
    expect(interveneCount('shape-1')).toBe(0);
    expect(deliverA2ASpy).not.toHaveBeenCalled();
  });

  it('the model failing is not a verdict: the request stays pending for the next sweep', async () => {
    seedOverThreshold('boom-1');
    expect(queueEffortReviewIfNeeded('boom-1')).toBe(true);
    callModelThrows = new Error('provider refused');

    await runEffortReview('boom-1');

    expect(effortRow('boom-1').effort_reviewed_calls).toBe(0);
    expect(interveneCount('boom-1')).toBe(0);
    // The durable marker is untouched, so the existing re-drive tries again next tick.
    expect(queueEffortReviewIfNeeded('boom-1')).toBe(false);
    expect(requestCount('boom-1')).toBe(1);
  });

  // ⚠ THE FIX-ROUND CLAUSE. t123 round 1 deleted the `pmActiveRuns` deferral on the correct
  // reasoning that a direct call races nothing — and removed, by accident, the ONLY thing
  // serialising this review. `runPMReview` is fire-and-forget from two sites and `await`s this
  // function in a loop; the durable pending marker clears only at the END (`advanceBaseline`), so
  // while a call is in flight the next 60s tick finds the task still pending and starts a second
  // review. If both return `circling`, both record `effort_review_intervene` and each can land
  // its own rung-2 poke at the assignee.
  //
  // Driven with a HUNG MOCK and no sleeps: the first call awaits a promise nobody resolves, which
  // is what "still in flight" means deterministically. No wall clock, so this cannot flake on a
  // loaded box (seven lanes share this machine).
  it('SINGLE-FLIGHT: a slow in-flight review + the next sweep runs EXACTLY ONE review, and pokes once', async () => {
    seedOverThreshold('inflight-1');
    expect(queueEffortReviewIfNeeded('inflight-1')).toBe(true);
    pmAnswers(JSON.stringify({
      advancing: false, reason: 'circling on the same three calls', task_id: 'inflight-1',
    }));

    // Sweep 1 — starts the review and hangs inside the model call. NOT awaited: this is exactly
    // how `runPMReview` calls it, and awaiting it here would serialise the test rather than the
    // product.
    hungGate = true;
    const sweep1 = runEffortReview('inflight-1');
    // `flushMicrotasks` (a zero-delay macrotask, already this file's idiom) rather than a bare
    // `await Promise.resolve()`: the call sits behind a dynamic `await import('../agent/model.js')`,
    // so one microtask tick does not reach it. Still no sleep and no wall-clock dependency.
    await flushMicrotasks();            // let it reach the model call
    expect(callModelSpy, 'the first review did not reach the model').toHaveBeenCalledTimes(1);

    // Sweep 2, sixty seconds later. The task is still pending (the baseline has not moved), so
    // the sweep hands it over again — and the guard must refuse to start a second one.
    //
    // NOT awaited before the assertion, deliberately: with the guard removed, sweep 2 enters the
    // SAME hung model call and never settles, so an `await` here would make the clause fail by
    // 30-second test timeout instead of by assertion. Started-then-flushed, the mutant fails it
    // in milliseconds on the count that actually matters — "the model was asked twice".
    const sweep2 = runEffortReview('inflight-1');
    await flushMicrotasks();
    expect(callModelSpy, 'a SECOND review of the same task started while the first was in flight')
      .toHaveBeenCalledTimes(1);
    await sweep2;                       // the guard made this a no-op, so it is already resolved
    expect(effortRow('inflight-1').effort_reviewed_calls, 'the duplicate applied a verdict').toBe(0);
    expect(interveneCount('inflight-1'), 'the duplicate recorded a second circling verdict').toBe(0);

    // Now let the first one finish. Exactly one verdict, exactly one intervene record — so the
    // guarded poke sweep has exactly one rung-2 poke to deliver, not two.
    hungGate = false;
    releaseHungCall();
    await sweep1;

    expect(callModelSpy).toHaveBeenCalledTimes(1);
    expect(interveneCount('inflight-1'), 'exactly one circling verdict must be on record').toBe(1);
    expect(effortRow('inflight-1').effort_reviewed_calls).toBe(effortRow('inflight-1').effort_calls);
  });

  it('SINGLE-FLIGHT: a HANDLED failure (the budget abort) leaves the task reviewable next sweep', async () => {
    // The realistic failure: the latency budget fires and `callModel` rejects. The review's own
    // catch handles it, so nothing propagates — the guard is released on the ordinary path and
    // the durable request is simply still pending.
    seedOverThreshold('wedge-1');
    callModelThrows = new Error('aborted: latency budget');
    await runEffortReview('wedge-1');
    expect(effortRow('wedge-1').effort_reviewed_calls).toBe(0);

    callModelThrows = null;
    pmAnswers(JSON.stringify({ advancing: true, reason: 'landing progress after all', task_id: 'wedge-1' }));
    await runEffortReview('wedge-1');

    expect(callModelSpy, 'the retry never reached the model — the task is wedged').toHaveBeenCalledTimes(2);
    expect(effortRow('wedge-1').effort_reviewed_calls).toBe(effortRow('wedge-1').effort_calls);
  });

  it('SINGLE-FLIGHT: an UNCAUGHT failure still releases the guard — this is what the `finally` is for', async () => {
    // ⚠ THE CLAUSE THAT REACHES THE `finally`, and it took a mutant to notice it was missing.
    // The clause above cannot: `runEffortReviewOnce` catches its own model errors and RETURNS, so
    // the guard is released on the happy path and a release placed outside the `finally` passes
    // it. (Planted exactly that — M10 — and watched it stay green.) The `finally` exists for the
    // UNCAUGHT class, so this clause produces one: `writeTaskLog` writes a `work_events` row, so
    // dropping that table makes the verdict's audit write throw straight out of the review.
    // Without the `finally`, the in-flight marker is never cleared and THIS TASK CAN NEVER BE
    // REVIEWED AGAIN for the lifetime of the process — strictly worse than the bug this guard
    // fixes, which is why it is worth a clause of its own.
    seedOverThreshold('uncaught-1');
    pmAnswers(JSON.stringify({ advancing: true, reason: 'the audit write will fail', task_id: 'uncaught-1' }));
    mockDb.current!.exec('DROP TABLE work_events');

    await expect(runEffortReview('uncaught-1'), 'the audit write was expected to throw uncaught').rejects.toThrow();

    // Rebuild the table and prove the task is still reviewable: the guard was released.
    mockDb.current!.close();
    const db = new Database(':memory:');
    createWorkTable(db);
    createMessagesTable(db);
    createAgentsTable(db);
    db.prepare(`INSERT INTO agents (id, name, status, model_id) VALUES (?, 'PM', 'idle', 'test-model')`).run(PM_ID);
    mockDb.current = db;
    seedOverThreshold('uncaught-1');
    pmAnswers(JSON.stringify({ advancing: true, reason: 'now it works', task_id: 'uncaught-1' }));
    callModelSpy.mockClear();

    await runEffortReview('uncaught-1');

    expect(callModelSpy, 'the task is WEDGED — the guard was never released after the throw')
      .toHaveBeenCalledTimes(1);
    expect(effortRow('uncaught-1').effort_reviewed_calls).toBe(effortRow('uncaught-1').effort_calls);
  });

  it('SINGLE-FLIGHT is per TASK, not per PM — a different task still gets reviewed', async () => {
    // Counted the other way: a guard that keyed on the PM instead of the task would make this
    // RED, and would re-introduce round 1's lost-review class by another route.
    seedOverThreshold('par-a');
    seedOverThreshold('par-b');
    pmAnswers(JSON.stringify({ advancing: true, reason: 'fine', task_id: 'par-b' }));

    hungGate = true;
    const hung = runEffortReview('par-a');
    await flushMicrotasks();
    expect(callModelSpy).toHaveBeenCalledTimes(1);

    hungGate = false;
    await runEffortReview('par-b');
    expect(callModelSpy, 'an unrelated task was refused a review').toHaveBeenCalledTimes(2);
    expect(effortRow('par-b').effort_reviewed_calls).toBe(effortRow('par-b').effort_calls);

    releaseHungCall();
    await hung;
  });

  it('no PM model to ask is not a verdict either — and nothing is written', async () => {
    seedOverThreshold('nomodel-1');
    mockDb.current!.prepare('UPDATE agents SET model_id = NULL WHERE id = ?').run(PM_ID);

    await runEffortReview('nomodel-1');

    expect(callModelSpy).not.toHaveBeenCalled();
    expect(effortRow('nomodel-1').effort_reviewed_calls).toBe(0);
    expect(assistantRowCount(PM_ID)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §5 (T79 FIX WAVE, FINDING 4) — a terminal task is never handed back for review
// ════════════════════════════════════════════════════════════════════════════════

describe('§5 findPendingEffortReviewTaskIds — the terminal-state filter', () => {
  function seedOverThreshold(id: string, agentId = 'a1'): void {
    seedTrackerTask(mockDb.current!, { id, agentId, status: 'in_progress', title: 'Sweep the mailbox' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, id);
  }

  it('CONTROL — a genuinely pending in_progress task IS returned', () => {
    seedOverThreshold('pending-1');
    expect(queueEffortReviewIfNeeded('pending-1')).toBe(true);

    expect(findPendingEffortReviewTaskIds()).toEqual(['pending-1']);
  });

  it('the crash window: a transition applied to DONE before advanceBaseline ran is excluded, not handed to the PM', () => {
    seedOverThreshold('crashed-done');
    expect(queueEffortReviewIfNeeded('crashed-done')).toBe(true);

    // Simulate the crash: `setTrackerStatus` applied the transition (state -> done) but the
    // process died before its own `advanceBaseline` call, so the delta is still >= threshold
    // and the queued request marker is still (falsely) "pending".
    mockDb.current!.prepare(`UPDATE work SET state = 'done' WHERE id = ?`).run('crashed-done');

    expect(findPendingEffortReviewTaskIds()).toEqual([]);
  });

  it('the same crash window on a CANCELLED (abandoned) task is also excluded', () => {
    seedOverThreshold('crashed-cancelled');
    expect(queueEffortReviewIfNeeded('crashed-cancelled')).toBe(true);
    mockDb.current!.prepare(`UPDATE work SET state = 'abandoned' WHERE id = ?`).run('crashed-cancelled');

    expect(findPendingEffortReviewTaskIds()).toEqual([]);
  });

  it('the same crash window on a FALLEN (failed) task is also excluded', () => {
    seedOverThreshold('crashed-fallen');
    expect(queueEffortReviewIfNeeded('crashed-fallen')).toBe(true);
    mockDb.current!.prepare(`UPDATE work SET state = 'failed' WHERE id = ?`).run('crashed-fallen');

    expect(findPendingEffortReviewTaskIds()).toEqual([]);
  });

  it('a BLOCKED (non-terminal) task with a pending request is still returned — only TERMINAL states are excluded', () => {
    seedOverThreshold('still-blocked');
    expect(queueEffortReviewIfNeeded('still-blocked')).toBe(true);
    mockDb.current!.prepare(`UPDATE work SET state = 'blocked' WHERE id = ?`).run('still-blocked');

    expect(findPendingEffortReviewTaskIds()).toEqual(['still-blocked']);
  });
});
