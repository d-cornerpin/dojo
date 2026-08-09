// PHASE-2 T8c2 item 4 — the occurrence claim.
//
// The first describe block is the REGRESSION, written from the defect's own recorded shape
// (PHASE-2 T8V bisect; DOJO-ISSUES-LOG.md): a schedule whose `next_run_at` carries
// milliseconds could never be claimed, because the due-scan projected the instant through
// `msToText` (second resolution) and the CAS compared the round-tripped value against the
// stored one. Stored 1785316028089, compared 1785316028000. The literal numbers below are
// that row, read off this box's `work` table at task start.
//
// The rest asserts the properties D21's timestamp CAS had, plus the one it could not have.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-occurrences-test', 'dojo.db'),
  };
});

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import { scheduleRowColumns } from '../tracker-view.js';
import {
  claimOccurrence, releaseOccurrence, settleOccurrence, occurrenceOf, inFlightOccurrence,
  OCCURRENCE_KIND, OCCURRENCE_EVENT,
} from '../occurrences.js';

const W = 'sched-1';
const AGENT = 'a1';

/** The exact instant from the bisected bug report. Its `% 1000` is 89, which is the point. */
const MS_OCCURRENCE = 1785316028089;

/** The scheduler's own due-scan read, character for character with `scheduler/runner.ts`. */
const dueRow = (id = W): Record<string, unknown> =>
  mockDb.current!.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`)
    .get(id) as Record<string, unknown>;

const seedSchedule = (nextRunAtMs: number, extra: Record<string, unknown> = {}): void => {
  seedTrackerTask(mockDb.current!, {
    id: W, title: 'a recurring chore', status: 'on_deck', agentId: AGENT,
    next_run_at: nextRunAtMs, schedule_status: 'waiting', is_paused: 0,
    repeat_interval: 1, repeat_unit: 'days', attempts: 0, ...extra,
  });
};

const occurrences = (): Array<{ id: string; sequence: number; state: string }> =>
  mockDb.current!.prepare(
    `SELECT id, sequence, state FROM work WHERE kind = ? AND parent_id = ? ORDER BY sequence`,
  ).all(OCCURRENCE_KIND, W) as Array<{ id: string; sequence: number; state: string }>;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  createWorkTable(db);
});

// ════════════════════════════════════════════════════════════════════════════════
describe('the millisecond CAS defect (regression)', () => {
  it('an occurrence whose start carries milliseconds is claimable', () => {
    seedSchedule(MS_OCCURRENCE);
    const row = dueRow();

    // The whole defect in one assertion: what the due-scan hands the claim must BE the
    // instant the row holds, not a truncated copy of it.
    expect(occurrenceOf(row)).toBe(MS_OCCURRENCE);

    const id = claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: occurrenceOf(row),
      nowMs: MS_OCCURRENCE + 5_000, nextRunMs: MS_OCCURRENCE + 86_400_000, agentId: AGENT,
    });
    expect(id).not.toBeNull();
  });

  it('and so is one on a whole second — the case that hid the defect for two weeks', () => {
    // Model-set reminders land on whole seconds, so `reminder-set-and-fire` was correctly
    // green the whole time the defect was live. Both must work, or a fix that only moved
    // the truncation around would pass.
    const whole = 1785316028000;
    seedSchedule(whole);
    const row = dueRow();
    expect(occurrenceOf(row)).toBe(whole);
    expect(claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: occurrenceOf(row),
      nowMs: whole + 5_000, nextRunMs: null, agentId: AGENT,
    })).not.toBeNull();
  });

  it('the display projection still reads as second-resolution TEXT beside the raw column', () => {
    // The fix ADDS a raw column; it does not change what the tracker and the dashboard
    // render. If `next_run_at` ever stopped being the SQLite-form text, every reader
    // `tracker-view.ts` feeds would shift shape silently.
    seedSchedule(MS_OCCURRENCE);
    const row = dueRow();
    expect(row.next_run_at).toBe('2026-07-29 09:07:08');
    expect(row.next_run_at_ms).toBe(MS_OCCURRENCE);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('exactly once, as a constraint', () => {
  it('the claim writes an occurrence row keyed on (parent, sequence)', () => {
    seedSchedule(MS_OCCURRENCE);
    const id = claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    });
    expect(id).not.toBeNull();
    expect(occurrences()).toEqual([{ id: id!, sequence: 1, state: 'open' }]);
  });

  it('a second process reading the SAME due row loses — by constraint, not by luck', () => {
    seedSchedule(MS_OCCURRENCE);
    const row = dueRow();
    const args = {
      workId: W, sequence: 1, occurrenceMs: occurrenceOf(row),
      nowMs: MS_OCCURRENCE + 1, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    };
    const first = claimOccurrence(args);
    const second = claimOccurrence(args);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(occurrences()).toHaveLength(1);
  });

  it('the loser leaves NOTHING behind — no half-claimed row, no orphan event', () => {
    seedSchedule(MS_OCCURRENCE);
    const args = {
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    };
    claimOccurrence(args);
    claimOccurrence(args);
    const events = mockDb.current!.prepare(
      `SELECT kind FROM work_events WHERE kind = ?`,
    ).all(OCCURRENCE_EVENT.fired) as Array<{ kind: string }>;
    expect(events).toHaveLength(1);
  });

  it('the NEXT sequence is a different occurrence and claims cleanly', () => {
    seedSchedule(MS_OCCURRENCE);
    expect(claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    })).not.toBeNull();
    // the schedule advanced to the next occurrence and went back to waiting
    mockDb.current!.prepare(
      `UPDATE work SET schedule_status = 'waiting' WHERE id = ?`,
    ).run(W);
    expect(claimOccurrence({
      workId: W, sequence: 2, occurrenceMs: MS_OCCURRENCE + 1000,
      nowMs: MS_OCCURRENCE + 1001, nextRunMs: null, agentId: AGENT,
    })).not.toBeNull();
    expect(occurrences().map(o => o.sequence)).toEqual([1, 2]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('the schedule preconditions the due-scan read', () => {
  it('a paused schedule cannot be claimed, and no occurrence row survives the attempt', () => {
    seedSchedule(MS_OCCURRENCE, { is_paused: 1 });
    expect(claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    })).toBeNull();
    expect(occurrences()).toHaveLength(0);
  });

  it('a schedule already running cannot be claimed again', () => {
    seedSchedule(MS_OCCURRENCE, { schedule_status: 'running' });
    expect(claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    })).toBeNull();
    expect(occurrences()).toHaveLength(0);
  });

  it('an occurrence that moved under the tick cannot be claimed', () => {
    seedSchedule(MS_OCCURRENCE);
    expect(claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE - 60_000, // a stale read
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    })).toBeNull();
    expect(occurrences()).toHaveLength(0);
  });

  it('D21 advance-at-fire: the NEXT occurrence is written when THIS one is claimed', () => {
    seedSchedule(MS_OCCURRENCE);
    const next = MS_OCCURRENCE + 86_400_000;
    claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: next, agentId: AGENT,
    });
    const after = mockDb.current!.prepare(
      'SELECT next_run_at, last_run_at, schedule_status FROM work WHERE id = ?',
    ).get(W) as { next_run_at: number; last_run_at: number; schedule_status: string };
    expect(after).toEqual({
      next_run_at: next, last_run_at: MS_OCCURRENCE + 1, schedule_status: 'running',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('a crashed fire cannot lose the occurrence', () => {
  it('the row persists `open` and names which occurrence was in flight', () => {
    seedSchedule(MS_OCCURRENCE);
    const id = claimOccurrence({
      workId: W, sequence: 7, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    });
    // …and now the process dies. Nothing else runs.
    expect(inFlightOccurrence(W)).toEqual({ id: id!, sequence: 7 });
  });

  it('a settled occurrence is no longer in flight', () => {
    seedSchedule(MS_OCCURRENCE);
    const id = claimOccurrence({
      workId: W, sequence: 7, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    })!;
    settleOccurrence(id, 'complete', null, null);
    expect(inFlightOccurrence(W)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('release — D21s unfired hand-back, carried', () => {
  it('restores the occurrence and the prior last_run_at exactly, and removes the row', () => {
    seedSchedule(MS_OCCURRENCE, { last_run_at: MS_OCCURRENCE - 86_400_000 });
    const prior = (mockDb.current!.prepare('SELECT last_run_at FROM work WHERE id = ?')
      .get(W) as { last_run_at: number }).last_run_at;
    const id = claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    })!;

    releaseOccurrence(id, W, MS_OCCURRENCE, prior, 'no agent available in the group');

    const after = mockDb.current!.prepare(
      'SELECT next_run_at, last_run_at, schedule_status FROM work WHERE id = ?',
    ).get(W) as { next_run_at: number; last_run_at: number; schedule_status: string };
    expect(after).toEqual({
      next_run_at: MS_OCCURRENCE, last_run_at: prior, schedule_status: 'waiting',
    });
    expect(occurrences()).toHaveLength(0);
  });

  it('and the SAME sequence can then be claimed again on the next tick', () => {
    // The release must not burn the sequence, or a group that was momentarily empty would
    // lose that occurrence forever — the exact failure the release exists to prevent.
    seedSchedule(MS_OCCURRENCE);
    const id = claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    })!;
    releaseOccurrence(id, W, MS_OCCURRENCE, null, 'no agent available');
    expect(claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 2, nextRunMs: MS_OCCURRENCE + 1000, agentId: AGENT,
    })).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('settling an occurrence — the run outcome, not a judgement', () => {
  const claim = (): string => {
    seedSchedule(MS_OCCURRENCE);
    return claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    })!;
  };
  const stateOf = (id: string): string =>
    (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

  it('a failed run fails its occurrence', () => {
    const id = claim();
    expect(settleOccurrence(id, 'failed', null, 'provider error').outcome!.kind).toBe('applied');
    expect(stateOf(id)).toBe('failed');
  });

  it('a skipped occurrence is abandoned', () => {
    const id = claim();
    expect(settleOccurrence(id, 'skipped', null, null).outcome!.kind).toBe('applied');
    expect(stateOf(id)).toBe('abandoned');
  });

  it('a completed run with NOTHING delivered is abandoned, and says so', () => {
    // G7 is a DB CHECK as well as a gate. No sentinel delivery is invented to make this
    // read as `done` — the same call T7 made for commitments and T8b for tracker closes.
    const id = claim();
    const r = settleOccurrence(id, 'complete', null, null);
    expect(r.verdict).toBe('settled');
    expect(r.outcome!.kind).toBe('applied');
    expect(stateOf(id)).toBe('abandoned');
    const ev = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition'`,
    ).get(id) as { payload: string };
    expect(ev.payload).toContain('nothing delivered');
  });

  it('a completed run WITH a delivery reaches done, pointing at it', () => {
    const id = claim();
    mockDb.current!.exec(`CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY)`);
    mockDb.current!.prepare('INSERT INTO deliveries (id) VALUES (?)').run('d1');
    expect(settleOccurrence(id, 'complete', 'd1', 'said it').outcome!.kind).toBe('applied');
    expect(stateOf(id)).toBe('done');
    const row = mockDb.current!.prepare('SELECT result_delivery_id FROM work WHERE id = ?')
      .get(id) as { result_delivery_id: string };
    expect(row.result_delivery_id).toBe('d1');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('the board never sees an occurrence', () => {
  it('occurrences are outside the tracker scope, so they cannot render as tasks', () => {
    seedSchedule(MS_OCCURRENCE);
    claimOccurrence({
      workId: W, sequence: 1, occurrenceMs: MS_OCCURRENCE,
      nowMs: MS_OCCURRENCE + 1, nextRunMs: null, agentId: AGENT,
    });
    const onBoard = mockDb.current!.prepare(
      `SELECT count(*) AS n FROM work
        WHERE kind IN ('task','project') AND root_kind IN ('legacy','tracker')`,
    ).get() as { n: number };
    expect(onBoard.n).toBe(1); // the schedule itself, and nothing else
  });
});
