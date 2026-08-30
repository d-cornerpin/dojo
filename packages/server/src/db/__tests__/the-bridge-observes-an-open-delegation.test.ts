// ════════════════════════════════════════════════════════════════════════════════════════
// AN OPEN DELEGATION IS NOT A REASON TO REFUSE THE BOOT.  (UPDATE-INTEGRITY U0, change 1)
//
// ── THE INCIDENT THIS FILE EXISTS FOR ───────────────────────────────────────────────────
// A user ("Michael") took the 3.1.16 → 3.1.17 update while one agent was waiting on another.
// `135b_stable_work_spine.sql` asserted `park_namespace_empty` — zero `messages.conv_key`
// rows matching `park:%` — through `_bridge_assert`'s `CHECK (ok = 1)`, so ONE open
// delegation aborted the migration, the chain, and the boot. launchd's KeepAlive then
// retried every ten seconds, forever: the park can only be consumed by the running
// platform, and the platform could not run. W52 reproduced it bit-for-bit.
//
// The assertion was never a fact about the schema. The file says so in its own words —
// "Measured on the reference body: 0 `park:%` keys on either message store" — a measurement
// of ONE dev box, promoted to an invariant. v3.1.16's `a2a-transport.ts` writes `park:<thread>`
// (and `park:~<t1>|<t2>#<remaining>` for a fan-out) every time an agent delegates and waits,
// and clears it only by rewriting the key. And the chain contradicted itself twelve files
// later: `147_conversation_identity_backfill.sql` lists `park:%` as an expected LEGACY SIGIL
// and skips it. 147 is right.
//
// ── WHAT IS ASSERTED HERE ───────────────────────────────────────────────────────────────
// The count is now REPORTED, exactly like its sibling `join_piece_population_reported` two
// lines below it in the same file: `ok = 1`, the number folded into `detail`. So:
//   * a body carrying open parks crosses the bridge (single, several, and the fan-out form);
//   * the number is still on the record, not silently dropped;
//   * the `CHECK (ok = 1)` MECHANISM is untouched — a genuinely broken invariant still
//     aborts. That negative control is the whole difference between demoting one row and
//     disarming the Stable Bridge.
//
// The chain is REPLAYED from the shipped files rather than hand-rolled, for migration
// 135's stated reason: the question is what the SHIPPED file does to a real 135-era body.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const SPINE = '135_work_spine.sql';
const BRIDGE = '135b_stable_work_spine.sql';

/** The runner's own first `db.exec()` — read, never copied, so the base cannot drift. */
function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base schema in migrations.ts');
  const ddl = src.slice(start + 'db.exec(`'.length, end);
  if (!ddl.includes('CREATE TABLE IF NOT EXISTS agents')) {
    throw new Error('base schema extraction looks wrong');
  }
  return ddl;
}

/** Apply the real chain, in order, up to and including `upTo`. Mirrors the product runner. */
function applyChainUpTo(db: Database.Database, upTo: string): void {
  db.pragma('foreign_keys = OFF');
  db.exec(baseSchemaFromRunner());
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (f > upTo) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    db.transaction(() => {
      // `019_agent_sdk_auth.sql` is a no-op marker whose real SQL is inline in the runner.
      if (f !== '019_agent_sdk_auth.sql') db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
  }
}

function applyOne(db: Database.Database, file: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  })();
}

const TEARDOWN_MARKER = '-- ── Scratch teardown';

/**
 * Apply `135b` with its final scratch teardown WITHHELD, so `_bridge_assert` survives the
 * call and the reported rows can be read. This is the only way to observe a report-tier
 * row: the file drops the table on its last line, by design. It throws rather than
 * degrading to a silent pass if the marker it splits on ever moves.
 */
function applyBridgeKeepingAssertions(db: Database.Database): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, BRIDGE), 'utf-8');
  const cut = sql.indexOf(TEARDOWN_MARKER);
  if (cut < 0) throw new Error(`${BRIDGE} no longer carries its "${TEARDOWN_MARKER}" marker`);
  db.exec(sql.slice(0, cut));
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyChainUpTo(db, SPINE);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')`).run();
});

afterEach(() => { db.close(); });

/** One message row carrying a conversation key — the shape v3.1.16 parks a delegation in. */
function seedKey(id: string, convKey: string | null): void {
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, conv_key)
     VALUES (?, 'a1', 'assistant', 'body of ' || ?, ?)`,
  ).run(id, id, convKey);
}

const parkCount = (): number => (db.prepare(
  `SELECT count(*) c FROM messages WHERE conv_key LIKE 'park:%'`,
).get() as { c: number }).c;

describe('the body this file is about is the body the bridge sees', () => {
  it('POSITIVE: the chain is at 135, and `messages.conv_key` is a live column here', () => {
    expect((db.prepare('SELECT count(*) c FROM _migrations').get() as { c: number }).c).toBe(135);
    expect((db.prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1')
      .get() as { name: string }).name).toBe(SPINE);
    const cols = (db.prepare(`SELECT name FROM pragma_table_info('messages')`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(cols).toContain('conv_key');
  });
});

describe('an open delegation crosses the Stable Bridge', () => {
  it('POSITIVE: ONE parked delegation does not abort 135b — the exact incident', () => {
    seedKey('m-park', 'park:t-abc123');
    expect(parkCount()).toBe(1);
    expect(() => applyOne(db, BRIDGE)).not.toThrow();
  });

  it('POSITIVE: the FAN-OUT park form crosses too (`park:~<t1>|<t2>|<t3>#<remaining>`)', () => {
    seedKey('m-fan', 'park:~t1|t2|t3#t2');
    expect(() => applyOne(db, BRIDGE)).not.toThrow();
  });

  it('POSITIVE: several parks at once, mixed with already-closed keys, still cross', () => {
    seedKey('m-p1', 'park:t1');
    seedKey('m-p2', 'park:~t1|t2#t2');
    seedKey('m-p3', 'park:t3');
    seedKey('m-r1', 'relayed:t9');
    seedKey('m-r2', 'relayed:failed:t8');
    seedKey('m-owner', 'owner');
    seedKey('m-null', null);
    expect(parkCount()).toBe(3);
    expect(() => applyOne(db, BRIDGE)).not.toThrow();
  });
});

describe('the count is reported, not discarded', () => {
  it('POSITIVE: `park_namespace_empty` is an ok=1 row whose detail carries the number', () => {
    seedKey('m-p1', 'park:t1');
    seedKey('m-p2', 'park:~t1|t2#t2');
    applyBridgeKeepingAssertions(db);
    const row = db.prepare(
      `SELECT ok, detail FROM _bridge_assert WHERE name = 'park_namespace_empty'`,
    ).get() as { ok: number; detail: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.ok).toBe(1);
    expect(row!.detail).toContain('2');
  });

  it('POSITIVE: on a body with no parks the same row still reports, at zero', () => {
    applyBridgeKeepingAssertions(db);
    const row = db.prepare(
      `SELECT ok, detail FROM _bridge_assert WHERE name = 'park_namespace_empty'`,
    ).get() as { ok: number; detail: string };
    expect(row.ok).toBe(1);
    expect(row.detail).toContain('0');
  });

  it('POSITIVE: it is shaped like its sibling reported row, which is the pattern it copies', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, BRIDGE), 'utf-8');
    expect(sql).toContain(`('join_piece_population_reported', 1,`);
    expect(sql).toContain(`('park_namespace_empty', 1,`);
    // The refusal shape is GONE from this row: no `= 0` comparison feeding its `ok`.
    expect(sql).not.toMatch(/park_namespace_empty[\s\S]{0,220}LIKE 'park:%'\) = 0/);
  });
});

describe('NEGATIVE CONTROL — the refusal mechanism is intact', () => {
  it('a genuinely broken invariant still aborts the file: `CHECK (ok = 1)` was not disarmed', () => {
    // `8_no_id_collision` reads `_pre.loop_id_collisions`: a `work` row whose id already
    // occupies the `legacy-loop:<id>` name 135b is about to mint. W52 used this same
    // contrived collision as its control, and it is the control here for the same reason —
    // a demotion that also disabled the CHECK would pass every test above and be a disaster.
    db.prepare(
      `INSERT INTO open_loops (id, agent_id, conv_key, description, status)
       VALUES ('collide', 'a1', 'owner', 'q?', 'open')`,
    ).run();
    db.prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, opened_at, updated_at, provenance)
       VALUES ('legacy-loop:collide', 'commitment', 'a1', 'owner', 'conversation', 'r1',
               'open', 'inform', 0, 0, 'squatter', 1700000000000, 1700000000000, 'live')`,
    ).run();
    expect(() => applyOne(db, BRIDGE)).toThrow(/CHECK constraint failed: ok = 1/);
  });

  it('the file still carries the assertion table with its CHECK', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, BRIDGE), 'utf-8');
    expect(sql).toContain('ok INTEGER NOT NULL CHECK (ok = 1)');
  });
});
