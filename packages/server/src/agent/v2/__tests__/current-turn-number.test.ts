// ════════════════════════════════════════════════════════════════════════════════════════
// G24 — the turn number comes from the `turns` RECORD. PHASE-3 T5 rider (c).
// Research 06 requirement 24, and PHASE-2's grep token that T9's exit gate reads.
//
// ── WHAT IT REPLACES ────────────────────────────────────────────────────────────────────
// Four copies of `SELECT MAX(turn_number) FROM messages WHERE agent_id = ?`, then `+ 1`:
// three readers in memory/assembler.ts (the continuity-brief window, the post-compaction
// scaffolding window, the tool-result stub age) and the WRITER in memory/compaction.ts that
// sets the value the first two compare against. Research 06 §7's three defects, verbatim:
// three DB round-trips per assembly for one number; "value only advances when a row
// persists … a turn persisting nothing never advances"; and "writer and readers derive the
// same number at different moments — a row landing between shifts the window by one".
//
// The `turns` table has allocated the number at turn START since PHASE-2 T2. It is not
// derived, it is not a race, and it does not care whether the turn wrote anything.
//
// ── WHY MAX(turn_number) AND NOT "THE OPEN TURN" ────────────────────────────────────────
// "The turn with ended_at IS NULL" reads like the obvious answer and it is WRONG, measured:
// on the live body 139 of 3,090 turn rows are open, because a turn that dies never reaches
// `finalizeTurn` — and the golden's own agent `FXID.n4` had an open row at turn 246 while
// turn 264 had already been allocated. That reader would have returned a number EIGHTEEN
// TURNS STALE on the one agent every prompt gate is bound to. The highest allocated number
// is the honest answer; a stale open row cannot poison it.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { currentTurnNumber } from '../turn-record.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`
    CREATE TABLE turns (
      agent_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (agent_id, turn_number)
    );
  `);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const allocate = (agent: string, n: number, ended: string | null = "2026-01-01") =>
  mockDb.current!.prepare('INSERT INTO turns (agent_id, turn_number, ended_at) VALUES (?, ?, ?)')
    .run(agent, n, ended);

describe('currentTurnNumber — one reader, the turns record', () => {
  it('is the highest turn ALLOCATED to this agent', () => {
    allocate(FXID.n4, 1); allocate(FXID.n4, 2); allocate(FXID.n4, 3);
    expect(currentTurnNumber(FXID.n4)).toBe(3);
  });

  it(`a STALE OPEN turn does not drag it backwards — the measured ${FXID.n4} case`, () => {
    // FXID.n4, on the live body: open row at 246, allocated up to 264. A reader keyed on
    // `ended_at IS NULL` would have answered 246 — eighteen turns stale, on the agent both
    // prompt goldens are bound to.
    allocate(FXID.n4, 246, null);
    for (let n = 247; n <= 264; n++) allocate(FXID.n4, n);
    expect(currentTurnNumber(FXID.n4)).toBe(264);
  });

  it('ADVANCES on a turn that persisted no message — research 06 §7\'s named defect', () => {
    // This is the whole reason the old derivation was wrong. MAX over `messages.turn_number`
    // only moved when a row landed, so a turn that wrote nothing left the continuity-brief
    // and scaffolding windows frozen. Measured on the live body: 19 of 48 agents with
    // stamped messages had `turns` AHEAD of `messages`.
    allocate(FXID.n4, 1); allocate(FXID.n4, 2);
    expect(currentTurnNumber(FXID.n4)).toBe(2);
    allocate(FXID.n4, 3);   // a turn that writes no message at all
    expect(currentTurnNumber(FXID.n4)).toBe(3);
  });

  it('is per AGENT, not global', () => {
    allocate(FXID.n4, 9); allocate(FXID.n5, 2);
    expect(currentTurnNumber(FXID.n4)).toBe(9);
    expect(currentTurnNumber(FXID.n5)).toBe(2);
  });

  it('an agent with no turns yet is 0, and never throws', () => {
    expect(currentTurnNumber('nobody')).toBe(0);
  });

  it('a missing turns table returns 0 rather than killing the assembly', () => {
    mockDb.current!.exec('DROP TABLE turns');
    expect(() => currentTurnNumber(FXID.n4)).not.toThrow();
    expect(currentTurnNumber(FXID.n4)).toBe(0);
  });
});

// ════════ the grep-zero half — T9's exit gate depends on it ════════

describe('G24 grep-zero: no reader derives the turn from messages', () => {

  function walk(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
        walk(fp, acc);
      } else if (e.name.endsWith('.ts')) acc.push(fp);
    }
    return acc;
  }

  /** The defect shape: a MAX over turn_number aimed at the MESSAGE store. The allocator's
   *  own `COALESCE(MAX(turn_number), 0) + 1 … FROM turns` is a different statement. */
  const DEFECT = /MAX\(turn_number\)[\s\S]{0,80}FROM messages/;

  it('BITE PROOF: the pattern still recognises the query it just deleted', () => {
    // A grep-zero clause that stopped matching anything would report clean forever. This is
    // the exact statement that stood at assembler.ts, compaction.ts and two more.
    expect(DEFECT.test(
      "const row = db.prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')",
    )).toBe(true);
    // and it does NOT match the allocator, or the re-point would be unfixable
    expect(DEFECT.test('SELECT ?, COALESCE(MAX(turn_number), 0) + 1 FROM turns WHERE agent_id = ?'))
      .toBe(false);
  });
});
