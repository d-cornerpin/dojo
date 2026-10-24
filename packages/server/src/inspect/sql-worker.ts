// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect (fix round 1) — A QUERY RUNS OFF THE ENGINE'S THREAD, AND THE STOP BUTTON ENDS IT.
//
// better-sqlite3 is synchronous: a statement run on the engine's thread freezes every agent,
// the gateway and the engine's own writer until it finishes (the review measured a recursive
// query holding the loop for 6 s, with no way out but a kill). So each `sql` query runs in its
// own worker thread on its own read-only connection, and the engine's thread only waits.
//
// NO DEADLINE, BY THE OWNER'S LAW: the signal that ends a query is the agent's own stop
// (`openAgentCall`), which terminates the thread — the only thing that can end work already
// inside SQLite. A query nobody stops simply finishes, without holding anybody else up.
//
// The worker body is an inline source string for the reason `memory/reader-pool.ts` gives (a
// worker FILE resolves differently under tsx, node and vitest; a string runs the same in all
// three). It is not the shared reader pool on purpose: that pool's stop DISCARDS a query and
// leaves it running on the one worker every history search shares, and it returns rows as
// objects, which lose duplicate column names and the source-column facts redaction needs.
// ════════════════════════════════════════════════════════════════════════════════════════

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { getDbPath } from '../db/connection.js';
import { openAgentCall, STOPPED_BY_USER } from '../agent/abortable-call.js';

/** One output column: its name as written, and the table column it comes from (null for an expression). */
export interface OutColumn { name: string; column: string | null; table: string | null }
export type ReadOutcome = { columns: OutColumn[]; rows: unknown[][] } | { error: string } | { ended: string };

const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require(workerData.betterSqlitePath);
  try {
    if (!/^\\s*(select|with|values|explain)\\b/i.test(workerData.lead)) throw new Error('only a read runs here');
    const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = 1');
    db.pragma('busy_timeout = 2000');
    const stmt = db.prepare(workerData.sql);
    if (!stmt.reader || !stmt.readonly) throw new Error('only a read runs here');
    const columns = stmt.columns().map((c) => ({ name: c.name, column: c.column, table: c.table }));
    const rows = stmt.raw(true).all().map((r) => r.map((v) => (Buffer.isBuffer(v) ? '<blob ' + v.length + ' bytes>' : v)));
    db.close();
    parentPort.postMessage({ columns, rows });
  } catch (err) {
    parentPort.postMessage({ error: String((err && err.message) || err) });
  }
`;

/**
 * Run one already-checked read in a worker. `lead` is the statement with its leading comments
 * removed, which the worker checks again. With an agent id the query rides that agent's stop.
 */
export function readInWorker(sql: string, lead: string, agentId?: string): Promise<ReadOutcome> {
  const slot = agentId === undefined ? null : openAgentCall(agentId, 'turn');
  if (slot?.refused) { slot.release(); return Promise.resolve({ ended: STOPPED_BY_USER }); }
  return new Promise<ReadOutcome>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sql, lead, dbPath: getDbPath(), betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3') },
    });
    const finish = (out: ReadOutcome): void => {
      if (settled) return;
      settled = true;
      slot?.signal.removeEventListener('abort', onAbort);
      slot?.release();
      resolve(out);
    };
    const onAbort = (): void => {
      void worker.terminate();
      finish({ ended: slot?.cutByStop() ? STOPPED_BY_USER : `The query was ended before it finished (${slot?.cutBy() ?? 'the turn ended'}).` });
    };
    slot?.signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: ReadOutcome) => { finish(msg); void worker.terminate(); });
    worker.once('error', (err) => finish({ error: err.message }));
    worker.once('exit', () => finish({ error: "the query's worker ended without an answer" }));
  });
}
