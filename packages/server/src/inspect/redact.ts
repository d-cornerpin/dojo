// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect A1 — THE REDACTION EVERY dojo_inspect VIEW PASSES THROUGH.
//
// The main agent may see everything about its platform except a credential. Three doors:
//
//   refuseDeniedSql  a statement that reaches a credential table, or reads a credential column
//                    of any table, is refused with a sentence naming it. The tables are found
//                    lexically (no schema needed). The columns are found in what SQLite's own
//                    compiled program READS (`EXPLAIN`), so an alias, a star, a UNION that
//                    renames every column, or a WHERE that probes a value through an index
//                    cannot carry a credential out under another name.
//   redactRows       a credential column is blanked, then every string cell is scrubbed.
//   redactText       for log lines and code: token-shaped strings (the shape list the technique
//                    exporter already keeps, `techniques/scrub.ts`) and every value the named
//                    agents have handled (`redactHandedCredentials`, the t118 door).
//
// WHY A SHAPE SCRUB HERE when the persist side deliberately keys on declared values only: the
// persist side must not rewrite bytes the agent still needs, so it may not guess. A read-only
// view rewrites nothing that is stored, so over-redaction costs a blank and cannot leak.
//
// A count, a rate or a timestamp is never a credential, so a column whose NAME matches a
// pattern but which holds a number, or ends in `_at`, is not blanked (`token_count` stays).
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { isReadStatement, stripExplain } from '../db/read-only-door.js';
import { PATTERNS } from '../techniques/scrub.js';
import { REDACTED_CREDENTIAL, redactHandedCredentials } from '../credentials/secret-values.js';

export const DENIED_TABLES: readonly string[] = ['agent_credentials', 'google_accounts', 'microsoft_accounts', 'twilio_config', 'github_account', 'plaud', 'vault_entries' /* owner's private memory stays behind vault_* tools */];
export const DENIED_COLUMN_PATTERNS: readonly RegExp[] = [/token/i, /secret/i, /password/i, /api_key/i, /refresh/i, /private/i];

const NUMERIC_TYPE = /INT|REAL|FLOA|DOUB|NUM|DEC|BOOL/i;

/** A column name that says credential and is not a time. */
export const columnNamesCredential = (name: string): boolean => namesCredential(name);
function namesCredential(name: string): boolean {
  return !/_at$/i.test(name) && DENIED_COLUMN_PATTERNS.some((r) => r.test(name));
}

/** A schema column that can hold a credential: its name says so and its type is not a number. */
export function isDeniedColumn(name: string, declaredType: string): boolean {
  return namesCredential(name) && !NUMERIC_TYPE.test(declaredType);
}

const BARE_ID = /[A-Za-z_][A-Za-z0-9_$]*/y;

/** The identifiers of a statement, lowercased, comments skipped and every quoting form ("x", [x],
 *  `x`) unwrapped. A single-quoted literal is kept too, whole: SQLite accepts `FROM 'name'` as a
 *  table name, so a literal that IS a denied table's name counts as naming it. */
function identifiers(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  const close: Record<string, string> = { '"': '"', '[': ']', '`': '`' };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1; let lit = '';
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) { lit += sql[j]; j += sql[j] === "'" ? 2 : 1; }
      out.push(lit.trim().toLowerCase()); i = j + 1; continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 2; continue; }
    if (close[c]) {
      const end = close[c];
      let j = i + 1; let id = '';
      while (j < sql.length && !(sql[j] === end && sql[j + 1] !== end)) { id += sql[j]; j += sql[j] === end ? 2 : 1; }
      out.push(id.toLowerCase()); i = j + 1; continue;
    }
    BARE_ID.lastIndex = i;
    const m = BARE_ID.exec(sql);
    if (m) { out.push(m[0].toLowerCase()); i += m[0].length; continue; }
    i++;
  }
  return out;
}

/** Opcodes that touch a cursor without reading any column's bytes. On an index cursor
 *  anything else (a Column, a Seek, an Idx comparison) reads the indexed values. */
const CONTENT_FREE = new Set(['OpenRead', 'ReopenIdx', 'Rewind', 'Next', 'Prev', 'Last', 'Close', 'Count', 'IdxRowid', 'DeferredSeek', 'NullRow', 'Rowid']);

interface Op { opcode: string; p1: number; p2: number; p3: number }
interface Tree { table: string; columns: Array<{ name: string; type: string }>; isIndex: boolean }

/** root page → the table or index it holds, with its columns in cursor order. */
function schemaTrees(db: Database.Database): Map<number, Tree> {
  const trees = new Map<number, Tree>();
  const objects = db.prepare(
    "SELECT type, name, tbl_name, rootpage FROM sqlite_master WHERE type IN ('table','index') AND rootpage > 0",
  ).all() as Array<{ type: string; name: string; tbl_name: string; rootpage: number }>;
  const tableCols = (t: string): Array<{ name: string; type: string }> =>
    (db.prepare('SELECT name, type FROM pragma_table_xinfo(?)').all(t) as Array<{ name: string; type: string }>);
  for (const o of objects) {
    if (o.type === 'table') { trees.set(o.rootpage, { table: o.name, columns: tableCols(o.name), isIndex: false }); continue; }
    const types = new Map(tableCols(o.tbl_name).map((c) => [c.name, c.type]));
    const cols = (db.prepare('SELECT name FROM pragma_index_xinfo(?) ORDER BY seqno').all(o.name) as Array<{ name: string | null }>)
      .map((c) => ({ name: c.name ?? '', type: c.name ? types.get(c.name) ?? '' : 'INTEGER' }));
    trees.set(o.rootpage, { table: o.tbl_name, columns: cols, isIndex: true });
  }
  return trees;
}

/** `table.column` pairs this statement's compiled program reads, plus every table it opens. */
function reads(sql: string, db: Database.Database): { tables: Set<string>; columns: Set<string> } {
  const tables = new Set<string>(); const columns = new Set<string>();
  const program = db.prepare(`EXPLAIN ${sql}`).all() as Op[];
  const trees = schemaTrees(db);
  // A cursor number can be reused by another part of the program, so a cursor stands for EVERY
  // tree ever opened on it: over-counting a read refuses more, and cannot leak.
  const cursors = new Map<number, Tree[]>();
  for (const op of program) {
    if ((op.opcode === 'OpenRead' || op.opcode === 'ReopenIdx') && op.p3 === 0) {
      const tree = trees.get(op.p2);
      if (tree) { cursors.set(op.p1, [...(cursors.get(op.p1) ?? []), tree]); tables.add(tree.table); }
    }
  }
  for (const op of program) {
    if (CONTENT_FREE.has(op.opcode)) continue;
    for (const tree of cursors.get(op.p1) ?? []) {
      const denied = (c: { name: string; type: string } | undefined): void => {
        if (c && c.name && isDeniedColumn(c.name, c.type)) columns.add(`${tree.table}.${c.name}`);
      };
      if (op.opcode === 'Column') denied(tree.columns[op.p2]);
      else if (tree.isIndex) tree.columns.forEach(denied);
    }
  }
  return { tables, columns };
}

/**
 * The sentence that refuses this statement, or null when it reaches no credential. With a
 * connection, the compiled program is checked as well. An EXPLAIN is checked as the statement
 * it explains (only a read may be explained); nothing else about a statement's words skips the
 * check. A statement SQLite cannot compile returns null here and fails with SQLite's own error
 * where it runs; one it compiles but this check cannot read is refused.
 */
export function refuseDeniedSql(sql: string, db?: Database.Database): string | null {
  const ids = new Set(identifiers(sql));
  const named = DENIED_TABLES.find((t) => ids.has(t));
  if (named) return tableRefusal(named);
  if (!db) return null;
  const { explained, inner } = stripExplain(sql);
  if (explained && !isReadStatement(inner)) return 'Refused: only a read (SELECT, WITH or VALUES) can be explained here.';
  let reached: ReturnType<typeof reads>;
  try { reached = reads(inner, db); } catch {
    try { db.prepare(inner); } catch { return null; }
    return 'Refused: the statement could not be checked for what it reads, so it does not run.';
  }
  const opened = DENIED_TABLES.find((t) => reached.tables.has(t));
  if (opened) return tableRefusal(opened);
  const [column] = [...reached.columns].sort();
  return column
    ? `Refused: the statement reads ${column}, which holds a credential and is not readable through dojo_inspect. Name the columns you need without it.`
    : null;
}

function tableRefusal(table: string): string {
  return `Refused: the statement reaches ${table}, which holds credentials (or the owner's private memory) and is not readable through dojo_inspect.`;
}

/** The scrubber, for log lines, code and any other text: token shapes, then handed values. */
export function redactText(s: string, agentIds: readonly string[] = []): string {
  if (!s) return s;
  let out = s;
  for (const p of PATTERNS) {
    out = out.replace(p.regex, (match: string, ...rest: unknown[]) => {
      const groups = rest.slice(0, -2).filter((g): g is string => typeof g === 'string' && g.length > 0);
      const value = groups[groups.length - 1];
      // A URL with inline credentials keeps its scheme, user and host; only the password goes.
      if (!value) return p.name === 'url-creds' ? match.replace(/^([^:]+:\/\/[^:/@\s]+:)[^@\s]+@/, `$1${REDACTED_CREDENTIAL}@`) : REDACTED_CREDENTIAL;
      const at = match.lastIndexOf(value);
      return `${match.slice(0, at)}${REDACTED_CREDENTIAL}${match.slice(at + value.length)}`;
    });
  }
  for (const a of new Set(agentIds)) out = redactHandedCredentials(a, out);
  return out;
}

/** The cells of a row that name the agents it belongs to, for the handed-value scrub. */
const AGENT_CELLS = ['agent_id', 'assignee_agent', 'source_agent_id', 'created_by_agent_id'];

/** One cell, redacted: blanked when its column names a credential (or it is the value of a
 *  key/value row whose key does) and it holds bytes; otherwise a string is scrubbed. */
export function redactCell(column: string, v: unknown, agentIds: readonly string[], keyNamesCredential = false): unknown {
  const holdsBytes = typeof v === 'string' || Buffer.isBuffer(v);
  if (holdsBytes && (namesCredential(column) || (column === 'value' && keyNamesCredential))) return REDACTED_CREDENTIAL;
  return typeof v === 'string' ? redactText(v, agentIds) : v;
}

/** The agents a row belongs to, read from its agent cells, for the handed-value scrub. */
export function rowAgents(cells: ReadonlyArray<[string, unknown]>, base: readonly string[] = []): string[] {
  return [...base, ...cells.filter(([k, v]) => AGENT_CELLS.includes(k) && typeof v === 'string').map(([, v]) => v as string)];
}

/** Does a `key` cell name a credential (the config table's shape)? */
export const keyNamesCredential = (key: unknown): boolean => typeof key === 'string' && namesCredential(key);

/** Blank credential columns (and the value of a key/value row whose key names one), then
 *  scrub every string cell. Returns new rows; the input is not changed. */
export function redactRows<T extends Record<string, unknown>>(rows: T[], agentIds: readonly string[] = []): T[] {
  return rows.map((row) => {
    const cells = Object.entries(row);
    const agents = rowAgents(cells, agentIds);
    const keyed = keyNamesCredential(row.key);
    return Object.fromEntries(cells.map(([k, v]) => [k, redactCell(k, v, agents, keyed)])) as T;
  });
}
