// PHASE-2 T8c item 1 — the drive ladder's rung is a QUERY over `work_events`, not a row count
// in `poke_log`, and it re-arms past a MARKER instead of by DELETE.
//
// Every clause below is written against the behaviour `poke_log` + `clearPokeLog` had, so the
// rekey is provably meaning-preserving, plus the ONE property the rekey adds: the previous
// cycle's pokes survive the re-arm.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-poke-ladder-test', 'dojo.db'),
  };
});

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import {
  currentRung, lastPoke, recordPoke, recordRemediation, POKE_EVENT, REMEDIATION_EVENT,
} from '../poke-ladder.js';

const W = 'task-1';
const PM = 'pm-agent';

const allEvents = (): Array<{ kind: string; payload: string | null }> =>
  mockDb.current!.prepare('SELECT kind, payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(W) as Array<{ kind: string; payload: string | null }>;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  createWorkTable(db);
  seedTrackerTask(db, { id: W, title: 'a stalled thing' });
});

describe('the rung, read from the work event log', () => {
  it('a fresh ticket is on rung 0 and has no last poke', () => {
    expect(currentRung(W)).toBe(0);
    expect(lastPoke(W)).toBeNull();
  });

  it('climbs with each recorded poke', () => {
    recordPoke(W, PM, 1, 'nudge', 'a1');
    expect(currentRung(W)).toBe(1);
    recordPoke(W, PM, 2, 'urgent', 'a1');
    expect(currentRung(W)).toBe(2);
    recordPoke(W, PM, 3, 'escalate_primary', 'primary');
    expect(currentRung(W)).toBe(3);
  });

  it('is MAX, not COUNT — a SKIPPED rung is not re-served later', () => {
    // The ladder jumps straight to `escalate_primary` when a task crosses two thresholds
    // while its assignee was mid-run. COUNT(*) would read 1 here and re-serve rungs 2 and 3.
    recordPoke(W, PM, 3, 'escalate_primary', 'primary');
    expect(currentRung(W)).toBe(3);
  });

  it('lastPoke carries the rung, the type and an epoch-ms instant', () => {
    recordPoke(W, PM, 2, 'urgent', 'a1');
    const p = lastPoke(W);
    expect(p).not.toBeNull();
    expect(p!.rung).toBe(2);
    expect(p!.pokeType).toBe('urgent');
    expect(typeof p!.sentAtMs).toBe('number');
    expect(p!.sentAtMs).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('re-arming is a MARKER, and the history survives it', () => {
  it('a remediation puts the ladder back on rung 0', () => {
    recordPoke(W, PM, 1, 'nudge', 'a1');
    recordPoke(W, PM, 2, 'urgent', 'a1');
    recordPoke(W, PM, 3, 'escalate_primary', 'primary');
    expect(currentRung(W)).toBe(3);

    recordRemediation(W, PM, 'auto-reset: the escalation ladder ran out');
    expect(currentRung(W)).toBe(0);
    expect(lastPoke(W)).toBeNull();
  });

  it('THE PROPERTY THE DELETE DESTROYED: the earlier cycle is still on the record', () => {
    recordPoke(W, PM, 1, 'nudge', 'a1');
    recordPoke(W, PM, 2, 'urgent', 'a1');
    recordRemediation(W, PM, 'retask');
    recordPoke(W, PM, 1, 'nudge', 'a1');

    const kinds = allEvents().map((e) => e.kind);
    expect(kinds).toEqual([POKE_EVENT, POKE_EVENT, REMEDIATION_EVENT, POKE_EVENT]);
    // "how many times has this work stalled" is answerable — it was not, before.
    const cycles = kinds.filter((k) => k === REMEDIATION_EVENT).length + 1;
    expect(cycles).toBe(2);
  });

  it('the ladder climbs again from nudge after a remediation', () => {
    recordPoke(W, PM, 4, 'auto_reset', 'primary');
    recordRemediation(W, PM, 'auto-reset');
    expect(currentRung(W)).toBe(0);
    recordPoke(W, PM, 1, 'nudge', 'a1');
    expect(currentRung(W)).toBe(1);
  });

  it('THE DEFECT THIS TEST CAUGHT: a poke in the SAME MILLISECOND as the remediation counts', () => {
    // The first version of this module bounded the cycle with `created_at > remediationAt`.
    // `created_at` is `Date.now()`, so a remediation followed immediately by a poke shares a
    // millisecond and the poke was excluded — the ladder would read rung 0 forever while
    // pokes were going out. The boundary is `work_events.id` for exactly this reason. Both
    // rows are written with an identical stamped instant here, which is what the clock
    // version could not survive.
    const at = 1_700_000_500_000;
    const put = mockDb.current!.prepare(
      `INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    put.run(W, REMEDIATION_EVENT, JSON.stringify({ reason: 'retask' }), PM, at);
    put.run(W, POKE_EVENT, JSON.stringify({ rung: 1, poke_type: 'nudge' }), PM, at);
    expect(currentRung(W)).toBe(1);
    expect(lastPoke(W)!.rung).toBe(1);
  });

  it('only the LATEST remediation bounds the window', () => {
    recordPoke(W, PM, 3, 'escalate_primary', 'primary');
    recordRemediation(W, PM, 'first');
    recordPoke(W, PM, 1, 'nudge', 'a1');
    recordRemediation(W, PM, 'second');
    expect(currentRung(W)).toBe(0);
  });
});

describe('scoping — negative controls of the same shape', () => {
  it('another ticket\'s pokes are not this ticket\'s rung', () => {
    seedTrackerTask(mockDb.current!, { id: 'task-2', title: 'other' });
    recordPoke('task-2', PM, 3, 'escalate_primary', 'primary');
    expect(currentRung(W)).toBe(0);
    expect(currentRung('task-2')).toBe(3);
  });

  it('another ticket\'s remediation does not re-arm this ticket', () => {
    seedTrackerTask(mockDb.current!, { id: 'task-2', title: 'other' });
    recordPoke(W, PM, 2, 'urgent', 'a1');
    recordRemediation('task-2', PM, 'unrelated');
    expect(currentRung(W)).toBe(2);
  });

  it('a non-poke event on the same ticket is not a rung', () => {
    // POSITIVE CONTROL of the same shape: the transition events `transition()` writes carry
    // no `rung`, and the ladder must not read them as rung 0-or-anything.
    mockDb.current!.prepare(
      `INSERT INTO work_events (work_id, kind, payload, actor, created_at)
       VALUES (?, 'transition', '{"to":"claimed"}', 'agent', ?)`,
    ).run(W, Date.now());
    expect(currentRung(W)).toBe(0);
    recordPoke(W, PM, 1, 'nudge', 'a1');
    expect(currentRung(W)).toBe(1);
  });
});
