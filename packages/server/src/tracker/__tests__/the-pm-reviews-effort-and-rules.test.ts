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
//   §4 (FIX ROUND, Finding 2, IMPORTANT) — the verdict is CORRELATED to its own request: a
//      busy PM defers the whole review, the read-back ignores anything older than the
//      dispatch, and a task_id mismatch is rejected.
//
// The LLM call is stubbed at the exact seam `effort-accumulates-until-the-task-advances.
// test.ts` already stubs it at for this same file: `agent/runtime.js`'s
// `getAgentRuntime().handleMessage`. Here the stub is made CONFIGURABLE per test (it has to
// simulate the PM's actual verdict text landing in `messages`, which the real runtime would
// do by actually calling a model) rather than a permanent no-op.

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

/** The LLM stub seam. Reassigned per test so each test controls what "the PM's turn" does —
 *  the real runtime would call a model and let it write an assistant message; the stub writes
 *  one directly, which is the behavioural contract `runEffortReview` actually depends on
 *  (it reads the PM's latest assistant `messages` row back after the turn returns). */
let handleMessageImpl: (agentId: string, content: string) => Promise<void> = async () => { /* no-op default */ };
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: (agentId: string, content: string) => handleMessageImpl(agentId, content) }),
}));

const deliverA2ASpy = vi.fn(async () => ({ delivered: true }));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...args: unknown[]) => deliverA2ASpy(...args),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { queueEffortReviewIfNeeded, runEffortReview, runPokeCheck } from '../pm-agent.js';
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
 *  `rowid` is the correlation boundary (Finding 2 fix), the same idiom `work_events.id`
 *  already uses elsewhere in this tree — an autoincrement, never a clock, so two rows landing
 *  in the same millisecond still order correctly. */
function createMessagesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
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

/** Simulate the PM's assistant reply landing in `messages`, the way a real model turn would. */
function pmReplies(pmId: string, content: string): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, datetime('now'))`,
  ).run(`m-${Math.random()}`, pmId, content);
}

/** Dynamic `import().then()` deliveries (the poke sweep's own long-standing shape) resolve on
 *  a LATER microtask than `runPokeCheck`'s own returned promise — flush it before asserting
 *  on `deliverA2ASpy`. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  createMessagesTable(db);
  mockDb.current = db;
  handleMessageImpl = async () => { /* reset to the no-op default each test */ };
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
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, JSON.stringify({ advancing: true, reason: '400-email sweep, labels are landing steadily', task_id: 'adv-1' }));
    };

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
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, JSON.stringify({ advancing: false, reason: 'same three calls repeated with nothing new landing', task_id: 'circ-1' }));
    };

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
    let asked = false;
    handleMessageImpl = async () => { asked = true; };

    await runEffortReview('under-1');

    expect(asked).toBe(false);
    expect(effortRow('under-1').effort_reviewed_calls).toBe(0);
    expect(pokeCount('under-1')).toBe(0);
  });

  it('an unparseable PM reply leaves the baseline untouched and pokes nobody — the request just retries next cycle', async () => {
    seedOverThreshold('garbled-1');
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, 'sorry, I got distracted and did not answer the question');
    };

    await runEffortReview('garbled-1');

    const row = effortRow('garbled-1');
    expect(row.effort_reviewed_calls).toBe(0); // NOT moved — still pending, will retry
    expect(pokeCount('garbled-1')).toBe(0);
    expect(deliverA2ASpy).not.toHaveBeenCalled();
  });

  it('the assignee is never sent anything, and no steer enters its turn, on the advancing=true path', async () => {
    seedOverThreshold('adv-2');
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, JSON.stringify({ advancing: true, reason: 'still going, still landing real progress', task_id: 'adv-2' }));
    };

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
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, JSON.stringify({
        advancing: false, reason: 'same handful of calls, nothing new landing', task_id: 'circ-guard-1',
      }));
    };
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
    const [envelope] = deliverA2ASpy.mock.calls[0] as [{ payload: string; toAgent: string; intent: string }];
    expect(envelope.toAgent).toBe('a1');
    expect(envelope.intent).toBe('QUESTION');
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
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, JSON.stringify({
        advancing: false, reason: 'circling on the same three files', task_id: 'circ-guard-2',
      }));
    };
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

describe('§4 the verdict is correlated: a busy PM defers, a stale reply is ignored, a mismatched task_id is rejected', () => {
  function seedOverThreshold(id: string, agentId = 'a1'): void {
    seedTrackerTask(mockDb.current!, { id, agentId, status: 'in_progress', title: 'Sweep the mailbox' });
    mockDb.current!.prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?')
      .run(EFFORT_REVIEW_DELTA_CALLS, id);
  }

  it('a busy PM defers the review entirely: nothing dispatched, nothing read, the durable request stays pending', async () => {
    seedOverThreshold('busy-1');
    expect(queueEffortReviewIfNeeded('busy-1')).toBe(true); // the durable pending marker

    let dispatched = false;
    handleMessageImpl = async () => { dispatched = true; };
    pmActiveRuns.add(PM_ID);
    try {
      await runEffortReview('busy-1');
    } finally {
      pmActiveRuns.delete(PM_ID);
    }

    expect(dispatched).toBe(false); // handleMessage was never even called
    expect(effortRow('busy-1').effort_reviewed_calls).toBe(0); // untouched
    expect(interveneCount('busy-1')).toBe(0);
    expect(deliverA2ASpy).not.toHaveBeenCalled();
    // Still pending — a second queue attempt does not file a duplicate, proving the durable
    // marker was left exactly as it was (this is the "self-heal already exists" re-drive:
    // the NEXT runPMReview tick will try the review again).
    expect(queueEffortReviewIfNeeded('busy-1')).toBe(false);
    expect(requestCount('busy-1')).toBe(1);
  });

  it('a pre-existing OLDER {advancing,...} message in the PM history is NOT mistaken for this request\'s verdict', async () => {
    seedOverThreshold('stale-1');
    // An older reply sitting in the PM's history from some earlier, unrelated exchange —
    // written BEFORE this review dispatches, so it predates the correlation boundary.
    pmReplies(PM_ID, JSON.stringify({ advancing: true, reason: 'an old unrelated verdict', task_id: 'stale-1' }));
    // This review's OWN turn writes nothing new (e.g. the PM called a tool and produced no
    // fresh plain-text reply) — the correlation boundary must still refuse the OLD message
    // rather than fall back to "whatever the newest PM message happens to be."
    handleMessageImpl = async () => { /* no new assistant message this turn */ };

    await runEffortReview('stale-1');

    expect(effortRow('stale-1').effort_reviewed_calls).toBe(0); // the stale verdict was NOT applied
    expect(interveneCount('stale-1')).toBe(0);
  });

  it('a verdict whose task_id does not match this request is REJECTED, not applied', async () => {
    seedOverThreshold('mismatch-1');
    seedOverThreshold('mismatch-2'); // the (wrong) task the garbled verdict claims to be about
    handleMessageImpl = async (agentId) => {
      pmReplies(agentId, JSON.stringify({ advancing: true, reason: 'looks fine to me', task_id: 'mismatch-2' }));
    };

    await runEffortReview('mismatch-1');

    // Rejected: neither task is touched by a verdict that named the wrong one.
    expect(effortRow('mismatch-1').effort_reviewed_calls).toBe(0);
    expect(effortRow('mismatch-2').effort_reviewed_calls).toBe(0);
    expect(deliverA2ASpy).not.toHaveBeenCalled();
  });
});
