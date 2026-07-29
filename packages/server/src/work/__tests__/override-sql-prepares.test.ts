// PHASE-2 T8T RESUMED-2 — PRODUCTION SQL MUST PREPARE, and this exists because it bit.
//
// THE DEFECT THAT CREATED THIS FILE. Converting the override queue off
// `task_override_requests` meant renaming a row shape from snake_case to camelCase at four
// call-site clusters. The rename was applied as a text substitution, and `r.task_id` is a
// SUBSTRING of `tr.task_id` — so three unrelated `task_runs` statements in
// `scheduler/runner.ts` silently became `tr.taskId`. Every unit test stayed green, typecheck
// stayed green, every gate stayed green. The only thing that noticed was the behavioural
// battery, which went 3-green to 0-green with `Scheduler tick failed: no such column:
// tr.taskId` repeating every 30 seconds — a whole scheduler tick down, reported as one log
// line the platform swallowed.
//
// That is the exact class T8b2 built `kit-schema-conformance.mjs` for on the HARNESS side:
// "preparing proves VALID, never CORRECT — and this is the new way to be valid and wrong."
// Production had no equivalent. It has one now, for the files this change touched.
//
// WHAT IT DOES: extracts every complete SQL string literal from those files and PREPARES it
// against a real migrated schema. A column that does not exist is a SQLite error at prepare
// time, so a rename that misses a site cannot reach a running server.
//
// WHAT IT DOES NOT DO, said plainly so nobody reads more into a green: it proves the statement
// is well-formed against the schema, not that it asks the right question. Statements built by
// interpolation (`${taskScope('w')}`) are reported and skipped, exactly as the kit's version
// does, because a fragment is not a statement.
//
// SCOPE: the four files this continuation converted. The whole-tree sweep is a bigger task and
// is named in the report rather than smuggled in here.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-sqlprep-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';

const FILES = [
  'scheduler/runner.ts',
  'tracker/tools.ts',
  'tracker/pm-agent.ts',
  'gateway/routes/tracker.ts',
  'work/override-requests.ts',
];

const SRC = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** Every backtick or quoted literal whose body starts with a SQL verb. Interpolated bodies
 *  are separated out rather than mangled — a fragment is not a statement. */
function statementsIn(src: string): { complete: string[]; interpolated: number } {
  const out: string[] = [];
  let interpolated = 0;
  const lits = src.match(/`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) ?? [];
  for (const raw of lits) {
    const body = raw.slice(1, -1).trim();
    // A SQL verb is not enough on its own: this tree is full of model-facing PROSE, and three
    // sentences beginning "with the real reason…" were picked up by an earlier `WITH` arm and
    // reported as broken SQL. A statement also has to name where it acts.
    if (!/^(SELECT|INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s|DELETE\s+FROM)/i.test(body)) continue;
    if (!/\b(FROM|INTO|SET)\b/i.test(body)) continue;
    if (body.includes('${')) { interpolated++; continue; }
    out.push(body);
  }
  return { complete: out, interpolated };
}

let db: Database.Database;

beforeAll(() => {
  // A real migrated schema, built by the product's OWN runner rather than by replaying files
  // by hand — so the columns these statements name are the columns the product ships.
  db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

afterAll(() => { db?.close(); mockDb.current = null; });

describe('every complete SQL literal in the converted files prepares against the real schema', () => {
  it('the corpus is not empty — a walk that finds nothing passes vacuously', () => {
    const total = FILES.reduce((n, f) => n + statementsIn(readFileSync(SRC(f), 'utf8')).complete.length, 0);
    expect(total).toBeGreaterThan(10);
  });

  it.each(FILES)('%s', (rel) => {
    const { complete } = statementsIn(readFileSync(SRC(rel), 'utf8'));
    const failures: string[] = [];
    for (const stmt of complete) {
      try { db.prepare(stmt); } catch (e) {
        failures.push(`${(e as Error).message} — ${stmt.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(failures, `${rel}: ${failures.length} statement(s) do not prepare`).toEqual([]);
  });

  it('THE PLANTED FAULT: a renamed column is caught at prepare time', () => {
    // The exact shape of the defect, asserted rather than described: an alias-qualified column
    // that EXISTS versus one that does not, where only the prepare distinguishes them.
    //
    // PHASE-2 T10F — THE EXAMPLE MOVED, THE PROPERTY DID NOT. This clause used to plant its
    // fault on `task_runs` because that is where the T8T incident happened: a blanket text
    // substitution turned three statements' `tr.task_id` into `r.task_id` (one is a substring
    // of the other), typecheck and 1,776 unit tests stayed green, and an entire scheduler tick
    // died behind one swallowed log line until the battery caught it. `task_runs` is dropped by
    // migration `144`, so the fault is planted on a table that still exists — with the SAME
    // hazard shape, a real snake_case column against a camelCase near-miss. The incident stays
    // named here so the next reader knows what this guard is for.
    expect(() => db.prepare('SELECT e.id, e.work_id FROM work_events e')).not.toThrow();
    expect(() => db.prepare('SELECT e.id, e.workId FROM work_events e')).toThrow(/no such column/);
    // ...and the substring half of the original incident, which is the part that hid: a
    // shortened alias still parses as a name, so nothing but a prepare can refuse it.
    expect(() => db.prepare('SELECT w.parent_id FROM work w')).not.toThrow();
    expect(() => db.prepare('SELECT w.arent_id FROM work w')).toThrow(/no such column/);
  });
});
