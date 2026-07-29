// PHASE-2 T1 Step 2 — the HEALER half of `failed-project-stays-open`
// (research 21 scenario batch; PHASE-2.md T1 Step 2 names "tracker AND healer
// paths"). The tracker half is the behavioural scenario
// `dojo-test-kit/behavioral/scenarios/failed-project-stays-open.mjs`; this file
// is the healer half.
//
// WHY IT IS HERE AND NOT IN THE BATTERY (AS-BUILT, PHASE-2 T1). The healer's
// auto-fixes only run when `config.healerMode === 'active'`
// (healer/healer-agent.ts), and the battery runner PAUSES the Healer to
// `observe` for the whole run (dojo-test-kit/behavioral/lib/healer.mjs) so it
// cannot terminate the BehaviorBot mid-scenario. A scenario clause that drove
// `POST /api/healer/run` inside a battery run would therefore assert nothing —
// a clause that cannot fail is not a guard. The predicate under test is pure
// SQL, so it is tested here, deterministically, against a real database.
//
// THE REQUIREMENT (owner decision D-K): a project that has run out of open tasks
// but has at least one FALLEN task must NOT be auto-closed as a success. Both
// closers must honour it — the tracker's `checkProjectCompletion` (which labels
// the project needs-attention and leaves it active) and the Healer's
// ORPHANED_PROJECT auto-fix. The Healer arm is the dangerous one: it is a single
// bulk UPDATE with no per-project reasoning, and it fires unattended on a
// 5-minute cadence. Loosen its `NOT EXISTS` predicate from `status != 'complete'`
// to `status NOT IN ('complete','fallen')` and every failed project on the box
// silently becomes a completed one overnight.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runAutoFixes } from '../auto-fix.js';
import type { DiagnosticItem } from '../diagnostic.js';

import { createWorkTable, seedTrackerTask, seedTrackerProject } from '../../work/__tests__/work-fixture.js';

const ORPHANED_PROJECT: DiagnosticItem = {
  code: 'ORPHANED_PROJECT',
  severity: 'warning',
  message: 'projects with no open tasks',
} as unknown as DiagnosticItem;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE deliveries (id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, tool TEXT, channel TEXT, outcome TEXT, created_at TEXT);
    CREATE TABLE work_events_unused (x INTEGER);
    CREATE TABLE healer_actions (
      id TEXT PRIMARY KEY, diagnostic_id TEXT, category TEXT, description TEXT,
      agent_id TEXT, action_taken TEXT, result TEXT, created_at TEXT
    );
  `);
  createWorkTable(db);
  const proj = { run: (id: string, title: string) => seedTrackerProject(db, { id, title, status: 'active' }) };
  const task = { run: (id: string, projectId: string, title: string, status: string) =>
    seedTrackerTask(db, { id, projectId, title, status }) };

  // 1. THE SUBJECT: work that FELL. One task shipped, one died. No open work
  //    remains, so every "is this finished?" sweep looks at it.
  proj.run('p-failed', 'Ship the quarterly report');
  task.run('t-f1', 'p-failed', 'Gather the numbers', 'complete');
  task.run('t-f2', 'p-failed', 'Send it to the client', 'fallen');

  // 2. THE CONTROL: a genuinely finished project. This one SHOULD close, and it
  //    is what stops the guard being satisfiable by simply never closing anything.
  // PHASE-2 T8b: `done` means DELIVERED (`transition()`'s G7), so the finished project's
  // finished child points at a real delivery row — which is exactly WHY the umbrella may
  // close. Without it the close is refused, and that refusal is the gate working, not a
  // fixture detail: `deliveryForCompletedChildren` reads this.
  db.prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
              VALUES ('d-done', 'a1', 1, 'imessage-door', 'imessage', 'delivered', '2026-07-29 10:00:00')`).run();
  proj.run('p-done', 'Tidy the desk');
  task.run('t-d1', 'p-done', 'Tidy the desk', 'complete');
  db.prepare("UPDATE work SET result_delivery_id = 'd-done', closed_at = 1700000000000 WHERE id = 't-d1'").run();

  // 3. Still-running project: untouched by either arm.
  proj.run('p-open', 'Long job');
  task.run('t-o1', 'p-open', 'Step 1', 'complete');
  task.run('t-o2', 'p-open', 'Step 2', 'in_progress');

  // 4. Empty project (no tasks at all): the auto-fix must not close it either,
  //    or every scaffold shell on the box reads as a completed project.
  proj.run('p-empty', 'Nothing here yet');

  mockDb.current = db;
});

const status = (id: string) =>
  (mockDb.current!.prepare("SELECT CASE state WHEN 'open' THEN 'active' WHEN 'done' THEN 'complete' ELSE state END AS status FROM work WHERE id = ?").get(id) as { status: string }).status;

describe("healer ORPHANED_PROJECT auto-fix: a fallen task blocks the close (D-K fail-open)", () => {
  it('never closes a project that has a FALLEN task, however many others completed', () => {
    runAutoFixes('diag-1', [ORPHANED_PROJECT]);
    expect(status('p-failed')).toBe('active');
    expect(
      mockDb.current!.prepare("SELECT closed_at AS completed_at FROM work WHERE id = 'p-failed'").get(),
    ).toEqual({ completed_at: null });
  });

  it('DOES close the genuinely-finished project (the fix still does its job)', () => {
    const res = runAutoFixes('diag-1', [ORPHANED_PROJECT]);
    expect(status('p-done')).toBe('complete');
    expect(res.fixCount).toBe(1);
  });

  it('leaves a still-running project and an empty project alone', () => {
    runAutoFixes('diag-1', [ORPHANED_PROJECT]);
    expect(status('p-open')).toBe('active');
    expect(status('p-empty')).toBe('active');
  });

  it('is idempotent: a second cycle finds nothing left to fix and never revisits the failed project', () => {
    runAutoFixes('diag-1', [ORPHANED_PROJECT]);
    const res2 = runAutoFixes('diag-2', [ORPHANED_PROJECT]);
    expect(res2.fixCount).toBe(0);
    expect(status('p-failed')).toBe('active');
  });
});
