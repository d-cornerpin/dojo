// SLOW-INFERENCE T79c — THE DURABLE PER-TASK EFFORT METER.
//
// A wide loop's signature is effort-without-advancement, and this is the wide-loop net:
// tool calls charged to the tracker task in SQLite, where compaction can't erase them.
// This file pins the three pieces:
//   §1 `tracker/effort-governor.ts` itself — chargeEffort / effortDelta / advanceBaseline,
//      against nothing but the `work` row (no model calls, no engine loop).
//   §2 `agent/v2/steps/execute/tracker-counting.ts`'s `resolveCurrentClaimedTaskId` — the
//      charge site's "which task pays for this call" resolution.
//   §3 the ADVANCE wiring through the real production choke point,
//      `work/tracker-store.ts:setTrackerStatus` — "the tracker's one status writer", which
//      is how `work_update(action="status")` (`tracker/tools.ts:2017`),
//      `work_update(action="complete_step")` (`tracker/tools.ts:3381`) and
//      `work_update(action="close_project")` (`tracker/schema.ts:410,426`, via
//      `closeProjectAndOpenTasks`) — plus every PM validate/override path — all reach it.
//   §4 the literal adversarial case at the TOOL-RESULT level: `trackerUpdateStatus` itself,
//      so "[NO-OP]" is not just an internal `no_change` outcome but the actual string a
//      looping agent would see, and the meter still does not move underneath it.
//   §5 CODE-REVIEW FIX (Important finding): §3 pinned the convergence of `complete_step` and
//      `close_project` onto `setTrackerStatus` only in COMMENTS. This section calls
//      `trackerCompleteStep` and `closeProjectAndOpenTasks` directly, so a future refactor
//      that gave either verb a fast path bypassing `setTrackerStatus` would be caught here
//      rather than only in a comment nobody re-reads. It also pins the fact the comments were
//      eliding: for a plain WORKER agent, `trackerCompleteStep` never itself produces an
//      applied `done` transition on a real (non-a2a) tracker task — PHASE-2 T8T's two-key
//      contract (RULING 1, `work/store.ts` G9, `two-key-completion.test.ts`) makes an agent's
//      own close a Key-1 REQUEST, and the baseline correctly does not move for a request. The
//      genuine advance happens when the PM turns Key 2 (`trackerValidateComplete`, `by: 'pm',
//      claim: 'authoritative'`) — the SAME `setTrackerStatus` call, a different caller. Both
//      halves are covered so "complete_step moves the baseline to current" is demonstrated
//      accurately rather than by constructing a scenario the real gate would never allow.
//      `close_project` has no such caveat: closing as `cancelled` (the tool's own documented
//      default) targets `abandoned`, not `done`, so G9 never applies and the baseline moves
//      directly on the first call, exactly as literally requested.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
// §4 imports `tracker/tools.js`, whose module-level imports would otherwise pull in real
// notification / PM / runtime machinery — the same mocks
// `cancelled-is-a-real-word.test.ts` uses, for the identical reason.
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
  // §5's trackerValidateComplete terminal-close path dynamically imports this.
  checkDependencies: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { chargeEffort, effortDelta, advanceBaseline, EFFORT_REVIEW_DELTA_CALLS } from '../effort-governor.js';
import { resolveCurrentClaimedTaskId } from '../../agent/v2/steps/execute/tracker-counting.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { trackerUpdateStatus, trackerCompleteStep, trackerValidateComplete } from '../tools.js';
import { closeProjectAndOpenTasks } from '../schema.js';
import { createWorkTable, seedTrackerTask, seedTrackerProject } from '../../work/__tests__/work-fixture.js';

function effortRow(id: string): { effort_calls: number; effort_reviewed_calls: number } {
  return mockDb.current!.prepare(
    'SELECT effort_calls, effort_reviewed_calls FROM work WHERE id = ?',
  ).get(id) as { effort_calls: number; effort_reviewed_calls: number };
}

function stateOf(id: string): string {
  return (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
}

/** The full schema `trackerUpdateStatus` needs to run end to end (§4 only); the base
 *  fixture alone is enough for §1-3, which stay below the tool layer. Copied from
 *  `cancelled-is-a-real-word.test.ts`'s own `applySchema`, same reason. */
function applyToolsSchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS task_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_entity TEXT NOT NULL,
      entry_kind TEXT NOT NULL, from_status TEXT, to_status TEXT, reason TEXT,
      action_taken TEXT, note TEXT, evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at TEXT,
      turn_number INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, task_id TEXT, run_id TEXT, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      swept_at TEXT, served_by_turn INTEGER, answer_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — the meter itself
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 chargeEffort / effortDelta / advanceBaseline — the durable meter itself', () => {
  beforeEach(() => {
    seedTrackerTask(mockDb.current!, { id: 't1', title: 'Do the thing' });
  });

  it('charges accumulate across two simulated turns, in the row, not in memory', () => {
    chargeEffort('t1', 40); // "turn" 1
    chargeEffort('t1', 65); // "turn" 2
    expect(effortRow('t1').effort_calls).toBe(105);
  });

  it('a non-positive charge does nothing (no call happened, nothing is charged)', () => {
    chargeEffort('t1', 0);
    chargeEffort('t1', -3);
    expect(effortRow('t1').effort_calls).toBe(0);
  });

  it('effortDelta survives a wipe of in-memory state — the compaction stand-in', () => {
    chargeEffort('t1', 12);
    chargeEffort('t1', 8);
    // Simulate compaction: the only thing that must still be true afterward is what the
    // DATABASE holds, not any JS variable that watched the charges happen. Drop every
    // local reference and re-derive from a fresh read, exactly as a brand-new process (or
    // a post-compaction turn that lost its own history) would have to.
    let watchedDuringTheTurn: number | undefined = 20;
    watchedDuringTheTurn = undefined; // <- the compaction: nothing in memory survives this
    void watchedDuringTheTurn;
    const freshlyReadRow = effortRow('t1');
    expect(effortDelta(freshlyReadRow)).toBe(20);
  });

  it('a fresh task that was never charged and never advanced reads delta 0', () => {
    seedTrackerTask(mockDb.current!, { id: 't2', title: 'Untouched' });
    expect(effortDelta(effortRow('t2'))).toBe(0);
  });

  it('advanceBaseline moves the baseline to the current total; the lifetime count is kept, not erased', () => {
    chargeEffort('t1', 150);
    advanceBaseline('t1');
    const row = effortRow('t1');
    expect(row.effort_calls).toBe(150);          // history kept
    expect(row.effort_reviewed_calls).toBe(150); // baseline moved to meet it
    expect(effortDelta(row)).toBe(0);
  });

  it('a later charge after advancement starts the new delta from the moved baseline, not from the erased history', () => {
    chargeEffort('t1', 150);
    advanceBaseline('t1');
    chargeEffort('t1', 30);
    const row = effortRow('t1');
    expect(row.effort_calls).toBe(180);
    expect(effortDelta(row)).toBe(30);
  });

  it('EFFORT_REVIEW_DELTA_CALLS is the one declared threshold, 150', () => {
    expect(EFFORT_REVIEW_DELTA_CALLS).toBe(150);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — the charge site's "which task pays" resolution
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 resolveCurrentClaimedTaskId — the charge site\'s "which task pays" resolution', () => {
  it('no claimed task: resolves to null (charge nothing)', () => {
    expect(resolveCurrentClaimedTaskId('a1')).toBeNull();
  });

  it('one claimed task: resolves to it', () => {
    seedTrackerTask(mockDb.current!, { id: 't1', agentId: 'a1', status: 'in_progress' });
    expect(resolveCurrentClaimedTaskId('a1')).toBe('t1');
  });

  it('an on_deck (queued) task is not a CLAIMED task and is never picked', () => {
    seedTrackerTask(mockDb.current!, { id: 't1', agentId: 'a1', status: 'on_deck' });
    expect(resolveCurrentClaimedTaskId('a1')).toBeNull();
  });

  it('a task claimed by a DIFFERENT agent is never picked', () => {
    seedTrackerTask(mockDb.current!, { id: 't1', agentId: 'someone-else', status: 'in_progress' });
    expect(resolveCurrentClaimedTaskId('a1')).toBeNull();
  });

  it('multiple claimed tasks: the MOST RECENTLY UPDATED one wins, deterministically', () => {
    seedTrackerTask(mockDb.current!, {
      id: 'older', agentId: 'a1', status: 'in_progress', updated_at: 1_700_000_000_000,
    });
    seedTrackerTask(mockDb.current!, {
      id: 'newer', agentId: 'a1', status: 'in_progress', updated_at: 1_700_000_050_000,
    });
    expect(resolveCurrentClaimedTaskId('a1')).toBe('newer');
    // Touch the older one and it takes over — the pick tracks LIVE state, not insertion
    // order or which row happened to be seeded first.
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(1_700_000_100_000, 'older');
    expect(resolveCurrentClaimedTaskId('a1')).toBe('older');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — the ADVANCE wiring, through the real single writer
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 the ADVANCE wiring — setTrackerStatus (the tracker\'s one status writer)', () => {
  it('an applied transition moves the baseline to the current total', () => {
    seedTrackerTask(mockDb.current!, { id: 't3', agentId: 'a1', status: 'in_progress' });
    chargeEffort('t3', 42);
    expect(effortDelta(effortRow('t3'))).toBe(42);

    const r = setTrackerStatus('t3', 'blocked', {
      by: 'agent', actorId: 'a1', reason: 'waiting on the owner',
    });

    expect(r.kind).toBe('applied');
    expect(stateOf('t3')).toBe('blocked');
    expect(effortDelta(effortRow('t3'))).toBe(0);   // baseline moved
    expect(effortRow('t3').effort_calls).toBe(42);  // lifetime total kept, not erased
  });

  it('the no-op-status adversarial case: a looping agent spamming the SAME status cannot reset its own meter', () => {
    seedTrackerTask(mockDb.current!, { id: 't4', agentId: 'a1', status: 'blocked' });
    chargeEffort('t4', 77);

    // `transition()`'s own G4 gate refuses to move a row that is already there,
    // returning `no_change` rather than `applied` — spammed twice, exactly the loop
    // this meter exists to catch.
    const r1 = setTrackerStatus('t4', 'blocked', { by: 'agent', actorId: 'a1', reason: 'still waiting' });
    const r2 = setTrackerStatus('t4', 'blocked', { by: 'agent', actorId: 'a1', reason: 'still waiting' });

    expect(r1.kind).toBe('no_change');
    expect(r2.kind).toBe('no_change');
    expect(effortDelta(effortRow('t4'))).toBe(77); // unmoved after two no-op spam calls
  });

  it('a refused (illegal) transition does not move the baseline either', () => {
    seedTrackerTask(mockDb.current!, { id: 't5', agentId: 'a1', status: 'complete' });
    chargeEffort('t5', 9);

    // done -> blocked is not a legal move (the LEGAL table in work/store.ts).
    const r = setTrackerStatus('t5', 'blocked', { by: 'agent', actorId: 'a1', reason: 'try to reopen' });

    expect(r.kind).toBe('refused');
    expect(effortDelta(effortRow('t5'))).toBe(9);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 — the literal tool-result adversarial case
// ════════════════════════════════════════════════════════════════════════════════

describe('§4 trackerUpdateStatus — the actual tool result says "[NO-OP]", and the meter agrees', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    applyToolsSchema(db);
    mockDb.current = db;
  });

  it('a same-status call returns [NO-OP] and the meter is untouched', () => {
    seedTrackerTask(mockDb.current!, { id: 'noop-task-001', agentId: 'a1', status: 'in_progress' });
    chargeEffort('noop-task-001', 33);

    const out = trackerUpdateStatus('a1', { taskId: 'noop-task-001', status: 'in_progress' });

    expect(out).toContain('[NO-OP]');
    const row = effortRow('noop-task-001');
    expect(row.effort_reviewed_calls).toBe(0); // baseline never moved
    expect(effortDelta(row)).toBe(33);         // spamming this call cannot reset the meter
  });

  it('CONTROL — a real status change through the same tool DOES move the baseline', () => {
    seedTrackerTask(mockDb.current!, { id: 'real-task-001', agentId: 'a1', status: 'on_deck' });
    chargeEffort('real-task-001', 12);

    const out = trackerUpdateStatus('a1', { taskId: 'real-task-001', status: 'cancelled' });

    expect(out).toContain('[OK]');
    expect(effortDelta(effortRow('real-task-001'))).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §5 — CODE-REVIEW FIX: complete_step and close_project, called directly
// ════════════════════════════════════════════════════════════════════════════════

describe('§5 trackerCompleteStep and closeProjectAndOpenTasks, called directly (not just cited in comments)', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    applyToolsSchema(db);
    mockDb.current = db;
  });

  describe('trackerCompleteStep — the two-key contract\'s two halves, both through setTrackerStatus', () => {
    /** A delivery `deliveryForTaskClose` can resolve (or the task's own `result_delivery_id`
     *  fallback can point at) so G7 ("done means delivered") never blocks either call below —
     *  the property under test here is the TWO-KEY gate (G9), not the delivery gate. */
    function seedDelivery(db: Database.Database, id: string, agentId: string): void {
      db.prepare(
        `INSERT INTO deliveries (id, agent_id, outcome, tool, created_at, turn_number)
         VALUES (?, ?, 'delivered', 'send_message', datetime('now'), NULL)`,
      ).run(id, agentId);
    }

    it('a plain agent\'s call FILES A KEY-1 REQUEST and does not itself advance the baseline', () => {
      // Measured, not assumed (this test was written against the real return string and
      // state after running it): a worker agent can never close its own tracker task
      // directly (PHASE-2 T8T, "an agent no longer closes one on its own say-so", G9 in
      // `work/store.ts`) — `setTrackerStatus`'s `transition()` call refuses with
      // `requires-validation`, which is `kind: 'refused'`, never `'applied'`. My wiring at
      // `setTrackerStatus` therefore correctly does NOT call `advanceBaseline` here — this is
      // the SAME "refused does not advance" property §3 already pins, now proven through
      // `trackerCompleteStep`'s own real call site rather than a direct `setTrackerStatus` call.
      seedTrackerTask(mockDb.current!, {
        id: 'complete-step-task', agentId: 'a1', status: 'in_progress', result_delivery_id: 'd-1',
      });
      seedDelivery(mockDb.current!, 'd-1', 'a1');
      chargeEffort('complete-step-task', 60);

      const out = trackerCompleteStep('a1', { taskId: 'complete-step-task' });

      expect(out, out).toContain('[FILED]');
      expect(stateOf('complete-step-task')).toBe('claimed'); // NOT moved to done — Key 1 only
      expect(effortDelta(effortRow('complete-step-task'))).toBe(60); // baseline untouched
    });

    it('the PM turning Key 2 (trackerValidateComplete) — the SAME setTrackerStatus choke point, a different caller — DOES move the baseline: this is "complete_step moves the baseline to current" in full', async () => {
      seedTrackerTask(mockDb.current!, {
        id: 'req-task-001', agentId: 'a1', status: 'in_progress', result_delivery_id: 'd-1',
      });
      seedDelivery(mockDb.current!, 'd-1', 'a1');
      chargeEffort('req-task-001', 60);

      // Step 1 — the worker files the request (Key 1). Baseline untouched, exactly as above.
      const filed = trackerCompleteStep('a1', { taskId: 'req-task-001' });
      expect(filed, filed).toContain('[FILED]');
      expect(effortDelta(effortRow('req-task-001'))).toBe(60);

      // Step 2 — the PM turns Key 2. `by: 'pm', claim: 'authoritative'` clears G9, so THIS
      // call is where `transition()` actually applies the move to `done`.
      const validated = await trackerValidateComplete('pm', { task_id: 'req-task-001', valid: true });

      expect(validated, validated).toContain('[OK]');
      expect(stateOf('req-task-001')).toBe('done');
      expect(effortDelta(effortRow('req-task-001'))).toBe(0);       // baseline moved
      expect(effortRow('req-task-001').effort_calls).toBe(60);      // lifetime total kept
    });
  });

  describe('closeProjectAndOpenTasks — moves the baseline directly, no two-key caveat', () => {
    it('closes every open child task AND the project row itself, moving each one\'s baseline', () => {
      seedTrackerProject(mockDb.current!, { id: 'proj-1', agentId: 'a1', status: 'active' });
      seedTrackerTask(mockDb.current!, { id: 'child-1', agentId: 'a1', status: 'in_progress', projectId: 'proj-1' });
      seedTrackerTask(mockDb.current!, { id: 'child-2', agentId: 'a1', status: 'on_deck', projectId: 'proj-1' });
      chargeEffort('child-1', 88);
      chargeEffort('child-2', 21);
      chargeEffort('proj-1', 5);
      expect(effortDelta(effortRow('child-1'))).toBe(88);
      expect(effortDelta(effortRow('child-2'))).toBe(21);
      expect(effortDelta(effortRow('proj-1'))).toBe(5);

      // 'cancelled' — the tool's own documented default for this verb — targets `abandoned`,
      // not `done`, so the two-key gate (G9) never applies and this is a genuine `applied`
      // transition on the first call, for every row it touches.
      const result = closeProjectAndOpenTasks({
        projectId: 'proj-1', closingAgentId: 'a1',
        taskStatus: 'cancelled', projectStatus: 'cancelled', reason: 'scope changed',
      });

      expect(result).toEqual({ projectId: 'proj-1', tasksClosed: 2, alreadyClosed: 0, refused: 0 });
      expect(effortDelta(effortRow('child-1'))).toBe(0);
      expect(effortDelta(effortRow('child-2'))).toBe(0);
      expect(effortDelta(effortRow('proj-1'))).toBe(0); // the project row itself, schema.ts:426
      expect(effortRow('child-1').effort_calls).toBe(88); // lifetime totals kept, not erased
      expect(effortRow('child-2').effort_calls).toBe(21);
      expect(effortRow('proj-1').effort_calls).toBe(5);
    });

    it('a task already terminal is skipped (alreadyClosed), and its baseline is correctly left alone', () => {
      seedTrackerProject(mockDb.current!, { id: 'proj-2', agentId: 'a1', status: 'active' });
      seedTrackerTask(mockDb.current!, { id: 'done-already', agentId: 'a1', status: 'complete', projectId: 'proj-2' });
      chargeEffort('done-already', 14);

      const result = closeProjectAndOpenTasks({
        projectId: 'proj-2', closingAgentId: 'a1',
        taskStatus: 'cancelled', projectStatus: 'cancelled', reason: 'cleanup',
      });

      expect(result.tasksClosed).toBe(0);
      expect(result.alreadyClosed).toBe(1);
      expect(effortDelta(effortRow('done-already'))).toBe(14); // never touched a second time
    });
  });
});
