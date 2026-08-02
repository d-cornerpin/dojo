// CRASH TEST C (PHASE-4 T2 Step 3) — kill inside a unit; a restart sees BOTH
// writes or NEITHER, and nothing was ever emitted about the uncommitted state.
//
// DRIVEN, NOT OBSERVED — roadmap #11's corollary, applied literally. The
// evidence is not "we reasoned that a transaction rolls back"; it is a real
// child process that opens the platform's own connection, starts a real unit,
// and is SIGKILLed with the transaction open. Then a SECOND process — the
// restart — opens the same file and reads the tables. Nothing here is
// simulated: no mocked db, no thrown error standing in for a crash, no
// `finally` given the chance to be polite.
//
// SIGKILL specifically. A throw proves the try/catch works. A kill proves what
// is on DISK, which is the only thing a restart can read.
//
// The "broadcast" is a durable sink (an appended file) rather than a ws frame,
// for the same reason: a frame leaves no evidence a restart can read, and the
// corollary requires reading a durable sink with a denominator, never observing.
//
// The positive control is the same child killed one line LATER — after the unit
// commits. Both writes are there and the effect fired. Without it, "the table is
// empty" would only prove the child never got started.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'crash-c-child.ts');
const TSX = path.resolve(here, '../../../../../node_modules/.bin/tsx');

let home: string;
let sink: string;

/** The child's DB, at the path `db/connection.ts` builds from ITS `$HOME`. */
const dbPath = (): string => path.join(home, '.dojo', 'data', 'dojo.db');

/** THE RESTART: a brand-new connection to the file the dead process left behind. */
function restartAndRead(): string[] {
  if (!fs.existsSync(dbPath())) return [];
  const db = new Database(dbPath(), { readonly: true });
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crash_c'").get();
    if (!t) return [];
    return (db.prepare('SELECT id FROM crash_c ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
  } finally {
    db.close();
  }
}

/** Did the dead process get far enough to CREATE the table? Without this, "the table
 *  is empty" and "the child never started" read identically. */
function tableExists(): boolean {
  if (!fs.existsSync(dbPath())) return false;
  const db = new Database(dbPath(), { readonly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crash_c'").get() !== undefined;
  } finally { db.close(); }
}

const emitted = (): string[] =>
  fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean) : [];

/** Returns 'killed' when the child really died on SIGKILL. `tsx` runs the script in a
 *  grandchild and forwards the death as status 137 (128 + 9) rather than as a signal on
 *  its own process, so both shapes count — and anything else does NOT, which is what
 *  makes the arms meaningful. */
function runChild(mode: 'kill-inside' | 'kill-after'): string {
  const r = spawnSync(TSX, [CHILD, mode, sink], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.signal === 'SIGKILL' || r.status === 137) return 'killed';
  return `exited:${String(r.status)}:${String(r.signal)}${r.stderr ? ` :: ${r.stderr.slice(0, 300)}` : ''}`;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-crashc-'));
  sink = path.join(home, 'effects.log');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('crash test C — a unit killed mid-flight leaves no half-truth', () => {
  it('POSITIVE CONTROL: killed AFTER the commit — the restart sees BOTH writes, and the effect fired', () => {
    expect(runChild('kill-after')).toBe('killed');   // it really died, it did not return
    expect(restartAndRead()).toEqual(['first', 'second']);
    expect(emitted()).toEqual(['EMITTED']);
  });

  it('THE PROPERTY: killed INSIDE the unit — the restart sees NEITHER write', () => {
    expect(runChild('kill-inside')).toBe('killed');
    // It got as far as creating the table, so the emptiness below is a ROLLBACK and
    // not a child that never ran.
    expect(tableExists()).toBe(true);
    // Not "one of them". Not "the first one". Neither.
    expect(restartAndRead()).toEqual([]);
  });

  it('THE LAW: nothing was emitted about the state that never committed', () => {
    runChild('kill-inside');
    expect(tableExists()).toBe(true);   // same guard: the child really ran
    // The queued effect describes writes that a restart cannot find. It must never
    // have run — which is what makes commit-then-emit a property rather than a habit.
    expect(emitted()).toEqual([]);
  });

  it('the two arms differ ONLY in where the kill lands — same child, same writes', () => {
    // Stated as a clause so nobody later "fixes" the arms apart: if the two modes
    // diverged in what they write, the comparison above would prove nothing.
    const src = fs.readFileSync(CHILD, 'utf8');
    expect(src).toMatch(/kill-inside/);
    expect(src).toMatch(/kill-after/);
    // Both arms write the same two rows and queue the same one effect.
    expect(src.match(/put\('first'\)/g)).toHaveLength(2);
    expect(src.match(/put\('second'\)/g)).toHaveLength(2);
    expect(src.match(/afterCommit\(\(\) => emit\('EMITTED'\)\)/g)).toHaveLength(2);
  });
});
