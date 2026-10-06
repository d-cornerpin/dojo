// ════════════════════════════════════════════════════════════════════════════════════════
// WHERE A `work_events` ORPHAN CAN COME FROM, AND THE TRIPWIRE FOR THE NEXT ONE (W2-B item B).
//
// ── THE BRIEF'S PREMISE, CORRECTED BY MEASUREMENT ──
// The item asks for "an FK-check at the WRITE SEAM with a loud log naming the caller", on the
// grounds that the source of the 481 `work_events -> work` orphans is unknown. There is exactly
// one write seam — `work/store.ts`'s `appendEvent`, the only `INSERT INTO work_events` in
// production source — and a check there CANNOT EVER FIRE. Measured on the real migrated schema
// by the first describe block below:
//
//   foreign_keys = ON    insert an event naming a missing work row  -> REFUSED by SQLite
//                        delete a work row out from under its event -> REFUSED by SQLite
//   foreign_keys = OFF   both succeed, and the second mints an orphan
//
// `work_events.work_id` is `TEXT NOT NULL REFERENCES work(id)` (migration 135 line 74), so with
// the pragma on, the database refuses both directions before any application code is consulted.
// A tripwire at the insert seam would be dead code guarding a door SQLite already holds shut.
//
// ── SO THE ORPHAN'S REAL PRECONDITION IS A CONNECTION WITH THE GUARD OFF ──
// That is also what migration `173`'s header already concluded from measurement, with the
// `messages` zero as its falsifiable control: the orphans were minted by the kit's behavioural
// teardown handing raw SQL to the `sqlite3` CLI, which leaves `foreign_keys` OFF and names
// `work` but not `work_events`. That writer lives in another repository and nothing here can
// reach it. What this file can do — and what "name the writer the next time an orphan appears"
// honestly reduces to on the engine side — is hold the one precondition closed:
//
//   CLAUSE B1  the schema itself refuses both orphan-minting moves while the pragma is on,
//              and mints them the moment it is off (the negative control that proves the
//              guarantee rests on the pragma rather than on luck)
//   CLAUSE B2  every production site that OPENS a SQLite database is declared here with a
//              reason, and any declared site that is not `db/connection.ts` must not carry a
//              statement that can delete a parent row — `DELETE FROM <parent>` or
//              `REPLACE INTO <parent>` — because such a statement on a connection with the
//              guard off is precisely how an orphan is minted. The parent-table set is DERIVED
//              from the schema's own foreign keys, so a table that becomes a parent later is
//              covered without anybody editing this file.
//
// A new connection therefore fails B2 by being undeclared, and a delete added to a declared one
// fails B2 by its shape. That is the tripwire: it names the FILE before the orphan exists,
// instead of naming a caller after the row is already unreachable.
//
// Measured at this head, the five non-`connection.ts` sites are all clean: two open Apple's
// `chat.db` READONLY (they cannot write anything, let alone delete), and three touch the dojo
// body with INSERT and UPDATE only. One of those three uses `INSERT OR REPLACE INTO config`,
// whose REPLACE does delete a conflicting row — `config` is a parent of nothing, so it is safe
// today, and B2 is what would catch that statement the day it moved to a table with children.
//
// All agents and rows below are fictional.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-orphan-precondition');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-orphan-precondition', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

import { runMigrations } from '../migrations.js';

const db = (): Database.Database => mockDb.current!;
const NOW = 1_790_000_000_000;

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

const seedWorkRow = (id: string): void => {
  db().prepare(`
    INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, title, opened_at, updated_at, sequence)
    VALUES (?, 'task', 'a-fictional-agent', 'owner', 'legacy', 'legacy', 'open', 'FYI', 0, 0,
            'a chore', ?, ?, 0)
  `).run(id, NOW, NOW);
};
const seedEvent = (workId: string): void => {
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES (?, 'opened', '{}', 'owner', ?)`).run(workId, NOW);
};
/** The thing the whole item is about: an event whose work row does not exist. */
const orphanCount = (): number => n(
  'SELECT COUNT(*) AS n FROM work_events WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = work_events.work_id)',
);

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── CLAUSE B1: THE DATABASE ALREADY REFUSES BOTH DIRECTIONS ──────────────────────────────

describe('CLAUSE B1 — with the guard ON, no path can mint an orphan', () => {
  beforeEach(() => {
    db().pragma('foreign_keys = ON');
    expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('the declared foreign key is still there, and still NOT the cascading kind', () => {
    const fk = (db().prepare('PRAGMA foreign_key_list("work_events")').all() as
      Array<{ table: string; from: string; on_delete: string }>).find(f => f.table === 'work');
    expect(fk).toBeDefined();
    expect(fk!.from).toBe('work_id');
    // NO ACTION is why the refusal below is a refusal and not a silent cascade.
    expect(fk!.on_delete).toBe('NO ACTION');
  });

  it('⚠ INSERTING an event for a work row that does not exist is REFUSED', () => {
    expect(() => seedEvent('no-such-work')).toThrow(/FOREIGN KEY constraint failed/);
    expect(orphanCount()).toBe(0);
  });

  it('⚠ DELETING a work row out from under its event is REFUSED', () => {
    seedWorkRow('w1');
    seedEvent('w1');

    expect(() => db().prepare('DELETE FROM work WHERE id = ?').run('w1'))
      .toThrow(/FOREIGN KEY constraint failed/);

    expect(n('SELECT COUNT(*) AS n FROM work WHERE id = ?', 'w1')).toBe(1);
    expect(orphanCount()).toBe(0);
  });
});

describe('CLAUSE B1 negative control — with the guard OFF, both moves succeed', () => {
  // This is what makes the clause above a measurement rather than an assumption: the guarantee
  // rests on the pragma, and this proves what the pragma is worth by taking it away.
  beforeEach(() => {
    db().pragma('foreign_keys = OFF');
    expect(db().pragma('foreign_keys', { simple: true })).toBe(0);
  });

  it('the INSERT lands, and the row is an orphan the moment it exists', () => {
    seedEvent('no-such-work');
    expect(orphanCount()).toBe(1);
  });

  it('the DELETE lands, and strands the event — the 481 rows’ shape exactly', () => {
    seedWorkRow('w1');
    seedEvent('w1');
    expect(orphanCount()).toBe(0);

    db().prepare('DELETE FROM work WHERE id = ?').run('w1');

    expect(orphanCount()).toBe(1);
  });
});

// ── CLAUSE B2: THE CENSUS OF EVERY DOOR THAT OPENS A DATABASE ────────────────────────────

const SRC = path.join(__dirname, '..', '..');

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
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping line count, so prose about opening a database is never a door. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const OPENS_A_DB_RE = /new\s+Database\s*\(/;

const openerFiles = (): string[] => walk(SRC).map(rel)
  .filter(f => OPENS_A_DB_RE.test(stripComments(read(f))))
  .sort();

/**
 * Every production site that opens a SQLite file, with what it opens and why that is allowed.
 * `readonly: true` is the strongest possible answer — a readonly handle cannot delete anything,
 * so the guard being off on it is harmless.
 */
const DECLARED_OPENERS: Record<string, { readonly: boolean; reason: string }> = {
  'db/connection.ts': {
    readonly: false,
    reason: 'THE one door to the dojo body. Sets `foreign_keys = ON` and READS IT BACK, '
      + 'forcing it again if SQLite did not take it — so every statement the platform runs '
      + 'inherits the guard that makes an orphan impossible.',
  },
  'migration/import.ts': {
    readonly: false,
    reason: 'Opens the RESTORED body once, after an import, while the main connection is '
      + 'closed, to stamp one config key. INSERT only (an OR REPLACE against `config`, which '
      + 'is a parent of nothing), so it cannot delete a parent row.',
  },
  'migration/path-migration.ts': {
    readonly: false,
    reason: 'Rewrites $HOME references inside a body taken from ANOTHER MACHINE, and opens '
      + 'that file itself deliberately — routing it through the singleton would target the '
      + 'wrong file the day the path argument is not the live one. UPDATE only.',
  },
  'memory/fts-health.ts': {
    readonly: false,
    reason: 'The FTS repair WORKER opens the body on its own connection to rebuild the search '
      + 'index inside BEGIN IMMEDIATE, chunked and stop-checked (t89). It touches only the '
      + 'messages_fts shadow tables, which no foreign key points at, so it cannot delete a '
      + 'parent row; the transaction leaves the prior index intact if killed.',
  },
  'memory/reader-pool.ts': {
    readonly: true,
    reason: 'The reader WORKER (t89) holds one long-lived connection opened readonly: true, '
      + 'fileMustExist: true against the same body, so bounded searches run off the serving '
      + 'thread. A readonly handle cannot write, so it cannot strand a row.',
  },
  'services/imessage-bridge.ts': {
    readonly: true,
    reason: 'Apple’s `chat.db`, not the dojo body, and opened `readonly: true` with '
      + '`fileMustExist: true`. A readonly handle cannot write, so it cannot strand a row.',
  },
};

/** Every table some foreign key points AT. Deleting one of these rows with the guard off is
 *  the move that mints an orphan, so these are the names B2 watches for. */
function parentTables(): string[] {
  const tables = (db().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(r => r.name);
  const parents = new Set<string>();
  for (const t of tables) {
    for (const fk of db().prepare(`PRAGMA foreign_key_list("${t}")`).all() as Array<{ table: string }>) {
      parents.add(fk.table);
    }
  }
  return [...parents].sort();
}

describe('CLAUSE B2 — every door that opens a database is declared, and none of them can strand a row', () => {
  it('the walk is not blind: it sees a real open and ignores a described one', () => {
    expect(OPENS_A_DB_RE.test(stripComments('const d = new Database(p);'))).toBe(true);
    expect(OPENS_A_DB_RE.test(stripComments('// new Database(p) — described, never called'))).toBe(false);
  });

  it('names every production site that opens a SQLite file, so a new one is visible', () => {
    const found = openerFiles();
    expect(found).toEqual(Object.keys(DECLARED_OPENERS).sort());
    expect(found.length).toBeGreaterThan(0);
    // Every declaration carries a real reason, so the list cannot grow by a bare string.
    for (const f of found) {
      expect(DECLARED_OPENERS[f].reason.length, `${f} has no recorded reason`).toBeGreaterThan(80);
    }
  });

  it('the parent-table set is read from the schema and is not empty', () => {
    const parents = parentTables();
    expect(parents).toContain('work');     // what `work_events` points at
    expect(parents).toContain('agents');   // the other census's subject
    expect(parents.length).toBeGreaterThan(5);
  });

  it('⚠ no opener but `db/connection.ts` carries a statement that can delete a parent row', () => {
    const parents = parentTables();
    for (const [file, decl] of Object.entries(DECLARED_OPENERS)) {
      if (file === 'db/connection.ts') continue;
      const src = stripComments(read(file));
      if (decl.readonly) {
        // The declaration has to be TRUE of the source, not just written down here.
        expect(/readonly:\s*true/.test(src), `${file} is declared readonly but does not say so`)
          .toBe(true);
        continue;
      }
      for (const parent of parents) {
        const deletes = new RegExp(String.raw`DELETE\s+FROM\s+${parent}\b`, 'i');
        const replaces = new RegExp(String.raw`REPLACE\s+INTO\s+${parent}\b`, 'i');
        expect(deletes.test(src),
          `${file} opens a database with the guard off and DELETEs from \`${parent}\`, a parent table`).toBe(false);
        expect(replaces.test(src),
          `${file} opens a database with the guard off and REPLACEs INTO \`${parent}\`, a parent table`).toBe(false);
      }
    }
  });

  it('the shape-matcher is not vacuous — it catches both spellings', () => {
    const deletes = new RegExp(String.raw`DELETE\s+FROM\s+work\b`, 'i');
    const replaces = new RegExp(String.raw`REPLACE\s+INTO\s+work\b`, 'i');
    expect(deletes.test("db.prepare('DELETE FROM work WHERE id = ?')")).toBe(true);
    expect(replaces.test("db.prepare('INSERT OR REPLACE INTO work (id) VALUES (?)')")).toBe(true);
    // …and does not fire on the child table, which is safe to delete from.
    expect(deletes.test("db.prepare('DELETE FROM work_events WHERE work_id = ?')")).toBe(false);
  });
});
