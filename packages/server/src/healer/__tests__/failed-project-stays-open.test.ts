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

const ORPHANED_PROJECT: DiagnosticItem = {
  code: 'ORPHANED_PROJECT',
  severity: 'warning',
  message: 'projects with no open tasks',
} as unknown as DiagnosticItem;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE legacy_projects (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT NOT NULL,
      completed_at TEXT, updated_at TEXT, created_by TEXT
    );
    CREATE TABLE legacy_tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT NOT NULL,
      assigned_to TEXT, is_paused INTEGER DEFAULT 0, updated_at TEXT
    );
    CREATE TABLE healer_actions (
      id TEXT PRIMARY KEY, diagnostic_id TEXT, category TEXT, description TEXT,
      agent_id TEXT, action_taken TEXT, result TEXT, created_at TEXT
    );
  `);
  const proj = db.prepare(`INSERT INTO legacy_projects (id, title, status) VALUES (?, ?, 'active')`);
  const task = db.prepare(`INSERT INTO legacy_tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)`);

  // 1. THE SUBJECT: work that FELL. One task shipped, one died. No open work
  //    remains, so every "is this finished?" sweep looks at it.
  proj.run('p-failed', 'Ship the quarterly report');
  task.run('t-f1', 'p-failed', 'Gather the numbers', 'complete');
  task.run('t-f2', 'p-failed', 'Send it to the client', 'fallen');

  // 2. THE CONTROL: a genuinely finished project. This one SHOULD close, and it
  //    is what stops the guard being satisfiable by simply never closing anything.
  proj.run('p-done', 'Tidy the desk');
  task.run('t-d1', 'p-done', 'Tidy the desk', 'complete');

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
  (mockDb.current!.prepare('SELECT status FROM legacy_projects WHERE id = ?').get(id) as { status: string }).status;

describe("healer ORPHANED_PROJECT auto-fix: a fallen task blocks the close (D-K fail-open)", () => {
  it('never closes a project that has a FALLEN task, however many others completed', () => {
    runAutoFixes('diag-1', [ORPHANED_PROJECT]);
    expect(status('p-failed')).toBe('active');
    expect(
      mockDb.current!.prepare("SELECT completed_at FROM legacy_projects WHERE id = 'p-failed'").get(),
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
