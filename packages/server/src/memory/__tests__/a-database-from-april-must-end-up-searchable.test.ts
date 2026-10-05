// ⚠ THE CLAIM THIS FILE MAKES, in the brief's own words: "A DB from April must end up with working
// FTS." Not "we log about it", not "search degrades gracefully" — the index gets FIXED, on its own
// thread, after the box is already serving.
//
// Five states and a clause each, because the whole value of detection is that the four broken ones
// are DIFFERENT and earn different lines. The repair is proven END TO END on a real file (a worker
// opens its own connection, so `:memory:` would be proving nothing about a second thread) and the
// never-boot-blocking property is proven by the only honest method available: run the schedule with
// fake timers and assert the database is not touched until the timer fires.
//
// Every fixture is generated and fictional.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-t89-ftshealth-'));

let probeCalls = 0;
let currentPath = ':memory:';
// ⚠ `vi.hoisted`, because `vi.mock` factories run before module-level `const`s are initialised and a
// plain declaration below them throws "cannot access before initialization" at collect time.
const logSpy = vi.hoisted(() => ({
  debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {},
} as unknown as {
  debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>;
}));
vi.mock('../../db/connection.js', () => ({
  getDbPath: () => currentPath,
  getDb: () => { probeCalls += 1; throw new Error('these clauses inject their own runner'); },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => logSpy,
}));
vi.mock('../reader-pool.js', () => ({
  readerPoolAvailable: () => false,
  readerQuery: () => Promise.reject(new Error('not used by these clauses')),
}));

import {
  probeFtsHealth, ftsRepairPlan, runFtsRepair, checkFtsHealthAndRepair, scheduleFtsHealthCheck,
  resetFtsHealthForTest, FTS_RECREATE_SQL, FTS_REBUILD_SQL, FTS_HEALTH_DELAY_MS,
  FTS_REPAIR_DEADLINE_MS, type FtsProbeRun, type FtsState,
} from '../fts-health.js';

const ROWS = 400;

/** A generated database shaped like the platform's: `messages` plus the external-content index. */
function makeDb(name: string, opts: { index: 'good' | 'none' | 'partial' | 'extra' }): string {
  const p = path.join(dbDir, `${name}.db`);
  fs.rmSync(p, { force: true });
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
    content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  const ins = db.prepare('INSERT INTO messages (agent_id, content, created_at) VALUES (?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < ROWS; i += 1) ins.run('agent-fixture', `generated fixture line ${i}`, 1_700_000_000_000 + i);
  })();
  if (opts.index !== 'none') {
    db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid')`);
    if (opts.index === 'good') {
      db.exec('INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages');
    } else if (opts.index === 'partial') {
      // Half the history indexed — the shape of a database that grew past a half-finished reindex.
      db.exec(`INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages WHERE rowid <= ${ROWS / 2}`);
    } else {
      // MORE entries than rows: the 809-stale-row shape migration 129b measured on a lived-in box.
      db.exec('INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages');
      db.exec(`INSERT INTO messages_fts(rowid, content) VALUES (${ROWS + 1}, 'an entry with no row behind it')`);
    }
  }
  db.close();
  return p;
}

/** The probe's injected runner, pointed at a real file. */
function runnerFor(p: string): FtsProbeRun {
  const db = new Database(p, { readonly: true });
  return async (sql, params = []) => db.prepare(sql).all(...params) as unknown[];
}

beforeEach(() => {
  probeCalls = 0;
  logSpy.debug = vi.fn(); logSpy.info = vi.fn(); logSpy.warn = vi.fn(); logSpy.error = vi.fn();
  resetFtsHealthForTest();
});

afterAll(() => {
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('⚠ DETECTION — five states, and each one is a different sentence', () => {
  it('HEALTHY: the index covers every row and answers a MATCH, so nothing is said and nothing is done', async () => {
    const health = await probeFtsHealth(runnerFor(makeDb('good', { index: 'good' })));
    expect(health.state).toBe('healthy');
    expect(health.indexedRows).toBe(ROWS);
    expect(health.tableRows).toBe(ROWS);
    expect(ftsRepairPlan(health.state)).toBe('none');
  });

  it('MISSING: no messages_fts at all — the brief\'s "born before the migration" case', async () => {
    const health = await probeFtsHealth(runnerFor(makeDb('none', { index: 'none' })));
    expect(health.state).toBe('missing');
    // ⚠ RECREATE, not rebuild: fts5\'s own `\'rebuild\'` command needs a table to rebuild, so this is
    // the one state whose repair needs the declaration.
    expect(ftsRepairPlan(health.state)).toBe('recreate');
    expect(health.detail).toContain('no messages_fts table');
  });

  it('UNPOPULATED: fewer entries than rows, named as messages the agent can no longer find', async () => {
    const health = await probeFtsHealth(runnerFor(makeDb('partial', { index: 'partial' })));
    expect(health.state).toBe('unpopulated');
    expect(health.indexedRows).toBe(ROWS / 2);
    expect(health.tableRows).toBe(ROWS);
    expect(health.detail).toContain(`${ROWS / 2} message(s) are in the table and not in the index`);
    expect(ftsRepairPlan(health.state)).toBe('rebuild');
  });

  it('STALE: more entries than rows — the 809-row drift a lived-in box actually had', async () => {
    const health = await probeFtsHealth(runnerFor(makeDb('extra', { index: 'extra' })));
    expect(health.state).toBe('stale');
    expect(health.indexedRows).toBe(ROWS + 1);
    expect(health.tableRows).toBe(ROWS);
    expect(ftsRepairPlan(health.state)).toBe('rebuild');
  });

  it('CORRUPT: the counts agree and MATCH fails anyway — the state a count comparison cannot see', async () => {
    // ⚠ THIS IS THE WHOLE REASON THE THIRD READ EXISTS. The migrations-side check compares two counts
    // and would call this database healthy. Simulated at the runner, because deliberately corrupting
    // fts5\'s internal pages in a fixture would be testing SQLite, not this policy: the runner answers
    // both counts truthfully and throws on the MATCH, which is exactly what a broken index does.
    const real = runnerFor(makeDb('good2', { index: 'good' }));
    const run: FtsProbeRun = async (sql, params) => {
      if (sql.includes('MATCH')) throw new Error('database disk image is malformed');
      return real(sql, params);
    };
    const health = await probeFtsHealth(run);
    expect(health.state).toBe('corrupt');
    expect(health.indexedRows).toBe(ROWS);
    expect(health.tableRows).toBe(ROWS);
    expect(ftsRepairPlan(health.state)).toBe('rebuild');
  });

  it('UNKNOWN: a probe that cannot read repairs NOTHING — the failure direction matters', async () => {
    const health = await probeFtsHealth(async () => { throw new Error('unable to open database file'); });
    expect(health.state).toBe('unknown');
    // ⚠ LOAD-BEARING. `recreate` starts with DROP TABLE. A probe that could not read must never reach
    // it, or an unreadable moment destroys a working index.
    expect(ftsRepairPlan(health.state)).toBe('none');
    for (const state of ['unknown', 'healthy'] as FtsState[]) {
      expect(ftsRepairPlan(state)).toBe('none');
    }
  });
});

describe('⚠ THE REPAIR — a database from April ends up searchable, on another thread', () => {
  it('RECREATE: a database with no index at all gets a working one, and MATCH finds a row', async () => {
    const p = makeDb('repair-none', { index: 'none' });
    const before = await probeFtsHealth(runnerFor(p));
    expect(before.state).toBe('missing');

    const result = await runFtsRepair('recreate', { dbPath: p, deadlineMs: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.ok, 'the repair reported failure').toBe(true);
    expect(result.indexedRows).toBe(ROWS);

    const after = await probeFtsHealth(runnerFor(p));
    expect(after.state).toBe('healthy');
    // And the index actually ANSWERS — a count that matches is not the claim, findability is.
    const db = new Database(p, { readonly: true });
    const hits = db.prepare(`SELECT rowid AS rid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 5`).all('fixture') as unknown[];
    db.close();
    expect(hits.length, 'the rebuilt index found nothing').toBeGreaterThan(0);
  }, 60_000);

  it('REBUILD: a half-indexed database comes back covering every row', async () => {
    const p = makeDb('repair-partial', { index: 'partial' });
    expect((await probeFtsHealth(runnerFor(p))).state).toBe('unpopulated');
    const result = await runFtsRepair('rebuild', { dbPath: p, deadlineMs: 60_000 });
    expect(result.ok, result.error ?? 'repair failed').toBe(true);
    expect((await probeFtsHealth(runnerFor(p))).state).toBe('healthy');
  }, 60_000);

  it('a repair against a database that is not there FAILS LOUDLY rather than claiming success', async () => {
    const result = await runFtsRepair('rebuild', { dbPath: path.join(dbDir, 'no-such.db'), deadlineMs: 20_000 });
    expect(result.ok).toBe(false);
    expect(result.error, 'a failed repair must carry its reason').toBeTruthy();
  }, 30_000);

  it('the deadline is far above a once-per-box reindex and far above a SEARCH deadline', () => {
    // A rebuild of a 729 MB table is minutes; a search that takes 15s is a defect. Two deadlines,
    // two questions, and the ordering between them is the claim.
    expect(FTS_REPAIR_DEADLINE_MS).toBeGreaterThan(60_000);
    expect(FTS_HEALTH_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('⚠ BOTH TRANSITIONS ARE LOGGED, and a healthy index says nothing', () => {
  it('a healthy index logs NOTHING — noise on every boot is how a real line gets ignored', async () => {
    const p = makeDb('log-good', { index: 'good' });
    const out = await checkFtsHealthAndRepair({ run: runnerFor(p) });
    expect(out.plan).toBe('none');
    expect(out.result).toBeNull();
    expect(logSpy.warn).not.toHaveBeenCalled();
    expect(logSpy.info).not.toHaveBeenCalled();
    expect(logSpy.error).not.toHaveBeenCalled();
  });

  it('a broken index logs the way IN (naming what search does meanwhile) and the way OUT (with the measurement)', async () => {
    const p = makeDb('log-partial', { index: 'partial' });
    const out = await checkFtsHealthAndRepair({
      run: runnerFor(p),
      repair: async () => ({ ok: true, ms: 1234, indexedRows: ROWS, tableRows: ROWS }),
    });
    expect(out.plan).toBe('rebuild');

    expect(logSpy.warn, 'the transition IN was not logged').toHaveBeenCalledTimes(1);
    const inLine = String(logSpy.warn.mock.calls[0][0]);
    expect(inLine).toContain('unpopulated');
    expect(inLine, 'the line must say what search does in the meantime').toContain('bounded LIKE fallback');
    expect(inLine).toContain('background');

    expect(logSpy.info, 'the transition OUT was not logged').toHaveBeenCalledTimes(1);
    expect(String(logSpy.info.mock.calls[0][0])).toContain('back on the index');
    expect(logSpy.info.mock.calls[0][1]).toMatchObject({ ms: 1234, plan: 'rebuild' });
    expect(logSpy.error).not.toHaveBeenCalled();
  });

  it('a repair that FAILS says so at error level and promises the retry, not the fix', async () => {
    const p = makeDb('log-fail', { index: 'partial' });
    await checkFtsHealthAndRepair({
      run: runnerFor(p),
      repair: async () => ({ ok: false, ms: 7, indexedRows: null, tableRows: null, error: 'disk I/O error' }),
    });
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    expect(String(logSpy.error.mock.calls[0][0])).toContain('retried next boot');
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it('a state nobody repairs is still SAID OUT LOUD — an unreadable index must not be silent', async () => {
    await checkFtsHealthAndRepair({ run: async () => { throw new Error('unable to open database file'); } });
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    expect(String(logSpy.warn.mock.calls[0][0])).toContain('will NOT be repaired automatically');
  });

  it('NO USER CONTENT reaches any of it — counts and state names only', async () => {
    const src = fs.readFileSync(new URL('../fts-health.ts', import.meta.url), 'utf-8');
    // The one literal the MATCH probe sends is a token defined in this module, so there is nowhere
    // for a user's query text to arrive. A probe that took a pattern argument would be that hole.
    expect(src).toMatch(/MATCH \? LIMIT 1`, \['zzqxhealthprobe'\]/);
    expect(src, 'probeFtsHealth must take no pattern argument').toMatch(
      /export async function probeFtsHealth\(run: FtsProbeRun\): Promise<FtsHealth>/);
  });
});

describe('⚠ NEVER BOOT-BLOCKING — and the property lives in the module so it can be proven', () => {
  it('scheduleFtsHealthCheck returns immediately and touches no database until its timer fires', async () => {
    vi.useFakeTimers();
    try {
      currentPath = path.join(dbDir, 'boot.db');
      makeDb('boot', { index: 'good' });
      scheduleFtsHealthCheck(FTS_HEALTH_DELAY_MS);
      // ⚠ THE CLAIM: nothing happened. Not "it was fast" — nothing ran at all.
      expect(probeCalls, 'the health check read the database during the call').toBe(0);
      expect(logSpy.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount(), 'the check did not schedule itself for later').toBeGreaterThan(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      currentPath = ':memory:';
    }
  });

  it('an in-memory database schedules nothing, because no second connection can reach it', () => {
    currentPath = ':memory:';
    vi.useFakeTimers();
    try {
      scheduleFtsHealthCheck(FTS_HEALTH_DELAY_MS);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the check runs ONCE per process, however many times the wire is called', () => {
    currentPath = path.join(dbDir, 'boot.db');
    vi.useFakeTimers();
    try {
      scheduleFtsHealthCheck(FTS_HEALTH_DELAY_MS);
      const after1 = vi.getTimerCount();
      scheduleFtsHealthCheck(FTS_HEALTH_DELAY_MS);
      scheduleFtsHealthCheck(FTS_HEALTH_DELAY_MS);
      expect(vi.getTimerCount(), 'the health check scheduled itself more than once').toBe(after1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      currentPath = ':memory:';
    }
  });

  it('the boot WIRE is present, and it is past the point where the server is already serving', () => {
    const boot = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf-8');
    expect(boot).toContain("from './memory/fts-health.js'");
    const call = boot.indexOf('scheduleFtsHealthCheck()');
    const serving = boot.indexOf("logger.info('Dojo Agent Platform is serving')");
    const migrations = boot.indexOf('runMigrations()');
    expect(call, 'the FTS health check is not wired at boot').toBeGreaterThan(0);
    expect(serving).toBeGreaterThan(0);
    // ⚠ BOTH DIRECTIONS OF THE ORDER, because either one alone is satisfiable by an accident: the
    // check must run AFTER the port is serving (so it is not part of the boot window) and after
    // migrations (so it is not racing the schema it inspects).
    expect(call, 'the check runs before the server is serving').toBeGreaterThan(serving);
    expect(call, 'the check runs before migrations').toBeGreaterThan(migrations);
  });
});

describe('⚠ THE INDEX DECLARATION HAS ONE OWNER — the migration, enforced rather than promised', () => {
  it('the recreate SQL matches migration 129b\'s own declaration, normalised for whitespace', () => {
    // ⚠ WHY THIS CLAUSE EXISTS. `recreate` needs the fts5 DDL, and writing it in a TypeScript module
    // makes a SECOND spelling of a schema the migrations own — the drift class this tree has spent
    // whole tasks removing. It is admitted on exactly one condition: that the condition is CHECKED.
    // If a migration ever redeclares the index differently, this reds and the module is corrected
    // with it. Note what is asserted is the DECLARATION, not the whole repair: the migration also
    // carries its own assertions and comments, which are not this module's business.
    const mig = fs.readFileSync(
      new URL('../../db/migrations/129b_stable_merge_messages.sql', import.meta.url), 'utf-8');
    // ALL whitespace removed, not merely collapsed: the migration breaks the column list across four
    // lines and the module writes it on one, which is a formatting difference and not a declaration
    // difference. Both sides get the identical treatment, so every token that distinguishes one
    // declaration from another survives it.
    const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
    const declaration = squash(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid')");
    expect(squash(FTS_RECREATE_SQL), 'the module no longer declares the index this way')
      .toContain(declaration);
    expect(squash(mig), 'migration 129b no longer declares the index this way — correct the module')
      .toContain(declaration);
    // And the populate statement, which is the other half of "a table with rows in it".
    // ⚠ AND THE POPULATE STATEMENT, whose expected value is EXTRACTED FROM THE MIGRATION rather than
    // written out here — so there is no third copy to drift, and (not incidentally) no bare `rowid`
    // projection literal in this file for T10's own reader guard to flag.
    //
    // ONE NAMED SUBSTITUTION is applied to the module's side, and it is a normalisation rather than a
    // loosening: the module projects `seq AS rowid` where the migration writes a bare `rowid`.
    // Identical values (T10 made `seq` the table's rowid alias) and identical behaviour (the INSERT
    // binds positionally), but a bare `rowid` projection over `messages` is refused in TypeScript by
    // that guard, which is right to have no exceptions. Substituting it BY NAME keeps this a
    // byte-level comparison: any OTHER difference between the two statements still reds.
    const populate = squash(mig).match(/insertintomessages_fts\(rowid,content\)select[a-z,_]*frommessages;/)?.[0];
    expect(populate, 'migration 129b no longer populates the index this way — correct the module')
      .toBeTruthy();
    expect(squash(FTS_RECREATE_SQL).replace('seqasrowid', 'rowid'),
      'the module no longer populates the index the way the migration does').toContain(populate!);
  });

  it('the rebuild command is fts5\'s own, not a hand-rolled reindex', () => {
    expect(FTS_REBUILD_SQL).toContain("messages_fts(messages_fts) VALUES('rebuild')");
    // A rebuild must never drop anything — only `recreate` may, and only on a MISSING table.
    expect(FTS_REBUILD_SQL).not.toContain('DROP');
  });
});
