// ════════════════════════════════════════════════════════════════════════════════════════
// THE VERSION-GAP RECONCILIATION PASS — the owner's "stale project checker", owner-requested
// 2026-08-06 from his own agent's report on his preflight box, landed by SWEEP CORE-2 item 3.
//
// HIS CASE: a prior build's broken `close_project` left his production dojo carrying 27 stale
// projects while the board reported 29 "Active" with zero in-progress work. The fix ships; the
// wreckage stays. Nothing in the tree reconciles tracker state across a version change.
//
// ── THE POPULATION, AND WHY THE ADVERSARIAL BODY IS THE COVERAGE (#15, #16) ─────────────
// The dev body has ZERO stale projects — measured 2026-08-06 by the orchestrator (228 projects,
// ALL terminal: 222 done / 6 abandoned; zero-task ghosts 0; all-terminal-but-open 0) because
// this box was reset during the overhaul. That is ABSENCE OF EVIDENCE, NOT EVIDENCE OF ABSENCE.
// So the coverage below is an ADVERSARIAL BODY carrying every shape at once, with a branch
// count per body, and the rehearsal on a `VACUUM INTO` copy of the real box is recorded in the
// task report as the second body.
//
// ── HIS SIX REQUIREMENTS, EACH A CLAUSE ────────────────────────────────────────────────
//   C1  A DECLARED PER-RELEASE STEP. The gap between the previous and current version decides
//       which steps run, and the facility is declared — not a hand-rolled boot block, which is
//       what `scheduler/anchor-compensation.ts` had to be because there was nowhere to declare it.
//   C2  IDEMPOTENT, PROVEN BY DRIVING IT TWICE.
//   C3  HIS FOUR CHECKS.
//   C4  HIS SAFETY CONSTRAINTS, VERBATIM: never close a project holding any `in_progress`/
//       `on_deck` task; never touch task-level data; flag-don't-touch when ambiguous.
//   C5  REPORT, NEVER REWRITE — except where a STRUCTURAL invariant makes the case unambiguous.
//   C6  A DENOMINATOR IS MANDATORY, and ONE plain line reaches him the OR2 way.
// ════════════════════════════════════════════════════════════════════════════════════════

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
const notices: Array<{ toAgentId: string; brief: string; intent?: string; selfIntro?: boolean }> = [];
vi.mock('../../agent/agent-notice.js', () => ({
  postAgentNotice: (o: { toAgentId: string; brief: string; intent?: string; selfIntro?: boolean }) => {
    notices.push(o); return 'notice-id';
  },
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
}));
import { createWorkTable, seedTrackerTask, seedTrackerProject } from '../../work/__tests__/work-fixture.js';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle'
    );
    CREATE TABLE IF NOT EXISTS healer_actions (
      id TEXT PRIMARY KEY, diagnostic_id TEXT, category TEXT, description TEXT,
      agent_id TEXT, action_taken TEXT, result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS turn_artifacts (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS adjudications (
      id INTEGER PRIMARY KEY, work_id TEXT, claim_state TEXT, verdict TEXT, by_agent TEXT,
      evidence_ref TEXT, note TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT, lane TEXT NOT NULL DEFAULT 'owner',
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, token_count INTEGER NOT NULL DEFAULT 0,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      served_by_turn INTEGER, swept_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, retired_at TEXT,
      origin_kind TEXT DEFAULT NULL, provenance TEXT NOT NULL DEFAULT 'live',
      sent_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES ('primary','Primary','idle')`).run();
  db.prepare(`INSERT INTO agents (id, name, status) VALUES ('ghost','Ghost','terminated')`).run();
}

/**
 * ⚠ THE REPAIR ARM CANNOT BE PROVEN ON A BODY WITH NO DELIVERIES, AND THAT IS G7 WORKING.
 *
 * The first adversarial body seeded `complete` tasks with no `result_delivery_id`, so the
 * rollup close `checkProjectCompletion` performs was REFUSED by the work gate — a `done` row
 * must point at a delivery — and `repaired` came back 0. The idempotence clause below then
 * passed for the wrong reason: "the second pass repaired nothing" is trivially true when the
 * first repaired nothing either. Recorded rather than quietly fixed: the body is widened so
 * the repair genuinely happens once, and the clause asserts 1-then-0.
 */
function deliverTask(db: Database.Database, taskId: string, deliveryId: string): void {
  db.prepare(`INSERT OR IGNORE INTO deliveries (id, agent_id, outcome, tool, created_at)
              VALUES (?, 'primary', 'sent', 'dashboard', 1700000000000)`).run(deliveryId);
  db.prepare('UPDATE work SET result_delivery_id = ? WHERE id = ?').run(deliveryId, taskId);
}

/** A project row with N tasks in the given statuses. */
function seedProject(
  db: Database.Database, id: string, taskStatuses: string[],
  opts: { projectStatus?: string; agentId?: string } = {},
): void {
  seedTrackerProject(db, { id, status: opts.projectStatus ?? 'active', createdBy: 'primary', agentId: 'primary', title: id });
  taskStatuses.forEach((status, i) => {
    seedTrackerTask(db, {
      id: `${id}-t${i}`, status, createdBy: 'primary',
      agentId: opts.agentId ?? 'primary', projectId: id, title: `${id} task ${i}`,
    });
  });
}

beforeEach(() => {
  notices.length = 0;
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════
// C1 — THE DECLARED PER-RELEASE FACILITY
// ════════════════════════════════════════════════════════════════════════════════

describe('C1 release steps are DECLARED, and the version gap decides which run', () => {
  it('a step whose release is inside the gap runs; one already behind the last boot does not', async () => {
    const { stepsInGap } = await import('../../release/release-steps.js');
    const steps = [
      { id: 'old', sinceVersion: '2.0.0' },
      { id: 'this-one', sinceVersion: '3.2.0' },
      { id: 'future', sinceVersion: '9.0.0' },
    ];
    // The box last ran steps at 3.1.0 and is now on 3.2.0.
    expect(stepsInGap(steps, { from: '3.1.0', to: '3.2.0' }).map(s => s.id)).toEqual(['this-one']);
    // Nothing moved: no step runs.
    expect(stepsInGap(steps, { from: '3.2.0', to: '3.2.0' })).toEqual([]);
    // A box with no recorded history runs everything at or below the current version — its
    // wreckage could have come from any release.
    expect(stepsInGap(steps, { from: null, to: '3.2.0' }).map(s => s.id)).toEqual(['old', 'this-one']);
  });

  it('the reconciliation pass IS one of the declared steps', async () => {
    const { RELEASE_STEPS } = await import('../../release/release-steps.js');
    const ids = RELEASE_STEPS.map(s => s.id);
    expect(ids).toContain('version-gap-reconcile');
    for (const s of RELEASE_STEPS) {
      expect(s.sinceVersion, `${s.id} declares no release`).toMatch(/^\d+\.\d+\.\d+/);
      expect(s.pays.length, `${s.id} does not say what it pays for`).toBeGreaterThan(30);
    }
  });

  it('the marker key is NEW and declared — `platform_version` has readers and no writer', async () => {
    const { RELEASE_STEPS_VERSION_KEY } = await import('../../release/release-steps.js');
    expect(RELEASE_STEPS_VERSION_KEY).toBe('release_steps_last_version');
    expect(RELEASE_STEPS_VERSION_KEY).not.toBe('platform_version');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// C3 — HIS FOUR CHECKS, ON AN ADVERSARIAL BODY CARRYING EVERY SHAPE
// ════════════════════════════════════════════════════════════════════════════════

describe('C3 the four checks, on a body carrying every shape at once', () => {
  function adversarialBody(db: Database.Database): void {
    // (a) every task terminal, project still open — the repairable shape.
    seedProject(db, 'p-all-done', ['complete', 'complete']);
    // (a') every task terminal but one FELL — D-K says LEAVE IT OPEN, deliberately.
    seedProject(db, 'p-fallen', ['complete', 'fallen']);
    // (b) a zero-task ghost.
    seedProject(db, 'p-empty', []);
    // (c) status contradicts the aggregate: project marked complete, a task still running.
    seedProject(db, 'p-contradiction', ['in_progress'], { projectStatus: 'complete' });
    // (d) a task dangling in_progress on a terminated assignee.
    seedProject(db, 'p-ghost-assignee', ['in_progress'], { agentId: 'ghost' });
    // THE CONTROL: a perfectly ordinary live project. It must appear in the denominator and
    // in NO finding — a checker that flags healthy work is worse than no checker.
    seedProject(db, 'p-healthy', ['in_progress', 'on_deck']);
  }

  it('finds each shape exactly once, and leaves the healthy project alone', async () => {
    const { scanVersionGap } = await import('../version-gap-reconcile.js');
    adversarialBody(mockDb.current!);

    const scan = scanVersionGap();
    const byShape = (s: string) => scan.findings.filter(f => f.shape === s).map(f => f.id);

    expect(byShape('all-tasks-terminal-but-open')).toEqual(['p-all-done']);
    expect(byShape('zero-task-ghost')).toEqual(['p-empty']);
    expect(byShape('status-contradicts-tasks')).toEqual(['p-contradiction']);
    expect(byShape('dangling-in-progress-dormant-assignee')).toEqual(['p-ghost-assignee-t0']);
    expect(scan.findings.map(f => f.id)).not.toContain('p-healthy');
  });

  it('D-K holds: a project whose last task FELL is left open on purpose, not flagged as done', async () => {
    const { scanVersionGap } = await import('../version-gap-reconcile.js');
    adversarialBody(mockDb.current!);
    const scan = scanVersionGap();
    expect(scan.findings.filter(f => f.shape === 'all-tasks-terminal-but-open').map(f => f.id))
      .not.toContain('p-fallen');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// C6 — THE DENOMINATOR IS MANDATORY
// ════════════════════════════════════════════════════════════════════════════════

describe('C6 a repair with no denominator is not evidence', () => {
  it('reports how many were EXAMINED, not only how many changed', async () => {
    const { scanVersionGap } = await import('../version-gap-reconcile.js');
    seedProject(mockDb.current!, 'p1', ['complete']);
    seedProject(mockDb.current!, 'p2', ['in_progress']);
    seedProject(mockDb.current!, 'p3', []);

    const scan = scanVersionGap();
    expect(scan.projectsExamined).toBe(3);
    expect(scan.tasksExamined).toBe(2);
  });

  it('every examined project is accounted for: stand-downs plus findings equal the denominator', async () => {
    const { scanVersionGap } = await import('../version-gap-reconcile.js');
    seedProject(mockDb.current!, 'p-all-done', ['complete']);
    seedProject(mockDb.current!, 'p-fallen', ['complete', 'fallen']);
    seedProject(mockDb.current!, 'p-empty', []);
    seedProject(mockDb.current!, 'p-healthy', ['in_progress']);

    const scan = scanVersionGap();
    const standDownTotal = Object.values(scan.projectStandDown).reduce((a, b) => a + b, 0);
    const projectFindings = scan.findings.filter(f => f.subject === 'project').length;
    expect(standDownTotal + projectFindings).toBe(scan.projectsExamined);
    // Every stand-down carries a NAMED reason — "the rest" is not a reason.
    for (const k of Object.keys(scan.projectStandDown)) expect(k.length).toBeGreaterThan(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// C4/C5 — THE SAFETY CONSTRAINTS, VERBATIM
// ════════════════════════════════════════════════════════════════════════════════

describe('C4 his safety constraints', () => {
  it('never closes a project holding any in_progress or on_deck task', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-live', ['complete', 'in_progress']);
    seedProject(db, 'p-ondeck', ['complete', 'on_deck']);

    await runVersionGapReconcile();
    for (const id of ['p-live', 'p-ondeck']) {
      const row = db.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string };
      expect(row.state, `${id} was closed while it still held live work`).toBe('open');
    }
  });

  it('never touches task-level data — the dangling task is REPORTED, not reassigned or closed', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-ghost-assignee', ['in_progress'], { agentId: 'ghost' });
    const before = db.prepare('SELECT state, agent_id FROM work WHERE id = ?').get('p-ghost-assignee-t0');

    const out = await runVersionGapReconcile();
    const after = db.prepare('SELECT state, agent_id FROM work WHERE id = ?').get('p-ghost-assignee-t0');
    expect(after).toEqual(before);
    expect(out.findings.some(f => f.shape === 'dangling-in-progress-dormant-assignee')).toBe(true);
  });

  it('flag-don\'t-touch when ambiguous: a zero-task ghost is reported, never closed', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-empty', []);

    await runVersionGapReconcile();
    const row = db.prepare('SELECT state FROM work WHERE id = ?').get('p-empty') as { state: string };
    expect(row.state, 'an empty project carries no record of intent — flag it, do not close it')
      .toBe('open');
  });
});

describe('C5 report, never rewrite — except where the structure is unambiguous', () => {
  it('every finding carries its correction and says why, so a report is actionable', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-empty', []);
    seedProject(db, 'p-contradiction', ['in_progress'], { projectStatus: 'complete' });
    seedProject(db, 'p-ghost-assignee', ['in_progress'], { agentId: 'ghost' });

    const out = await runVersionGapReconcile();
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(f.correction.length, `${f.shape} has no correction`).toBeGreaterThan(10);
      expect(f.why.length, `${f.shape} does not say why it is a finding`).toBeGreaterThan(20);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// C2 — IDEMPOTENT, PROVEN BY DRIVING IT TWICE
// ════════════════════════════════════════════════════════════════════════════════

describe('C2 running it twice produces the same result', () => {
  it('the second pass changes nothing the first did not', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-all-done', ['complete', 'complete']);
    seedProject(db, 'p-empty', []);
    seedProject(db, 'p-ghost-assignee', ['in_progress'], { agentId: 'ghost' });
    seedProject(db, 'p-healthy', ['in_progress']);

    deliverTask(db, 'p-all-done-t0', 'd-1');
    deliverTask(db, 'p-all-done-t1', 'd-2');

    const first = await runVersionGapReconcile();
    const snapshotAfterFirst = db.prepare('SELECT id, state, closed_at FROM work ORDER BY id').all();
    const second = await runVersionGapReconcile();
    const snapshotAfterSecond = db.prepare('SELECT id, state, closed_at FROM work ORDER BY id').all();

    expect(snapshotAfterSecond).toEqual(snapshotAfterFirst);
    expect(second.projectsExamined).toBe(first.projectsExamined);
    expect([first.repaired, second.repaired], 'the finished project settles once, from its tasks').toEqual([1, 0]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// C6b — ONE PLAIN LINE, THE OR2 WAY
// ════════════════════════════════════════════════════════════════════════════════

describe('C5b exactly the repairable shape is settled, and nothing else', () => {
  it('only the all-tasks-ended project settles from its tasks; live, fallen and empty projects stay open', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-all-done', ['complete']);
    seedProject(db, 'p-fallen', ['complete', 'fallen']);
    seedProject(db, 'p-empty', []);
    seedProject(db, 'p-live', ['complete', 'in_progress']);
    seedProject(db, 'p-ghost-assignee', ['in_progress'], { agentId: 'ghost' });
    deliverTask(db, 'p-all-done-t0', 'd-1');

    await runVersionGapReconcile();
    const settled = (db.prepare("SELECT id FROM work WHERE kind = 'project' AND state = 'done' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(settled, 'a project with live work, a fallen task, or no tasks never settles').toEqual(['p-all-done']);
  });
});

describe('C6b the owner hears ONE plain line, through the agent', () => {
  it('one notice, to the primary, carrying the denominator — and it is not a wall of detail', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedProject(db, 'p-all-done', ['complete']);
    seedProject(db, 'p-empty', []);
    seedProject(db, 'p-ghost-assignee', ['in_progress'], { agentId: 'ghost' });

    await runVersionGapReconcile();
    expect(notices.length).toBe(1);
    expect(notices[0].toAgentId).toBe('primary');
    expect(notices[0].selfIntro).toBe(false);
    // The denominator is IN the line — a repair with no denominator is not evidence.
    expect(notices[0].brief).toMatch(/\b3\b/);
    // ONE line, not the report.
    expect(notices[0].brief.split('\n').length).toBe(1);
    expect(notices[0].brief.length).toBeLessThan(400);
  });

  it('a clean body says NOTHING — the negative control', async () => {
    const { runVersionGapReconcile } = await import('../version-gap-reconcile.js');
    seedProject(mockDb.current!, 'p-healthy', ['in_progress']);
    await runVersionGapReconcile();
    expect(notices.length).toBe(0);
  });
});

describe('C7 the healer and this pass do not hold two copies of one predicate', () => {

  // ════════════════════════════════════════════════════════════════════════════════════
  // ⚠ t129 — THE RULING'S OWN CLAUSE: the diagnostic and the auto-fix select the SAME row
  //          set, so a row the auto-fix has just fixed cannot still be flagged critical.
  // ════════════════════════════════════════════════════════════════════════════════════
  it('⚠ a row the auto-fix has fixed is no longer raised by the diagnostic', async () => {
    const { runAutoFixes } = await import('../../healer/auto-fix.js');
    const { ORPHANED_TASK_JOIN, ORPHANED_TASK_WHERE } = await import('../version-gap-reconcile.js');
    const db = mockDb.current!;
    seedTrackerTask(db, { id: 'orphan-0001', title: 'left behind', status: 'in_progress', agentId: 'ghost' });

    /** The diagnostic's own row set, read through the shared definition. */
    const flagged = (): string[] => (db.prepare(
      `SELECT t.id AS id FROM work t ${ORPHANED_TASK_JOIN('t', 'a')} WHERE ${ORPHANED_TASK_WHERE('t', 'a')}`,
    ).all() as Array<{ id: string }>).map((r) => r.id);

    expect(flagged(), 'the orphan is flagged before the fix').toEqual(['orphan-0001']);
    const r = runAutoFixes('diag-conformance', [
      { code: 'ORPHANED_TASK', severity: 'critical', message: '', detail: '' } as never,
    ]);
    expect(r.fixCount, 'the auto-fix acted').toBe(1);
    expect(flagged(), 'and the diagnostic no longer raises the row it just fixed').toEqual([]);
  });
});
