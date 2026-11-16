// The redaction every dojo_inspect view passes through: everything but a credential may be seen.
// refuseDeniedSql refuses a statement that reaches a credential table (found lexically) or reads a credential
// column (found in what SQLite's compiled program READS, so an alias, star or renaming UNION cannot hide it).
// redactRows and redactCell blank a credential column, then scrub every string cell. redactText scrubs log
// lines, code and command output: the secrets file's values, token shapes (techniques/scrub.ts) and the values
// the named agents handled. Over-redaction only costs a blank. A count, rate or timestamp is never a credential:
// numeric columns and `_at` are not blanked.

import type Database from 'better-sqlite3';
import { isReadStatement, stripExplain } from '../db/read-only-door.js';
import { PATTERNS, secretOf } from '../techniques/scrub.js';
import { REDACTED_CREDENTIAL, redactHandedCredentials } from '../credentials/secret-values.js';
import { loadSecrets } from '../config/loader.js';

export const DENIED_TABLES: readonly string[] = ['agent_credentials', 'google_accounts', 'microsoft_accounts', 'twilio_config', 'github_account', 'plaud'];
export const DENIED_COLUMN_PATTERNS: readonly RegExp[] = [/token/i, /secret/i, /passw(?:or)?d/i, /api[_-]?key/i, /refresh/i, /private/i];

const NUMERIC_TYPE = /INT|REAL|FLOA|DOUB|NUM|DEC|BOOL/i;

/** SQLite's own statistics tables: after ANALYZE, `sqlite_stat4.sample` holds sampled index keys in
 *  cleartext (a destructive_approvals token among them). */
const STAT_TABLE = /^sqlite_stat/;
const isDeniedTable = (t: string): boolean => DENIED_TABLES.includes(t) || STAT_TABLE.test(t);

/** The schema pragmas name a table's columns and indexes, never its values, so the table they
 *  are asked about is not "reached". Their quoted argument is set aside before the name scan. */
const SCHEMA_PRAGMA = /\bpragma_(table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list)\s*\(\s*'(?:[^']|'')*'\s*\)/gi;

/** The child shows `config` through a same-named TEMP TABLE copy with credential values blanked; a
 *  schema-qualified name (`main.config`) would skip it. Only a schema name qualifies (ATTACH never runs on
 *  either read path, so the schemas are `main` and `temp`): `a.config` is a column of an aliased table. */
const SCHEMA_QUALIFIED_CONFIG = /(?:"(?:main|temp)"|\[(?:main|temp)\]|`(?:main|temp)`|(?<![\w$])(?:main|temp))\s*\.\s*(?:"config"|\[config\]|`config`|config\b)/i;
const CONFIG_QUALIFIED = 'Refused: name the config table without a schema (from config, not main.config).';
const stripLiterals = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

export const columnNamesCredential = (name: string): boolean => namesCredential(name);
function namesCredential(name: string): boolean {
  return !/_at$/i.test(name) && DENIED_COLUMN_PATTERNS.some((r) => r.test(name));
}

export function isDeniedColumn(name: string, declaredType: string): boolean {
  return namesCredential(name) && !NUMERIC_TYPE.test(declaredType);
}

const BARE_ID = /[A-Za-z_][A-Za-z0-9_$]*/y;

/** The identifiers of a statement, lowercased, comments skipped, quoting unwrapped. A single-quoted literal is
 *  kept whole: SQLite accepts `FROM 'name'` as a table name, so a literal naming a denied table counts. */
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

/** The sentence refusing this statement, or null when it reaches no credential. An EXPLAIN is checked as the
 *  statement it explains. A statement SQLite cannot compile returns null (SQLite fails it where it runs); one it
 *  compiles but this check cannot read is refused. */
export function refuseDeniedSql(sql: string, db?: Database.Database): string | null {
  const ids = new Set(identifiers(sql.replace(SCHEMA_PRAGMA, 'pragma_$1(NULL)')));
  if (SCHEMA_QUALIFIED_CONFIG.test(stripLiterals(sql))) return CONFIG_QUALIFIED;
  const named = [...ids].find(isDeniedTable);
  if (named) return tableRefusal(named);
  if (!db) return null;
  const { explained, inner } = stripExplain(sql);
  if (explained && !isReadStatement(inner)) return 'Refused: only a read (SELECT, WITH or VALUES) can be explained here.';
  let reached: ReturnType<typeof reads>;
  try { reached = reads(inner, db); } catch {
    try { db.prepare(inner); } catch { return null; }
    return 'Refused: the statement could not be checked for what it reads, so it does not run.';
  }
  const opened = [...reached.tables].find(isDeniedTable);
  if (opened) return tableRefusal(opened);
  const [column] = [...reached.columns].sort();
  return column
    ? `Refused: the statement reads ${column}, which holds a credential and is not readable through dojo_inspect. Name the columns you need without it.`
    : null;
}

function tableRefusal(table: string): string {
  if (STAT_TABLE.test(table)) return `Refused: the statement reaches ${table}, SQLite's statistics, which sample index keys (credentials among them) and are not readable through dojo_inspect.`;
  return `Refused: the statement reaches ${table}, which holds credentials and is not readable through dojo_inspect.`;
}

/** The secrets file's values (every field but the search provider's name), longest first. */
function secretsFileValues(): string[] {
  let s: ReturnType<typeof loadSecrets>;
  try { s = loadSecrets(); } catch { return []; }
  const providers = Object.values(s.providers ?? {}).flatMap((p) => [p.api_key, p.oauth_token]);
  return [s.jwt_secret, s.dashboard_password_hash, s.credential_master_key, s.search?.api_key, ...providers]
    .filter((v): v is string => typeof v === 'string' && v.length >= 16).sort((a, b) => b.length - a.length);
}

export function redactText(s: string, agentIds: readonly string[] = []): string {
  if (!s) return s;
  let out = s;
  for (const v of secretsFileValues()) out = out.split(v).join(REDACTED_CREDENTIAL);
  for (const p of PATTERNS) {
    out = out.replace(p.regex, (match: string, ...rest: unknown[]) => {
      const value = secretOf(p, match, rest);
      if (value === null) return match;
      // A URL with inline credentials keeps its scheme, user and host; only the password goes.
      if (!value) return p.name === 'url-creds' ? match.replace(/^([^:]+:\/\/[^:/@\s]+:)[^@\s]+@/, `$1${REDACTED_CREDENTIAL}@`) : REDACTED_CREDENTIAL;
      const at = match.lastIndexOf(value);
      return `${match.slice(0, at)}${REDACTED_CREDENTIAL}${match.slice(at + value.length)}`;
    });
  }
  for (const a of new Set(agentIds)) out = redactHandedCredentials(a, out);
  return out;
}

const AGENT_CELLS = ['agent_id', 'assignee_agent', 'source_agent_id', 'created_by_agent_id'];

/** One cell, redacted: blanked when its column names a credential (or it is the value of a
 *  key/value row whose key does) and it holds bytes; otherwise a string is scrubbed. */
export function redactCell(column: string, v: unknown, agentIds: readonly string[], keyNamesCredential = false): unknown {
  const holdsBytes = typeof v === 'string' || Buffer.isBuffer(v);
  if (holdsBytes && (namesCredential(column) || (column === 'value' && keyNamesCredential))) return REDACTED_CREDENTIAL;
  return typeof v === 'string' ? redactText(v, agentIds) : v;
}

export function rowAgents(cells: ReadonlyArray<[string, unknown]>, base: readonly string[] = []): string[] {
  return [...base, ...cells.filter(([k, v]) => AGENT_CELLS.includes(k) && typeof v === 'string').map(([, v]) => v as string)];
}

export const keyNamesCredential = (key: unknown): boolean => typeof key === 'string' && namesCredential(key);

export function redactRows<T extends Record<string, unknown>>(rows: T[], agentIds: readonly string[] = []): T[] {
  return rows.map((row) => {
    const cells = Object.entries(row);
    const agents = rowAgents(cells, agentIds);
    const keyed = keyNamesCredential(row.key);
    return Object.fromEntries(cells.map(([k, v]) => [k, redactCell(k, v, agents, keyed)])) as T;
  });
}
