// PHASE-4 T2 Step 1 — the platform's transaction primitive and its effect queue.
//
// Two facts this file exists to make true, both of which the tree could not
// state before it:
//
//   1. `withUnit(fn)` runs related writes as ONE unit — both or neither — and it
//      is SYNCHRONOUS BY TYPE. A transaction cannot span an await: SQLite's
//      transaction is a property of the CONNECTION, and this process has exactly
//      one, so an `await` inside a transaction hands the connection to whatever
//      else the event loop is holding, mid-transaction. The signature refuses
//      that shape rather than a comment asking nicely — and the refusal is a
//      COMPILE fact, which is why it is not asserted here: a file that does not
//      compile cannot also run assertions. It is proven by PLANTING the three
//      async shapes and reading the compiler's own refusal; the command and its
//      verbatim output are recorded in `../unit.ts`'s header and in
//      `.superpowers/sdd/PHASE-4/task-T2-report.md`.
//   2. `afterCommit(fn)` queues an effect — a broadcast, a wake — that runs only
//      after the outermost unit COMMITS. Commit-then-emit is the law (research
//      22: no concurrency primitive existed at all, and 53 mutation sites at
//      HEAD still sit within 15 lines of a broadcast). **A thrown unit runs NO
//      afterCommit**, because a broadcast about a write that rolled back is the
//      platform lying to every listener at once.
//
// Everything here is a real SQLite database in a temp dir, because the claim is
// about transactions and a mock cannot roll one back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../connection.js', async () => {
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-unit-test', 'dojo.db'),
  };
});

import { withUnit, afterCommit } from '../unit.js';

let dir: string;

const rows = (): Array<{ id: string }> =>
  mockDb.current!.prepare('SELECT id FROM t ORDER BY id').all() as Array<{ id: string }>;
const put = (id: string): void => { mockDb.current!.prepare('INSERT INTO t (id) VALUES (?)').run(id); };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-unit-'));
  mockDb.current = new Database(path.join(dir, 'dojo.db'));
  mockDb.current.pragma('journal_mode = WAL');
  mockDb.current.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('withUnit — both writes or neither', () => {
  it('POSITIVE: two writes inside one unit are both there when it returns', () => {
    const out = withUnit(() => { put('a'); put('b'); return 'done'; });
    expect(out).toBe('done');
    expect(rows().map(r => r.id)).toEqual(['a', 'b']);
  });

  it('NEGATIVE: a unit that throws after the FIRST write leaves NEITHER', () => {
    expect(() => withUnit(() => {
      put('a');
      throw new Error('the second write never happens');
    })).toThrow('the second write never happens');
    // The whole point: `a` is not there either.
    expect(rows()).toEqual([]);
  });

  it('the unit is closed when it returns — nothing is left open for the next caller', () => {
    withUnit(() => { put('a'); });
    expect(mockDb.current!.inTransaction).toBe(false);
  });

  it('a NESTED unit is part of the outer one: the outer throwing discards the inner writes', () => {
    expect(() => withUnit(() => {
      withUnit(() => { put('inner'); });
      put('outer');
      throw new Error('outer fails after the inner returned');
    })).toThrow('outer fails after the inner returned');
    expect(rows()).toEqual([]);
  });
});

describe('afterCommit — commit-then-emit is the law', () => {
  it('POSITIVE: the effect runs AFTER the unit commits, never during it', () => {
    const seen: string[] = [];
    withUnit(() => {
      put('a');
      afterCommit(() => {
        seen.push('effect');
        // The effect sees a CLOSED transaction and a committed row. Both, because
        // "after commit" is two claims: not inside, and the write is durable.
        seen.push(`inTransaction=${String(mockDb.current!.inTransaction)}`);
        seen.push(`rows=${String(rows().length)}`);
      });
      seen.push('unit-body-end');
    });
    expect(seen).toEqual(['unit-body-end', 'effect', 'inTransaction=false', 'rows=1']);
  });

  it('NEGATIVE: a THROWN unit runs NO afterCommit — nobody is told about a write that rolled back', () => {
    let fired = 0;
    expect(() => withUnit(() => {
      put('a');
      afterCommit(() => { fired++; });
      throw new Error('rolled back');
    })).toThrow('rolled back');
    expect(fired).toBe(0);
    expect(rows()).toEqual([]);
  });

  it('effects run in the order they were queued', () => {
    const seen: number[] = [];
    withUnit(() => {
      afterCommit(() => seen.push(1));
      afterCommit(() => seen.push(2));
      afterCommit(() => seen.push(3));
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('a NESTED unit\'s effect waits for the OUTERMOST commit, not the inner return', () => {
    const seen: string[] = [];
    withUnit(() => {
      withUnit(() => { afterCommit(() => seen.push('inner-effect')); });
      // The inner unit has returned. A SAVEPOINT release is not a commit, so nothing
      // has been emitted yet — this is the assertion that makes nesting honest.
      seen.push('inner-returned');
    });
    expect(seen).toEqual(['inner-returned', 'inner-effect']);
  });

  it('NEGATIVE: an inner unit\'s effect is discarded when the OUTER unit throws', () => {
    let fired = 0;
    expect(() => withUnit(() => {
      withUnit(() => { put('inner'); afterCommit(() => { fired++; }); });
      throw new Error('outer fails');
    })).toThrow('outer fails');
    expect(fired).toBe(0);
  });

  it('OUTSIDE a unit the effect runs immediately — autocommit already committed it', () => {
    // Not a special case being tolerated: in autocommit mode the write IS committed by
    // the time the next statement runs, so running now IS commit-then-emit. The
    // alternative (throw) would make every call site ask "am I in a unit?", which is
    // the ceremony this primitive exists to remove.
    let fired = 0;
    put('a');
    afterCommit(() => { fired++; });
    expect(fired).toBe(1);
  });

  it('an effect that THROWS does not roll the commit back and does not stop the others', () => {
    const seen: string[] = [];
    withUnit(() => {
      put('a');
      afterCommit(() => { seen.push('first'); throw new Error('a listener blew up'); });
      afterCommit(() => { seen.push('second'); });
    });
    // The write is committed and the second effect still ran: an effect is downstream
    // of the truth, never a condition on it.
    expect(rows().map(r => r.id)).toEqual(['a']);
    expect(seen).toEqual(['first', 'second']);
  });

  it('the queue does not leak between units', () => {
    let first = 0;
    withUnit(() => { afterCommit(() => { first++; }); });
    expect(first).toBe(1);
    // A second unit that queues nothing must not re-run the first unit's effect.
    withUnit(() => { put('b'); });
    expect(first).toBe(1);
  });

  it('a THROWN unit does not poison the next one — the discarded queue is cleared', () => {
    let fired = 0;
    expect(() => withUnit(() => { afterCommit(() => { fired++; }); throw new Error('x'); })).toThrow('x');
    expect(fired).toBe(0);
    withUnit(() => { put('a'); });
    expect(fired).toBe(0);
  });
});
