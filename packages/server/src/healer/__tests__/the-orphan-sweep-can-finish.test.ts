// ════════════════════════════════════════════════════════════════════════════════════════
// t129 / S6 — THE HEALER'S ORPHAN SWEEP CAN FINISH.
//
// ── THE DEFECT, VERIFIED AT THIS HEAD RATHER THAN INHERITED ──
// `fixOrphanedTask` unassigned an orphaned task with
// `patchWork(id, { agent_id: null, assignee_agent: null })`. `work.agent_id` is
// `TEXT NOT NULL` (`135_work_spine.sql:42`), so that write is a constraint abort:
//
//     patchWork('<row>', { agent_id: null, … })
//       → NOT NULL constraint failed: work.agent_id        [measured, 937e2051]
//
// And it THROWS rather than refusing. `patchWork` RETURNS its own refusals, so
// `noteUnsettled` is the right reader for those — but SQLite's abort comes out of the
// statement itself, so the exception walked straight past it and out of the function. By then
// the STATE half had already committed (its own `setTrackerStatus` call, a few lines earlier),
// which left the row reading `on_deck` while still owned by a terminated agent — and the
// FIRST orphan ended the whole pass, taking every orphan behind it. Daily cycle,
// `healerMode === 'active'` only.
//
// ── THE FIX IS A PROTOCOL THAT WAS ALREADY WRITTEN DOWN ──
// M7 / P706, stated in full on `tracker/schema.ts`'s `updateTask`: "nobody in particular is
// assigned" does not live in `agent_id`, because NOT NULL means that column must always name
// someone; `assignee_agent` is the nullable column that carries it. So a clear leaves the
// HOLDER and clears the ASSIGNEE. §1 is that write; §2 is the sweep surviving a row it cannot
// fix; §3 is idempotence, because a daily "I fixed 1 task" about the same row for ever is its
// own defect.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runAutoFixes } from '../auto-fix.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const DEAD = 'terminated-agent';
const LIVE = 'live-agent';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS healer_actions (
      id TEXT PRIMARY KEY, diagnostic_id TEXT, category TEXT, description TEXT,
      agent_id TEXT, action_taken TEXT, result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Dead', 'terminated')").run(DEAD);
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Live', 'idle')").run(LIVE);
}

/** One orphan: a task whose ASSIGNEE is a terminated agent. */
function seedOrphan(id: string, state = 'in_progress'): void {
  seedTrackerTask(mockDb.current!, { id, title: 'a job whose owner is gone', status: state, agentId: DEAD });
}

const rowOf = (id: string) =>
  mockDb.current!.prepare('SELECT state, agent_id, assignee_agent FROM work WHERE id = ?')
    .get(id) as { state: string; agent_id: string; assignee_agent: string | null };

/** The diagnostic item `fixOrphanedTask` keys on. Only `code` is read by that branch. */
const ORPHAN_ITEM = { code: 'ORPHANED_TASK', severity: 'critical', message: '', detail: '' };

/**
 * The sweep as production runs it — through `runAutoFixes`, not by reaching for the private
 * fixer. That matters for §2: `runAutoFixes` wraps each ITEM in a try/catch, so a throw from
 * inside `fixOrphanedTask` is swallowed there and reported as one failed category. Every
 * orphan on the box arrives inside that ONE item, which is precisely why a per-row fault used
 * to end the pass for all of them while the cycle still looked healthy from outside.
 */
function runSweep(): { applied: boolean; description: string } {
  const r = runAutoFixes('diag-1', [ORPHAN_ITEM as never]);
  return { applied: r.fixCount > 0, description: r.fixes.join(' | ') };
}

/** Did the sweep report a FAILED category? The outer catch logs one `healer_actions` row with
 *  `result='failed'`, which is the only outward trace of a swallowed throw. */
const failedRows = () =>
  mockDb.current!.prepare("SELECT description FROM healer_actions WHERE result = 'failed'")
    .all() as Array<{ description: string }>;

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE WRITE LANDS. (this threw at 937e2051)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the orphan sweep unassigns without violating NOT NULL', () => {
  it('⚠ THE DEFECT: the sweep completes and reports the fix instead of throwing', () => {
    seedOrphan('orph-0001');
    const r = runSweep();
    expect(failedRows(), 'the NOT NULL abort is gone, not merely swallowed').toEqual([]);
    expect(r.applied, `the sweep must finish and say so, got: ${JSON.stringify(r)}`).toBe(true);
    expect(r.description).toContain('1 task');
  });

  it('the CLEAR PROTOCOL is what landed: the assignee is cleared, the holder survives', () => {
    seedOrphan('orph-0001');
    runSweep();
    const row = rowOf('orph-0001');
    expect(row.assignee_agent, 'nobody in particular is assigned now').toBeNull();
    expect(row.agent_id, 'and NOT NULL is not violated — the holder is the row\'s history').toBe(DEAD);
    expect(row.state, 'the work is back on the deck for reassignment').toBe('on_deck');
  });

  it('a PAUSED orphan is unassigned but NOT unpaused — the owner paused it on purpose', () => {
    seedOrphan('orph-0002', 'paused');
    runSweep();
    const row = rowOf('orph-0002');
    expect(row.state, 'the pause is the owner\'s and the healer does not undo it').toBe('paused');
    expect(row.assignee_agent).toBeNull();
  });

  it('CONTROL: a task assigned to a LIVE agent is not touched', () => {
    seedTrackerTask(mockDb.current!, { id: 'fine-0001', title: 'a job in hand', status: 'in_progress', agentId: LIVE });
    const r = runSweep();
    expect(r.applied, 'there is nothing to fix').toBe(false);
    const row = rowOf('fine-0001');
    expect(row.state).toBe('claimed');
    expect(row.assignee_agent).toBe(LIVE);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — ONE BAD ROW DOES NOT END THE PASS. This is the half of S6 that was never about the
//      constraint: a per-row fault was escaping into the caller.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the first orphan cannot take the rest of the sweep with it', () => {
  it('⚠ every orphan is reached, not just the one before the first fault', () => {
    for (const n of [1, 2, 3, 4, 5]) seedOrphan(`orph-many-000${n}`);
    const r = runSweep();
    expect(r.applied).toBe(true);
    expect(r.description, 'all five, not one').toContain('5 task');
    for (const n of [1, 2, 3, 4, 5]) {
      expect(rowOf(`orph-many-000${n}`).assignee_agent, `orphan ${n} was reached`).toBeNull();
    }
  });

  it('a row that CANNOT be fixed is logged and skipped — the others still land', () => {
    seedOrphan('orph-bad-0001');
    seedOrphan('orph-ok-0001');
    // A trigger standing in for any per-row fault: this one row's unassignment aborts. The
    // clause is about the SWEEP's resilience, so what makes the row fail does not matter —
    // only that the pass carries on past it.
    mockDb.current!.exec(`
      CREATE TRIGGER no_unassign_bad BEFORE UPDATE OF assignee_agent ON work
      WHEN NEW.id = 'orph-bad-0001'
      BEGIN SELECT RAISE(ABORT, 'this row refuses to be unassigned'); END;
    `);
    const r = runSweep();
    expect(r.applied, 'the pass still did real work').toBe(true);
    expect(rowOf('orph-ok-0001').assignee_agent, 'the row BEHIND the fault was reached').toBeNull();
    expect(rowOf('orph-bad-0001').assignee_agent, 'and the faulting row is left as it was').toBe(DEAD);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — IDEMPOTENCE. A sweep that reports the same fix every day for ever is noise the owner
//      learns to ignore, which is how a real finding gets missed.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the sweep settles', () => {
  it('⚠ a second pass finds nothing to do', () => {
    seedOrphan('orph-0001');
    expect(runSweep().applied).toBe(true);
    const second = runSweep();
    expect(second.applied, 'the row it already cleared is not an orphan any more').toBe(false);
  });

  it('and the row is not re-touched by the second pass', () => {
    seedOrphan('orph-0001');
    runSweep();
    const before = rowOf('orph-0001');
    runSweep();
    expect(rowOf('orph-0001')).toEqual(before);
  });
});
