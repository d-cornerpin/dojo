// ════════════════════════════════════════════════════════════════════════════════════════
// FTS HEALTH AT BOOT (t89 deliverable 3) — a long-lived database must not search by LIKE for ever.
//
// ⚠ THE DEFECT, in the brief's own words: "A DB born before the `messages_fts` migration (or with a
// broken FTS table) silently LIKE-scans FOREVER — the fallback is a warn nobody sees." Deliverable 2
// made that fallback BOUNDED and LOUD, so the degradation is visible and finite. This file is the
// other half: notice the broken index and fix it, rather than complaining on every search for the
// rest of the database's life.
//
// ── WHAT WAS THERE BEFORE, AND WHY IT HAD TO GO (read this before adding anything back) ──
// `db/migrations.ts` used to carry a post-migration region (PHASE-1 T7) that compared
// `messages_fts_docsize` against `messages` and repaired a mismatch with fts5's `'rebuild'`. It asked
// the RIGHT question — it replaced an earlier probe that compared `messages` against itself and whose
// repair structurally could not fire: measured on a `VACUUM INTO` copy of a lived-in box with ONE row
// genuinely removed from the index, both counts read 3,629, the NOT-IN subquery returned 0 rows, the
// `if` never fired, and the message stayed unsearchable. Three things about the region that replaced
// it are why THIS module exists, and why that region is now DELETED (t98 D3):
//   1. IT WAS BOOT-BLOCKING. It ran inside `runMigrations()`, hundreds of lines before the port bind,
//      and `'rebuild'` on a 729 MB database is minutes of synchronous C++ on the thread that will
//      serve HTTP. The brief is explicit — "rebuild it as a BACKGROUND job (never boot-blocking)" —
//      and a box whose index is broken is exactly the box that cannot afford to spend its whole boot
//      window rebuilding before it answers anything.
//   2. IT COULD NOT SEE A MISSING TABLE. With no `messages_fts`, `COUNT(*) FROM messages_fts_docsize`
//      THROWS, the catch logs, and nothing is repaired — the precise case the brief names.
//   3. IT COULD NOT SEE A CORRUPT ONE. Agreeing counts say the row COUNT is right and say nothing
//      about whether `MATCH` works: a corrupt index with the right number of rows reads healthy and
//      searches by LIKE for ever.
// ⚠ THIS MODULE NOW OWNS EVERY REPAIR CASE — `missing`, `unpopulated`, `stale` and `corrupt` — AND IS
// THE ONLY THING THAT REPAIRS THE INDEX ANYWHERE. While both mechanisms shipped (t89 → t98) migrations
// repaired the COUNT-MISMATCH case synchronously first, so this module found the common case already
// healthy and did nothing: the background job was real and the boot was still blocked. The deletion is
// what makes "never boot-blocking" true of the TREE rather than of one module, and a clause reads
// `db/migrations.ts` with its comments stripped and reds if an fts5 `'rebuild'` ever reappears there.
//
// ── WHERE THE WORK RUNS ──
// Detection is three cheap reads through the READER POOL when it is up, for the same reason every
// other read in this package does. The REPAIR is a WRITE, so it cannot use the read-only pool: it
// gets its own short-lived worker with a writable connection, by the same inline-source argument
// `reader-pool.ts` makes at length (a worker FILE resolves as `.ts` under `tsx watch`, `.js` under
// `node dist/`, and differently again under vitest's loader — in a fresh context that does not
// inherit the parent's).
//
// ⚠ AND THE COST OF THE REPAIR, STATED RATHER THAN HIDDEN: an fts5 rebuild is one large write
// transaction, so while it runs the platform's own writers wait on the write lock (`busy_timeout`,
// generously set in the worker). That is real, it is bounded by the rebuild's duration, it is paid
// ONCE per box, and it does not touch the event loop — the server keeps answering throughout. The
// alternative is a database that LIKE-scans for the rest of its life, which is what produced this
// package.
// ════════════════════════════════════════════════════════════════════════════════════════

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import { getDb, getDbPath } from '../db/connection.js';
import { readerPoolAvailable, readerQuery } from './reader-pool.js';

const logger = createLogger('fts-health');

/**
 * How long after the server is listening the first health check runs.
 *
 * Not zero, and not a number picked for taste: the platform's other post-boot background jobs sit at
 * 60 s (the embedding backfill) and 90 s (the vault re-embed), and this one must not compete with the
 * boot it was moved out of. 45 s puts it after the box has settled and still inside the first minute,
 * so a broken index is found in the same session a user notices slow search rather than the next one.
 */
export const FTS_HEALTH_DELAY_MS = 45_000;

/**
 * The repair's hard deadline. Past it the worker is terminated and the next boot tries again.
 *
 * Ten minutes is deliberately far above the reader pool's 15 s: that deadline guards a SEARCH, which
 * must be fast or it is a defect, while this one guards a once-per-box full reindex of what may be a
 * 729 MB table. A rebuild that has not finished in ten minutes is not slow, it is wedged.
 */
export const FTS_REPAIR_DEADLINE_MS = 10 * 60_000;

/**
 * ⚠ THE INDEX'S DECLARATION, AND IT HAS EXACTLY ONE OWNER — the migration.
 *
 * `missing` is the only state whose repair needs the DDL, because fts5's `'rebuild'` command needs a
 * table to rebuild. Writing the DDL here makes a SECOND spelling of a schema the migrations own, which
 * is the drift class this tree has spent whole tasks removing. It is admitted on one condition, and the
 * condition is enforced rather than promised: a clause reads `db/migrations/129b_stable_merge_messages.sql`
 * and asserts these three statements match the migration's, normalised for whitespace. If the migration
 * ever redeclares the index differently, that clause reds and this string is corrected with it.
 *
 * ⚠ ONE DELIBERATE DIFFERENCE FROM THE MIGRATION'S OWN TEXT, and it is not drift: the populate
 * statement projects `seq AS rowid` where the migration writes a bare `rowid`. Same value — PHASE-1
 * T10 made `seq` the table's rowid alias (`INTEGER PRIMARY KEY AUTOINCREMENT`) — and the INSERT binds
 * positionally, so nothing about the repair changes. What changes is that a bare `rowid` projection
 * over `messages` is refused in TypeScript by T10's own reader guard (`memory/__tests__/lane-readers`),
 * because SQLite names that result column `seq` and a JavaScript `row.rowid` read then returns
 * `undefined` WITHOUT THROWING. The guard does not care that this particular projection is never read
 * from JavaScript, and it is right not to: the rule earns its value by having no exceptions. The clause
 * normalises this one substitution by name before comparing, so the comparison stays byte-level.
 */
export const FTS_RECREATE_SQL = [
  'DROP TABLE IF EXISTS messages_fts;',
  "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');",
  'INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages;',
].join('\n');

/** The same three statements, separately, because the repair now DRIVES them (I1/I8) rather than
 *  handing the lot to `db.exec`: the populate runs in interruptible chunks and the whole sequence
 *  runs inside one transaction. `FTS_RECREATE_SQL` above stays as the one-owner declaration the
 *  migration clause compares against — these are the same strings, split at the semicolons. */
export const FTS_DROP_SQL = 'DROP TABLE IF EXISTS messages_fts;';
export const FTS_CREATE_SQL =
  "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');";
/** One chunk of the populate, by insertion-key range. `seq AS rowid` for T10's reader guard. */
export const FTS_POPULATE_CHUNK_SQL =
  'INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages'
  + ' WHERE seq > ? AND seq <= ?;';

/** fts5's own emptying command — the first half of a chunked `rebuild` (I1). */
export const FTS_DELETE_ALL_SQL = `INSERT INTO messages_fts(messages_fts) VALUES('delete-all');`;

/** fts5's own repair command. Kept as the declaration of what a rebuild MEANS; the worker reaches the
 *  same end state through `delete-all` plus the chunked populate, because the single command is one
 *  uninterruptible native call and a SIGTERM during it hangs the process (I1). */
export const FTS_REBUILD_SQL = `INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`;

/**
 * How many rows one populate chunk indexes.
 *
 * ⚠ THIS NUMBER IS A SHUTDOWN BUDGET, not a throughput knob. The process can only exit between
 * chunks — nothing in JavaScript preempts a native sqlite call — so the chunk size IS the worst-case
 * delay a SIGTERM can meet. 5,000 wide rows is a fraction of a second; the whole 123,000-row repair
 * the brief's box needed is ~25 chunks. Measured consequence of getting this wrong: a single-statement
 * rebuild on a 729 MB table is minutes, and launchd SIGKILLs at its `ExitTimeOut` (20 s by default).
 */
export const FTS_POPULATE_CHUNK_ROWS = 5_000;

/**
 * How long a stopped repair gets to reach its next chunk boundary and roll back cleanly.
 *
 * It is a CHUNK's worth of time plus slack, not a guess: the worker only checks the stop flag between
 * statements, so this must outlast one chunk or the backstop kill makes the boundary check pointless.
 * Two seconds is far above a 5,000-row insert and far below launchd's 20-second `ExitTimeOut`, which
 * is the deadline the whole of I1 is measured against.
 */
export const FTS_STOP_GRACE_MS = 2_000;

export type FtsState =
  /** The index exists, covers exactly the table's rows, and answers a MATCH. Nothing to do. */
  | 'healthy'
  /** No `messages_fts` at all — a database whose index migration never landed, or was dropped. */
  | 'missing'
  /** The index holds FEWER rows than the table: rows the agent owns that it can no longer find. */
  | 'unpopulated'
  /** The index holds MORE rows than the table. Measured on a lived-in box at 809 stale rows (129b). */
  | 'stale'
  /** The counts agree and `MATCH` fails anyway — the state a count comparison cannot see. */
  | 'corrupt'
  /** The probe itself could not run. Never repaired: an unreadable database is not a broken index. */
  | 'unknown';

export interface FtsHealth {
  readonly state: FtsState;
  /** Rows actually in the index (`messages_fts_docsize`), or null when it could not be read. */
  readonly indexedRows: number | null;
  readonly tableRows: number | null;
  /** One short sentence for the log. Never carries user content — counts and state names only. */
  readonly detail: string;
}

/** What a probe needs: run a statement, get rows back. Injected so the probe is pure and testable,
 *  and so production can route it through the reader pool without this function knowing. */
export type FtsProbeRun = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

/**
 * The three cheap reads, in the order that makes each one's failure mean something.
 *
 * ⚠ THE MATCH PROBE IS CHEAP ON PURPOSE AND ITS LIMIT IS STATED: fts5 offers a full
 * `'integrity-check'`, which reads the entire index — the very shape this package exists to keep off a
 * serving box. So the probe runs one `MATCH` for a token that matches nothing, which still forces fts5
 * to open and walk the index structure and therefore still throws on a broken one. It can miss
 * corruption confined to a page the probe never reads. That is a smaller hole than a minutes-long
 * check nobody dares run, and the bounded LIKE fallback is what covers the remainder.
 */
export async function probeFtsHealth(run: FtsProbeRun): Promise<FtsHealth> {
  let present: unknown[];
  try {
    present = await run(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`,
    );
  } catch (err) {
    return {
      state: 'unknown', indexedRows: null, tableRows: null,
      detail: `the index could not be probed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (present.length === 0) {
    return {
      state: 'missing', indexedRows: null, tableRows: null,
      detail: 'there is no messages_fts table, so every message search falls back to a LIKE walk',
    };
  }

  let indexedRows: number;
  let tableRows: number;
  try {
    // ⚠ `messages_fts_docsize` IS THE RIGHT TABLE and not an implementation detail leaking: the index
    // is EXTERNAL-CONTENT (`content='messages'`), so a plain SELECT from `messages_fts` reads THROUGH
    // to the content table and counting it compares `messages` with itself. The shadow table's count
    // is the number of rows actually indexed, which is the question. (PHASE-1 T7 learned this the
    // expensive way: the probe it replaced repaired nothing for months.)
    indexedRows = ((await run('SELECT COUNT(*) AS n FROM messages_fts_docsize'))[0] as { n: number }).n;
    tableRows = ((await run('SELECT COUNT(*) AS n FROM messages'))[0] as { n: number }).n;
  } catch (err) {
    // The shadow tables are PART of the index. One that cannot be counted is broken, not unreadable.
    return {
      state: 'corrupt', indexedRows: null, tableRows: null,
      detail: `the index's own shadow table could not be counted: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (indexedRows < tableRows) {
    return {
      state: 'unpopulated', indexedRows, tableRows,
      detail: `${tableRows - indexedRows} message(s) are in the table and not in the index, so they cannot be found by search`,
    };
  }
  if (indexedRows > tableRows) {
    return {
      state: 'stale', indexedRows, tableRows,
      detail: `${indexedRows - tableRows} index entr(ies) have no row behind them, so search can return hits that resolve to nothing`,
    };
  }

  try {
    // A token that matches nothing, so the probe costs an index open and not a result set. No user
    // text reaches this query by construction — the token is a literal in this file.
    await run(`SELECT rowid AS rid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1`, ['zzqxhealthprobe']);
  } catch (err) {
    return {
      state: 'corrupt', indexedRows, tableRows,
      detail: `the index holds the right number of rows and still refuses a MATCH: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    state: 'healthy', indexedRows, tableRows,
    detail: `the index covers all ${tableRows} message(s) and answers a MATCH`,
  };
}

export type FtsRepairPlan = 'none' | 'rebuild' | 'recreate';

/**
 * The repair a state earns. Pure, so the policy is testable without a database.
 *
 * `unknown` repairs NOTHING, and that is the load-bearing line: a probe that could not read must not
 * trigger a DROP TABLE. The failure direction of a wrong guess here is destroying a working index.
 */
export function ftsRepairPlan(state: FtsState): FtsRepairPlan {
  if (state === 'missing') return 'recreate';
  if (state === 'unpopulated' || state === 'stale' || state === 'corrupt') return 'rebuild';
  return 'none';
}

export interface FtsRepairResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly indexedRows: number | null;
  readonly tableRows: number | null;
  /** How many populate chunks ran — the number that makes "interruptible" checkable (I1). */
  readonly chunks?: number;
  readonly error?: string;
}

/**
 * The repair's whole program, on its own thread with its own WRITABLE connection.
 *
 * ⚠ CHUNKED AND INTERRUPTIBLE (I1), because `process.exit()` JOINS this thread. Measured: an
 * `unref()`'d eval worker inside a 4.65 s sqlite statement, with `process.exit(0)` requested at
 * +404 ms, exited at 5,630 ms wall — `unref` lets the loop drain, it does not make exit skip the
 * join, and neither `terminate()` nor anything else in JavaScript preempts `sqlite3_step`. A
 * single-statement rebuild on a 729 MB table is MINUTES, so a SIGTERM during the once-per-box repair
 * hung until launchd's `ExitTimeOut` SIGKILLed it, the transaction rolled back, and the next boot
 * redid the whole thing. So the populate is a loop of bounded statements and a stop is checked
 * between them; the worst-case exit delay is now one chunk.
 *
 * ⚠ AND IT IS ONE TRANSACTION (I8). `DROP; CREATE; INSERT` in autocommit left `messages_fts`
 * PRESENT AND EMPTY for the whole populate — minutes on a large table — during which `MATCH`
 * succeeded with zero rows, nothing threw, the LIKE fallback was therefore NOT taken, and every
 * `history_search` returned "No results" while looking perfectly healthy. Readers must see the old
 * index or the new one, never an empty one. SQLite permits `CREATE VIRTUAL TABLE` inside a
 * transaction; the rule that forbids a rebuild inside one belongs to the migration RUNNER, not to
 * SQLite, and this does not run in a migration.
 */
const REPAIR_WORKER_SOURCE = `
  const { parentPort, workerData, receiveMessageOnPort } = require('node:worker_threads');
  const Database = require(workerData.betterSqlitePath);
  const started = Date.now();
  // ⚠ THE STOP IS POLLED, NOT DELIVERED BY A LISTENER, AND THAT IS NOT A STYLE CHOICE.
  // The populate loop below is SYNCHRONOUS — it has to be, it is a run of prepared statements inside
  // one transaction — so this thread's event loop never gets a turn while it runs and a
  // \`parentPort.on('message')\` handler CANNOT FIRE. My first cut used one, and the flag the
  // boundary check reads could never change: the only thing that ever ended a cancelled repair was
  // the backstop \`terminate()\`, i.e. the interruptibility this fix exists to add was dead behind
  // its own safety net, and the clause recorded "the repair worker exited without answering".
  // \`receiveMessageOnPort\` drains the port WITHOUT yielding, which is exactly the shape a tight
  // synchronous loop needs. The port must stay paused for it, so no listener is attached.
  const stopRequested = () => {
    for (;;) {
      const m = receiveMessageOnPort(parentPort);
      if (!m) return false;
      if (m.message && m.message.stop) return true;
    }
  };
  try {
    const db = new Database(workerData.dbPath, { fileMustExist: true });
    // Generous, because this thread WAITS for the write lock rather than failing the repair: the
    // platform is serving throughout and its writers come and go.
    db.pragma('busy_timeout = 60000');
    const maxSeq = db.prepare('SELECT MAX(seq) AS r FROM messages').get().r || 0;
    let committed = false;
    // BEGIN IMMEDIATE takes the write lock up front rather than discovering a conflict halfway.
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (workerData.plan === 'recreate') {
        db.exec(workerData.dropSql);
        db.exec(workerData.createSql);
      } else {
        db.exec(workerData.deleteAllSql);
      }
      const populate = db.prepare(workerData.populateSql);
      let from = 0;
      let chunks = 0;
      while (from < maxSeq) {
        if (stopRequested()) throw new Error('the repair was asked to stop at a chunk boundary');
        const to = Math.min(maxSeq, from + workerData.chunkRows);
        populate.run(from, to);
        chunks += 1;
        from = to;
      }
      db.exec('COMMIT;');
      committed = true;
      const indexed = db.prepare('SELECT COUNT(*) AS n FROM messages_fts_docsize').get().n;
      const rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
      db.close();
      parentPort.postMessage({ ok: indexed === rows, ms: Date.now() - started, indexedRows: indexed, tableRows: rows, chunks });
    } finally {
      if (!committed) { try { db.exec('ROLLBACK;'); } catch (e) { /* the transaction is already gone */ }
        try { db.close(); } catch (e) { /* already closed */ } }
    }
  } catch (err) {
    parentPort.postMessage({ ok: false, ms: Date.now() - started, indexedRows: null, tableRows: null, error: String(err && err.message || err) });
  }
`;

/** The repair in flight, if any — so a shutdown can ask it to stop at its next chunk boundary. */
let liveRepair: Worker | null = null;

/**
 * ⚠ ASK A RUNNING REPAIR TO STOP, AND CALL THIS FROM `shutdown` (I1).
 *
 * `process.exit()` joins worker threads, so a repair inside a native statement holds the exit for the
 * length of that statement — measured at 5.2 s for a 4.65 s statement, and a single-statement rebuild
 * on a 729 MB table is minutes. Nothing in JavaScript can preempt `sqlite3_step`, so the only honest
 * answer is a boundary the worker checks, which is why the populate is chunked. The message is a
 * REQUEST and the worker answers it between chunks; `terminate()` is the backstop for a thread that
 * is somehow already past caring.
 *
 * ⚠ THE REQUEST IS NOT FOLLOWED BY AN IMMEDIATE `terminate()`, AND THAT IS THE WHOLE POINT. My first
 * cut posted the stop and killed the thread on the next line; the kill won the race every time, the
 * chunk-boundary check never ran, and the clause recorded "the repair worker exited without
 * answering" — i.e. the mechanism this fix exists to add was dead on arrival behind its own backstop.
 * The worker gets `FTS_STOP_GRACE_MS` to reach its next boundary and unwind its transaction cleanly;
 * `terminate()` is the backstop for a thread that is somehow past caring, on an `unref`'d timer so it
 * is never itself a reason the process stays up.
 *
 * Returns true when there was something to stop — which is the only interesting case to log.
 */
export function stopFtsRepair(): boolean {
  const w = liveRepair;
  if (!w) return false;
  liveRepair = null;
  try { w.postMessage({ stop: true }); } catch { /* the thread is already gone */ }
  const backstop = setTimeout(() => { void w.terminate(); }, FTS_STOP_GRACE_MS);
  backstop.unref?.();
  w.once('exit', () => clearTimeout(backstop));
  return true;
}

/**
 * Run one repair on a short-lived worker. Resolves with what the index looked like afterwards, so the
 * caller logs a MEASURED outcome rather than "we ran something".
 */
export function runFtsRepair(
  plan: Exclude<FtsRepairPlan, 'none'>,
  opts: { dbPath?: string; deadlineMs?: number; chunkRows?: number } = {},
): Promise<FtsRepairResult> {
  const dbPath = opts.dbPath ?? getDbPath();
  const deadlineMs = opts.deadlineMs ?? FTS_REPAIR_DEADLINE_MS;
  return new Promise<FtsRepairResult>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(REPAIR_WORKER_SOURCE, {
        eval: true,
        workerData: {
          dbPath,
          plan,
          // ⚠ THE NATIVE MODULE'S PATH, RESOLVED HERE (I3's lesson, applied to this worker too): an
          // eval worker's bare `require` resolves from `process.cwd()`, which is not a property of
          // this code. The parent knows where the module is.
          betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3'),
          dropSql: FTS_DROP_SQL,
          createSql: FTS_CREATE_SQL,
          deleteAllSql: FTS_DELETE_ALL_SQL,
          populateSql: FTS_POPULATE_CHUNK_SQL,
          chunkRows: opts.chunkRows ?? FTS_POPULATE_CHUNK_ROWS,
        },
      });
      liveRepair = worker;
    } catch (err) {
      resolve({ ok: false, ms: 0, indexedRows: null, tableRows: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    worker.unref();
    let settled = false;
    const finish = (r: FtsRepairResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (liveRepair === worker) liveRepair = null;
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, ms: deadlineMs, indexedRows: null, tableRows: null, error: `the repair exceeded ${deadlineMs}ms and was terminated` });
    }, deadlineMs);
    timer.unref?.();
    worker.on('message', (msg: FtsRepairResult) => finish(msg));
    worker.on('error', (err) => finish({ ok: false, ms: 0, indexedRows: null, tableRows: null, error: err.message }));
    worker.on('exit', () => finish({ ok: false, ms: 0, indexedRows: null, tableRows: null, error: 'the repair worker exited without answering' }));
  });
}

/** Production's probe runner: the reader pool when it is up, the serving connection otherwise. */
async function defaultProbeRun(sql: string, params: readonly unknown[] = []): Promise<unknown[]> {
  if (readerPoolAvailable()) return readerQuery<unknown>('fts_health:probe', sql, params);
  return getDb().prepare(sql).all(...params) as unknown[];
}

let checked = false;

/**
 * ⚠ ONE CHECK PER PROCESS, AND BOTH TRANSITIONS ARE LOGGED. The brief asks for both lines because a
 * repair that starts and never reports is indistinguishable from one that never ran.
 *
 * A healthy index logs NOTHING. Every other state logs on the way in and on the way out, at a level
 * that survives production (`logger.ts` pins `debug` out of existence there, which is how the original
 * silent fallback stayed silent).
 */
export async function checkFtsHealthAndRepair(
  opts: { run?: FtsProbeRun; repair?: typeof runFtsRepair } = {},
): Promise<{ health: FtsHealth; plan: FtsRepairPlan; result: FtsRepairResult | null }> {
  const run = opts.run ?? defaultProbeRun;
  const repair = opts.repair ?? runFtsRepair;
  const health = await probeFtsHealth(run);
  const plan = ftsRepairPlan(health.state);

  if (plan === 'none') {
    if (health.state !== 'healthy') {
      logger.warn(`the message search index is ${health.state} and will NOT be repaired automatically`, {
        state: health.state, detail: health.detail,
        indexedRows: health.indexedRows, tableRows: health.tableRows,
      });
    }
    return { health, plan, result: null };
  }

  // TRANSITION IN. Named with what searches do in the meantime, because that is the question a reader
  // of this line actually has.
  //
  // ⚠ AND THE ANSWER IS NOT THE SAME FOR EVERY STATE (I8). This line used to say "takes the bounded
  // LIKE fallback" unconditionally, which is true only when the index cannot answer at all:
  //   · `missing`  — no table, `MATCH` throws, the fallback IS taken.
  //   · `corrupt`  — `MATCH` throws, the fallback IS taken.
  //   · `unpopulated` / `stale` — the index ANSWERS, just not for every row, and nothing throws, so
  //     `retrieval.ts` never reaches its catch. Search is partial, not fallen back. Saying otherwise
  //     sends a reader of the log looking for warns that will never appear.
  // The honest sentence per state, rather than one sentence that is wrong for half of them.
  const meanwhile = (health.state === 'missing' || health.state === 'corrupt')
    ? 'until it finishes, message search takes the bounded LIKE fallback'
    : 'the index still answers until it finishes, but not for every message — results may be incomplete';
  logger.warn(`the message search index is ${health.state} — rebuilding it in the background; ${meanwhile}`, {
    state: health.state, plan, detail: health.detail,
    indexedRows: health.indexedRows, tableRows: health.tableRows,
  });

  const result = await repair(plan);

  // TRANSITION OUT, with the measurement.
  if (result.ok) {
    logger.info('the message search index was rebuilt in the background; message search is back on the index', {
      state: health.state, plan, ms: result.ms, chunks: result.chunks,
      indexedRows: result.indexedRows, tableRows: result.tableRows,
    });
  } else {
    logger.error('the message search index could NOT be rebuilt; message search stays on the bounded LIKE fallback and this will be retried next boot', {
      state: health.state, plan, ms: result.ms, error: result.error,
    });
  }
  return { health, plan, result };
}

/**
 * ⚠ THE BOOT WIRE, AND THE "NEVER BOOT-BLOCKING" PROPERTY LIVES HERE rather than in the caller — so a
 * clause can prove it. This function returns IMMEDIATELY and touches no database; everything happens
 * inside an `unref`'d timer after the server is already serving. A caller cannot get this wrong by
 * forgetting to defer, because there is nothing to defer at the call site.
 */
export function scheduleFtsHealthCheck(delayMs: number = FTS_HEALTH_DELAY_MS): void {
  if (checked) return;
  checked = true;
  // A worker reads and writes the database BY PATH on its own connection, so a path no second
  // connection can reach has no repair to offer, honestly. Same guard, same reason as the reader pool.
  if (getDbPath() === ':memory:') return;
  const timer = setTimeout(() => {
    void checkFtsHealthAndRepair().catch((err) => {
      logger.warn('the FTS health check failed to run (non-fatal; search keeps its bounded fallback)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, delayMs);
  timer.unref?.();
}

/** Test seam: let a clause run the schedule again. */
export function resetFtsHealthForTest(): void {
  checked = false;
}
