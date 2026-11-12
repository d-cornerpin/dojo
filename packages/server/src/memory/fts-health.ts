// Boot-time check of the `messages_fts` index: probe it, repair a broken one on a background worker.
// This module owns every repair case; `db/migrations.ts` must never run an fts5 'rebuild' (it blocks boot).
// The repair is a write, so it runs on its own short-lived worker with a writable connection (inline source,
// as in `reader-pool.ts`) and holds the write lock for the rebuild while the event loop keeps serving.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import { getDb, getDbPath } from '../db/connection.js';
import { readerPoolAvailable, readerQuery } from './reader-pool.js';

const logger = createLogger('fts-health');

export const FTS_HEALTH_DELAY_MS = 45_000;

export const FTS_REPAIR_DEADLINE_MS = 10 * 60_000;

/** The index's declaration; the migration `129b_stable_merge_messages.sql` owns it and a test compares
 *  this copy to it. `seq AS rowid` replaces a bare `rowid`, which the lane-readers guard refuses. */
export const FTS_RECREATE_SQL = [
  'DROP TABLE IF EXISTS messages_fts;',
  "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');",
  'INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages;',
].join('\n');

// The same statements as `FTS_RECREATE_SQL`, split so the worker can chunk the populate; change both.
export const FTS_DROP_SQL = 'DROP TABLE IF EXISTS messages_fts;';
export const FTS_CREATE_SQL =
  "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');";
export const FTS_POPULATE_CHUNK_SQL =
  'INSERT INTO messages_fts(rowid, content) SELECT seq AS rowid, content FROM messages'
  + ' WHERE seq > ? AND seq <= ?;';

export const FTS_DELETE_ALL_SQL = `INSERT INTO messages_fts(messages_fts) VALUES('delete-all');`;

/** What a rebuild means. The worker never runs it: one native call cannot stop, so SIGTERM would hang. */
export const FTS_REBUILD_SQL = `INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`;

/** A shutdown budget, not a throughput knob: exit can happen only between chunks, so keep a chunk short. */
export const FTS_POPULATE_CHUNK_ROWS = 5_000;

/** Grace for a stopped repair to reach its next chunk boundary: above one chunk, under launchd's timeout. */
export const FTS_STOP_GRACE_MS = 2_000;

export type FtsState =
  | 'healthy'
  | 'missing'
  | 'unpopulated'
  | 'stale'
  | 'corrupt'
  | 'unknown';

export interface FtsHealth {
  readonly state: FtsState;
  readonly indexedRows: number | null;
  readonly tableRows: number | null;
  /** One short sentence for the log: counts and state names only, never user content. */
  readonly detail: string;
}

export type FtsProbeRun = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

/** The three cheap reads. The MATCH probe uses a no-match token: it walks the index, throwing if broken,
 *  where `integrity-check` would read all of it. */
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
    // `messages_fts_docsize` is counted because the index is external-content: counting `messages_fts`
    // reads through to `messages` and would compare it with itself.
    indexedRows = ((await run('SELECT COUNT(*) AS n FROM messages_fts_docsize'))[0] as { n: number }).n;
    tableRows = ((await run('SELECT COUNT(*) AS n FROM messages'))[0] as { n: number }).n;
  } catch (err) {
    // The shadow tables are part of the index: one that cannot be counted is broken, not unreadable.
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

/** `unknown` repairs nothing: an unreadable probe must never DROP TABLE. */
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
  readonly chunks?: number;
  readonly error?: string;
}

/**
 * The repair program, on its own thread with a writable connection. Chunked and interruptible, because
 * `process.exit()` joins this thread and nothing preempts a native sqlite call. One transaction, so readers
 * never see a present but empty index (it answers `MATCH` with zero rows and skips the LIKE fallback).
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

let liveRepair: Worker | null = null;

/**
 * Ask a running repair to stop; `index.ts` calls this on shutdown. The stop is a request the worker answers
 * between chunks; `terminate()` follows only after `FTS_STOP_GRACE_MS` (unref'd timer) so the check can run.
 * Returns true when there was something to stop.
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
          // The native module's path is resolved here: an eval worker's bare `require` uses `process.cwd()`.
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

async function defaultProbeRun(sql: string, params: readonly unknown[] = []): Promise<unknown[]> {
  if (readerPoolAvailable()) return readerQuery<unknown>('fts_health:probe', sql, params);
  return getDb().prepare(sql).all(...params) as unknown[];
}

let checked = false;

/** Logs in and out at warn or above, never debug (the logger drops it); a healthy index logs nothing. */
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

  // Say what searches do meanwhile, per state: missing and corrupt make `MATCH` throw, so the LIKE
  // fallback runs; unpopulated and stale still answer, only partially.
  const meanwhile = (health.state === 'missing' || health.state === 'corrupt')
    ? 'until it finishes, message search takes the bounded LIKE fallback'
    : 'the index still answers until it finishes, but not for every message — results may be incomplete';
  logger.warn(`the message search index is ${health.state} — rebuilding it in the background; ${meanwhile}`, {
    state: health.state, plan, detail: health.detail,
    indexedRows: health.indexedRows, tableRows: health.tableRows,
  });

  const result = await repair(plan);

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

/** The boot wire: returns immediately and touches no database. All work runs in an unref'd timer after the
 *  server is serving, so a caller cannot block boot. */
export function scheduleFtsHealthCheck(delayMs: number = FTS_HEALTH_DELAY_MS): void {
  if (checked) return;
  checked = true;
  // A worker reaches the database by path, so an in-memory database has no repair to offer.
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

export function resetFtsHealthForTest(): void {
  checked = false;
}
