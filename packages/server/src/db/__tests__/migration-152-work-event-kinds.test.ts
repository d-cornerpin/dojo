// PHASE-4 T4-SCHEMA — migration `152`: the CHECK born on a live column.
//
// `work_events.kind` had a "12-value enum" written in a COMMENT at `135:75` and nothing
// else: no CHECK, no TypeScript union, `appendEvent(workId, kind: string, …)`. Twelve in
// the comment, 24 writable from code, 16 stored. `152` makes the list real.
//
// A CHECK constraint born on a column with live rows VALIDATES EVERY EXISTING ROW when it
// is created — the one migration class that can refuse a lived-in database and halt the
// chain on a box nobody here can reach. That is the `.23` incident's class, and `151`
// (a BEFORE DELETE trigger, which validates nothing at creation) is deliberately the
// opposite shape. So the whole question this file exists to answer is: WHAT HAPPENS TO A
// PRE-EXISTING OFF-LIST ROW? The answer is CARRY, NEVER ABORT, and it is derived — see the
// migration's own header for the three enumerations behind it. Here it is DRIVEN.
//
// THREE BODIES, because a clean body cannot exercise the branch that matters:
//   BODY B (this file)   a VIRGIN chain — nothing to carry, the control
//   BODY B'              the same chain with off-list rows PLANTED before `152` runs
//   BODY A / BODY C      VACUUM INTO copies of the real dev body, clean and planted, in the
//                        task report — 4,953 rows, byte-identical afterwards
//
// AND THE NEGATIVE CONTROL IS THE POINT OF THE WHOLE FILE: the same rebuild WITHOUT the
// quarantine is run against a planted body here, and the refusal is read. Without that
// clause the quarantine is decoration nobody can tell is load-bearing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK_EVENT_KINDS } from '../../work/event-kinds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const BEFORE = '151_delivery_evidence_guard.sql';
const SUBJECT = '152_work_event_kinds_check.sql';

/** The runner's own base schema, lifted from `migrations.ts` so this replay cannot drift
 *  from it (the `150` test's helper, reused verbatim in shape). */
function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base schema in migrations.ts');
  return src.slice(start + 'db.exec(`'.length, end);
}

function applyChainUpTo(db: Database.Database, upTo: string): void {
  db.pragma('foreign_keys = OFF');
  db.exec(baseSchemaFromRunner());
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (f > upTo) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    db.transaction(() => {
      if (f !== '019_agent_sdk_auth.sql') db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
  }
}

/** Applied the way `db/migrations.ts` applies it: `db.exec` of the whole file INSIDE one
 *  transaction, so a failure anywhere rolls the whole file back and leaves the body exactly
 *  as it was. Returns the error message instead of throwing, so a clause can read a refusal. */
function applyOne(db: Database.Database, file: string, sqlOverride?: string): string | null {
  const sql = sqlOverride ?? fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  try {
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    })();
    return null;
  } catch (e) { return String((e as Error).message); }
}

/** The subject file with its quarantine step removed — the file this migration WOULD have
 *  been if "add the CHECK" had been taken literally. Derived from the real file rather than
 *  hand-written, so it cannot drift into a straw man. */
function subjectWithoutQuarantine(): string {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, SUBJECT), 'utf-8');
  const from = sql.indexOf('UPDATE work_events\n   SET payload');
  const to = sql.indexOf('-- ── STEP 2');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return sql.slice(0, from) + sql.slice(to);
}

const WORK_ID = 'w-152';
const OFF_LIST = 'kind NOT IN (' + WORK_EVENT_KINDS.map((k) => `'${k}'`).join(',') + ')';

let db: Database.Database;

/** One work row so the planted events have a parent; FK is OFF for the whole chain, which
 *  is why one of the plants below deliberately has no parent at all. */
function seedWork(): void {
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id,
                       state, intent, wakes, closes_thread, title, opened_at, updated_at, provenance)
     VALUES (?, 'ask', 'kevin', 'owner', 'owner', 'ask', ?, 'open', 'ask', 0, 0, 'q',
             1700000000000, 1700000000000, 'live')`,
  ).run(WORK_ID, WORK_ID);
}

const putEvent = (workId: string, kind: string, payload: string | null, at: number): void => {
  db.prepare(
    'INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workId, kind, payload, 'planter', at);
};

/** THE PLANTS. Each is a BRANCH the clean body has zero rows in, and a zero-row branch is
 *  an untested one (the rehearsal-body rider, earned by the `.23` incident at `144`). */
const PLANTS: Array<{ kind: string; payload: string | null; why: string; workId?: string }> = [
  { kind: 'plant_json_payload', payload: '{"a":1,"b":"x"}', why: 'the ordinary case' },
  { kind: 'plant_null_payload', payload: null, why: 'NULL payload — json_object must not choke' },
  { kind: 'plant_text_payload', payload: 'not json at all, just prose', why: 'payload is NOT valid JSON — the shape that breaks json(payload)' },
  { kind: 'Opened', payload: '{"case":"near-miss"}', why: 'case near-miss: SQLite IN is BINARY-collated, so this is off-list' },
  { kind: 'transitions', payload: '{"near":"miss"}', why: 'spelling near-miss of a real kind' },
  { kind: 'plant_dangling', payload: '{"orphan":true}', why: 'no parent work row at all (FK is OFF for the chain)', workId: 'no-such-work-row' },
  { kind: '', payload: '{"empty":"kind"}', why: 'empty-string kind — NOT NULL does not refuse it' },
  { kind: "plant_quote's_kind", payload: '{"quote":"in the name"}', why: 'a quote inside the value' },
];

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

describe('BODY B — the CONTROL: a virgin chain, nothing to carry', () => {
  beforeEach(() => { applyChainUpTo(db, BEFORE); });

  it('152 applies to a body with no rows, and the column carries the CHECK afterwards', () => {
    expect(db.prepare('SELECT count(*) AS c FROM work_events').get()).toEqual({ c: 0 });
    expect(applyOne(db, SUBJECT)).toBeNull();
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='work_events'`)
      .get() as { sql: string }).sql;
    expect(ddl).toMatch(/CHECK\s*\(\s*kind\s+IN/i);
    // ...and the rebuild left nothing behind: one object on this table, no index, no
    // trigger, no half-renamed twin.
    expect(db.prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name='work_events'`).all())
      .toEqual([{ type: 'table', name: 'work_events' }]);
    expect(db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE name LIKE '%_new'`).get())
      .toEqual({ c: 0 });
  });

  it('every one of the 25 DECLARED kinds is accepted — the CHECK admits the whole list', () => {
    seedWork();
    applyOne(db, SUBJECT);
    for (const k of WORK_EVENT_KINDS) putEvent(WORK_ID, k, '{}', 1);
    expect(db.prepare('SELECT count(DISTINCT kind) AS c FROM work_events').get())
      .toEqual({ c: WORK_EVENT_KINDS.length });
  });

  it('`floor_ghosted` is insertable — PHASE-4 T4 Step 2 depends on exactly this', () => {
    seedWork();
    applyOne(db, SUBJECT);
    expect(() => putEvent(WORK_ID, 'floor_ghosted', '{"floor":"promise"}', 1)).not.toThrow();
  });

  it('an UNDECLARED kind is REFUSED, on INSERT and on UPDATE', () => {
    seedWork();
    applyOne(db, SUBJECT);
    expect(() => putEvent(WORK_ID, 'totally_bogus_kind', '{}', 1)).toThrow(/CHECK constraint failed/);
    expect(() => putEvent(WORK_ID, 'Opened', '{}', 1)).toThrow(/CHECK constraint failed/);
    expect(() => putEvent(WORK_ID, '', '{}', 1)).toThrow(/CHECK constraint failed/);
    putEvent(WORK_ID, 'transition', '{}', 1);
    expect(() => db.prepare(`UPDATE work_events SET kind='sneaked_in'`).run())
      .toThrow(/CHECK constraint failed/);
  });

  it('RED-FIRST: before 152 the same column accepts every one of those', () => {
    // The defect, on the body the fix has not reached yet. Without this the four refusals
    // above would only prove that a CHECK refuses things, not that anything changed.
    seedWork();
    for (const bad of ['totally_bogus_kind', 'Opened', '', "quote's"]) {
      expect(() => putEvent(WORK_ID, bad, '{}', 1)).not.toThrow();
    }
    expect(db.prepare(`SELECT count(*) AS c FROM work_events WHERE ${OFF_LIST}`).get())
      .toEqual({ c: 4 });
  });
});

describe("BODY B' — the ADVERSARIAL body: off-list rows already there when 152 runs", () => {
  beforeEach(() => {
    applyChainUpTo(db, BEFORE);
    seedWork();
    let at = 1700000000001;
    for (const p of PLANTS) putEvent(p.workId ?? WORK_ID, p.kind, p.payload, at++);
    // A CONTROL planted beside them: an ON-LIST row the quarantine must not touch.
    putEvent(WORK_ID, 'transition', '{"to":"claimed","control":true}', at);
  });

  it('every plant is really off-list before the file runs — the branch has rows in it', () => {
    expect(db.prepare(`SELECT count(*) AS c FROM work_events WHERE ${OFF_LIST}`).get())
      .toEqual({ c: PLANTS.length });
    expect(db.prepare('SELECT count(*) AS c FROM work_events').get())
      .toEqual({ c: PLANTS.length + 1 });
  });

  it('THE MIGRATION APPLIES — a stray kind does not abort a lived-in chain', () => {
    expect(applyOne(db, SUBJECT)).toBeNull();
    expect(db.prepare(`SELECT count(*) AS c FROM _migrations WHERE name=?`).get(SUBJECT))
      .toEqual({ c: 1 });
  });

  it('EXACT CONSERVATION: no row is created, deleted, renumbered or re-timed', () => {
    const before = db.prepare('SELECT id, work_id, actor, created_at FROM work_events ORDER BY id').all();
    applyOne(db, SUBJECT);
    const after = db.prepare('SELECT id, work_id, actor, created_at FROM work_events ORDER BY id').all();
    expect(after).toEqual(before);
  });

  it('each off-list row is CARRIED as an audit entry with its original kind and payload intact', () => {
    applyOne(db, SUBJECT);
    for (const p of PLANTS) {
      const row = db.prepare(
        `SELECT kind, json_extract(payload,'$.original_kind') AS ok,
                json_extract(payload,'$.original_payload') AS op,
                json_extract(payload,'$.entry_kind')       AS ek,
                json_extract(payload,'$.provenance')       AS prov
           FROM work_events WHERE json_extract(payload,'$.original_kind') IS ?`,
      ).get(p.kind === '' ? '' : p.kind) as Record<string, unknown> | undefined;
      expect(row, `plant ${p.kind || '<empty>'} (${p.why}) survived`).toBeDefined();
      expect(row!.kind).toBe('audit');
      expect(row!.ok).toBe(p.kind);
      expect(row!.ek).toBe(p.kind);
      expect(row!.op).toBe(p.payload);   // byte-for-byte, including the non-JSON one
      expect(row!.prov).toBe('quarantined_by_152');
    }
    // ...and no off-list value survives in the column itself.
    expect(db.prepare(`SELECT count(*) AS c FROM work_events WHERE ${OFF_LIST}`).get()).toEqual({ c: 0 });
  });

  it('the ON-LIST row planted beside them is NOT touched', () => {
    applyOne(db, SUBJECT);
    const row = db.prepare(
      `SELECT kind, payload FROM work_events WHERE json_extract(payload,'$.control') = 1`,
    ).get() as { kind: string; payload: string };
    expect(row.kind).toBe('transition');
    expect(row.payload).toBe('{"to":"claimed","control":true}');
  });

  it('THE NEGATIVE CONTROL: the same rebuild WITHOUT the quarantine ABORTS, and takes nothing with it', () => {
    // This is what "carry, never abort" is worth. The file below differs from the real one
    // by the deleted `UPDATE` and nothing else.
    const err = applyOne(db, SUBJECT, subjectWithoutQuarantine());
    expect(err).toMatch(/CHECK constraint failed/);
    // The transaction rolled the whole file back: the rows are all still there, unmodified,
    // the column has NO CHECK, and the chain would stop at 151 on this box forever.
    expect(db.prepare(`SELECT count(*) AS c FROM work_events WHERE ${OFF_LIST}`).get())
      .toEqual({ c: PLANTS.length });
    expect((db.prepare(`SELECT sql FROM sqlite_master WHERE name='work_events'`)
      .get() as { sql: string }).sql).not.toMatch(/CHECK/i);
    expect(db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE name='work_events_new'`).get())
      .toEqual({ c: 0 });
    expect(db.prepare(`SELECT count(*) AS c FROM _migrations WHERE name=?`).get(SUBJECT))
      .toEqual({ c: 0 });
    // ...and the SAME file on a body with no off-list row applies fine, which is why a
    // clean rehearsal body would have reported this migration safe.
    const clean = new Database(':memory:');
    applyChainUpTo(clean, BEFORE);
    let ok: string | null = null;
    try {
      clean.transaction(() => { clean.exec(subjectWithoutQuarantine()); })();
    } catch (e) { ok = String((e as Error).message); }
    expect(ok).toBeNull();
    clean.close();
  });
});

describe('what the rebuild must not lose', () => {
  beforeEach(() => { applyChainUpTo(db, BEFORE); seedWork(); });

  it('AUTOINCREMENT is preserved, and so is the counter — ids of deleted rows stay retired', () => {
    for (let i = 0; i < 5; i++) putEvent(WORK_ID, 'transition', '{}', 1700000000000 + i);
    db.prepare('DELETE FROM work_events WHERE id > 2').run();     // counter 5, max(id) 2
    const seqBefore = (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='work_events'`)
      .get() as { seq: number }).seq;
    expect(seqBefore).toBe(5);
    expect(db.prepare('SELECT MAX(id) AS m FROM work_events').get()).toEqual({ m: 2 });

    applyOne(db, SUBJECT);

    expect((db.prepare(`SELECT sql FROM sqlite_master WHERE name='work_events'`)
      .get() as { sql: string }).sql).toMatch(/AUTOINCREMENT/);
    expect(db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='work_events'`).get())
      .toEqual({ seq: seqBefore });
    // The contract that matters: the next row does NOT get an id that once belonged to a
    // deleted one. A plain rebuild resets the counter to MAX(id) and hands out 3.
    putEvent(WORK_ID, 'transition', '{}', 1);
    expect(db.prepare('SELECT MAX(id) AS m FROM work_events').get()).toEqual({ m: 6 });
  });

  it('rows whose parent work row is gone are carried, not dropped (FK is OFF for the chain)', () => {
    putEvent('no-such-work-row', 'transition', '{}', 1);
    applyOne(db, SUBJECT);
    expect(db.prepare(
      `SELECT count(*) AS c FROM work_events e
        WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = e.work_id)`).get()).toEqual({ c: 1 });
  });

  it('re-applying the file is a no-op on the data', () => {
    for (const k of ['transition', 'opened', 'audit']) putEvent(WORK_ID, k, '{"x":1}', 1);
    applyOne(db, SUBJECT);
    const after = db.prepare('SELECT id, work_id, kind, payload, actor, created_at FROM work_events ORDER BY id').all();
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(SUBJECT);
    expect(applyOne(db, SUBJECT)).toBeNull();
    expect(db.prepare('SELECT id, work_id, kind, payload, actor, created_at FROM work_events ORDER BY id').all())
      .toEqual(after);
  });
});

describe('the file and the union are one list', () => {
  it('the CHECK in the landed migration is exactly WORK_EVENT_KINDS', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, SUBJECT), 'utf-8');
    const m = /CHECK\s*\(\s*kind\s+IN\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(listed).toEqual([...WORK_EVENT_KINDS].sort());
  });

  it('the QUARANTINE predicate carries the same list as the CHECK — one cannot drift from the other', () => {
    // Two copies of the list live in this file by necessity (SQLite has no way to name one).
    // If the `WHERE kind NOT IN (…)` ever admitted a value the CHECK refuses, the rebuild
    // would abort on exactly the row the quarantine was supposed to have taken.
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, SUBJECT), 'utf-8');
    const guard = /WHERE kind NOT IN \(([\s\S]*?)\n \);/.exec(sql);
    expect(guard).not.toBeNull();
    const quarantined = [...guard![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(quarantined).toEqual([...WORK_EVENT_KINDS].sort());
  });
});
