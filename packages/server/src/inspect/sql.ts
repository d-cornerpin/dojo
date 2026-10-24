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
// THE WRITER IS NEVER HELD. The database runs in WAL mode, where a reader works from its own
// snapshot and the engine's writer appends beside it; the read-only connection's busy timeout
// covers the rare checkpoint wait. A long SELECT costs this view time, not the engine.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { keyNamesCredential, redactCell, refuseDeniedSql, rowAgents } from './redact.js';

const READ_ONLY = 'Refused: only a read runs here (a statement starting with SELECT, WITH or EXPLAIN). dojo_inspect never changes anything.';

/** The first keyword, past comments and whitespace. */
function firstWord(q: string): string {
  const s = q.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toLowerCase();
}

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `<blob ${v.length} bytes>`;
  return String(v).replace(/\r?\n/g, '\\n');
}

/** Run one read and render its rows. */
export function sql(args: { query: string }, db: Database.Database = getReadOnlyDb()): string {
  const query = (args.query ?? '').trim().replace(/;\s*$/, '');
  if (!['select', 'with', 'explain'].includes(firstWord(query))) return READ_ONLY;
  const refused = refuseDeniedSql(query, db);
  if (refused) return refused;
  let stmt: Database.Statement;
  try { stmt = db.prepare(query); } catch (e) { return `SQLite refused the statement: ${e instanceof Error ? e.message : String(e)}`; }
  if (!stmt.reader) return READ_ONLY;
  const columns = stmt.columns().map((c) => c.name);
  const keyAt = columns.indexOf('key');
  const rows: string[][] = [];
  try {
    for (const raw of stmt.raw(true).iterate() as Iterable<unknown[]>) {
      const cells = columns.map((c, i) => [c, raw[i]] as [string, unknown]);
      const agents = rowAgents(cells);
      const keyed = keyAt !== -1 && keyNamesCredential(raw[keyAt]);
      rows.push(cells.map(([c, v]) => show(redactCell(c, v, agents, keyed))));
    }
  } catch (e) {
    return `SQLite stopped the query: ${e instanceof Error ? e.message : String(e)}`;
  }
  const count = `${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}.`;
  // Every column but the last is padded to its widest cell; the last is never padded.
  const widths = columns.map((c, i) => rows.reduce((w, r) => Math.max(w, r[i].length), c.length));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' ');
  return [count, '', line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '', count].join('\n');
}
