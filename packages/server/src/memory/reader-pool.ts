// ════════════════════════════════════════════════════════════════════════════════════════
// THE READER OFFLOAD — text search runs on a worker thread, so a slow read cannot deafen the server.
//
// ⚠ WHAT THIS IS FOR, in the measurement that produced it: 4,693 of 7,487 main-thread profiler samples
// inside ONE `Statement::JS_all`, on the thread that serves HTTP, with the box DEAF to a health probe
// for 43 seconds. Bounding the queries (deliverable 2) turned an unbounded pin into a short one; this
// takes the pin off the serving thread altogether. ⚠ AND IT IS WHY THE STOP BUTTON WAS DEAD on that box:
// an abort signal cannot preempt a synchronous C++ call, and while the scan ran the server could not even
// RECEIVE the stop request. Off-thread, a stop is real for the first time — see `discard`.
//
// ── FIVE SENTENCES OF DESIGN, WHICH IS ALL IT IS ──
// One long-lived worker holds its own `better-sqlite3` connection opened READ-ONLY against the same file,
// which WAL makes safe for concurrent readers. The main thread posts `{ id, sql, params }` and keeps a
// `Map<id, pending>`; the worker replies `{ id, rows }` or `{ id, error }` and the pool resolves by id —
// that is the entire protocol, with no job-queue framework (the brief's YAGNI line). A stop becomes real
// by DISCARDING: the map entry is deleted, so a late reply resolves nothing and the caller is already
// gone. An overrun past a hard deadline TERMINATES the worker and respawns it, because terminate is the
// only thing that can stop work already inside synchronous C++. The chunked bounds from deliverable 2
// stay on the main thread and send one message per chunk, so the loop breathes between chunks for free.
//
// ⚠ THE WORKER'S BODY IS AN INLINE SOURCE STRING, AND THAT IS A DELIBERATE CHOICE RATHER THAN A SHORTCUT.
// A separate worker FILE has to resolve as `.ts` under `tsx watch` in dev, as `.js` under
// `node dist/index.js` in prod, and under vitest's loader in tests — three different answers, and a
// worker is spawned in a fresh Node context that does NOT inherit the parent's loader. Every workaround
// for that (execArgv propagation, conditional path probing, a build step that copies the file) is
// machinery that can break in one environment and not another, which is exactly the kind of difference
// that ships broken. An inline string has no path to resolve: it runs identically in all three. The cost
// is that the worker cannot import this repo's modules — so it receives SQL and parameters rather than
// calling our query builders, which keeps its body to the twenty lines below.
// ════════════════════════════════════════════════════════════════════════════════════════

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import { getDbPath } from '../db/connection.js';

const logger = createLogger('reader-pool');

/**
 * The hard deadline for ONE query on the worker. Past it the worker is terminated, because a request
 * that has not answered in this long is inside a scan nothing can interrupt politely.
 *
 * 15 seconds is far above any bounded search (deliverable 2's budgets make a chunk a fraction of a
 * second) and far below the 43-second windows that produced this package. A deadline nobody reaches is
 * the goal; reaching it means a bound failed, and the log says so.
 */
export const READER_DEADLINE_MS = 15_000;

interface Pending {
  readonly resolve: (rows: unknown[]) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly label: string;
  /** ⚠ WHICH WORKER THIS QUERY IS WAITING ON (I7). The deadline path kills a worker and used to
   *  leave its OTHER in-flight queries waiting out their own full 15 seconds against a dead thread,
   *  because it nulled `worker` before `terminate()` and the exit handler's `worker === w` guard
   *  then skipped them. The fix for one orphaning bug created its twin; this field closes both. */
  readonly worker: Worker;
}

/**
 * The worker's whole program. Opens the database read-only and answers one message with one result set.
 * ⚠ `readonly: true` is the safety property that makes a second connection sound: a reader cannot
 * corrupt, cannot block a writer under WAL, and cannot be blamed for a lock.
 */
const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  // ⚠ AN ABSOLUTE PATH, RESOLVED ON THE MAIN THREAD (I3). An eval worker has no file of its own, so
  // its bare \`require('better-sqlite3')\` resolves from process.cwd() — which is the platform
  // directory in production and verified to be \`Cannot find module\` from, say, \`/\`. The parent
  // knows exactly where the module is; passing the path removes the question entirely.
  const Database = require(workerData.betterSqlitePath);
  let db;
  try {
    db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    parentPort.postMessage({ id: '__open_failed__', error: String(err && err.message || err) });
  }
  parentPort.on('message', (req) => {
    if (!db) { parentPort.postMessage({ id: req.id, error: 'reader database is not open' }); return; }
    try {
      const rows = db.prepare(req.sql).all(...(req.params || []));
      parentPort.postMessage({ id: req.id, rows });
    } catch (err) {
      parentPort.postMessage({ id: req.id, error: String(err && err.message || err) });
    }
  });
`;

let worker: Worker | null = null;
let pending = new Map<string, Pending>();
let nextId = 0;
let spawnFailed = false;
/** True once a worker has answered anything. An error before that is a broken worker (I3). */
let sawFirstReply = false;

/** Where `better-sqlite3` actually lives, asked on the MAIN thread where the answer is knowable. */
function betterSqliteModulePath(): string {
  return createRequire(import.meta.url).resolve('better-sqlite3');
}

/**
 * The pool is shut and callers go back to the serving thread (I3).
 *
 * ⚠ LATCHED, not "retried next time": every failure that reaches here is one a respawn would
 * reproduce — the database cannot be opened read-only, the native module cannot be found, the thread
 * cannot start. Retrying each of those once per search turns one broken instrument into a per-query
 * rejection storm while the sync path that works sits unused.
 */
function failPool(err: Error, w: Worker): void {
  spawnFailed = true;
  if (worker === w) worker = null;
  failAllPending(err);
  void w.terminate();
}

function spawn(): Worker | null {
  if (spawnFailed) return null;
  try {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath: getDbPath(), betterSqlitePath: betterSqliteModulePath() },
    });
    w.unref();                       // an instrument must never be why a process refuses to exit
    w.on('message', (msg: { id: string; rows?: unknown[]; error?: string }) => {
      if (msg.id === '__open_failed__') {
        // ⚠ LATCH IT (I3). This line used to SAY "searches stay on the serving thread" and then not
        // arrange it: `readerPoolAvailable()` kept answering true, every `readerQuery` rejected, the
        // FTS arm's catch fell to the LIKE arm which rejected too, and `history_search` ERRORED.
        // The sync path was never taken. A log line that describes a fallback must be the line that
        // engages it.
        logger.warn('reader worker could not open the database read-only — searches stay on the serving thread', {
          error: msg.error,
        });
        failPool(new Error(`reader database could not be opened: ${msg.error ?? 'unknown'}`), w);
        return;
      }
      sawFirstReply = true;
      const p = pending.get(msg.id);
      // ⚠ NO ENTRY MEANS DISCARDED: the caller aborted, and a late answer resolves nothing. This is the
      // whole of "a stop can genuinely cancel" — the work may still be running, but nobody is waiting.
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.rows ?? []);
    });
    // ⚠ EVERY HANDLER IS SCOPED TO *THIS* WORKER, and a failing clause is what taught me to write it
    // that way. `terminate()` resolves before the thread's `exit` event arrives, so by the time the
    // event lands the pool has already spawned a replacement and the caller after the overrun has
    // already queued a request against it. My first version failed ALL pending on any exit — so the
    // deliberate kill of a timed-out worker rejected the NEXT, innocent query with "reader worker
    // exited". In production that is a terminate taking an unrelated in-flight search down with it.
    w.on('error', (err) => {
      // ⚠ AN ERROR BEFORE THE FIRST SUCCESSFUL REPLY IS A BROKEN WORKER, NOT A HICCUP (I3) — a
      // missing native module, a bad path, a thread that cannot start. Respawning it on the next
      // query re-runs the same failure, so the pool latches shut and callers take the sync path,
      // which is what the warn claimed all along. An error AFTER a worker has answered once is the
      // measured self-healing case and keeps its old behaviour: replaced on the next query.
      if (!sawFirstReply) {
        logger.warn('reader worker failed before it ever answered — searches stay on the serving thread', {
          error: err.message,
        });
        failPool(new Error(`reader worker error: ${err.message}`), w);
        return;
      }
      logger.warn('reader worker errored; it will be replaced on the next query', { error: err.message });
      if (worker === w) {
        failAllPending(new Error(`reader worker error: ${err.message}`));
        worker = null;
      }
    });
    w.on('exit', () => {
      // Includes the deliberate `terminate()` below. Anything still waiting ON THIS WORKER is told,
      // rather than hanging — and anything waiting on its replacement is left alone.
      if (worker === w) {
        failAllPending(new Error('reader worker exited'));
        worker = null;
      }
    });
    return w;
  } catch (err) {
    // A box where worker threads are unavailable keeps working: callers fall back to the serving thread.
    spawnFailed = true;
    logger.warn('reader worker could not be spawned — searches stay on the serving thread', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function failAllPending(err: Error): void {
  const entries = [...pending.values()];
  pending = new Map();
  for (const p of entries) {
    clearTimeout(p.timer);
    p.reject(err);
  }
}

/** Fail exactly the queries bound to one worker, leaving its replacement's callers alone (I7). */
function failPendingFor(w: Worker, err: Error): void {
  for (const [id, p] of [...pending.entries()]) {
    if (p.worker !== w) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(err);
  }
}

/** True when the offload is available. A caller that gets `false` runs its query itself, as before. */
export function readerPoolAvailable(): boolean {
  if (spawnFailed || closed) return false;
  // A worker reads the database by PATH on its own connection, so a path no second connection can
  // reach — ':memory:' (every db-mocking test, and any future ephemeral mode) — has no pool, honestly:
  // claiming availability there answers every query from a different, empty universe.
  if (getDbPath() === ':memory:') return false;
  if (!worker) worker = spawn();
  return worker !== null;
}

/** A whole-pool terminate is a SHUTDOWN, not a hiccup: it latches closed until warmReaderPool —
 *  otherwise the next search after shutdown would quietly respawn the thread the shutdown killed.
 *  (The DEADLINE kill inside readerQuery deliberately does not latch: one overrun worker is
 *  replaced on the next query; that self-healing is measured and wanted.) */
let closed = false;

/**
 * Run one read on the worker. Rejects on an aborted signal (the result is discarded), on the deadline
 * (the worker is terminated), and on a query error.
 */
export function readerQuery<T>(
  label: string,
  sql: string,
  params: readonly unknown[],
  opts: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<T[]> {
  if (!readerPoolAvailable() || !worker) {
    return Promise.reject(new Error('reader pool unavailable'));
  }
  if (opts.signal?.aborted) return Promise.reject(new Error('aborted before dispatch'));

  const id = `r${nextId += 1}`;
  const deadlineMs = opts.deadlineMs ?? READER_DEADLINE_MS;
  const w = worker;

  return new Promise<T[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      // ⚠ TERMINATE, NOT A POLITE CANCEL. The worker is inside `sqlite3_step`; nothing in JavaScript can
      // ask it to stop. Killing the thread is the only honest way to end an overrun, and the next query
      // spawns a fresh one — which is why the pool holds no state worth preserving.
      pending.delete(id);
      logger.warn('reader query exceeded its deadline — terminating the reader worker', {
        label, deadlineMs,
      });
      // Drop the pool's reference FIRST, so this worker's `exit` event finds `worker !== w` and cannot
      // reject the queries that follow it onto the replacement.
      if (worker === w) worker = null;
      void w.terminate();
      reject(new Error(`reader query '${label}' exceeded ${deadlineMs}ms and the worker was terminated`));
      // ⚠ AND EVERYTHING ELSE THAT WAS WAITING ON *THIS* WORKER (I7). The thread is about to die
      // inside `sqlite3_step`; its siblings will never be answered. Before this they waited out
      // their own 15 seconds and then each logged "terminating the reader worker" at a worker that
      // was already dead. Scoped to `w`, so the replacement's callers are untouched — which is the
      // bug the `worker === w` guard was added to fix, kept.
      failPendingFor(w, new Error(`reader worker was terminated while '${label}' overran its deadline`));
    }, deadlineMs);
    timer.unref?.();

    pending.set(id, {
      label,
      timer,
      worker: w,
      resolve: (rows) => resolve(rows as T[]),
      reject,
    });

    const onAbort = (): void => {
      // Discard: the entry goes, the worker keeps running to completion, and its reply lands on nobody.
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      reject(new Error('aborted'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      w.postMessage({ id, sql, params: [...params] });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** How many replies the pool is still waiting for — the discard clause reads this. */
export function readerPendingCount(): number {
  return pending.size;
}

export async function terminateReaderPool(): Promise<void> {
  closed = true;
  const w = worker;
  worker = null;
  failAllPending(new Error('reader pool terminated'));
  if (w) await w.terminate();
}

/**
 * Spawn the worker now and prove it answers, so a caller's FIRST search does not pay the spawn cost.
 * Measured: a cold first query costs ~10ms of main-thread time (compiling the inline source and opening
 * the connection) against ~0 for every query after it — real, one-time, and worth paying at boot rather
 * than inside somebody's search.
 */
export async function warmReaderPool(): Promise<boolean> {
  closed = false;
  if (!readerPoolAvailable()) return false;
  try {
    await readerQuery('warm', 'SELECT 1 AS ok', [], { deadlineMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget a previous spawn failure so a clause can exercise the real path. */
export function resetReaderPoolForTest(): void {
  spawnFailed = false;
  closed = false;
  sawFirstReply = false;
  worker = null;
  pending = new Map();
}
