// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect (fix round 2) — A QUERY RUNS IN ITS OWN PROCESS, AND THE STOP BUTTON KILLS IT.
//
// better-sqlite3 is synchronous. On the engine's thread a long query froze the platform; in a
// worker THREAD the platform stayed live, but a stop could not end the query: `terminate()`
// does not interrupt a thread inside SQLite's native loop. Measured by the re-review: a
// stopped recursive query kept a core at ~100% for seconds, and a stopped cross join kept its
// read snapshot, so `wal_checkpoint(TRUNCATE)` stayed busy and the WAL grew 20 → 55 MB.
// better-sqlite3 exposes no `sqlite3_interrupt` and no progress handler; only killing the
// process frees the loop and the snapshot.
//
// So each query runs in a CHILD PROCESS on its own read-only connection, started through the
// toolbox's one process door (`spawnAuthorized`, the door `shell`/`exec` use). That door ties
// the child to the agent's stop (`endsWithTheStop`): Stop ends its process group, and the
// snapshot goes with it. NO DEADLINE, by the owner's law: the stop is the signal. The door needs
// the call's capability to name the node executable (`process.execPath`), so `dojo_inspect`'s
// declaration must declare that program (Part C).
//
// The child's program is an inline source string (the reason `memory/reader-pool.ts` gives: a
// file resolves differently under tsx, node and vitest). It applies the read-only door's rules
// itself, whatever the parent sent: only SELECT/WITH/VALUES (or EXPLAIN of one), a reader SQLite
// calls read-only, on a `readonly` handle with `query_only` set.
//
// t278 — THE QUERY DIES WITH THE PROCESS THAT STARTED IT. Its own process group is what lets the
// stop end it, and also what kept it alive when the server did not: a server that crashed, was
// SIGKILLed or restarted mid-query left the query running forever at full CPU, holding its read
// snapshot, with nobody left who could stop it (seen on a build box: orphans, parent pid 1, at
// ~40% CPU for half an hour). The signal is the parent's absence itself, not a deadline:
//   • the parent writes the request as ONE line and keeps the child's stdin OPEN until the child
//     has closed. The parent holds the only write end, so the kernel closes it the moment the
//     parent dies, however it dies;
//   • the query runs on a worker THREAD of the child, so the child's main thread is idle and its
//     event loop sees that stdin 'end' even while SQLite is inside a native loop (a timer on the
//     query's own thread could never fire there);
//   • the main thread then SIGKILLs its own process, which a native loop cannot ignore (a
//     `process.exit()` would JOIN the busy thread and wait on it).
// Stop is unchanged: SIGTERM to the group ends the process at once (no handler), then SIGKILL.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module';
import { getDbPath } from '../db/connection.js';
import { spawnAuthorized } from '../agent/effects/proc.js';
import { currentCapability } from '../agent/effects/capability.js';
import { isStopFenced } from '../agent/shared-state.js';
import { STOPPED_BY_USER } from '../agent/abortable-call.js';

/** One output column: its name as written, and the table column it comes from (null for an expression). */
export interface OutColumn { name: string; column: string | null; table: string | null }
export type ReadOutcome = { columns: OutColumn[]; rows: unknown[][] } | { error: string } | { ended: string };

const CHILD_SOURCE = `
  const { Worker } = require('node:worker_threads');
  // The query, on the worker thread: everything that touches SQLite runs here.
  function query() {
    const { workerData: req, parentPort } = require('node:worker_threads');
    let out;
    try {
      const lead = String(req.sql).replace(/^(\\s+|--[^\\n]*(\\n|$)|\\/\\*[\\s\\S]*?\\*\\/)+/, '').replace(/^explain(\\s+query\\s+plan)?\\s+/i, '');
      if (!/^(select|with|values)\\b/i.test(lead)) throw new Error('only a read runs here');
      const Database = require(req.betterSqlitePath);
      const db = new Database(req.dbPath, { readonly: true, fileMustExist: true });
      db.pragma('query_only = 1');
      db.pragma('busy_timeout = 2000');
      const stmt = db.prepare(req.sql);
      if (!stmt.reader || !stmt.readonly) throw new Error('only a read runs here');
      const columns = stmt.columns().map((c) => ({ name: c.name, column: c.column, table: c.table }));
      const rows = stmt.raw(true).all().map((r) => r.map((v) => (Buffer.isBuffer(v) ? '<blob ' + v.length + ' bytes>' : v)));
      db.close();
      out = { columns, rows };
    } catch (err) {
      out = { error: String((err && err.message) || err) };
    }
    parentPort.postMessage(out);
  }
  // The main thread: hands the request to the query's thread, answers once, and watches the parent.
  let answered = false;
  const answer = (out) => {
    if (answered) return;
    answered = true;
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
  };
  // The parent keeps stdin open for the child's whole life; its end means the parent is gone.
  const orphaned = () => { if (!answered) process.kill(process.pid, 'SIGKILL'); };
  process.stdin.on('end', orphaned);
  process.stdin.on('close', orphaned);
  process.stdin.on('error', orphaned);
  let got = '';
  let started = false;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (c) => {
    if (started) return;
    got += c;
    const nl = got.indexOf('\\n');
    if (nl === -1) return;
    started = true;
    let req;
    try { req = JSON.parse(got.slice(0, nl)); } catch (err) { answer({ error: String((err && err.message) || err) }); return; }
    const w = new Worker('(' + query.toString() + ')()', { eval: true, workerData: req });
    w.once('message', answer);
    w.once('error', (err) => answer({ error: String((err && err.message) || err) }));
    w.once('exit', () => answer({ error: "the query's thread ended without an answer" }));
  });
`;

/**
 * Run one already-checked read in a child process, inside the current dojo_inspect call.
 * `onSpawn` hands the child's pid to a test; production passes nothing.
 */
export function readInChild(sql: string, onSpawn?: (pid: number) => void): Promise<ReadOutcome> {
  const agentId = currentCapability()?.agentId;
  let child: ReturnType<typeof spawnAuthorized>;
  try {
    child = spawnAuthorized(process.execPath, ['-e', CHILD_SOURCE]);
  } catch (e) {
    return Promise.resolve({ error: e instanceof Error ? e.message : String(e) });
  }
  if (child.pid !== undefined) onSpawn?.(child.pid);
  return new Promise<ReadOutcome>((resolve) => {
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.once('error', (e) => { child.stdin.destroy(); resolve({ error: e.message }); });
    child.once('close', (_code, signal) => {
      child.stdin.destroy(); // held open until now: its end is how the child knows this process is gone (t278)
      if (signal) {
        resolve({ ended: agentId && isStopFenced(agentId) ? STOPPED_BY_USER : `The query was ended before it finished (${signal}).` });
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf-8')) as ReadOutcome); } catch {
        resolve({ error: Buffer.concat(err).toString('utf-8').trim() || "the query's process ended without an answer" });
      }
    });
    child.stdin.on('error', () => undefined);
    // ONE line (JSON escapes every newline inside it), and stdin stays open: see t278 above.
    child.stdin.write(`${JSON.stringify({ sql, dbPath: getDbPath(), betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3') })}\n`);
  });
}
