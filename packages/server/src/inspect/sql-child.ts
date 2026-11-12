// A query runs in its own child process so the agent's stop can kill it: better-sqlite3 is synchronous, and
// a worker thread cannot be interrupted in SQLite's native loop (terminate() leaves CPU and snapshot held).
// It starts through the one process door (`spawnAuthorized`), tied to the agent's stop with no deadline; the
// door needs the call's capability to name `process.execPath`, so definition.ts must declare that program.
// The program is an inline source string (as `memory/reader-pool.ts` does: a file resolves differently
// under tsx, node and vitest) and applies the read-only door's rules itself, whatever the parent sent.
// The query dies with the process that started it: the parent writes the request as ONE line (JSON escapes
// its newlines) and keeps stdin OPEN, the only write end, so the kernel closes it when the parent dies.
// The query runs on a worker thread so the main thread stays idle and sees that 'end' even inside a native
// SQLite loop, then SIGKILLs itself (process.exit() would join it). No SIGTERM handler: the stop ends it.

import { createRequire } from 'node:module';
import { DENIED_COLUMN_PATTERNS } from './redact.js';
import { getDbPath } from '../db/connection.js';
import { spawnAuthorized } from '../agent/effects/proc.js';
import { currentCapability } from '../agent/effects/capability.js';
import { isStopFenced } from '../agent/shared-state.js';
import { STOPPED_BY_USER } from '../agent/abortable-call.js';

export interface OutColumn { name: string; column: string | null; table: string | null }
export type ReadOutcome = { columns: OutColumn[]; rows: unknown[][] } | { error: string } | { ended: string };

const CHILD_SOURCE = `
  const { Worker } = require('node:worker_threads');
  // The query, on the worker thread: everything that touches SQLite runs here.
  function query() {
    const { workerData: req, parentPort } = require('node:worker_threads');
    let out;
    // The statement past its leading comments, its EXPLAIN [QUERY PLAN], and any comments after that.
    const LEAD = /^(\\s+|--[^\\n]*(\\n|$)|\\/\\*[\\s\\S]*?\\*\\/)+/;
    const readBody = (sql) => String(sql).replace(LEAD, '').replace(/^explain(\\s+query\\s+plan)?\\s+/i, '').replace(LEAD, '');
    try {
      const lead = readBody(req.sql);
      if (!/^(select|with|values)\\b/i.test(lead)) throw new Error('only a read runs here');
      const Database = require(req.betterSqlitePath);
      const db = new Database(req.dbPath, { readonly: true, fileMustExist: true });
      // t285 F1: the credential values of \`config\` are blanked BEFORE any expression, filter, window or
      // aggregate of the query can see them: a TEMP VIEW of the same name (temp is searched first)
      // returns the placeholder for every row whose key names a credential. The parent refuses a
      // schema-qualified name, which would skip the view.
      const keyRules = req.credentialKeyPatterns.map((p) => new RegExp(p, 'i'));
      db.function('dojo_credential_key', { deterministic: true }, (k) => (typeof k === 'string' && !/_at$/i.test(k) && keyRules.some((r) => r.test(k)) ? 1 : 0));
      const cfg = db.prepare("SELECT name FROM pragma_table_info('config')").all().map((r) => r.name);
      if (cfg.includes('key') && cfg.includes('value')) {
        // t285 fix round 2: a COPY, not a view. The copy lives in temp with its credential values already
        // blanked, and the statement is then compiled and its bytecode read: any b-tree it would open in
        // the MAIN database that belongs to the real config table (or an index of it) is refused, whatever
        // spelling of the name reached it (schema-qualified, quoted, hidden behind comments, aliased).
        // A view could not be told apart from the statement in that check, a copy can.
        db.exec('CREATE TEMP TABLE config AS SELECT ' + cfg.map((n) => (n === 'value' ? "CASE WHEN dojo_credential_key(key) THEN '<redacted-credential>' ELSE value END AS value" : '"' + n + '"')).join(', ') + ' FROM main.config');
        // A view of the main schema that reads config is re-made in temp, over the copy.
        for (const v of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'").all()) {
          try { db.exec(String(v.sql).replace(/^\\s*CREATE\\s+VIEW/i, 'CREATE TEMP VIEW')); } catch (e) { if (/config/i.test(String(v.sql))) throw new Error('a view of config could not be made safe: ' + e.message); }
        }
        const roots = new Set(db.prepare("SELECT rootpage FROM main.sqlite_master WHERE (type = 'table' AND name = 'config') OR (type = 'index' AND tbl_name = 'config')").all().map((r) => r.rootpage));
        const inner = readBody(req.sql);
        for (const op of db.prepare('EXPLAIN ' + inner).all()) {
          if ((op.opcode === 'OpenRead' || op.opcode === 'OpenWrite' || op.opcode === 'ReopenIdx') && op.p3 === 0 && roots.has(op.p2)) {
            throw new Error('Refused: the statement reads the real config table; name config without a schema (from config, not main.config).');
          }
        }
      }
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

/** Run one already-checked read in a child process; `onSpawn` hands its pid to a test. */
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
      child.stdin.destroy();
      if (signal) {
        resolve({ ended: agentId && isStopFenced(agentId) ? STOPPED_BY_USER : `The query was ended before it finished (${signal}).` });
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf-8')) as ReadOutcome); } catch {
        resolve({ error: Buffer.concat(err).toString('utf-8').trim() || "the query's process ended without an answer" });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify({ sql, dbPath: getDbPath(), betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3'), credentialKeyPatterns: DENIED_COLUMN_PATTERNS.map((r) => r.source) })}\n`);
  });
}
