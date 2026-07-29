// PHASE-2 T2 Step 3 — the work spine's single-writer conformance walk.
//
// Two guarantees, one walk, and they are deliberately different shapes:
//
//   PART A — THE TWO-CLAUSE PROPERTY (orchestrator ruling, PHASE-2 ledger 2026-07-29, T6
//     acceptance §3; executed by T8b, which is the task that needed the split).
//       (a) every write to `work` / `work_events` / `adjudications` lives under `work/`, and
//       (b) `work.state` UPDATEs exist ONLY in `store.ts`, inside `transition()`.
//     Clause (b) is the sharp half and it is what the original file-scoped rule was FOR:
//     the thing being protected was never "one file touches the table", it was "one gate
//     decides a state change". Widening (a) to the directory costs nothing as long as (b)
//     holds, and (b) is now checked directly instead of implied.
//     Both clauses have planted-fault proofs below; a rule with no proof it bites is a
//     comment.
//
//   PART B — THE BURN-DOWN, NOW EMPTY. `legacy_tasks` / `legacy_projects` state writes were
//     the conversion T8 owed. PHASE-2 T8b drove the allowlist to zero: the tracker's rows
//     live on `work` and every state change goes through `transition()`. The list stays,
//     empty, because an empty list that is CHECKED is the proof; deleting the check would
//     make a regression invisible.
//
// The walk reads source with fs.readFileSync rather than grep: two of this tree's largest
// files carry NUL bytes and grep skips them silently, and `grep` on this machine is ugrep.
//
// ── THE MEASURED MATRIX (re-derived at this commit, not inherited) ──
// Command (scanner in the task report; it captures each UPDATE statement BODY so multi-line
// SQL is not missed the way a single-line grep misses it, and it blanks comments first
// because two of the raw matches are PROSE describing a call):
//
//   node scan-writers.mjs packages/server/src
//     -> TOTAL UPDATE legacy_tasks|legacy_projects statements (production, non-test): 86
//        R1 raw inline SQL that sets status: 36 sites / 8 files
//        R2 updateTask({ status }) call sites: 11 sites / 2 files
//        GRID TOTAL: 47 state-writing sites across 9 files
//     (+2 declared by PHASE-2 T6 — see the note on the allowlist below: 49 across 10 files)
//
// CORRECTION TO PHASE-2.md's PINNED §13, recorded rather than silently adopted (#14): the
// plan's table says "48 state-writing sites ... across 12 files" and labels R2 as 12. Its
// PER-FILE lists are right and were confirmed line for line; the two AGGREGATES are not.
// T0's own R2 rows sum to 11 (tracker/tools.ts 10 + gateway/routes/tracker.ts 1), and the
// distinct file count across both routes is 9, not 12. 36 + 11 = 47.
//
// The other 39 of the 86 `UPDATE legacy_*` statements touch non-state columns; they are the
// denormalized-cache surface research 03 dispositions as DIE and are NOT this walk's
// business — a walk that failed on them would be enforcing a rule nobody wrote.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', '..');
/** Clause (b): the ONE module that may move `work.state`. */
const STATE_WRITER_MODULE = 'work/store.ts';
/** Clause (a): the directory the spine's writes live inside. */
const WRITER_DIR = 'work/';

/** Matched on the TABLE, never on the verb: `INSERT OR IGNORE INTO`, an interpolated verb
 *  (`${verb} INTO x`) and an interpolated table (`INTO ${t}`) are all writes, and a gate that
 *  only knows the literal `INSERT INTO` sees a fraction of them. The word boundary keeps
 *  `work_events` from matching `work` and vice versa — it is load-bearing and self-tested. */
const SPINE_WRITE_RE = new RegExp(
  [
    String.raw`(?:INSERT(?:\s+OR\s+\w+)?|\$\{\w+\})\s+INTO\s+(?:work\b|work_events\b|adjudications\b|\$\{)`,
    String.raw`UPDATE\s+(?:work\b|work_events\b|adjudications\b|\$\{)`,
    String.raw`DELETE\s+FROM\s+(?:work\b|work_events\b|adjudications\b|\$\{)`,
  ].join('|'),
  'i',
);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const sourceFiles = (): string[] => walk(SRC).map(rel).sort();
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping line count, so prose describing a call is never counted as one. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

// ── PART B's burn-down allowlist. Each entry is {file: sites}. PHASE-2 T8 empties it. ──
// TOTAL 47. When a T8 cluster lands, its line drops out and the total below drops with it.
//
// PHASE-2 T8b EMPTIED IT. All 49 conversions landed: the tracker's rows are `work` rows,
// `tracker/schema.ts:updateTask`'s status branch (PINNED §13's ungated "route R2") is
// deleted, and every state change in the tree goes through `transition()`.
const LEGACY_STATE_WRITERS: Record<string, number> = {};
const BURN_DOWN_TOTAL = Object.values(LEGACY_STATE_WRITERS).reduce((a, b) => a + b, 0);

/** A raw UPDATE against a legacy table whose SET list assigns `status`, or a call to the
 *  generic column patcher carrying a status. Both routes must stay at zero. */
function countLegacyStateWrites(text: string): number {
  const src = stripComments(text);
  let n = 0;
  const r1 = /UPDATE\s+(legacy_tasks|legacy_projects)\b([\s\S]{0,600}?)(?=`|;\s*$|WHERE\s)/gi;
  let m: RegExpExecArray | null;
  while ((m = r1.exec(src))) if (/\bstatus\s*=/.test(m[2])) n++;
  const r2 = /updateTask\(([\s\S]{0,300}?)\)/g;
  while ((m = r2.exec(src))) if (/\bstatus\b/.test(m[1])) n++;
  return n;
}

/** Clause (b)'s matcher: an `UPDATE work` whose SET list assigns `state`. Deliberately NOT
 *  "any UPDATE work" — the tracker's attribute patcher writes this table all day and must,
 *  which is the whole point of splitting the rule in two. */
const STATE_UPDATE_RE = /UPDATE\s+work\b([\s\S]{0,600}?)(?=`|;\s*$|WHERE\s)/gi;
function writesWorkState(text: string): boolean {
  const src = stripComments(text);
  STATE_UPDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATE_UPDATE_RE.exec(src))) if (/\bstate\s*=/.test(m[1])) return true;
  return false;
}

describe('PART A — the work spine has exactly one writer', () => {
  it('CLAUSE (a): no module OUTSIDE work/ writes work, work_events or adjudications', () => {
    const offenders = sourceFiles()
      .filter((f) => !f.startsWith(WRITER_DIR))
      .filter((f) => SPINE_WRITE_RE.test(stripComments(read(f))));
    expect(offenders).toEqual([]);
  });

  it('CLAUSE (b): work.state is UPDATEd in store.ts and NOWHERE else, inside or outside work/', () => {
    const offenders = sourceFiles()
      .filter((f) => f !== STATE_WRITER_MODULE)
      .filter((f) => writesWorkState(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the writer module DOES write all three tables — the rule above is not vacuous', () => {
    const writer = read(STATE_WRITER_MODULE);
    expect(writer).toMatch(/UPDATE work\b/);
    expect(writer).toMatch(/INSERT INTO work_events\b/);
    expect(writer).toMatch(/INSERT INTO adjudications\b/);
    expect(writesWorkState(writer)).toBe(true);
  });

  it('PLANTED FAULT (a): a spine write outside work/ is caught', () => {
    expect(SPINE_WRITE_RE.test(stripComments(
      "db.prepare('INSERT INTO work (id) VALUES (?)').run(id);",
    ))).toBe(true);
  });

  it('PLANTED FAULT (b): a state UPDATE inside work/ but outside store.ts is caught', () => {
    // The exact shape the directory widening makes newly possible, and the reason clause
    // (b) exists: a sibling module under work/ passes clause (a) and must still fail here.
    expect(writesWorkState("db.prepare(`UPDATE work SET state = ?, updated_at = ? WHERE id = ?`).run(s, t, id);")).toBe(true);
    // ...and the attribute patcher that legitimately lives beside it does NOT trip it.
    expect(writesWorkState("db.prepare(`UPDATE work SET notes = ?, updated_at = ? WHERE id = ?`).run(n, t, id);")).toBe(false);
    expect(writesWorkState("db.prepare(`UPDATE work SET schedule_status = 'waiting' WHERE id = ?`).run(id);")).toBe(false);
  });

  it('SELF-TEST: the matcher catches every write form, and the word boundary holds', () => {
    for (const form of [
      'INSERT INTO work (id) VALUES (?)',
      'INSERT OR IGNORE INTO work (id) VALUES (?)',
      'INSERT OR REPLACE INTO adjudications (id) VALUES (?)',
      '`${verb} INTO work_events (id)`',
      'UPDATE work SET state = ?',
      'DELETE FROM work_events WHERE id = ?',
      'UPDATE ${table} SET state = ?',
    ]) expect(SPINE_WRITE_RE.test(form)).toBe(true);

    // ...and does NOT fire on names that merely start the same way, or on reads.
    for (const form of [
      'SELECT * FROM work WHERE id = ?',
      'INSERT INTO workspace_twins (id) VALUES (?)',
      'UPDATE workflow SET x = 1',
      'INSERT INTO legacy_tasks (id) VALUES (?)',
    ]) expect(SPINE_WRITE_RE.test(form)).toBe(false);
  });

  it('SELF-TEST: comment stripping does not hide a real write', () => {
    expect(stripComments('// UPDATE work SET state = ?').trim()).toBe('');
    expect(SPINE_WRITE_RE.test(stripComments('const q = `UPDATE work SET state = ?`;'))).toBe(true);
  });
});

describe('PART B — the burn-down: legacy state writes still outstanding (PHASE-2 T8 empties this)', () => {
  it('every file with an ungated legacy state write is on the allowlist, with its exact count', () => {
    const measured: Record<string, number> = {};
    for (const f of sourceFiles()) {
      const n = countLegacyStateWrites(read(f));
      if (n > 0) measured[f] = n;
    }
    // Exact equality in BOTH directions: a new ungated writer fails, and so does a stale
    // allowlist entry for a file T8 already converted. A burn-down list that only ever
    // shrinks by hand is not a measurement.
    expect(measured).toEqual(LEGACY_STATE_WRITERS);
  });

  it('records the outstanding total so the number is visible on every run', () => {
    // PHASE-2 T8b: ZERO. `legacy_tasks` / `legacy_projects` have no production state writer.
    expect(BURN_DOWN_TOTAL).toBe(0);
  });

  it('SELF-TEST: the legacy counter sees both routes and ignores prose', () => {
    expect(countLegacyStateWrites('db.prepare(`UPDATE legacy_tasks SET status = ? WHERE id = ?`)')).toBe(1);
    expect(countLegacyStateWrites("updateTask(id, { status: 'complete' })")).toBe(1);
    expect(countLegacyStateWrites('// it does a bare updateTask(status=\'complete\')')).toBe(0);
    // a non-state UPDATE is not this walk's business
    expect(countLegacyStateWrites('db.prepare(`UPDATE legacy_tasks SET notes = ? WHERE id = ?`)')).toBe(0);
  });
});
