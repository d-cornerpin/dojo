// A scheduled run is DECLARED deliverable-owing from its definition, never from the run (ARM 1), and a
// second live recurring task of the same shape by the same owner is caught as a twin (ARM 4). What a run
// owing a message settles as is `a-fired-reminder-reaches-the-user` and the run hand-in tests.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-run-deliverable-test', 'dojo.db'),
  };
});

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import {
  declaredDeliverableShape, declareDeliverableOnSchedule, taskOwesDeliverable,
  occurrenceOwesDeliverable, findLiveRecurringTwin, DELIVERABLE_OWING_TASK_KINDS,
  DECLARATION_MARKER,
} from '../deliverable-declaration.js';

const W = 'sched-1';
const AGENT = 'a1';
const RUN_OPENED = 1785316028089;

/** The two tables the evidence predicate reads. Only the columns it names. */
function createLedgerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, display_kind TEXT, content TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool TEXT NOT NULL, channel TEXT NOT NULL,
      outcome TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL
    );
  `);
}

const seedSchedule = (extra: Record<string, unknown> = {}): void => {
  seedTrackerTask(mockDb.current!, {
    id: W, title: 'Tomorrow Brief', status: 'on_deck', agentId: AGENT,
    next_run_at: RUN_OPENED, schedule_status: 'waiting', is_paused: 0,
    repeat_interval: 1, repeat_unit: 'days', attempts: 0,
    description: 'Every morning, send me a short brief of what is on for tomorrow.',
    ...extra,
  });
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  createWorkTable(db);
  createLedgerTables(db);
});

// ════════════════════════════════════════════════════════════════════════════════
describe('ARM 1 — THE DECLARATION: decided once, from the DEFINITION, never from the run', () => {
  it("1a the owner's own definition declares a brief", () => {
    const s = declaredDeliverableShape({
      title: 'Tomorrow Brief',
      description: 'Every morning, send me a short brief of what is on for tomorrow.',
      goal: null, hasSchedule: true,
    });
    expect(s?.shape).toBe('brief');
    expect(s?.matched.toLowerCase()).toBe('brief');
  });

  it('1a the plain-language shape the owner actually types is caught by the notify rule', () => {
    expect(declaredDeliverableShape({
      title: 'Morning update', description: 'Every day at 7am, text me what is on today.',
      hasSchedule: true,
    })?.shape).toBe('notify');
    expect(declaredDeliverableShape({
      title: 'Weekly status', description: 'Send me the weekly report every Monday.',
      hasSchedule: true,
    })?.shape).toBe('report');
  });

  it('1b an explicit kind from the caller ALWAYS wins, schedule or not', () => {
    const s = declaredDeliverableShape({ kind: 'reminder', title: 'x', hasSchedule: false });
    expect(s?.shape).toBe('reminder');
    expect(s?.rule).toBe('declared-by-the-caller');
  });

  it('1c NEGATIVE CONTROL — an UNSCHEDULED task is never declared, however it is worded', () => {
    expect(declaredDeliverableShape({
      title: 'Send me the brief', description: 'send me a brief when you are done',
      hasSchedule: false,
    })).toBeNull();
  });

  it('1d NEGATIVE CONTROLS — the patterns are word-bounded and addressed, not substrings', () => {
    // "debrief" contains "brief". An unbounded substring is the exact defect class TB3 fixed
    // in the kit's own census, and it would declare this a brief.
    expect(declaredDeliverableShape({
      title: 'debrief the logs', description: 'debrief the logs nightly', hasSchedule: true,
    })).toBeNull();
    // A bare "report" verb with no person on the other end owes nobody a word.
    expect(declaredDeliverableShape({
      title: 'error sweep', description: 'report any errors to the log file', hasSchedule: true,
    })).toBeNull();
    // A telling verb aimed at somebody who is not a person in this conversation.
    expect(declaredDeliverableShape({
      title: 'client mail', description: 'email the client the invoice each month', hasSchedule: true,
    })).toBeNull();
    // The nightly backup: the case that must keep closing exactly as it always has.
    expect(declaredDeliverableShape({
      title: 'Nightly backup', description: 'back up the database to the NAS every night at 2am',
      hasSchedule: true,
    })).toBeNull();
  });

  it('1e the declaration is written to the row AND audited with the phrase that caused it', () => {
    seedSchedule();
    const s = declareDeliverableOnSchedule(W);
    expect(s?.shape).toBe('brief');
    expect(taskOwesDeliverable(W)).toEqual({ owes: true, taskKind: 'brief' });
    const ev = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.marker') = ?`,
    ).get(W, DECLARATION_MARKER) as { payload: string } | undefined;
    expect(ev, 'the declaration must be readable by a person, not only by the closer').toBeTruthy();
    expect(ev!.payload).toContain('brief');
    expect(ev!.payload).toContain('cannot be recorded complete');
  });

  it('1f it is idempotent and never re-labels a kind somebody already set', () => {
    seedSchedule({ task_kind: 'reminder' });
    expect(declareDeliverableOnSchedule(W)?.rule).toBe('already-declared');
    expect(taskOwesDeliverable(W).taskKind).toBe('reminder');
    // A caller-supplied kind that is NOT on the list is a deliberate statement and is honoured.
    seedTrackerTask(mockDb.current!, {
      id: 'sched-2', title: 'Daily brief', status: 'on_deck', agentId: AGENT,
      schedule_status: 'waiting', repeat_interval: 1, repeat_unit: 'days', task_kind: 'chore',
      description: 'send me a brief every day',
    });
    expect(declareDeliverableOnSchedule('sched-2')).toBeNull();
    expect(taskOwesDeliverable('sched-2')).toEqual({ owes: false, taskKind: 'chore' });
  });

  it('1g the closed inventory is exactly the list the kit mirrors', () => {
    expect([...DELIVERABLE_OWING_TASK_KINDS]).toEqual(['reminder', 'brief', 'report', 'notify']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════
describe('ARM 4 — THE DUPLICATE-RECURRING GUARD (Step 3)', () => {
  const twinArgs = {
    creatorId: AGENT, shape: 'brief', repeatInterval: 1, repeatUnit: 'days',
    repeatDaysOfWeek: null,
  };
  const seedLiveBrief = (id: string, extra: Record<string, unknown> = {}): void => {
    seedTrackerTask(mockDb.current!, {
      id, title: `Tomorrow Brief ${id}`, status: 'on_deck', agentId: AGENT,
      next_run_at: RUN_OPENED, schedule_status: 'waiting', is_paused: 0,
      repeat_interval: 1, repeat_unit: 'days', task_kind: 'brief', ...extra,
    });
  };

  it("4a THE OWNER'S CASE — a live daily brief by the same owner IS a twin", () => {
    seedLiveBrief('old-brief');
    expect(findLiveRecurringTwin(twinArgs)?.id).toBe('old-brief');
  });

  it('4b …and the ANCHOR is deliberately not compared, because his differed', () => {
    // He recreated the briefs BECAUSE the anchor was wrong. Matching on it would have missed
    // his case exactly — this clause is the reason the guard keys on the cadence.
    seedLiveBrief('old-brief', { anchor_local: '2026-08-01T07:00:00Z', next_run_at: RUN_OPENED + 3_600_000 });
    expect(findLiveRecurringTwin(twinArgs)?.id).toBe('old-brief');
  });

  it('4c NEGATIVE CONTROL — a DIFFERENT cadence is not a twin', () => {
    seedLiveBrief('weekly-brief', { repeat_unit: 'weeks' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4d NEGATIVE CONTROL — a different deliverable shape on the same cadence is not a twin', () => {
    seedLiveBrief('daily-notify', { task_kind: 'notify' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4e NEGATIVE CONTROL — another owner\'s schedule is not a twin', () => {
    seedLiveBrief('someone-elses');
    mockDb.current!.prepare('UPDATE work SET requester_id = ? WHERE id = ?').run('other', 'someone-elses');
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4f NEGATIVE CONTROL — a schedule that fires nothing is not a twin', () => {
    // This is the legitimate re-creation the owner was ACTUALLY attempting: stop the old one,
    // then make a new one. Refusing against a dead schedule would block exactly that.
    seedLiveBrief('paused', { is_paused: 1 });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
    seedLiveBrief('stopped', { schedule_status: 'completed' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
    seedLiveBrief('cancelled', { status: 'cancelled' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4g NEGATIVE CONTROL — a shape that is not deliverable-owing is never twinned here', () => {
    seedLiveBrief('chore', { task_kind: 'chore' });
    expect(findLiveRecurringTwin({ ...twinArgs, shape: 'chore' })).toBeNull();
  });

  it('4h NO TIME WINDOW — the twin counts however old it is', () => {
    seedLiveBrief('ancient', { opened_at: 1600000000001 });
    expect(findLiveRecurringTwin(twinArgs)?.id,
      'his duplicate was created DAYS after its twin; a five-minute window cannot see that').toBe('ancient');
  });

  it('4i the row being created is excludable, so a later pass cannot twin a task with itself', () => {
    seedLiveBrief('me');
    expect(findLiveRecurringTwin({ ...twinArgs, excludeTaskId: 'me' })).toBeNull();
  });
});
