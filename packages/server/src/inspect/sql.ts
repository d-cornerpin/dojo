// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B2 — A READ-ONLY QUERY.
//
// Three refusals stand between a statement and the data, and the last is SQLite's own:
//   1. only a statement that starts with SELECT, WITH or EXPLAIN is accepted, and one that
//      SQLite compiles as anything but a read (a WITH … DELETE) is refused before it runs;
//   2. `refuseDeniedSql` refuses a statement that reaches a credential table or reads a
//      credential column, by what the compiled program reads;
//   3. the connection is `readonly` with `query_only` set, so a write cannot happen at all.
// Every cell then passes the redaction. The result is an aligned table with its row count at
// both ends, whole: a result too long for one view is kept whole by the tool layer (t200), which
// shows its head and tail and the `tool_result_read` call that reads the rest.
//
// NOTHING IS HELD. The query runs in its own child process on its own read-only connection
// (`sql-child.ts`), so the engine's thread keeps serving while it runs, and in WAL mode the
// engine's writer appends beside the reader's snapshot. The agent's stop KILLS a runaway query,
// which is what releases its CPU and its snapshot (a thread could not be stopped inside SQLite).
// Every cell is redacted under the SOURCE column it was read from, never only its alias.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { isReadStatement } from '../db/read-only-door.js';
import { columnNamesCredential, keyNamesCredential, redactCell, refuseDeniedSql, rowAgents } from './redact.js';
import { readInChild, type OutColumn } from './sql-child.js';

const READ_ONLY = 'Refused: only a read runs here (a statement starting with SELECT, WITH or EXPLAIN). dojo_inspect never changes anything.';

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return String(v).replace(/\r?\n/g, '\\n');
}

/** The name a cell is redacted under: the SOURCE column it was read from when that names a
 *  credential, so an alias can never carry one out unblanked; otherwise its output name. */
const redactionName = (c: OutColumn): string => (c.column && columnNamesCredential(c.column) ? c.column : c.name);

/**
 * Run one read and render its rows. The checks and the compile run here, on the same database
 * the query runs on; the query itself runs in a child process (`sql-child.ts`) inside the
 * current dojo_inspect call, so the engine's thread is never held and the agent's stop kills it.
 */
export async function sql(args: { query: string }): Promise<string> {
  const db: Database.Database = getReadOnlyDb();
  const query = (args.query ?? '').trim().replace(/;\s*$/, '');
  if (!isReadStatement(query)) return READ_ONLY;
  const refused = refuseDeniedSql(query, db);
  if (refused) return refused;
  try {
    const stmt = db.prepare(query);
    if (!stmt.reader) return READ_ONLY;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /read-only connection/.test(msg) ? READ_ONLY : `SQLite refused the statement: ${msg}`;
  }
  const out = await readInChild(query);
  if ('ended' in out) return out.ended;
  if ('error' in out) return `SQLite stopped the query: ${out.error}`;
  const names = out.columns.map(redactionName);
  const keyAt = out.columns.findIndex((c) => (c.column ?? c.name) === 'key');
  const rows: string[][] = out.rows.map((raw) => {
    const cells = names.map((c, i) => [c, raw[i]] as [string, unknown]);
    const agents = rowAgents(cells);
    const keyed = keyAt !== -1 && keyNamesCredential(raw[keyAt]);
    return cells.map(([c, v]) => show(redactCell(c, v, agents, keyed)));
  });
  const columns = out.columns.map((c) => c.name);
  const count = `${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}.`;
  // Every column but the last is padded to its widest cell; the last is never padded.
  const widths = columns.map((c, i) => rows.reduce((w, r) => Math.max(w, r[i].length), c.length));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' ');
  return [count, '', line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '', count].join('\n');
}
