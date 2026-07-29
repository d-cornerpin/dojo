// PHASE-2 T10, RULING 5 — the drain ladders survive a restart.
//
// The property, in one sentence: `stuck` counts CONSECUTIVE drain passes over the SAME
// head, a new head resets it to zero, and NEITHER fact is lost when the process dies.
// The last clause is the whole reason this table exists — a `Map` reset both ladders to
// zero on every boot, so a crash loop reset the storm protection with them.
//
// Every clause below has a negative control beside it, because a ladder that only ever
// goes up and a ladder that never goes up both pass a one-directional test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-drain-state-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  bumpDrainLadder, clearDrainLadder, clearAllDrainLadders, drainLadder,
  DRAIN_LADDER_UNREADABLE,
} from '../drain-state.js';

const A = 'kevin';
const B = 'ana';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01'), (?, 'Ana', 'idle', '1970-01-01')`,
  ).run(A, B);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the ladder counts consecutive passes over one head', () => {
  it('first sighting is 0, and each further pass over the SAME head is one more', () => {
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(0);
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(1);
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(2);
  });

  it('NEGATIVE CONTROL: a NEW head resets to zero — it does not keep counting', () => {
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:2')).toBe(0);
    expect(drainLadder(A, 'unserved_wake')).toEqual({ head: 'w:2', stuck: 0 });
  });

  it('the two drains of one agent are separate ladders', () => {
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(0);
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(1);
    // The human drain has never seen anything; it must not inherit the other's count.
    expect(bumpDrainLadder(A, 'human_conversation', '900')).toBe(0);
    expect(drainLadder(A, 'unserved_wake')!.stuck).toBe(1);
  });

  it('two agents are separate ladders', () => {
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    expect(bumpDrainLadder(B, 'unserved_wake', 'w:1')).toBe(0);
  });
});

describe('THE POINT: the ladder survives the process', () => {
  it('a "restart" (a fresh handle onto the same file) keeps the count', () => {
    // A real restart is a new process onto the same database file. `:memory:` cannot be
    // reopened, so the equivalent is done honestly: write through one handle, drop every
    // in-process reference, and read the value back out of the FILE.
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const fs = require('node:fs') as typeof import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-drain-restart-'));
    const file = path.join(dir, 'dojo.db');

    mockDb.current?.close();
    mockDb.current = new Database(file);
    mockDb.current.pragma('foreign_keys = ON');
    runMigrations();
    mockDb.current.pragma('foreign_keys = ON');
    mockDb.current.prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
    ).run(A);

    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(0);
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(1);

    // ── the crash ──
    mockDb.current.close();
    mockDb.current = new Database(file);
    mockDb.current.pragma('foreign_keys = ON');

    // The Map lost this. The table does not: the next pass is the THIRD, not the first.
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(2);

    mockDb.current.close();
    mockDb.current = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('clearing', () => {
  it('clearDrainLadder removes one drain and leaves the other', () => {
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    bumpDrainLadder(A, 'human_conversation', '900');
    clearDrainLadder(A, 'unserved_wake');
    expect(drainLadder(A, 'unserved_wake')).toBeNull();
    expect(drainLadder(A, 'human_conversation')).not.toBeNull();
  });

  it('a cleared ladder starts again at zero', () => {
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    clearDrainLadder(A, 'unserved_wake');
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).toBe(0);
  });

  it('clearAllDrainLadders clears both drains of ONE agent and nobody else', () => {
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    bumpDrainLadder(A, 'human_conversation', '900');
    bumpDrainLadder(B, 'unserved_wake', 'w:1');
    clearAllDrainLadders(A);
    expect(drainLadder(A, 'unserved_wake')).toBeNull();
    expect(drainLadder(A, 'human_conversation')).toBeNull();
    expect(drainLadder(B, 'unserved_wake')).not.toBeNull();
  });
});

describe('direction of error', () => {
  it('an unwritable spine stands the drain DOWN rather than reporting a fresh head', () => {
    // The failing direction matters: 0 would re-enable the unbounded spin this bound exists
    // to stop. The value returned must be above every bound in the tree.
    mockDb.current!.exec('DROP TABLE drain_state');
    const n = bumpDrainLadder(A, 'unserved_wake', 'w:1');
    expect(n).toBe(DRAIN_LADDER_UNREADABLE);
    expect(n).toBeGreaterThan(4); // MAX_DRAIN_STUCK, the larger of the two live bounds
    expect(n).toBeGreaterThan(2); // the unserved-wake drain's bound
  });

  it('NEGATIVE CONTROL: a healthy spine does NOT return the stand-down sentinel', () => {
    expect(bumpDrainLadder(A, 'unserved_wake', 'w:1')).not.toBe(DRAIN_LADDER_UNREADABLE);
  });

  it('clearing never throws on an unwritable spine', () => {
    mockDb.current!.exec('DROP TABLE drain_state');
    expect(() => clearDrainLadder(A, 'unserved_wake')).not.toThrow();
    expect(() => clearAllDrainLadders(A)).not.toThrow();
    expect(drainLadder(A, 'unserved_wake')).toBeNull();
  });
});

describe('the row goes when the agent goes', () => {
  it('deleting the agent takes its ladders with it', () => {
    bumpDrainLadder(A, 'unserved_wake', 'w:1');
    mockDb.current!.prepare('DELETE FROM agents WHERE id = ?').run(A);
    expect(drainLadder(A, 'unserved_wake')).toBeNull();
  });
});
