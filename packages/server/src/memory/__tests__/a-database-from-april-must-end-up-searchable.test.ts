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

const dbDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t89-ftshealth-'));

let probeCalls = 0;
let currentPath = ':memory:';
let bootDb: Database.Database | null = null;
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
  // ⚠ STILL COUNTS, AND STILL REFUSES BY DEFAULT. `probeCalls` is what the never-boot-blocking clause
  // reads, so every call is counted whether or not a database is handed back; and with no fixture set
  // it throws, so a clause that reaches for the serving connection by accident says so loudly. The
  // t98 boot clauses set `bootDb` deliberately, because `runMigrations()` takes no argument.
  getDb: () => {
    probeCalls += 1;
    if (bootDb) return bootDb;
    throw new Error('these clauses inject their own runner');
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => logSpy,
}));
vi.mock('../reader-pool.js', () => ({
  readerPoolAvailable: () => false,
  readerQuery: () => Promise.reject(new Error('not used by these clauses')),
}));

// ⚠ IMPORTED FOR THE t98 D3 CLAUSES AND NOT USED ANYWHERE ELSE: the proof that boot no longer
// repairs the index is "run the whole real migration chain over a broken index and watch it stay
// broken", which needs the real runner.
import { runMigrations } from '../../db/migrations.js';
import {
  probeFtsHealth, ftsRepairPlan, runFtsRepair, checkFtsHealthAndRepair, scheduleFtsHealthCheck,
  resetFtsHealthForTest, FTS_RECREATE_SQL, FTS_REBUILD_SQL, FTS_HEALTH_DELAY_MS,
  FTS_REPAIR_DEADLINE_MS, FTS_POPULATE_CHUNK_ROWS, FTS_STOP_GRACE_MS, stopFtsRepair,
  type FtsProbeRun, type FtsState,
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
    expect(inLine).toContain('background');
    // ⚠ I8: THIS CLAUSE USED TO PIN THE WRONG SENTENCE. It asserted "bounded LIKE fallback" for every
    // repairable state, and for `unpopulated`/`stale` that is false: the index ANSWERS, partially,
    // nothing throws, and `retrieval.ts` therefore never reaches the catch that would fall back. A
    // reader of that line would go looking for fallback warns that never appear. The line is now
    // state-accurate and the clause moved with it — see the `missing` clause below for the other half.
    expect(inLine, 'an index that still answers must not be described as fallen back')
      .not.toContain('bounded LIKE fallback');
    expect(inLine, 'a partial index must say the results may be incomplete').toContain('may be incomplete');

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

describe('⚠ I8 — THE LINE IS STATE-ACCURATE, AND THE REPAIR IS NEVER VISIBLE HALF-DONE', () => {
  it('a MISSING index DOES say the fallback is taken — the other half of the same claim', async () => {
    const p = makeDb('log-missing', { index: 'none' });
    await checkFtsHealthAndRepair({
      run: runnerFor(p),
      repair: async () => ({ ok: true, ms: 5, indexedRows: ROWS, tableRows: ROWS }),
    });
    const line = String(logSpy.warn.mock.calls[0][0]);
    // With no table, `MATCH` throws, `retrieval.ts` reaches its catch, and the fallback really is
    // what serves the search. Both directions of I8 are asserted, so neither sentence can drift.
    expect(line).toContain('missing');
    expect(line, 'a missing index must say the bounded fallback is what answers')
      .toContain('bounded LIKE fallback');
  });

  it('⚠ A RECREATE IS ONE TRANSACTION — a concurrent reader never sees an empty index', async () => {
    // ⚠ THE DEFECT: `DROP; CREATE; INSERT` in autocommit COMMITS EACH STATEMENT, so from the CREATE
    // to the INSERT — minutes on a large table — `messages_fts` existed and was EMPTY. `MATCH`
    // succeeded with zero rows, nothing threw, so the LIKE fallback was not taken and every
    // `history_search` returned "No results" while looking perfectly healthy. Readers must see the
    // old index or the new one.
    const src = fs.readFileSync(new URL('../fts-health.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, 'the repair no longer takes the write lock up front').toContain("BEGIN IMMEDIATE;");
    expect(src, 'and it must commit').toContain("COMMIT;");
    expect(src, 'a repair that cannot finish must leave the previous index in place')
      .toContain("ROLLBACK;");
    // And the end state is still right — the transaction is not just ceremony.
    const p = makeDb('txn-recreate', { index: 'none' });
    const result = await runFtsRepair('recreate', { dbPath: p, deadlineMs: 60_000 });
    expect(result.ok, result.error ?? 'repair failed').toBe(true);
    expect((await probeFtsHealth(runnerFor(p))).state).toBe('healthy');
  }, 60_000);
});

describe('⚠ I1 — THE REPAIR IS INTERRUPTIBLE, BECAUSE process.exit() JOINS IT', () => {
  it('the populate runs in BOUNDED CHUNKS, so the worst-case exit delay is one chunk', async () => {
    // ⚠ WHY: `process.exit()` joins a worker thread and nothing in JavaScript preempts
    // `sqlite3_step`. Measured on an `unref`'d eval worker inside a 4.65 s statement with exit
    // requested at +404 ms: the process left at 5,630 ms. A single-statement rebuild on a 729 MB
    // table is MINUTES, so a SIGTERM during the once-per-box repair hung until launchd's
    // `ExitTimeOut` SIGKILLed it and the transaction rolled back. The chunk size is a SHUTDOWN
    // BUDGET, which is why it is asserted as a count and not inferred.
    const p = makeDb('chunked', { index: 'none' });
    const result = await runFtsRepair('recreate', { dbPath: p, deadlineMs: 60_000, chunkRows: 100 });
    expect(result.ok, result.error ?? 'repair failed').toBe(true);
    // eslint-disable-next-line no-console
    console.log(`I1  ${ROWS} rows populated in ${result.chunks} chunk(s) of 100 · ${result.ms}ms`);
    expect(result.chunks, 'the populate is still one statement').toBe(ROWS / 100);
    expect((await probeFtsHealth(runnerFor(p))).state).toBe('healthy');
  }, 60_000);

  it('the default chunk is small enough to be a shutdown budget and large enough to not be silly', () => {
    expect(FTS_POPULATE_CHUNK_ROWS).toBeGreaterThan(500);
    expect(FTS_POPULATE_CHUNK_ROWS).toBeLessThan(50_000);
    // The grace must outlast a chunk (or the backstop kill makes the boundary check pointless) and
    // must stay well inside launchd's 20-second ExitTimeOut, which is I1's actual deadline.
    expect(FTS_STOP_GRACE_MS).toBeGreaterThan(0);
    expect(FTS_STOP_GRACE_MS).toBeLessThan(20_000);
  });

  it('⚠ A CANCELLED REPAIR LEAVES THE PREVIOUS INDEX IN PLACE — it never half-writes', async () => {
    // A `rebuild` on a HEALTHY-but-stale index, stopped mid-populate. The transaction means the
    // outcome is binary: either the rebuild committed, or the index is exactly what it was.
    const p = makeDb('cancelled', { index: 'extra' });
    const before = await probeFtsHealth(runnerFor(p));
    expect(before.state).toBe('stale');
    const beforeCount = before.indexedRows;

    // One row per chunk, so there are many boundaries, and the stop is posted SYNCHRONOUSLY on the
    // line after the launch. ⚠ DETERMINISTIC ON PURPOSE: my first version polled with `waitFor` and
    // the 400-row repair finished in 16 ms before the first poll ran, so the clause passed by
    // measuring a COMPLETED repair (`ok=true`). A stop that must win a race is a clause that reports
    // whatever the machine felt like. `liveRepair` is assigned inside `runFtsRepair`'s executor,
    // which runs synchronously, so the message is queued before the worker reads its first boundary.
    const inFlight = runFtsRepair('rebuild', { dbPath: p, deadlineMs: 60_000, chunkRows: 1 });
    expect(stopFtsRepair(), 'there was no repair in flight to stop').toBe(true);
    const result = await inFlight;
    // eslint-disable-next-line no-console
    console.log(`I1  a cancelled repair reported ok=${result.ok} error=${String(result.error).slice(0, 48)}`);
    expect(result.ok, 'a cancelled repair must not report success').toBe(false);
    // ⚠ IT STOPPED AT A CHUNK BOUNDARY, not by being killed — which is the mechanism I1 adds, and the
    // thing my first cut got wrong: posting the stop and calling `terminate()` on the next line let
    // the kill win every race, so the boundary check never ran and this read "exited without
    // answering". The backstop kill is still there; it is just no longer the normal path.
    expect(String(result.error), 'the repair was killed rather than asked to stop — the chunk '
      + 'boundary check never ran').toContain('asked to stop at a chunk boundary');

    // ⚠ THE CLAIM: the index is NOT half-written. It is either what it was, or fully rebuilt.
    const after = await probeFtsHealth(runnerFor(p));
    expect(['stale', 'healthy'], `a cancelled repair left the index ${after.state}`)
      .toContain(after.state);
    if (after.state === 'stale') {
      expect(after.indexedRows, 'the rolled-back repair still changed the index').toBe(beforeCount);
    }
  }, 60_000);

  it('stopFtsRepair reports honestly when there is nothing to stop', () => {
    expect(stopFtsRepair()).toBe(false);
  });

  it('⚠ THE SHUTDOWN WIRE — both worker threads are stopped before the process exits', () => {
    const boot = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf-8');
    const code = boot.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const shutdownAt = code.indexOf('const shutdown = (): void => {');
    const exitAt = code.indexOf('process.exit(0)');
    expect(shutdownAt).toBeGreaterThan(0);
    const body = code.slice(shutdownAt, exitAt);
    // ⚠ BOTH, and BEFORE the exit. The reader pool's exposure is bounded by its 15 s deadline; the
    // repair's was not bounded at all, which is why it is the one with a stop message.
    expect(body, 'the FTS repair is not stopped on shutdown — a SIGTERM will hang on it')
      .toMatch(/stopFtsRepair\(\)/);
    expect(body, 'the reader pool is not terminated on shutdown')
      .toMatch(/terminateReaderPool\(\)/);
    expect(code).toContain("from './memory/reader-pool.js'");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// t98 D3 — THE BOOT-BLOCKING REBUILD IS DELETED, AND THIS MODULE OWNS EVERY REPAIR CASE.
//
// ⚠ WHY A DELETION NEEDS CLAUSES. While both mechanisms shipped, `db/migrations.ts` repaired the
// COUNT-MISMATCH case synchronously inside `runMigrations()` — hundreds of lines before the port
// bind — so this module's background check found the common case ALREADY HEALTHY and did nothing.
// The background job was real and the boot was still blocked. "Never boot-blocking" was therefore
// true of one module and false of the tree, and the only way to make it true of the tree is for the
// synchronous repair to be gone and to STAY gone.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('⚠ t98 D3 — NOTHING REPAIRS THE INDEX AT BOOT ANY MORE', () => {
  it('db/migrations.ts contains no fts5 rebuild — asserted with the comments STRIPPED', () => {
    // ⚠ COMMENTS STRIPPED, and that is not fastidiousness. The region's replacement is a POINTER that
    // explains what used to be here and why it left, and it names `'rebuild'` four times doing so —
    // so a clause over the raw source would be green with the code still present, or red with only
    // the prose present. Either way it would be testing the comment.
    const raw = fs.readFileSync(new URL('../../db/migrations.ts', import.meta.url), 'utf-8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'a boot-blocking fts5 rebuild is back in the migration runner')
      .not.toMatch(/messages_fts\s*\(\s*messages_fts\s*\)\s*VALUES/i);
    expect(code, "the migration runner is reading the index's shadow table again")
      .not.toContain('messages_fts_docsize');
    // The pointer itself IS required to stay: a bare deletion loses the argument for why the question
    // moved, and the next reader re-adds the synchronous repair because it looks like a gap.
    expect(raw, 'the deletion left no pointer to where the question went')
      .toContain('memory/fts-health.ts');
  });

  it('this module says it owns EVERY repair case, and the both-mechanisms caveat is retired', () => {
    const src = fs.readFileSync(new URL('../fts-health.ts', import.meta.url), 'utf-8');
    // The four repairable states are named together, because the old wording claimed only two.
    expect(src).toMatch(/OWNS EVERY REPAIR CASE/);
    for (const state of ['missing', 'unpopulated', 'stale', 'corrupt']) {
      expect(ftsRepairPlan(state as FtsState), `${state} must still earn a repair`).not.toBe('none');
    }
    // ⚠ THE RETIRED SENTENCE, asserted as ABSENT. It was true while both mechanisms shipped and is a
    // lie now, and a stale caveat in a module header is worse than none: a reader who believes it
    // thinks the count-mismatch case is somebody else's.
    expect(src, 'the "owns only the MISSING and CORRUPT cases" caveat is still here, and it is false now')
      .not.toMatch(/owns outright, today, is[\s\S]{0,60}MISSING and CORRUPT/);
    expect(src, 'the header still says the deletion is a proposal')
      .not.toMatch(/THAT DELETION IS NOT IN THIS LANE'S FENCE/);
  });

  it('a half-indexed database boots WITHOUT being repaired, and the background job then fixes it', async () => {
    // ⚠ THE END-TO-END PROOF, and the instrument is the index itself rather than a stopwatch. A
    // timing assertion on a loaded box is a coin flip; "the index is still broken after the whole
    // migration chain ran" is the same fact on every machine, and it is exactly the claim: boot did
    // not spend its window rebuilding.
    const p = path.join(dbDir, 't98-boot-halfindexed.db');
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}-wal`, { force: true });
    fs.rmSync(`${p}-shm`, { force: true });
    currentPath = p;
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    bootDb = db;
    try {
      // The real schema, from the real migration chain.
      runMigrations();
      // `messages.agent_id` is a real foreign key, so the fixture needs an owner.
      db.prepare(
        "INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Box Under Test', 'idle', '1970-01-01')",
      ).run('agent-fixture');
      const ins = db.prepare(
        `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                               turn_number, provenance, authorized, token_count, created_at)
         VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 10, ?)`);
      db.transaction(() => {
        for (let i = 0; i < ROWS; i += 1) {
          ins.run(`t98-m-${i}`, 'agent-fixture', `generated fixture line ${i}`, 1_700_000_000_000 + i);
        }
      })();
      const indexed = (): number =>
        (db.prepare('SELECT COUNT(*) AS n FROM messages_fts_docsize').get() as { n: number }).n;
      const total = (): number =>
        (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
      expect(indexed()).toBe(total());

      // Break it the way a half-finished reindex breaks it: delete the newest half of the index.
      db.exec(`DELETE FROM messages_fts WHERE rowid > ${ROWS / 2}`);
      const broken = indexed();
      expect(broken, 'the fixture did not actually break the index').toBeLessThan(total());

      // ⚠ BOOT AGAIN. Pre-fix this call ran fts5's `'rebuild'` in autocommit and the index came back
      // whole — on the thread about to serve HTTP, which on a 729 MB database is minutes.
      runMigrations();
      expect(indexed(), 'the migration runner repaired the index at boot again — the region is back')
        .toBe(broken);

      // …and the background job, which is where that work lives now, repairs it.
      const health = await probeFtsHealth(async (sql, params = []) => db.prepare(sql).all(...params));
      expect(health.state).toBe('unpopulated');
      const out = await checkFtsHealthAndRepair({
        run: async (sql, params = []) => db.prepare(sql).all(...params),
        repair: (plan) => runFtsRepair(plan, { dbPath: p, deadlineMs: 60_000 }),
      });
      expect(out.plan).toBe('rebuild');
      expect(out.result?.ok, `the background repair failed: ${out.result?.error}`).toBe(true);
      expect(indexed()).toBe(total());
      // And the index actually answers for a row it could not find a moment ago.
      const hit = db.prepare(
        `SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`,
      ).get(`line`) as { n: number };
      expect(hit.n).toBeGreaterThan(0);
    } finally {
      bootDb = null;
      db.close();
      currentPath = ':memory:';
      fs.rmSync(p, { force: true });
      fs.rmSync(`${p}-wal`, { force: true });
      fs.rmSync(`${p}-shm`, { force: true });
    }
  }, 180_000);
});
