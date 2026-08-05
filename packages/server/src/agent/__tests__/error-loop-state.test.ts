// PHASE-6 T10 Step 2 — THE ERROR LOOP STOPS FORGETTING, AND ITS DECISION LEAVES EVIDENCE.
//
// Two defects of one shape, both caused by the counter living in a module-scope Map:
//
//   1. THE COUNT DIED WITH THE PROCESS. An error loop that takes the server down is the one
//      that matters most, and the count reset to zero on every boot — so a crash loop could
//      never trip the brake built to stop it. `drain_state` (migration 140) is the precedent
//      and its own header is the sentence: a Map dies with the process.
//   2. THE DECISION LEFT NO EVIDENCE. The old code paused the agent and then
//      `agentErrors.delete(agentId)` — the five records that JUSTIFIED the pause were
//      destroyed at the moment they became worth reading.
//
// The restart clause below is the one that matters, and it is DRIVEN, not asserted about
// source: the module is re-imported against the same durable body with a fresh module
// registry — which is what a restart is — and the count is still there. A `Map` cannot pass
// it, and nothing else in this file would have failed on the old code alone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-error-loop-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  recordErrorInWindow, noteErrorLoopPause, clearErrorLoop, errorLoopPauses,
  ERROR_LOOP_THRESHOLD, ERROR_LOOP_WINDOW_MS,
} from '../error-loop-state.js';

const AGENT = 'kevin';
const OTHER = 'other';
const T0 = 1_700_000_000_000;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Kevin', 'idle'), (?, 'Other', 'idle')")
    .run(AGENT, OTHER);
});

const rowsOfKind = (kind: string, agentId = AGENT): number =>
  (mockDb.current!.prepare(
    'SELECT count(*) AS n FROM error_loop_state WHERE agent_id = ? AND kind = ?',
  ).get(agentId, kind) as { n: number }).n;

describe('T10 Step 2 — the bounds are the tree\'s own, and nothing was tuned', () => {
  it('five errors in two minutes, exactly as before', () => {
    expect(ERROR_LOOP_THRESHOLD).toBe(5);
    expect(ERROR_LOOP_WINDOW_MS).toBe(2 * 60 * 1000);
  });
});

describe('T10 Step 2 — the window, with the Map\'s semantics preserved', () => {
  it('four errors do not trip; the fifth does', () => {
    for (let i = 1; i <= 4; i++) {
      const w = recordErrorInWindow(AGENT, T0 + i);
      expect(w.count).toBe(i);
      expect(w.tripped).toBe(false);
    }
    const fifth = recordErrorInWindow(AGENT, T0 + 5);
    expect(fifth.count).toBe(5);
    expect(fifth.tripped).toBe(true);
    expect(fifth.firstAtMs).toBe(T0 + 1);
  });

  it('errors that fall OUT of the window stop counting — five spread over an hour is not a loop', () => {
    for (let i = 0; i < 4; i++) recordErrorInWindow(AGENT, T0 + i * 15 * 60_000);
    const w = recordErrorInWindow(AGENT, T0 + 4 * 15 * 60_000);
    expect(w.count, 'each error aged out before the next arrived').toBe(1);
    expect(w.tripped).toBe(false);
  });

  it('the boundary is the same one the Map used: a record exactly at the window edge is dropped', () => {
    recordErrorInWindow(AGENT, T0);
    const w = recordErrorInWindow(AGENT, T0 + ERROR_LOOP_WINDOW_MS);
    expect(w.count).toBe(1);
  });

  it('the window is PER AGENT — another agent\'s errors never pause this one', () => {
    for (let i = 0; i < 4; i++) recordErrorInWindow(OTHER, T0 + i);
    const w = recordErrorInWindow(AGENT, T0 + 5);
    expect(w.count).toBe(1);
    expect(w.tripped).toBe(false);
  });

  it('two errors in the SAME millisecond are two errors', () => {
    // The reason the table has an autoincrement id rather than a composite key on (agent,
    // at_ms): a fast crash loop records several errors inside one millisecond, and a
    // collision there would UNDER-count exactly the case the brake exists for.
    recordErrorInWindow(AGENT, T0);
    expect(recordErrorInWindow(AGENT, T0).count).toBe(2);
  });

  it('a clean turn clears the window and the next error starts from one', () => {
    for (let i = 0; i < 3; i++) recordErrorInWindow(AGENT, T0 + i);
    clearErrorLoop(AGENT);
    expect(recordErrorInWindow(AGENT, T0 + 10).count).toBe(1);
  });
});

describe('T10 Step 2 — the pause decision leaves evidence', () => {
  it('the trip writes ONE durable row carrying the numbers it decided on', () => {
    let w = { count: 0, firstAtMs: null as number | null, tripped: false };
    for (let i = 1; i <= 5; i++) w = recordErrorInWindow(AGENT, T0 + i);
    expect(w.tripped).toBe(true);

    noteErrorLoopPause(AGENT, w, T0 + 6);

    const pauses = errorLoopPauses(AGENT);
    expect(pauses).toHaveLength(1);
    expect(pauses[0].atMs).toBe(T0 + 6);
    const detail = JSON.parse(pauses[0].detail!) as Record<string, number>;
    expect(detail.errorCount).toBe(5);
    expect(detail.threshold).toBe(ERROR_LOOP_THRESHOLD);
    expect(detail.windowMs).toBe(ERROR_LOOP_WINDOW_MS);
    expect(detail.firstErrorAtMs).toBe(T0 + 1);
  });

  it('the trip clears the WINDOW and keeps the DECISION — the old code deleted both', () => {
    let w = { count: 0, firstAtMs: null as number | null, tripped: false };
    for (let i = 1; i <= 5; i++) w = recordErrorInWindow(AGENT, T0 + i);
    noteErrorLoopPause(AGENT, w, T0 + 6);
    expect(rowsOfKind('error'), 'the window is reset, as the Map was').toBe(0);
    expect(rowsOfKind('paused'), 'the decision survives it').toBe(1);
    // …and the next loop starts from one, exactly as `agentErrors.delete` made it.
    expect(recordErrorInWindow(AGENT, T0 + 7).count).toBe(1);
  });

  it('a clean turn does NOT erase a past pause — evidence is not working state', () => {
    let w = { count: 0, firstAtMs: null as number | null, tripped: false };
    for (let i = 1; i <= 5; i++) w = recordErrorInWindow(AGENT, T0 + i);
    noteErrorLoopPause(AGENT, w, T0 + 6);
    clearErrorLoop(AGENT);
    expect(errorLoopPauses(AGENT)).toHaveLength(1);
  });

  it('each pause is its own row — a repeat offender has a history, not an overwrite', () => {
    for (const trip of [0, 1]) {
      let w = { count: 0, firstAtMs: null as number | null, tripped: false };
      for (let i = 1; i <= 5; i++) w = recordErrorInWindow(AGENT, T0 + trip * 1000 + i);
      noteErrorLoopPause(AGENT, w, T0 + trip * 1000 + 6);
    }
    expect(errorLoopPauses(AGENT)).toHaveLength(2);
    // newest first
    expect(errorLoopPauses(AGENT)[0].atMs).toBeGreaterThan(errorLoopPauses(AGENT)[1].atMs);
  });
});

describe('T10 Step 2 — IT SURVIVES A RESTART, and that is the whole point', () => {
  it('four errors, then a RESTART, then one more: the fifth still trips', async () => {
    // A crash loop is the case the brake exists for, and it was the one case the Map could
    // not see: the process that dies takes the count with it, so the next boot starts at
    // zero and the brake can never engage.
    for (let i = 1; i <= 4; i++) recordErrorInWindow(AGENT, T0 + i);

    // THE RESTART, driven: the module registry is reset and the module is imported afresh,
    // against the same durable body. Every module-scope value the old implementation kept —
    // including a `Map` — is gone at this line.
    vi.resetModules();
    const fresh = await import('../error-loop-state.js');
    expect(fresh.recordErrorInWindow).not.toBe(recordErrorInWindow); // a genuinely new module

    const w = fresh.recordErrorInWindow(AGENT, T0 + 5);
    expect(w.count, 'the four errors from before the restart are still counted').toBe(5);
    expect(w.tripped, 'the brake engages across the restart').toBe(true);
  });

  it('and the evidence is readable after a restart too', async () => {
    let w = { count: 0, firstAtMs: null as number | null, tripped: false };
    for (let i = 1; i <= 5; i++) w = recordErrorInWindow(AGENT, T0 + i);
    noteErrorLoopPause(AGENT, w, T0 + 6);

    vi.resetModules();
    const fresh = await import('../error-loop-state.js');
    const pauses = fresh.errorLoopPauses(AGENT);
    expect(pauses).toHaveLength(1);
    expect(JSON.parse(pauses[0].detail!).errorCount).toBe(5);
  });
});

describe('T10 Step 2 — direction of error: an unreadable spine never pauses an agent', () => {
  it('a missing table reports NO LOOP rather than a trip', () => {
    // Pausing is the platform's most drastic engine-level action and must never be taken
    // from a state nobody could read. The error is still logged and still lands on
    // `agents.last_error`; the Healer's own detectors do not depend on this table.
    mockDb.current!.exec('DROP TABLE error_loop_state');
    const w = recordErrorInWindow(AGENT, T0);
    expect(w).toEqual({ count: 0, firstAtMs: null, tripped: false });
  });

  it('the readers fail soft too, and say so rather than throwing into the error path', () => {
    mockDb.current!.exec('DROP TABLE error_loop_state');
    expect(errorLoopPauses(AGENT)).toEqual([]);
    expect(() => clearErrorLoop(AGENT)).not.toThrow();
    expect(() => noteErrorLoopPause(AGENT, { count: 5, firstAtMs: T0, tripped: true })).not.toThrow();
  });
});
