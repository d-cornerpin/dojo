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
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let out;
    try {
      const req = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
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
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
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
    child.once('error', (e) => resolve({ error: e.message }));
    child.once('close', (_code, signal) => {
      if (signal) {
        resolve({ ended: agentId && isStopFenced(agentId) ? STOPPED_BY_USER : `The query was ended before it finished (${signal}).` });
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf-8')) as ReadOutcome); } catch {
        resolve({ error: Buffer.concat(err).toString('utf-8').trim() || "the query's process ended without an answer" });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ sql, dbPath: getDbPath(), betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3') }));
  });
}
