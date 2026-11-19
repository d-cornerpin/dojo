// The shell door on the Dojo's own database. The main agent may do anything with the Dojo folder;
// only its plain sqlite3 statements are checked, and only for credential tables. For the Healer it is
// an allowlist that fails closed: a line referring to the live database file or the data folder runs
// only in the shape shapeSql() accepts, each statement a read that passes refuseDeniedSql, or as a
// metadata look (METADATA_PROGRAMS, plain words, not piped) alone on its line; anything else gets
// FACT_REFUSAL. A worker gets every refusal.

import path from 'node:path';
import type Database from 'better-sqlite3';
import { isHealerAgent, isPrimaryAgent } from '../../config/platform.js';
import { getDb } from '../../db/connection.js';
import { firstKeyword } from '../../db/read-only-door.js';
import { homeDir } from '../../home.js';
import { refuseDeniedSql } from '../../inspect/redact.js';
import { DOJO_BACKUP_DIRS, denyRuleFor, namesSecretsFile } from './deny.js';
import { lexShellLine, type Segment, type Word } from './shell-words.js';
import { deny, type Verdict } from './types.js';

export type DoorRole = 'main' | 'healer' | 'worker';
/** `untouched`: the line does not refer to the database or the data folder. */
export type DoorOutcome = 'untouched' | 'allowed' | 'refused' | 'credential';
export interface DoorVerdict { outcome: DoorOutcome; message?: string }

export const FACT_REFUSAL = 'Refused: dojo_inspect answers questions about the Dojo\'s database, and the shell allows only a plain read-only sqlite3 SELECT of it, written as sqlite3 -readonly ~/.dojo/data/dojo.db "SELECT ...".';
export const LOOK_REFUSAL = "Look at the Dojo's data folder in a command of its own, with no pipe and nothing else on the line.";
export const WORKER_REFUSAL = "Refused: the Dojo's own database is read through the shell by the main agent and the Healer only; it holds the platform's credential tables.";

const SQLITE = new Set(['sqlite3', '/usr/bin/sqlite3']);
const METADATA_PROGRAMS = new Set(['ls', 'stat', 'du', 'wc', 'lsof', 'fuser', 'file', 'shasum', 'find']);
/** The words that turn a look into running a program, writing or deleting a file, or printing a file's lines. */
const NOT_A_LOOK: Record<string, RegExp> = {
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from)$/,
  file: /^-(?:[^-]*[fmM]|-(?:f|ma))/,
};
const SYSTEM_BIN = new Set(['/bin', '/usr/bin', '/usr/sbin', '/sbin']);
const OUTPUT_FLAGS = new Set(['-readonly', '-header', '-noheader', '-csv', '-json', '-line', '-column', '-list', '-box', '-table', '-markdown', '-tabs']);
const READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);
const TILDE_PATH = '~/.dojo/data/dojo.db';
/** Shell-only tables/functions (raw page reads, file writes, code loads): the agent's sqlite3 CLI may
 *  differ from the server's SQLite, so its compile check cannot see them; refused by name. */
const CLI_ONLY_NAME = /(?<![\w$])(?:sqlite_dbpage|sqlite_dbdata|sqlite_dbptr|fsdir|lsdir|zipfile|sqlar(?:_\w+)?|sha3_query|sha3_agg|sha3|readfile|writefile|edit|load_extension|fts3_tokenizer)(?![\w$])/i;
/** Table-valued functions a read may name in its FROM clause. Any other one is refused. */
const SAFE_TABLE_FUNCTIONS = new Set(['json_each', 'json_tree', 'pragma_table_info', 'pragma_table_xinfo', 'pragma_index_list', 'pragma_index_info', 'pragma_index_xinfo', 'pragma_foreign_key_list']);
const FROM_ENDS = new Set(['where', 'group', 'order', 'limit', 'having', 'window', 'union', 'intersect', 'except', 'on', 'using', 'select', 'values', 'returning']);

/** The table-valued functions a bare statement names as row sources, lowercased. */
function tableFunctions(b: string): string[] {
  const tokens = b.toLowerCase().match(/[a-z_][\w$]*|[(),]/g) ?? [];
  const found: string[] = [];
  const inFrom: boolean[] = [false];   // one flag per parenthesis depth
  let expectSource = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const d = inFrom.length - 1;
    if (t === '(') { inFrom.push(false); expectSource = false; continue; }
    if (t === ')') { if (inFrom.length > 1) inFrom.pop(); expectSource = false; continue; }
    if (t === ',') { expectSource = inFrom[d]; continue; }
    if (t === 'from' || t === 'join') { inFrom[d] = true; expectSource = true; continue; }
    if (FROM_ENDS.has(t)) { inFrom[d] = false; expectSource = false; continue; }
    if (expectSource && tokens[k + 1] === '(') found.push(t);
    expectSource = false;
  }
  return found;
}

/** The live database file by its basename, as a whole path segment (`dojo.db.bak` is not it). */
const DB_FILE = /(?:^|[^\w.-])dojo\.db(?:-wal|-shm|-journal)?(?![\w.-])/i;
/** The Dojo folder itself, its data or backup folders, a glob inside it, or a `..` that could reach either. */
const DOJO_FOLDER = new RegExp(String.raw`\.dojo(?:\/+(?:data|${DOJO_BACKUP_DIRS.map((d) => d.replace('/', String.raw`\/+`)).join('|')})(?![\w.-])|\/+[^\s/'"]*[*?[{]|\/+(?:[^\s'"]*\/)?\.\.(?![\w.-])|\/*(?=$|[\s'";|&)<>]))`, 'i');

export function refersToDojoDatabase(text: string): boolean {
  const t = text.replace(/\/\.(?=\/)/g, '');   // `a/./b` is `a/b`
  return DB_FILE.test(t) || DOJO_FOLDER.test(t);
}

function absolutePath(): string | null {
  try { return path.join(homeDir(), '.dojo', 'data', 'dojo.db'); } catch { return null; }
}

/** The statements of a SQL text, split at semicolons outside literals, quoted names and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const closer: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };
  while (i < sql.length) {
    const c = sql[i];
    if (closer[c]) {
      const end = closer[c];
      let j = i + 1;
      while (j < sql.length && !(sql[j] === end && sql[j + 1] !== end)) j += sql[j] === end ? 2 : 1;
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); const stop = e === -1 ? sql.length : e; cur += sql.slice(i, stop); i = stop; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); const stop = e === -1 ? sql.length : e + 2; cur += sql.slice(i, stop); i = stop; continue; }
    if (c === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  return out.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim() !== '');
}

/** The statement with literals and quoted names emptied and comments blanked, read left to right. */
const bare = (s: string): string => s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
  (m) => (m.startsWith('--') || m.startsWith('/*') ? ' ' : m[0] === '[' ? '[]' : m[0] + m[0]));

function topLevelWords(s: string): string[] {
  let depth = 0; let flat = '';
  for (const c of s) { if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1); else if (depth === 0) flat += c; }
  return flat.toLowerCase().match(/[a-z_]+/g) ?? [];
}

function openDb(): Database.Database | undefined {
  try { return getDb(); } catch { return undefined; }
}

/** Refusal for one statement the door does not admit as a read, or null when it does. */
function readRefusal(stmt: string, db: Database.Database | undefined): string | null {
  const b = bare(stmt);
  if (/^\s*\./.test(stmt)) return FACT_REFUSAL;   // a dot-command inside the SQL text
  if (CLI_ONLY_NAME.test(b)) return FACT_REFUSAL;
  if (tableFunctions(b).some((f) => !SAFE_TABLE_FUNCTIONS.has(f))) return FACT_REFUSAL;
  // FAIL CLOSED: the server's own SQLite is the reference, so a statement it cannot
  // compile, or compiles as anything but read-only, is no admitted read (errors in SQLite's own words).
  if (!db) return FACT_REFUSAL;
  try {
    if (!db.prepare(stmt).readonly) return FACT_REFUSAL;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    return `Refused: the Dojo's SQLite cannot compile this statement (${msg}), so it does not run.`;
  }
  const kw = firstKeyword(stmt);
  if (kw === 'pragma') {
    const m = /^\s*pragma\s+([a-z_]+)\s*(?:\(\s*(?:[\w]+|''|"")\s*\))?\s*$/i.exec(b.replace(/^(?:\s|--[^\n]*)+/, ''));
    return m && READ_PRAGMAS.has(m[1].toLowerCase()) ? null : FACT_REFUSAL;
  }
  if (kw !== 'select' && kw !== 'with') return FACT_REFUSAL;
  const top = topLevelWords(b);
  if (top.some((t, k) => ['insert', 'update', 'delete', 'upsert', 'attach', 'detach'].includes(t) || (t === 'replace' && top[k + 1] === 'into'))) return FACT_REFUSAL;
  if (kw === 'with' && !top.includes('select')) return FACT_REFUSAL;
  return null;
}

// The Healer's repair scope: every statement still passes the credential list and the server's own
// SQLite compile; dot-commands (an `.import` writes rows no SQL check can read) stay refused, and a
// `VACUUM INTO` copy lands only in a backup folder.
const VACUUM_INTO = /^\s*vacuum\b[^;]*\binto\b/i;
const COPY_REFUSAL = `Refused: a copy of the database may be written only into ${DOJO_BACKUP_DIRS.map((d) => `~/.dojo/${d}/`).join(' or ')}, given as a full path.`;
/** Whole-db checks: they open every table and return no rows; the credential list holds them by NAME. */
const WHOLE_DB_MAINTENANCE = /^\s*(?:pragma\s+(?:integrity_check|quick_check)\s*(?:\(\s*\w+\s*\))?|reindex(?:\s+\w+)?|vacuum)\s*$/i;

/** Refusal for one statement the Healer may not run as a repair, or null when it may. */
export function healerRepairRefusal(stmt: string, db: Database.Database | undefined): string | null {
  const b = bare(stmt);
  if (/^\s*\./.test(stmt)) return FACT_REFUSAL;
  if (CLI_ONLY_NAME.test(b)) return FACT_REFUSAL;
  if (tableFunctions(b).some((f) => !SAFE_TABLE_FUNCTIONS.has(f))) return FACT_REFUSAL;
  const to = /^\s*vacuum(?:\s+\w+)?\s+into\s+'([^']+)'\s*;?\s*$/i.exec(stmt)?.[1];
  if (VACUUM_INTO.test(b) && !(to && path.isAbsolute(to) && denyRuleFor(path.normalize(to), 'global_read')?.id === 'dojo-database-backups')) return COPY_REFUSAL;
  if (!db) return FACT_REFUSAL;
  try {
    db.prepare(stmt);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    return `Refused: the Dojo's SQLite cannot compile this statement (${msg}), so it does not run.`;
  }
  return null;
}

/** A metadata look: METADATA_PROGRAMS program (bare or system bin), plain words, `wc` bytes only, no NOT_A_LOOK word. */
function isMetadataLook(words: readonly Word[]): boolean {
  const head = words[0];
  if (!head || !head.plain) return false;
  const base = path.basename(head.value);
  const dir = path.dirname(head.value);
  if (!METADATA_PROGRAMS.has(base) || (head.value !== base && !SYSTEM_BIN.has(dir))) return false;
  const rest = words.slice(1);
  if (rest.some((w) => w.expands)) return false;
  if (rest.some((w) => NOT_A_LOOK[base]?.test(w.value))) return false;
  if (base === 'wc') {
    const flags = rest.filter((w) => w.value.startsWith('-'));
    return flags.length > 0 && flags.every((w) => w.value === '-c' || w.value === '--bytes');
  }
  return true;
}

/** The verdict on one sqlite3 command's words, already known to be the exact shape. */
function sqlVerdict(sql: string, role: DoorRole): DoorVerdict {
  // `.tables` prints names and `.schema` table definitions; neither is a secret.
  const dot = sql.trim();
  if (dot === '.tables' || /^\.schema(?:\s+[A-Za-z_]\w*)?$/.test(dot)) return { outcome: 'allowed' };
  const statements = splitStatements(sql);
  const db = openDb();
  // The credential check runs first for every role; for the Healer the read-only check then fails closed.
  for (const s of statements) {
    const maintenance = WHOLE_DB_MAINTENANCE.test(bare(s));
    const refused = refuseDeniedSql(s, maintenance ? undefined : db, role === 'main');   // undefined: the credential list by name only
    if (refused) return { outcome: 'credential', message: refused };
  }
  if (role === 'main') return { outcome: 'allowed' };
  if (statements.length === 0) return { outcome: 'refused', message: FACT_REFUSAL };
  for (const s of statements) {
    const asRead = readRefusal(s, db);
    const refused = asRead !== null && role === 'healer' ? healerRepairRefusal(s, db) : asRead;
    if (refused) return { outcome: 'refused', message: refused };
  }
  return { outcome: 'allowed' };
}

/** The SQL argument when these words are exactly the allowed sqlite3 shape, else null. */
function shapeSql(words: readonly Word[]): string | null {
  const abs = absolutePath();
  if (words.length < 3 || !words[0].plain || !SQLITE.has(words[0].value)) return null;
  let i = 1;
  while (i < words.length && words[i].plain && OUTPUT_FLAGS.has(words[i].value)) i++;
  const p = words[i];
  if (!p || p.expands) return null;
  const literal = (p.tilde && p.plain && p.value === TILDE_PATH) || (!p.tilde && abs !== null && p.value === abs && (p.plain || p.quotedWhole));
  if (!literal) return null;
  // sqlite3 reads its options on either side of the path, so output flags may follow it.
  i++;
  while (i < words.length && words[i].plain && OUTPUT_FLAGS.has(words[i].value)) i++;
  const sql = words[i];
  if (!sql || sql.expands) return null;
  // `.schema agents` as two plain words is the quoted `".schema agents"`.
  const table = words[i + 1];
  if (sql.plain && sql.value === '.schema' && table && i + 2 === words.length && table.plain && /^[A-Za-z_]\w*$/.test(table.value)) return `.schema ${table.value}`;
  if (i + 1 !== words.length) return null;
  if (!sql.quotedWhole && !(sql.plain && (sql.value === '.tables' || sql.value === '.schema'))) return null;   // one plain dot-command word
  return sql.value;
}

/** Each simple command's words: the shell's reading of a line, or an argv vector as one literal command. */
function commandsOf(command: string | readonly string[]): Word[][] {
  if (typeof command === 'string') return lexShellLine(command)?.segments.map((seg) => seg.words) ?? [];
  // No shell: every element is literal text, so nothing expands and the SQL element is whole.
  return [command.map((value) => ({ value, plain: !/\s/.test(value), quotedWhole: true, expands: false, tilde: value.startsWith('~/') }))];
}

/** A pragma setting writable_schema, read with comments blanked and name quotes dropped. */
const WRITABLE_SCHEMA = /^\s*pragma\s+(?:\w+\s*\.\s*)?writable_schema(?!\w)/i;

/** Whether a sqlite3 command on the Dojo database deletes, replaces, drops or reshapes, asked of each
 *  statement's top-level words; a pragma only by its name. */
export function destroysDojoData(command: string | readonly string[]): boolean {
  return commandsOf(command).some((words) => {
    const sql = shapeSql(words);
    return sql !== null && splitStatements(sql).some((stmt) => {
      if (firstKeyword(stmt) === 'pragma') return WRITABLE_SCHEMA.test(stmt.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, ' ').replace(/["'`[\]]/g, ''));
      const top = topLevelWords(bare(stmt));
      return top.some((t, k) => t === 'delete' || t === 'drop' || t === 'alter'
        || (t === 'replace' && (top[k + 1] === 'into' || (top[k - 1] === 'or' && ['insert', 'update'].includes(top[k - 2])))));
    });
  });
}

/** The Dojo's core tables: the Healer's raw INSERT or UPDATE of one waits for the owner. */
const CORE_TABLES = new Set(['messages', 'agents', 'work', 'config']);
const CONFLICT_WORDS = ['or', 'rollback', 'abort', 'replace', 'fail', 'ignore'];
/** A statement with literals emptied, comments blanked and name quotes dropped, so `"agents"` and `main.agents` read as words. */
const namesOf = (s: string): string => s.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, ' ').replace(/["`[\]]/g, '');

/** Whether a sqlite3 command on the Dojo database inserts into or updates one of its core tables. */
export function writesCoreDojoRows(command: string | readonly string[]): boolean {
  return commandsOf(command).some((words) => {
    const sql = shapeSql(words);
    return sql !== null && splitStatements(sql).some((stmt) => {
      const top = topLevelWords(namesOf(stmt)).filter((t) => t !== 'main' && t !== 'temp');
      return top.some((t, k) => {
        if (t === 'update') {
          let j = k + 1;
          while (CONFLICT_WORDS.includes(top[j])) j++;
          return CORE_TABLES.has(top[j]);
        }
        return t === 'into' && (top[k - 1] === 'insert' || CONFLICT_WORDS.includes(top[k - 1])) && CORE_TABLES.has(top[k + 1]);
      });
    });
  });
}

/** Programs that destroy every path they name, and copy-style programs that overwrite their last one. */
const DESTROYS_OPERANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'truncate', 'mv', 'tee', 'dd']);
const OVERWRITES_LAST = new Set(['cp', 'rsync', 'ditto', 'install', 'ln']);

/** Whether a command deletes, moves, truncates or overwrites a file `names` matches: a redirect
 *  target, an operand of a program that destroys what it names, or a copy-style program's last one. */
export function overwritesFile(command: string | readonly string[], names: (word: string) => boolean): boolean {
  const text = typeof command === 'string' ? command : command.join(' ');
  if ([...text.matchAll(/>\|?\s*([^\s;&|<>]+)/g)].some((m) => names(m[1]))) return true;
  return commandsOf(command).some((words) => {
    const at = words.findIndex((w) => DESTROYS_OPERANDS.has(path.basename(w.value)) || OVERWRITES_LAST.has(path.basename(w.value)));
    if (at < 0) return false;
    const operands = words.slice(at + 1).map((w) => w.value).filter((v) => !v.startsWith('-'));
    return (OVERWRITES_LAST.has(path.basename(words[at].value)) ? operands.slice(-1) : operands).some(names);
  });
}

/** Whether a command deletes, moves, truncates or overwrites the Dojo's database, data, backups or secrets file. */
export function destroysDojoFiles(command: string | readonly string[]): boolean {
  return destroysDojoData(command) || overwritesFile(command, (word) => refersToDojoDatabase(word) || namesSecretsFile(word));
}

/** The door's verdict on a command (a shell line, or an argv vector) for an agent's role. */
export function dojoDoorVerdict(command: string | readonly string[], role: DoorRole): DoorVerdict {
  const text = typeof command === 'string' ? command : command.join(' ');
  // The words as the shell will unquote them count too, so `~/.do''jo/...` is still the folder.
  const lexed = typeof command === 'string' ? lexShellLine(command) : null;
  const unquoted = lexed ? lexed.segments.flatMap((seg) => seg.words.map((w) => w.value)).join(' ') : '';
  if (!refersToDojoDatabase(text) && !refersToDojoDatabase(unquoted)) return { outcome: 'untouched' };
  if (role === 'worker') return { outcome: 'refused', message: WORKER_REFUSAL };
  if (role === 'main') {
    for (const words of commandsOf(command)) {
      const sql = shapeSql(words);
      const v = sql === null ? null : sqlVerdict(sql, role);
      if (v && v.outcome !== 'allowed') return v;
    }
    return { outcome: 'allowed' };
  }
  if (typeof command !== 'string') {
    const [words] = commandsOf(command);
    if (isMetadataLook(words)) return { outcome: 'allowed' };
    const sql = shapeSql(words);
    return sql === null ? { outcome: 'refused', message: FACT_REFUSAL } : sqlVerdict(sql, role);
  }
  if (!lexed || lexed.special) return { outcome: 'refused', message: FACT_REFUSAL };
  // `$_` is the previous command's last word, so a command reading it may be handed a name on the data.
  const refers = (seg: Segment): boolean => /\$\{?[#!]?_(?!\w)/.test(seg.text) || refersToDojoDatabase(seg.text) || refersToDojoDatabase(seg.words.map((w) => w.value).join(' '));
  const looks = lexed.segments.some((seg) => refers(seg) && isMetadataLook(seg.words));
  let result: DoorVerdict = { outcome: 'allowed' };
  for (const [k, seg] of lexed.segments.entries()) {
    if (!looks && !refers(seg)) continue;
    // A look at the file, not its rows, and only while its output goes nowhere else.
    if (!seg.pipedIn && !lexed.segments[k + 1]?.pipedIn && isMetadataLook(seg.words)) continue;
    const sql = seg.pipedIn ? null : shapeSql(seg.words);
    if (sql === null) return { outcome: 'refused', message: looks ? LOOK_REFUSAL : FACT_REFUSAL };
    const v = sqlVerdict(sql, role);
    if (v.outcome !== 'allowed') return v;
    result = v;
  }
  return result;
}

/** The refusal for a command the broker ALLOWED, or null; asked only after the allow, so it can refuse,
 *  never permit. Pass the script text or the argv vector, never the space-joined display (it loses quoting). */
export function redirectDojoQuestion(agentId: string, command: string | readonly string[]): Verdict | null {
  const role: DoorRole = isPrimaryAgent(agentId) ? 'main' : isHealerAgent(agentId) ? 'healer' : 'worker';
  const v = dojoDoorVerdict(command, role);
  if (v.outcome === 'untouched' || v.outcome === 'allowed') return null;
  if (v.outcome === 'credential') return deny('ladder-parity', 'dojo-db-credential-read', 'the Dojo database\'s credential tables stay hidden', v.message ?? FACT_REFUSAL);
  if (role === 'worker') return deny('ladder-parity', 'dojo-db-shell-read', 'the Dojo database is reached through the shell by the main agent and the Healer only', v.message ?? WORKER_REFUSAL);
  return deny('ladder-parity', 'dojo-db-shell-shape', 'only a plain read-only sqlite3 SELECT of the Dojo database runs from the shell', v.message ?? FACT_REFUSAL);
}
