// A read-only query, refused three ways: only SELECT, WITH, VALUES or an EXPLAIN SQLite compiles as a read;
// `refuseDeniedSql` for credential tables and columns; the connection is readonly with query_only set.
// It runs in its own child process (sql-child.ts), so the engine's thread is never held and the agent's stop
// can kill a runaway query (a thread could not be stopped inside SQLite). Cells are redacted by SOURCE column.

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { isReadStatement } from '../db/read-only-door.js';
import { refuseDeniedSql } from './redact.js';
import { redactResultRow } from './result-row.js';
import { readInChild } from './sql-child.js';

const READ_ONLY = 'Refused: only a read runs here (a statement starting with SELECT, WITH or EXPLAIN). dojo_inspect never changes anything.';

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return String(v).replace(/\r?\n/g, '\\n');
}

/** Run one read and render its rows: checks run here, the query itself in a child process (`sql-child.ts`). */
export async function sql(args: { query: string }, forMain = false): Promise<string> {
  const db: Database.Database = getReadOnlyDb();
  const query = (args.query ?? '').trim().replace(/;\s*$/, '');
  if (!isReadStatement(query)) return READ_ONLY;
  const refused = refuseDeniedSql(query, db, forMain);
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
  const rows: string[][] = out.rows.map((raw) => redactResultRow(out.columns, raw).map(show));
  const columns = out.columns.map((c) => c.name);
  const count = `${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}.`;
  // Every column but the last is padded to its widest cell; the last is never padded.
  const widths = columns.map((c, i) => rows.reduce((w, r) => Math.max(w, r[i].length), c.length));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' ');
  return [count, '', line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '', count].join('\n');
}
