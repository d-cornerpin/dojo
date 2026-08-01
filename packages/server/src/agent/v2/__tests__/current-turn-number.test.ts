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
// `finalizeTurn` — and the golden's own agent `kevin` had an open row at turn 246 while
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
    allocate('kevin', 1); allocate('kevin', 2); allocate('kevin', 3);
    expect(currentTurnNumber('kevin')).toBe(3);
  });

  it('a STALE OPEN turn does not drag it backwards — the measured kevin case', () => {
    // kevin, on the live body: open row at 246, allocated up to 264. A reader keyed on
    // `ended_at IS NULL` would have answered 246 — eighteen turns stale, on the agent both
    // prompt goldens are bound to.
    allocate('kevin', 246, null);
    for (let n = 247; n <= 264; n++) allocate('kevin', n);
    expect(currentTurnNumber('kevin')).toBe(264);
  });

  it('ADVANCES on a turn that persisted no message — research 06 §7\'s named defect', () => {
    // This is the whole reason the old derivation was wrong. MAX over `messages.turn_number`
    // only moved when a row landed, so a turn that wrote nothing left the continuity-brief
    // and scaffolding windows frozen. Measured on the live body: 19 of 48 agents with
    // stamped messages had `turns` AHEAD of `messages`.
    allocate('kevin', 1); allocate('kevin', 2);
    expect(currentTurnNumber('kevin')).toBe(2);
    allocate('kevin', 3);   // a turn that writes no message at all
    expect(currentTurnNumber('kevin')).toBe(3);
  });

  it('is per AGENT, not global', () => {
    allocate('kevin', 9); allocate('kelly', 2);
    expect(currentTurnNumber('kevin')).toBe(9);
    expect(currentTurnNumber('kelly')).toBe(2);
  });

  it('an agent with no turns yet is 0, and never throws', () => {
    expect(currentTurnNumber('nobody')).toBe(0);
  });

  it('a missing turns table returns 0 rather than killing the assembly', () => {
    mockDb.current!.exec('DROP TABLE turns');
    expect(() => currentTurnNumber('kevin')).not.toThrow();
    expect(currentTurnNumber('kevin')).toBe(0);
  });
});

// ════════ the grep-zero half — T9's exit gate depends on it ════════

describe('G24 grep-zero: no reader derives the turn from messages', () => {
  const SRC = path.resolve(__dirname, '..', '..', '..');   // packages/server/src

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

  /** The file with whole-line comments removed. Same rule and same reason as
   *  `__tests__/marker-ownership.test.ts`: a comment that NAMES the defect is the
   *  documentation this codebase runs on — `turn-record.ts`'s own docstring quotes the dead
   *  query verbatim so the next reader knows what was replaced — while a live QUERY is the
   *  drift. Without this the clause would punish the explanation and reward silence. */
  const code = (f: string) =>
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');

  /** The defect shape: a MAX over turn_number aimed at the MESSAGE store. The allocator's
   *  own `COALESCE(MAX(turn_number), 0) + 1 … FROM turns` is a different statement. */
  const DEFECT = /MAX\(turn_number\)[\s\S]{0,80}FROM messages/;

  it('`MAX(turn_number) … FROM messages` appears in NO production file', () => {
    const offenders = walk(SRC).filter((f) => DEFECT.test(code(f))).map((f) => path.relative(SRC, f));
    expect(offenders, 'PHASE-2 handed this token forward; T9\'s exit gate reads it').toEqual([]);
  });

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

  it('and the allocator still owns its own MAX — a vacuity guard on the clause above', () => {
    // If the regex above stopped matching anything at all it would go green over a rename.
    const alloc = fs.readFileSync(path.join(SRC, 'agent/v2/turn-record.ts'), 'utf8');
    expect(alloc).toMatch(/MAX\(turn_number\)/);
    expect(alloc).toMatch(/FROM turns/);
  });
});
