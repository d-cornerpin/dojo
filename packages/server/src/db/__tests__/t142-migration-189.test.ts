// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATIONS 189 + 189c (v3.3.3 t142) — THE REHEARSAL, ON LIVED-IN BODIES.
//
// G13: each vintage is built by replaying the REAL chain up to the box's version, given an
// ADVERSARIAL body (orphans, NULL and corrupted payloads, a deleted tail that leaves the
// AUTOINCREMENT counter ahead of MAX(id), verdicts with and without companions, a same-
// millisecond tie) beside correct rows, copied with VACUUM INTO, and then upgraded exactly the
// way `db/migrations.ts` applies a file (one `db.exec` inside one transaction). Every
// statement's reach is asserted as a count, so no branch passes by touching nothing.
//
//   vintage A — a v3.3.2 box: the whole chain except 189/189c (159's CHECK, 178's index).
//   vintage B — an older box at 159, which then runs 160..188 and 189 in ONE upgrade.
//   vintage C — a fresh box with an EMPTY work_events table and no counter row at all.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = __dirname;
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const M189 = '189_work_told_event.sql';
const M189C = '189c_verdict_event_sequence.sql';
/** Every lane-t142 migration, whatever letters exist: 189, 189c and the fix round's files. */
const SUBJECTS = FILES.filter((f) => f.startsWith('189'));
const isSubject = (f: string): boolean => SUBJECTS.includes(f);

function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base schema in migrations.ts');
  return src.slice(start + 'db.exec(`'.length, end);
}

function applyFile(db: Database.Database, f: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
  db.transaction(() => {
    if (f !== '019_agent_sdk_auth.sql') db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
  })();
}

/** Replay the real chain, skipping the subjects, stopping after `upTo` (inclusive). */
function vintage(upTo: string | null): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(baseSchemaFromRunner());
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (isSubject(f)) continue;
    if (upTo !== null && f > upTo) break;
    applyFile(db, f);
  }
  return db;
}

/** VACUUM INTO a file copy and reopen it — the rehearsal never touches the body it was built on. */
function copyOf(db: Database.Database): Database.Database {
  const dir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t142-189-'));
  const file = path.join(dir, 'copy.db');
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copy = new Database(file);
  copy.pragma('foreign_keys = OFF');
  return copy;
}

const T0 = 1_700_000_000_000;

/** The adversarial body. Returns the ids the clauses read back. */
function seedBody(db: Database.Database) {
  const work = db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state,
                       intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', 'fixture-agent', 'owner', 'owner', 'tracker', ?, ?, 'do-it', 1, 0, 'fixture row', ?, ?)`,
  );
  const ev = db.prepare(
    'INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const adj = db.prepare(
    `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
     VALUES (?, ?, ?, ?, NULL, 'fixture', ?)`,
  );
  // The agent the rows belong to: migration 173 sweeps work rows whose agent is gone, and an
  // older vintage runs it AFTER this body is seeded.
  db.prepare(`INSERT INTO agents (id, name, status) VALUES ('fixture-agent', 'Fixture', 'idle')`).run();
  const tr = (to: string, extra: Record<string, unknown> = {}) => JSON.stringify({ from: 'claimed', to, by: 'agent', ...extra });
  const ids: Record<string, number> = {};

  for (const id of ['w-auth', 'w-uphold', 'w-reject', 'w-tie', 'w-none', 'w-corrupt', 'w-null']) {
    work.run(id, id, id === 'w-none' ? 'claimed' : 'blocked', T0, T0);
  }
  // CORRECT: an authoritative entry and its verdict, one instant (transition()'s own shape).
  adj.run('w-auth', 'blocked', 'upheld', 'pm-fixture', T0 + 10);
  ids.authEntry = Number(ev.run('w-auth', 'transition', tr('blocked', { claim: 'authoritative' }), 'pm-fixture', T0 + 10).lastInsertRowid);
  // CORRECT: entry, then an uphold with its claim_upheld companion a millisecond later.
  ids.upholdEntry = Number(ev.run('w-uphold', 'transition', tr('blocked'), 'agent', T0 + 20).lastInsertRowid);
  adj.run('w-uphold', 'blocked', 'upheld', 'pm-fixture', T0 + 21);
  ids.upholdCompanion = Number(ev.run('w-uphold', 'claim_upheld', JSON.stringify({ claim_state: 'blocked', note: 'x' }), 'pm-fixture', T0 + 22).lastInsertRowid);
  // CORRECT: a rejection and its companion.
  ev.run('w-reject', 'transition', tr('blocked'), 'agent', T0 + 30);
  adj.run('w-reject', 'blocked', 'rejected', 'pm-fixture', T0 + 31);
  ids.rejectCompanion = Number(ev.run('w-reject', 'claim_rejected', JSON.stringify({ claim_state: 'blocked', note: 'x' }), 'pm-fixture', T0 + 31).lastInsertRowid);
  // THE TIE: blocked, upheld, resolved, blocked again — all in ONE millisecond.
  ids.tieEntry = Number(ev.run('w-tie', 'transition', tr('blocked'), 'agent', T0 + 40).lastInsertRowid);
  adj.run('w-tie', 'blocked', 'upheld', 'pm-fixture', T0 + 40);
  ids.tieUpheld = Number(ev.run('w-tie', 'claim_upheld', JSON.stringify({ claim_state: 'blocked' }), 'pm-fixture', T0 + 40).lastInsertRowid);
  ev.run('w-tie', 'transition', tr('claimed'), 'agent', T0 + 40);
  ids.tieReentry = Number(ev.run('w-tie', 'transition', tr('blocked'), 'agent', T0 + 40).lastInsertRowid);
  // NO COMPANION AT ALL: a verdict on a row with no events (no product version writes this).
  adj.run('w-none', 'claimed', 'upheld', 'pm-fixture', T0 + 50);
  // CORRUPTED: the only candidate companion has an unreadable payload; a later readable one exists.
  ev.run('w-corrupt', 'transition', '{"to": "blocked", BROKEN', 'agent', T0 + 60);
  adj.run('w-corrupt', 'blocked', 'upheld', 'pm-fixture', T0 + 60);
  ids.corruptCompanion = Number(ev.run('w-corrupt', 'claim_upheld', JSON.stringify({ claim_state: 'blocked' }), 'pm-fixture', T0 + 61).lastInsertRowid);
  // NULL payloads, and an ORPHAN event whose work row does not exist.
  ev.run('w-null', 'transition', null, 'agent', T0 + 70);
  ev.run('w-null', 'activity', null, 'engine', T0 + 71);
  ev.run('w-ghost-row', 'activity', JSON.stringify({ turn: 1 }), 'engine', T0 + 72);
  // A DELETED TAIL: the counter is now AHEAD of MAX(id), the state 159 carries by hand.
  const tail1 = Number(ev.run('w-null', 'activity', null, 'engine', T0 + 80).lastInsertRowid);
  ev.run('w-null', 'activity', null, 'engine', T0 + 81);
  db.prepare('DELETE FROM work_events WHERE id >= ?').run(tail1);
  ids.seqBefore = (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'work_events'`).get() as { seq: number }).seq;
  ids.maxIdBefore = (db.prepare('SELECT MAX(id) AS m FROM work_events').get() as { m: number }).m;
  return ids;
}

const snapshotEvents = (db: Database.Database): string =>
  JSON.stringify(db.prepare('SELECT id, work_id, kind, payload, actor, created_at FROM work_events ORDER BY id').all());
const seqOf = (db: Database.Database, workId: string, state: string, verdict = 'upheld'): number | null =>
  (db.prepare('SELECT event_seq FROM adjudications WHERE work_id = ? AND claim_state = ? AND verdict = ?')
    .get(workId, state, verdict) as { event_seq: number | null }).event_seq;

describe('vintage A — a v3.3.2 box upgrades', () => {
  const built = vintage(null);
  const ids = seedBody(built);
  const db = copyOf(built);
  const before = snapshotEvents(db);
  const nAdj = (db.prepare('SELECT COUNT(*) AS n FROM adjudications').get() as { n: number }).n;

  it('the vintage is what it claims: 159\'s CHECK, 178\'s index, no event_seq, no person_told', () => {
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'work_events'`).get() as { sql: string }).sql;
    expect(ddl).toContain("'owed_interrupt'");
    expect(ddl).not.toContain("'person_told'");
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_work_events_work_id'`).get()).toBeDefined();
    const cols = (db.prepare('PRAGMA table_info(adjudications)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('event_seq');
    expect(ids.seqBefore, 'the planted tail gap is real').toBeGreaterThan(ids.maxIdBefore);
  });

  it('189 applies, carries every row byte-for-byte, the counter, and the index', () => {
    applyFile(db, M189);
    expect(snapshotEvents(db), 'every row, every column, every id').toBe(before);
    const seq = (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'work_events'`).get() as { seq: number }).seq;
    expect(seq, 'AUTOINCREMENT never reissues a deleted id').toBe(ids.seqBefore);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name LIKE 'work_events%'`).get())
      .toEqual({ n: 1 });
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_work_events_work_id'`).get(),
      '178\'s index survives the rebuild').toBeDefined();
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'work_events_new'`).get()).toBeUndefined();
  });

  it('the widened CHECK admits person_told and still refuses an off-list kind', () => {
    db.prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('w-auth', 'person_told', '{}', 'x', 1)`).run();
    expect(() => db.prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('w-auth', 'person_tolled', '{}', 'x', 1)`).run())
      .toThrow(/CHECK/);
    db.prepare(`DELETE FROM work_events WHERE kind = 'person_told'`).run();
  });

  it('189c applies over the corrupted payload without raising, and positions EVERY verdict', () => {
    applyFile(db, M189C);
    const unpositioned = (db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE event_seq IS NULL').get() as { n: number }).n;
    expect(unpositioned).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM adjudications').get() as { n: number }).n,
      'no verdict gained or lost').toBe(nAdj);
  });

  it('each backfill branch was REACHED, with the right answer (no branch passes by touching nothing)', () => {
    expect(seqOf(db, 'w-auth', 'blocked'), 'companion = its own transition').toBe(ids.authEntry);
    expect(seqOf(db, 'w-uphold', 'blocked'), 'companion = its claim_upheld').toBe(ids.upholdCompanion);
    expect(seqOf(db, 'w-reject', 'blocked', 'rejected'), 'companion = its claim_rejected').toBe(ids.rejectCompanion);
    // THE TIE, where the clock cannot say which same-millisecond row is the companion: the
    // backfill takes the FIRST matching row at or after the verdict's instant, which can be
    // earlier than the true companion but NEVER later — so a verdict can never leak forward
    // into a later episode. Here it lands on the first entry; both it and the uphold's own
    // row sit before the re-entry, which is the fact that decides the answer.
    expect(seqOf(db, 'w-tie', 'blocked'), 'first matching row at the instant').toBe(ids.tieEntry);
    expect(seqOf(db, 'w-tie', 'blocked')!, 'never at or past the re-entry').toBeLessThan(ids.tieReentry);
    expect(seqOf(db, 'w-corrupt', 'blocked'), 'the unreadable row is skipped, the readable one taken').toBe(ids.corruptCompanion);
    expect(seqOf(db, 'w-none', 'claimed'), 'no companion: the end of the history it was filed into').toBe(ids.maxIdBefore);
  });

  it('THE POINT: the tie row now reads unvalidated by the sequence, and the auth row validated', async () => {
    const { validatedExpr } = await import('../../work/tracker-view.js');
    const v = (id: string) => (db.prepare(`SELECT ${validatedExpr('w', 'blocked')} AS v FROM work w WHERE w.id = ?`).get(id) as { v: number }).v;
    expect(v('w-tie')).toBe(0);
    expect(v('w-auth')).toBe(1);
    expect(v('w-uphold')).toBe(1);
  });

  it('the trigger stamps a NEW verdict with the id the next event receives — past the tail gap', () => {
    const seqNow = (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'work_events'`).get() as { seq: number }).seq;
    const maxNow = (db.prepare('SELECT MAX(id) AS m FROM work_events').get() as { m: number }).m;
    expect(seqNow, 'the counter is still ahead of MAX(id)').toBeGreaterThan(maxNow);
    db.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, note, created_at) VALUES ('w-null', 'blocked', 'upheld', 'pm', 'n', 9)`,
    ).run();
    const stamped = seqOf(db, 'w-null', 'blocked');
    const next = Number(db.prepare(
      `INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('w-null', 'claim_upheld', '{"claim_state":"blocked"}', 'pm', 9)`,
    ).run().lastInsertRowid);
    expect(stamped).toBe(next);
    expect(next, 'the counter, not MAX(id), decides').toBe(seqNow + 1);
  });

  it('a FUTURE work_events rebuild (how the next event kind is added) still applies after 189c', () => {
    // The 159/189 shape, replayed on this body after the trigger exists: build work_events_new,
    // copy, carry the counter, DROP, RENAME. SQLite >= 3.26 re-validates every trigger on the
    // RENAME, so a trigger that NAMED work_events would make this throw on the product's SQLite.
    const rebuild = fs.readFileSync(path.join(MIGRATIONS_DIR, M189), 'utf-8');
    const before = snapshotEvents(db);
    expect(() => db.transaction(() => db.exec(rebuild))()).not.toThrow();
    expect(snapshotEvents(db)).toBe(before);
    db.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, note, created_at) VALUES ('w-null', 'done', 'upheld', 'pm', 'n', 9)`,
    ).run();
    const next = Number(db.prepare(
      `INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('w-null', 'claim_upheld', '{"claim_state":"done"}', 'pm', 9)`,
    ).run().lastInsertRowid);
    expect(seqOf(db, 'w-null', 'done'), 'and the trigger still stamps the companion after it').toBe(next);
  });

  it('a writer that supplies event_seq itself is left alone', () => {
    db.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, note, created_at, event_seq) VALUES ('w-auth', 'paused', 'upheld', 'pm', 'n', 9, 4242)`,
    ).run();
    expect(seqOf(db, 'w-auth', 'paused')).toBe(4242);
  });
});

describe('vintage B — an older box (at 159) takes 160..189c in one upgrade', () => {
  const built = vintage('159_owed_interrupt_event_kind.sql');
  const ids = seedBody(built);
  const db = copyOf(built);
  const before = snapshotEvents(db);

  it('the rest of the chain, 189 and 189c apply in order on the same body', () => {
    for (const f of FILES) {
      if (f <= '159_owed_interrupt_event_kind.sql') continue;
      applyFile(db, f);
    }
    expect(db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(M189C)).toBeDefined();
    // 172/176 sweep orphans; whatever they leave, 189 must carry exactly.
    const survivors = JSON.parse(before) as Array<{ id: number }>;
    const after = JSON.parse(snapshotEvents(db)) as Array<{ id: number }>;
    expect(after.map((r) => r.id).every((id) => survivors.some((s) => s.id === id)),
      'no event invented').toBe(true);
    expect(seqOf(db, 'w-tie', 'blocked')).toBe(ids.tieEntry);
    expect(seqOf(db, 'w-uphold', 'blocked')).toBe(ids.upholdCompanion);
    expect((db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE event_seq IS NULL').get() as { n: number }).n).toBe(0);
  });
});

describe('vintage C — a fresh box with an empty work_events and no counter row', () => {
  const db = copyOf(vintage(null));

  it('189 and 189c apply, and the first verdict ever written is stamped id 1', () => {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_events`).get()).toEqual({ n: 0 });
    applyFile(db, M189);
    applyFile(db, M189C);
    db.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, note, created_at) VALUES ('w', 'blocked', 'upheld', 'pm', 'n', 1)`,
    ).run();
    const id = Number(db.prepare(
      `INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('w', 'claim_upheld', '{}', 'pm', 1)`,
    ).run().lastInsertRowid);
    expect(id).toBe(1);
    expect((db.prepare('SELECT event_seq FROM adjudications').get() as { event_seq: number }).event_seq).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// vintage D — FIX ROUND 1: what the owner hears on the FIRST BOOT after the upgrade (I1), and
// a verdict with no companion read conservatively (M1). The body is pre-upgrade HISTORY: rows
// the ladder already escalated, then reopened and blocked again, long ago. Upgraded through
// every 189* file in order, exactly as a box takes them.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('vintage D — upgrade day: no escalation about a long-dead, already-escalated row', () => {
  const built = vintage(null);
  const ev = built.prepare('INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)');
  const tr = (to: string) => JSON.stringify({ from: 'claimed', to, by: 'agent', note: 'fixture obstacle' });
  built.prepare(`INSERT INTO agents (id, name, status) VALUES ('fixture-agent', 'Fixture', 'idle')`).run();
  const work = built.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state,
                       intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', 'fixture-agent', 'owner', 'owner', 'tracker', ?, ?, 'do-it', 1, 0, 'fixture row', ?, ?)`,
  );
  // THE SET: blocked, escalated (the ladder ran to its end), resolved, blocked AGAIN — months ago.
  work.run('d-reblocked', 'd-reblocked', 'blocked', T0, T0);
  ev.run('d-reblocked', 'transition', tr('blocked'), 'agent', T0 + 100);
  const origStamp = Number(ev.run('d-reblocked', 'validation_escalated', JSON.stringify({ thread_id: 'conv-owner' }), 'scheduler', T0 + 101).lastInsertRowid);
  ev.run('d-reblocked', 'transition', tr('claimed'), 'agent', T0 + 102);
  ev.run('d-reblocked', 'transition', tr('blocked'), 'agent', T0 + 103);
  // CONTROLS: escalated in its CURRENT block (already settled), and never escalated (eligible today).
  work.run('d-current', 'd-current', 'blocked', T0, T0);
  ev.run('d-current', 'transition', tr('blocked'), 'agent', T0 + 110);
  ev.run('d-current', 'validation_escalated', JSON.stringify({ thread_id: null }), 'scheduler', T0 + 111);
  work.run('d-never', 'd-never', 'blocked', T0, T0);
  ev.run('d-never', 'transition', tr('blocked'), 'agent', T0 + 120);
  // NOT BLOCKED NOW: escalated once, now claimed — base behaviour keeps it settled (I3).
  work.run('d-claimed', 'd-claimed', 'claimed', T0, T0);
  ev.run('d-claimed', 'transition', tr('blocked'), 'agent', T0 + 130);
  ev.run('d-claimed', 'validation_escalated', JSON.stringify({ thread_id: null }), 'scheduler', T0 + 131);
  ev.run('d-claimed', 'transition', tr('claimed'), 'agent', T0 + 132);
  // M1: a verdict with NO companion, filed between an entry and a LATER re-entry into the
  // same state. Base read it unvalidated for the re-entry; so must the upgraded box.
  work.run('d-orphan', 'd-orphan', 'blocked', T0, T0);
  ev.run('d-orphan', 'transition', tr('blocked'), 'agent', T0 + 150);
  built.prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, note, created_at)
                 VALUES ('d-orphan', 'blocked', 'upheld', 'pm-fixture', 'fixture', ?)`).run(T0 + 200);
  ev.run('d-orphan', 'transition', tr('claimed'), 'agent', T0 + 250);
  ev.run('d-orphan', 'transition', tr('blocked'), 'agent', T0 + 300);

  const db = copyOf(built);
  for (const f of SUBJECTS) applyFile(db, f);

  const settled = async (id: string): Promise<number> => {
    const { ownerEpisodeSettledExpr } = await import('../../work/validation-drive.js');
    return (db.prepare(`SELECT (CASE WHEN ${ownerEpisodeSettledExpr('w')} THEN 1 ELSE 0 END) AS s FROM work w WHERE w.id = ?`)
      .get(id) as { s: number }).s;
  };

  it.fails('THE MEASURE: rows the old suppressor silenced and the new one would not — zero after upgrade', async () => {
    const { ownerEpisodeSettledExpr } = await import('../../work/validation-drive.js');
    const newlyEligible = (db.prepare(
      `SELECT COUNT(*) AS n FROM work w
        WHERE EXISTS (SELECT 1 FROM work_events s WHERE s.work_id = w.id AND s.kind = 'validation_escalated')
          AND NOT ${ownerEpisodeSettledExpr('w')}`,
    ).get() as { n: number }).n;
    expect(newlyEligible).toBe(0);
  });

  it.fails('the already-escalated, re-blocked row is carried as settled; the controls are untouched', async () => {
    expect(await settled('d-reblocked'), 'carried').toBe(1);
    expect(await settled('d-current'), 'already settled').toBe(1);
    expect(await settled('d-never'), 'never escalated: eligible exactly as at base').toBe(0);
    expect(await settled('d-claimed'), 'not blocked: base behaviour').toBe(1);
  });

  it.fails('the carry is exactly ONE row, invisible on the dashboard (the original instant and thread)', () => {
    const carried = db.prepare(
      `SELECT work_id, actor, created_at, payload FROM work_events
        WHERE kind = 'validation_escalated' AND json_extract(payload, '$.carried') = 1`,
    ).all() as Array<{ work_id: string; actor: string; created_at: number; payload: string }>;
    expect(carried.map((c) => c.work_id)).toEqual(['d-reblocked']);
    expect(carried[0].created_at, 'same instant as the stamp it carries').toBe(T0 + 101);
    expect(JSON.parse(carried[0].payload)).toMatchObject({ thread_id: 'conv-owner', carried_from: origStamp });
  });

  it.fails('M1: a companion-less verdict filed before a later re-entry reads UNVALIDATED, as base read it', async () => {
    const { validatedExpr } = await import('../../work/tracker-view.js');
    const v = (db.prepare(`SELECT ${validatedExpr('w', 'blocked')} AS v FROM work w WHERE w.id = 'd-orphan'`).get() as { v: number }).v;
    expect(v).toBe(0);
  });
});
