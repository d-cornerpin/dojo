// PHASE-2 T10F cluster A — `task_runs` IS ABSORBED, and every requirement it encoded is a
// clause below.
//
// WHY THIS FILE EXISTS RATHER THAN A DROP. T8c2 item 4 built the replacement
// (`work(kind='occurrence')` + `occurrences.ts`) and DID NOT DELETE THE PREDECESSOR: the
// scheduler claims an occurrence at `runner.ts:729` and then INSERTs a `task_runs` row 18
// lines later, and it settles the occurrence at `:931` and then UPDATEs `task_runs` at `:911`.
// Two records of one fact, written by one function — the disease this phase exists to remove,
// in its purest observed form.
//
// So the absorption is not a cutover onto something new; it is the deletion of the old half.
// What makes that safe is that `task_runs` carried SEVEN facts the occurrence row did not yet
// project, and #15 forbids inferring their deadness from the table's two rows: the run history
// route (`/api/tasks/:taskId/runs`) is MOUNTED (`gateway/server.ts:280`) and its consumer is
// LIVE (`dashboard/src/components/TaskRunHistory.tsx`, rendered at `pages/Tracker.tsx:278`).
// Each of those seven is a clause here, RED before the projection existed.
//
// requirement preserved, one per describe block:
//   * the owner's run history — number, instant, start, finish, status, who, summary
//   * the four statuses that history renders (complete / failed / skipped / running)
//   * the run's result summary, which `settleOccurrence` was discarding
//   * "the latest running run for this task", the close-out's entry point
//   * close-once: RC-17's `.changes === 1` token, so a lost race cannot double-advance
//   * the two orphan sweeps (parent-not-running; assigned agent terminated)
//   * the fallen path's skipped-run COUNT, which the owner heads-up quotes
//   * deleting a schedule takes its runs with it

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-occurrence-runs-test', 'dojo.db'),
  };
});

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import {
  claimOccurrence, settleOccurrence, inFlightOccurrence,
  skipOpenOccurrences, skipOpenOccurrencesAsComplete, assignOccurrence,
  sweepOrphanedOccurrences, sweepTerminatedAgentOccurrences, deleteOccurrencesOf,
  OCCURRENCE_KIND,
} from '../occurrences.js';
import { listOccurrenceRuns, occurrenceRunStatus } from '../occurrence-runs.js';

const W = 'sched-1';
const AGENT = 'a1';
const T0 = 1785316028089;

const seedSchedule = (nextRunAtMs: number, extra: Record<string, unknown> = {}): void => {
  seedTrackerTask(mockDb.current!, {
    id: W, title: 'a recurring chore', status: 'on_deck', agentId: AGENT,
    next_run_at: nextRunAtMs, schedule_status: 'waiting', is_paused: 0,
    repeat_interval: 1, repeat_unit: 'days', attempts: 0, ...extra,
  });
};

/** Claim occurrence `seq`, re-arming the schedule first so each claim is a legal one. */
const fire = (seq: number, at = T0 + seq * 1000): string => {
  mockDb.current!.prepare(
    `UPDATE work SET schedule_status='waiting', next_run_at=?, is_paused=0 WHERE id=?`,
  ).run(at, W);
  const id = claimOccurrence({
    workId: W, sequence: seq, occurrenceMs: at, nowMs: at,
    nextRunMs: at + 86_400_000, agentId: AGENT,
  });
  if (!id) throw new Error(`claim ${seq} lost`);
  return id;
};

const seedAgents = (rows: Array<{ id: string; status: string; name?: string }>): void => {
  mockDb.current!.exec(
    `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL)`,
  );
  for (const r of rows) {
    mockDb.current!.prepare('INSERT OR REPLACE INTO agents (id,name,status) VALUES (?,?,?)')
      .run(r.id, r.name ?? r.id, r.status);
  }
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  createWorkTable(db);
  seedAgents([{ id: AGENT, status: 'active', name: 'Ada' }]);
  // G7 resolves `result_delivery_id` against a real row, so a run that DELIVERED needs one.
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY)`);
  db.prepare('INSERT INTO deliveries (id) VALUES (?)').run('del-1');
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: the run history the owner reads', () => {
  it('projects one entry per occurrence, newest run first', () => {
    seedSchedule(T0);
    const o1 = fire(1);
    settleOccurrence(o1, 'complete', 'del-1', 'first run said the thing');
    const o2 = fire(2);

    const runs = listOccurrenceRuns(W);
    expect(runs.map(r => r.runNumber)).toEqual([2, 1]);
    expect(runs[1].id).toBe(o1);
    expect(runs[0].id).toBe(o2);
  });

  it('carries every field the dashboard renders', () => {
    seedSchedule(T0);
    const o1 = fire(1);
    settleOccurrence(o1, 'complete', 'del-1', 'the summary the owner opens the row to read');

    const [run] = listOccurrenceRuns(W);
    expect(run.taskId).toBe(W);
    expect(run.runNumber).toBe(1);
    // the instant the occurrence was FOR, not the instant it fired
    expect(run.scheduledFor).not.toBeNull();
    expect(run.startedAt).not.toBeNull();
    expect(run.completedAt).not.toBeNull();
    expect(run.assignedTo).toBe(AGENT);
    expect(run.agentName).toBe('Ada');
    expect(run.resultSummary).toBe('the summary the owner opens the row to read');
  });

  it('an unsettled occurrence has no completion instant', () => {
    seedSchedule(T0);
    fire(1);
    const [run] = listOccurrenceRuns(W);
    expect(run.completedAt).toBeNull();
    expect(run.startedAt).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: the four statuses that history renders', () => {
  it("a delivered run reads 'complete'", () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', 'done');
    expect(listOccurrenceRuns(W)[0].status).toBe('complete');
  });

  it("a failed run reads 'failed'", () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'failed', null, 'the agent died');
    expect(listOccurrenceRuns(W)[0].status).toBe('failed');
  });

  it("a run that never ran reads 'skipped', NOT 'complete'", () => {
    // THE DISTINCTION THAT `abandoned` ALONE WOULD HAVE LOST. `settleOccurrence` maps both
    // "finished but reached nobody" and "never ran" onto `abandoned`, because G7 makes `done`
    // unreachable without a delivery. The history must still tell them apart, because
    // "skipped" and "finished, nothing delivered" are different things to be told.
    seedSchedule(T0);
    settleOccurrence(fire(1), 'skipped', null, null);
    expect(listOccurrenceRuns(W)[0].status).toBe('skipped');
  });

  it("a run that finished with nothing delivered reads 'complete', not 'skipped'", () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', null, 'said it into the void');
    expect(listOccurrenceRuns(W)[0].status).toBe('complete');
  });

  it("an open occurrence reads 'running'", () => {
    seedSchedule(T0);
    fire(1);
    expect(listOccurrenceRuns(W)[0].status).toBe('running');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("requirement preserved: 'the latest running run for this task'", () => {
  it('finds the newest open occurrence and skips the settled ones', () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', null);
    const o2 = fire(2);
    expect(inFlightOccurrence(W)?.id).toBe(o2);
  });

  it('returns null when nothing is in flight — the no-op the close-out reports', () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', null);
    expect(inFlightOccurrence(W)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: close-once (RC-17)', () => {
  it('a second settle of the same occurrence does not apply', () => {
    // The old token was `UPDATE ... WHERE id=? AND status='running'` and `.changes === 1`.
    // The new one is the transition result: a row already terminal is not re-closed, so a
    // concurrent tick cannot advance `run_count` twice (the P-5 inflation class).
    seedSchedule(T0);
    const o1 = fire(1);
    expect(settleOccurrence(o1, 'complete', 'del-1', 'first').kind).toBe('applied');
    expect(settleOccurrence(o1, 'complete', 'del-1', 'second').kind).not.toBe('applied');
  });

  it('the first summary is not overwritten by the loser', () => {
    seedSchedule(T0);
    const o1 = fire(1);
    settleOccurrence(o1, 'complete', 'del-1', 'the winner wrote this');
    settleOccurrence(o1, 'failed', null, 'the loser must not');
    expect(listOccurrenceRuns(W)[0].resultSummary).toBe('the winner wrote this');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: the orphaned-run sweeps', () => {
  it('an open occurrence whose schedule is not running is swept skipped', () => {
    seedSchedule(T0);
    const o1 = fire(1);
    // The claim set schedule_status='running'. A path that reset the row without closing the
    // run is exactly RC-17.4's transcript (runs 42-45 never closed).
    mockDb.current!.prepare(`UPDATE work SET schedule_status='idle' WHERE id=?`).run(W);
    mockDb.current!.prepare(`UPDATE work SET opened_at=? WHERE id=?`).run(T0 - 600_000, o1);

    const swept = sweepOrphanedOccurrences(T0);
    expect(swept).toBe(1);
    expect(listOccurrenceRuns(W)[0].status).toBe('skipped');
  });

  it('a FRESH orphan is left alone — the age guard against racing an in-flight advance', () => {
    seedSchedule(T0);
    const o1 = fire(1);
    mockDb.current!.prepare(`UPDATE work SET schedule_status='idle' WHERE id=?`).run(W);
    mockDb.current!.prepare(`UPDATE work SET opened_at=? WHERE id=?`).run(T0 - 1_000, o1);
    expect(sweepOrphanedOccurrences(T0)).toBe(0);
    expect(listOccurrenceRuns(W)[0].status).toBe('running');
  });

  it('an occurrence whose schedule IS running is not an orphan (positive control)', () => {
    seedSchedule(T0);
    const o1 = fire(1);
    mockDb.current!.prepare(`UPDATE work SET opened_at=? WHERE id=?`).run(T0 - 600_000, o1);
    expect(sweepOrphanedOccurrences(T0)).toBe(0);
    expect(listOccurrenceRuns(W)[0].status).toBe('running');
  });

  it('reports an open occurrence whose assigned agent is terminated', () => {
    seedSchedule(T0);
    fire(1);
    seedAgents([{ id: AGENT, status: 'terminated' }]);
    expect(sweepTerminatedAgentOccurrences().map(o => o.taskId)).toEqual([W]);
  });

  it('reports one whose agent row is gone entirely', () => {
    seedSchedule(T0);
    fire(1);
    mockDb.current!.prepare('DELETE FROM agents WHERE id = ?').run(AGENT);
    expect(sweepTerminatedAgentOccurrences().map(o => o.taskId)).toEqual([W]);
  });

  it('a live agent is not reported (positive control)', () => {
    seedSchedule(T0);
    fire(1);
    expect(sweepTerminatedAgentOccurrences()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("requirement preserved: the fallen path's skipped-run COUNT", () => {
  it('closes every open occurrence and returns how many', () => {
    // The count is quoted to the owner ("N open run(s) skipped"), so it is a preserved fact,
    // not a log line.
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', null);
    fire(2);
    fire(3);
    expect(skipOpenOccurrences(W, 'agent fell over')).toBe(2);
    expect(listOccurrenceRuns(W).map(r => r.status)).toEqual(['skipped', 'skipped', 'complete']);
  });

  it('returns 0 when nothing was open, so no heads-up is posted', () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', null);
    expect(skipOpenOccurrences(W, 'agent fell over')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("requirement preserved: 'all runs complete' retires the schedule's open run", () => {
  it("closes the open run and its history reads 'complete', not 'skipped'", () => {
    // The three sites this replaces all wrote `status='complete'` with no delivery to point
    // at: "All runs completed by agent", "Schedule stopped and marked complete",
    // "Auto-completed: group deleted". G7 forces the ROW to `abandoned`; the history must
    // still say what the caller asserted.
    seedSchedule(T0);
    fire(1);
    expect(skipOpenOccurrencesAsComplete(W, 'All runs completed by agent')).toBe(1);
    const [run] = listOccurrenceRuns(W);
    expect(run.status).toBe('complete');
    expect(run.resultSummary).toBe('All runs completed by agent');
  });

  it('is a no-op when nothing is open — a stale call must not invent a run', () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', 'the real close');
    expect(skipOpenOccurrencesAsComplete(W, 'stale')).toBe(0);
    expect(listOccurrenceRuns(W)[0].resultSummary).toBe('the real close');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: the run records WHO ran it, not who was guessed', () => {
  it("the resolved assignee replaces the schedule's own guess", () => {
    // The claim has to fire before the assignee is known, so it fires on the schedule's
    // `assigned_to` (or 'scheduler'). A group pick, the primary fallback and the
    // terminated-agent reassignment are all resolved AFTER it, and `task_runs.assigned_to`
    // was written at exactly that point. The run history renders this field.
    seedAgents([{ id: 'picked', status: 'active', name: 'Grace' }]);
    seedSchedule(T0);
    const o1 = fire(1);
    assignOccurrence(o1, 'picked');
    const [run] = listOccurrenceRuns(W);
    expect(run.assignedTo).toBe('picked');
    expect(run.agentName).toBe('Grace');
  });

  it('does not touch a row that is not an occurrence', () => {
    seedSchedule(T0);
    assignOccurrence(W, 'picked');
    const sched = mockDb.current!.prepare('SELECT agent_id FROM work WHERE id = ?').get(W) as
      { agent_id: string };
    expect(sched.agent_id).toBe(AGENT);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: a run status by its run id', () => {
  it("reads the closed run's status", () => {
    seedSchedule(T0);
    const o1 = fire(1);
    settleOccurrence(o1, 'failed', null, null);
    expect(occurrenceRunStatus(o1)).toBe('failed');
  });

  it('reads an in-flight run as running', () => {
    seedSchedule(T0);
    expect(occurrenceRunStatus(fire(1))).toBe('running');
  });

  it('returns null for an id that is not a run — the trigger-is-spent signal', () => {
    seedSchedule(T0);
    expect(occurrenceRunStatus('no-such-run')).toBeNull();
    // a SCHEDULE id is not a run id, and must not read as one
    expect(occurrenceRunStatus(W)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('requirement preserved: deleting a schedule takes its runs with it', () => {
  it('removes the occurrence rows and their events', () => {
    seedSchedule(T0);
    settleOccurrence(fire(1), 'complete', 'del-1', null);
    fire(2);
    expect(deleteOccurrencesOf([W])).toBe(2);

    const left = mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM work WHERE kind = ? AND parent_id = ?`,
    ).get(OCCURRENCE_KIND, W) as { n: number };
    expect(left.n).toBe(0);
    const events = mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM work_events WHERE work_id NOT IN (SELECT id FROM work)`,
    ).get() as { n: number };
    expect(events.n).toBe(0);
  });

  it('the schedule itself then deletes without an FK orphan', () => {
    seedSchedule(T0);
    fire(1);
    deleteOccurrencesOf([W]);
    mockDb.current!.prepare('DELETE FROM work_events WHERE work_id = ?').run(W);
    expect(() => mockDb.current!.prepare('DELETE FROM work WHERE id = ?').run(W)).not.toThrow();
  });
});
