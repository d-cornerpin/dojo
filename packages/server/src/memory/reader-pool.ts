// Text search runs on a worker thread so a slow read cannot pin the serving thread, which also receives HTTP
// and the stop request (an abort signal cannot preempt a synchronous C++ call). A stop discards the pending
// entry; a deadline overrun terminates the worker, the only way to stop work inside synchronous C++.
// The worker body is an inline source string because a worker does not inherit the parent's loader (tsx,
// node dist, vitest), so it cannot import repo modules and receives SQL and parameters instead.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import { getDbPath } from '../db/connection.js';

const logger = createLogger('reader-pool');

/** Per query; past it the worker is terminated. Far above any bounded chunk: reaching it means a bound failed. */
export const READER_DEADLINE_MS = 15_000;

interface Pending {
  readonly resolve: (rows: unknown[]) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly label: string;
  /** The worker this query waits on, so a deadline kill fails only its own queries (`failPendingFor`). */
  readonly worker: Worker;
}

/** `readonly: true` is what makes a second connection sound: a reader cannot corrupt, cannot block a writer
 *  under WAL, and cannot be blamed for a lock. */
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
/** True once a worker has answered anything. An error before that is a broken worker. */
let sawFirstReply = false;

/** Resolved on the main thread: an eval worker's bare require resolves from process.cwd() and can miss it. */
function betterSqliteModulePath(): string {
  return createRequire(import.meta.url).resolve('better-sqlite3');
}

/** Latched, not retried: every failure that reaches here would recur on respawn, and retrying would turn one
 *  broken worker into a per-query rejection storm. Callers fall back to the serving thread. */
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
        // Latch shut so `readerPoolAvailable()` turns false and callers really take the serving-thread path.
        logger.warn('reader worker could not open the database read-only — searches stay on the serving thread', {
          error: msg.error,
        });
        failPool(new Error(`reader database could not be opened: ${msg.error ?? 'unknown'}`), w);
        return;
      }
      sawFirstReply = true;
      const p = pending.get(msg.id);
      // No entry means the caller aborted: a late answer resolves nothing.
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.rows ?? []);
    });
    // Every handler is scoped to THIS worker: `terminate()` resolves before `exit` arrives, by which time a
    // replacement may hold queued queries that failing all pending would reject.
    w.on('error', (err) => {
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
      if (worker === w) {
        failAllPending(new Error('reader worker exited'));
        worker = null;
      }
    });
    return w;
  } catch (err) {
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

/** Fail exactly the queries bound to one worker, leaving its replacement's callers alone. */
function failPendingFor(w: Worker, err: Error): void {
  for (const [id, p] of [...pending.entries()]) {
    if (p.worker !== w) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(err);
  }
}

/** False means the caller runs its query itself on the serving thread. */
export function readerPoolAvailable(): boolean {
  if (spawnFailed || closed) return false;
  // A second connection cannot reach ':memory:' (every db-mocking test); it would read an empty database.
  if (getDbPath() === ':memory:') return false;
  if (!worker) worker = spawn();
  return worker !== null;
}

/** A whole-pool terminate latches closed until `warmReaderPool`, so the next search does not respawn the
 *  thread a shutdown killed; the deadline kill in `readerQuery` does not latch. */
let closed = false;

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
    const onAbort = (): void => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      reject(new Error('aborted'));
    };
    // `{ once: true }` only removes the listener after it FIRES, so the wrapped resolve/reject strip it
    // first, exactly once on whichever way the query ends (a parked listener leaks and Node warns past 10).
    const cleanup = (): void => opts.signal?.removeEventListener('abort', onAbort);
    const finishResolve = (rows: T[]): void => { cleanup(); resolve(rows); };
    const finishReject = (err: unknown): void => { cleanup(); reject(err); };

    const timer = setTimeout(() => {
      pending.delete(id);
      logger.warn('reader query exceeded its deadline — terminating the reader worker', {
        label, deadlineMs,
      });
      // Drop the pool's reference FIRST, so this worker's `exit` event finds `worker !== w` and cannot
      // reject the queries that follow it onto the replacement.
      if (worker === w) worker = null;
      void w.terminate();
      finishReject(new Error(`reader query '${label}' exceeded ${deadlineMs}ms and the worker was terminated`));
      // The dying worker's other queries will never be answered; scoped to `w`, so the replacement's are untouched.
      failPendingFor(w, new Error(`reader worker was terminated while '${label}' overran its deadline`));
    }, deadlineMs);
    timer.unref?.();

    pending.set(id, {
      label,
      timer,
      worker: w,
      resolve: (rows) => finishResolve(rows as T[]),
      reject: finishReject,
    });

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      w.postMessage({ id, sql, params: [...params] });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      finishReject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

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

/** Spawn the worker now and prove it answers, so no one's first search pays the one-time spawn cost. */
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
