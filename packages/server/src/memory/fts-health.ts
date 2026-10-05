// ════════════════════════════════════════════════════════════════════════════════════════
// FTS HEALTH AT BOOT (t89 deliverable 3) — a long-lived database must not search by LIKE for ever.
//
// ⚠ THE DEFECT, in the brief's own words: "A DB born before the `messages_fts` migration (or with a
// broken FTS table) silently LIKE-scans FOREVER — the fallback is a warn nobody sees." Deliverable 2
// made that fallback BOUNDED and LOUD, so the degradation is now visible and finite. This file is the
// other half: notice the broken index and fix it, rather than complaining about it on every search for
// the rest of the database's life.
//
// ── WHAT WAS ALREADY THERE, AND WHY IT IS NOT ENOUGH (read this before deleting anything) ──
// `db/migrations.ts` carries a post-migration region (PHASE-1 T7) that compares
// `messages_fts_docsize` against `messages` and repairs a mismatch with fts5's `'rebuild'`. That check
// is RIGHT about the question it asks — it replaced an earlier probe that compared `messages` against
// itself and whose repair structurally could not fire — and three things about it are the reason this
// module exists:
//
//   1. IT IS BOOT-BLOCKING. It runs at `index.ts:390`, hundreds of lines before the port bind, and
//      `'rebuild'` on a 729 MB database is minutes of synchronous C++ on the thread that will serve
//      HTTP. The brief's requirement is explicit — "rebuild it as a BACKGROUND job (never
//      boot-blocking)" — and a box whose index is broken is exactly the box that cannot afford to
//      spend its whole boot window rebuilding before it answers anything.
//   2. IT CANNOT SEE A MISSING TABLE. With no `messages_fts`, `COUNT(*) FROM messages_fts_docsize`
//      THROWS, the catch logs, and nothing is repaired — the precise case the brief names.
//   3. IT CANNOT SEE A CORRUPT ONE. Counts agreeing says the row COUNT is right; it says nothing
//      about whether `MATCH` works. A corrupt index with the right number of rows reads healthy and
//      searches by LIKE for ever.
//
// So this module owns the question, and the boot-blocking region in `db/migrations.ts` should be
// deleted in favour of it. ⚠ THAT DELETION IS NOT IN THIS LANE'S FENCE and is handed up as a proposed
// diff rather than taken. UNTIL IT LANDS BOTH MECHANISMS SHIP, and the honest consequence is stated
// here rather than discovered later: migrations repairs the COUNT-MISMATCH case synchronously first,
// so this module finds it already healthy and does nothing. What this module owns outright, today, is
// the MISSING and CORRUPT cases — which the migrations region cannot reach at all.
//
// ── WHERE THE WORK RUNS ──
// Detection is three cheap reads and they go through the READER POOL when it is up, for the same
// reason every other read in this package does. The REPAIR is a WRITE, so it cannot use the
// read-only pool: it gets its own short-lived worker with a writable connection, by the same inline-
// source argument `reader-pool.ts` makes at length (a worker FILE has to resolve as `.ts` under
// `tsx watch`, `.js` under `node dist/`, and under vitest's loader — three answers, in a fresh
// context that does not inherit the parent's loader).
//
// ⚠ AND THE COST OF THE REPAIR, STATED RATHER THAN HIDDEN: an fts5 rebuild is one large write
// transaction, so while it runs the platform's own writers wait on the write lock (`busy_timeout`,
// generously set in the worker). That is real, it is bounded by the rebuild's duration, it is paid
// ONCE per box, and it does not touch the event loop — the server keeps answering throughout. The
// alternative is a database that LIKE-scans for the rest of its life, which is what produced this
// package.
// ════════════════════════════════════════════════════════════════════════════════════════

import { Worker } from 'node:worker_threads';
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
 */
export const FTS_RECREATE_SQL = [
  'DROP TABLE IF EXISTS messages_fts;',
  "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');",
  'INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages;',
].join('\n');

/** fts5's own repair command, for an index that exists but does not answer for its rows. */
export const FTS_REBUILD_SQL = `INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`;

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
  readonly error?: string;
}

/** The repair's whole program, on its own thread with its own WRITABLE connection. */
const REPAIR_WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require('better-sqlite3');
  const started = Date.now();
  try {
    const db = new Database(workerData.dbPath, { fileMustExist: true });
    // Generous, because this thread WAITS for the write lock rather than failing the repair: the
    // platform is serving throughout and its writers come and go.
    db.pragma('busy_timeout = 60000');
    db.exec(workerData.sql);
    const indexed = db.prepare('SELECT COUNT(*) AS n FROM messages_fts_docsize').get().n;
    const rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    db.close();
    parentPort.postMessage({ ok: indexed === rows, ms: Date.now() - started, indexedRows: indexed, tableRows: rows });
  } catch (err) {
    parentPort.postMessage({ ok: false, ms: Date.now() - started, indexedRows: null, tableRows: null, error: String(err && err.message || err) });
  }
`;

/**
 * Run one repair on a short-lived worker. Resolves with what the index looked like afterwards, so the
 * caller logs a MEASURED outcome rather than "we ran something".
 */
export function runFtsRepair(
  plan: Exclude<FtsRepairPlan, 'none'>,
  opts: { dbPath?: string; deadlineMs?: number } = {},
): Promise<FtsRepairResult> {
  const dbPath = opts.dbPath ?? getDbPath();
  const deadlineMs = opts.deadlineMs ?? FTS_REPAIR_DEADLINE_MS;
  const sql = plan === 'recreate' ? FTS_RECREATE_SQL : FTS_REBUILD_SQL;
  return new Promise<FtsRepairResult>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(REPAIR_WORKER_SOURCE, { eval: true, workerData: { dbPath, sql } });
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
  logger.warn(`the message search index is ${health.state} — rebuilding it in the background; until it finishes, message search takes the bounded LIKE fallback`, {
    state: health.state, plan, detail: health.detail,
    indexedRows: health.indexedRows, tableRows: health.tableRows,
  });

  const result = await repair(plan);

  // TRANSITION OUT, with the measurement.
  if (result.ok) {
    logger.info('the message search index was rebuilt in the background; message search is back on the index', {
      state: health.state, plan, ms: result.ms,
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
