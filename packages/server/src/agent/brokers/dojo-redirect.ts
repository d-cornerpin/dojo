// ════════════════════════════════════════════════════════════════════════════════════════
// THE SHELL DOOR ON THE DOJO'S OWN DATABASE: AN ALLOWLIST (field fix 3, v35-field-fix-3).
//
// The owner's rulings: the main agent may read the Dojo's own database and log from the shell;
// password and credential data stays hidden from every agent, the main agent included; helper
// agents keep their limits.
//
// WHY AN ALLOWLIST: the door before this one tried to spot credential reads inside arbitrary
// shell text, and a reviewer showed that text-spotting cannot be complete. So the door fails
// closed. A command line that REFERS to the live database file (dojo.db and its -wal, -shm and
// -journal siblings) or to the Dojo data folder runs only in this one exact shape:
//
//     sqlite3 [-readonly] [output flags] <the literal database path> '<SQL>'
//
//   • the program is `sqlite3` (or /usr/bin/sqlite3), not behind a launcher;
//   • the path is given literally, `~/.dojo/data/dojo.db` or its absolute form: no variable, glob,
//     relative path or other spelling;
//   • the flags come from OUTPUT_FLAGS below, and nothing else (no flag that carries SQL or a file);
//   • then exactly ONE quoted SQL argument, which the shell does not expand, and nothing after it;
//   • every statement in it (split by a quote-aware splitter) is SELECT, WITH ... SELECT, or a pragma
//     from READ_PRAGMAS, and passes `refuseDeniedSql` (inspect/redact.ts), the one credential list
//     dojo_inspect uses too;
//   • the line around it is plain commands joined by `;`, `&&`, `||` or `|`: no redirect, here-doc,
//     subshell, substitution or background job, and nothing piped INTO sqlite3.
//
// THE ONE OTHER SHAPE, a look at the FILE and not its contents: a metadata program from
// METADATA_PROGRAMS (ls, stat, du, wc -c, lsof, fuser, file, shasum), its plain words only (no
// variable, glob or substitution), shows size, WAL growth and who holds the file, and reads no row.
// `wc` counts only with `-c` (a line or word count reads the contents). A copy, an archive or any
// reader of the bytes is not a metadata look.
//
// Any other line that refers to the database file or the data folder is refused with one factual
// sentence (FACT_REFUSAL), a whole-folder copy or archive included. The platform log is not the
// database: a grep or tail of it is not this door's business, for any agent.
//
// WHO: the main agent and the Healer get the allowlist. A worker is refused any reference to the
// database file or the data folder at all. The Healer's fixed repair statements (REPAIRS below)
// keep working in the same shape; each must also pass `refuseDeniedSql`, and a repair line holds
// only that one statement.
//
// THE LIMIT, STATED PLAINLY: a shell door reads the command line, so it cannot see inside a script
// file the agent writes and then runs, or a program that opens the database by itself. This door
// keeps the everyday shell honest; it is not what protects a credential. The trigger is a word scan
// of the line (raw, and as the shell will unquote it), so a path put together while the command
// runs (a variable, a string built inside another program) is not seen. The real protections are
// encryption at rest for credentials and the blocked key file.
// ════════════════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import type Database from 'better-sqlite3';
import { isHealerAgent, isPrimaryAgent } from '../../config/platform.js';
import { getDb } from '../../db/connection.js';
import { firstKeyword } from '../../db/read-only-door.js';
import { homeDir } from '../../home.js';
import { refuseDeniedSql } from '../../inspect/redact.js';
import { deny, type Verdict } from './types.js';

export type DoorRole = 'main' | 'healer' | 'worker';
/** `untouched`: the line does not refer to the database or the data folder. */
export type DoorOutcome = 'untouched' | 'allowed' | 'refused' | 'credential';
export interface DoorVerdict { outcome: DoorOutcome; message?: string }

export const FACT_REFUSAL = 'Refused: dojo_inspect answers questions about the Dojo\'s database, and the shell allows only a plain read-only sqlite3 SELECT of it, written as sqlite3 -readonly ~/.dojo/data/dojo.db "SELECT ...".';
export const WORKER_REFUSAL = "Refused: the Dojo's own database is read through the shell by the main agent and the Healer only; it holds the platform's credential tables.";

const SQLITE = new Set(['sqlite3', '/usr/bin/sqlite3']);
/** Programs that look at a file's metadata (size, type, digest, who holds it), never its rows. */
const METADATA_PROGRAMS = new Set(['ls', 'stat', 'du', 'wc', 'lsof', 'fuser', 'file', 'shasum']);
const SYSTEM_BIN = new Set(['/bin', '/usr/bin', '/usr/sbin', '/sbin']);
const OUTPUT_FLAGS = new Set(['-readonly', '-header', '-noheader', '-csv', '-json', '-line', '-column', '-list', '-box', '-table', '-markdown', '-tabs']);
const READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);
const TILDE_PATH = '~/.dojo/data/dojo.db';
/** Tables and functions the sqlite3 shell (or a build of it) adds that read raw pages or files,
 *  write files or load code. Refused by name wherever they appear, for a CLI that may differ from
 *  the server's SQLite (re-review 3 M1). */
const CLI_ONLY_NAME = /(?<![\w$])(?:sqlite_dbpage|sqlite_dbdata|sqlite_dbptr|fsdir|lsdir|zipfile|sqlar(?:_\w+)?|sha3_query|sha3_agg|sha3|readfile|writefile|edit|load_extension|fts3_tokenizer)(?![\w$])/i;
/** Table-valued functions a read may name in its FROM clause. Any other one is refused. */
const SAFE_TABLE_FUNCTIONS = new Set(['json_each', 'json_tree', 'pragma_table_info', 'pragma_table_xinfo', 'pragma_index_list', 'pragma_index_info', 'pragma_index_xinfo', 'pragma_foreign_key_list']);
/** Keywords that end a FROM clause at its own depth. */
const FROM_ENDS = new Set(['where', 'group', 'order', 'limit', 'having', 'window', 'union', 'intersect', 'except', 'on', 'using', 'select', 'values', 'returning']);

/** The table-valued functions a bare statement names as row sources (`FROM f(...)`, `JOIN f(...)`,
 *  `, f(...)` inside a FROM clause), lowercased. */
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

// ── does the line refer to the database file or the data folder? ──
/** The live database file by its basename, as a whole path segment (`dojo.db.bak` is not it). */
const DB_FILE = /(?:^|[^\w.-])dojo\.db(?:-wal|-shm|-journal)?(?![\w.-])/i;
/** The Dojo folder itself, its data folder, a glob inside it, or a `..` that could reach either. */
const DOJO_FOLDER = /\.dojo(?:\/+data(?![\w.-])|\/+[^\s/'"]*[*?[{]|\/+(?:[^\s'"]*\/)?\.\.(?![\w.-])|\/*(?=$|[\s'";|&)<>]))/i;

/** Does this text refer to the live database file or the Dojo data folder? */
export function refersToDojoDatabase(text: string): boolean {
  const t = text.replace(/\/\.(?=\/)/g, '');   // `a/./b` is `a/b`
  return DB_FILE.test(t) || DOJO_FOLDER.test(t);
}

function absolutePath(): string | null {
  try { return path.join(homeDir(), '.dojo', 'data', 'dojo.db'); } catch { return null; }
}

// ── a quote-aware lexer for one shell line ──
interface Word {
  value: string;
  /** No quotes, escapes or expansions: the word is exactly its characters. */
  plain: boolean;
  /** The whole word is one quoted span. */
  quotedWhole: boolean;
  /** Contains something the shell expands or substitutes ($name, glob, brace, backtick). */
  expands: boolean;
  /** Starts with an unquoted `~/` (the shell's home expansion); otherwise plain. */
  tilde: boolean;
}
interface Segment { words: Word[]; text: string; pipedIn: boolean }
interface Lexed { segments: Segment[]; special: boolean }

/** Split a line into simple commands joined by ; && || | and newlines, or null when a quote is
 *  left open. `special` is set by any redirect, here-doc, subshell, substitution, background job
 *  or comment: syntax the allowlist does not admit on a line that refers to the database. */
function lex(line: string): Lexed | null {
  const segments: Segment[] = [];
  let special = false;
  let words: Word[] = [];
  let start = 0;
  let pipedIn = false;
  let w: Word | null = null;
  let parts = 0;          // the spans that make up the current word
  let quotedParts = 0;    // how many of them are quoted
  let inRun = false;      // inside an unquoted run of the current word
  const endWord = (): void => {
    if (w) { w.quotedWhole = parts === 1 && quotedParts === 1; words.push(w); }
    w = null; parts = 0; quotedParts = 0; inRun = false;
  };
  const endSegment = (at: number, nextPiped: boolean): void => {
    endWord();
    if (words.length > 0) segments.push({ words, text: line.slice(start, at), pipedIn });
    words = []; pipedIn = nextPiped;
  };
  const word = (): Word => (w ??= { value: '', plain: true, quotedWhole: false, expands: false, tilde: false });
  const run = (): Word => { const cur = word(); if (!inRun) { parts++; inRun = true; } return cur; };
  const quoted = (): Word => { const cur = word(); parts++; quotedParts++; inRun = false; cur.plain = false; return cur; };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '\n' || c === ';') { endSegment(i, false); i++; start = i; continue; }
    if (c === '&' && line[i + 1] === '&') { endSegment(i, false); i += 2; start = i; continue; }
    if (c === '|' && line[i + 1] === '|') { endSegment(i, false); i += 2; start = i; continue; }
    if (c === '|') { endSegment(i, true); i++; start = i; continue; }
    if ('&<>()`'.includes(c) || (c === '#' && !w)) { special = true; const cur = run(); cur.plain = false; cur.value += c; i++; continue; }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null;
      quoted().value += line.slice(i + 1, end);
      i = end + 1; continue;
    }
    if (c === '"') {
      const cur = quoted();
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j];
        if (d === '\\' && j + 1 < line.length && '$`"\\\n'.includes(line[j + 1])) { cur.value += line[++j]; continue; }
        if (d === '`') { special = true; cur.expands = true; }
        if (d === '$' && /[A-Za-z_{(0-9@*#?$!-]/.test(line[j + 1] ?? '')) { cur.expands = true; if (line[j + 1] === '(') special = true; }
        cur.value += d;
      }
      if (j >= line.length) return null;
      i = j + 1; continue;
    }
    if (c === '\\') { const cur = run(); cur.plain = false; cur.value += line[i + 1] ?? ''; i += 2; continue; }
    // An ordinary unquoted character.
    const fresh = w === null;
    const cur = run();
    if (fresh && c === '~') {
      if (line[i + 1] === '/') cur.tilde = true; else { cur.expands = true; cur.plain = false; }
    } else if ('$*?[{~'.includes(c)) {
      cur.expands = true; cur.plain = false;
      if (c === '$' && line[i + 1] === '(') special = true;
    }
    cur.value += c; i++;
  }
  endSegment(line.length, false);
  return { segments, special };
}

// ── the SQL ──
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

/** The statement with its literals, quoted names and comments blanked, for keyword scans. */
const bare = (s: string): string => s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The words at parenthesis depth 0 of a bare statement, lowercased. */
function topLevelWords(s: string): string[] {
  let depth = 0; let flat = '';
  for (const c of s) { if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1); else if (depth === 0) flat += c; }
  return flat.toLowerCase().match(/[a-z_]+/g) ?? [];
}

function openDb(): Database.Database | undefined {
  try { return getDb(); } catch { return undefined; }
}

/** Is this one statement a read the door admits (before the credential check)? */
function isAdmittedRead(stmt: string, db: Database.Database | undefined): boolean {
  const b = bare(stmt);
  if (CLI_ONLY_NAME.test(b)) return false;
  if (tableFunctions(b).some((f) => !SAFE_TABLE_FUNCTIONS.has(f))) return false;
  // FAIL CLOSED (re-review 3 M1): the server's own SQLite is the reference. A statement it cannot
  // compile, or that it compiles as anything but read-only, is not an admitted read, and with no
  // connection to check against nothing is admitted.
  if (!db) return false;
  try { if (!db.prepare(stmt).readonly) return false; } catch { return false; }
  const kw = firstKeyword(stmt);
  if (kw === 'pragma') {
    const m = /^\s*pragma\s+([a-z_]+)\s*(?:\(\s*(?:[\w]+|''|"")\s*\))?\s*$/i.exec(b.replace(/^(?:\s|--[^\n]*)+/, ''));
    return !!m && READ_PRAGMAS.has(m[1].toLowerCase());
  }
  if (kw !== 'select' && kw !== 'with') return false;
  const top = topLevelWords(b);
  if (top.some((t, k) => ['insert', 'update', 'delete', 'upsert', 'attach', 'detach'].includes(t) || (t === 'replace' && top[k + 1] === 'into'))) return false;
  if (kw === 'with' && !top.includes('select')) return false;
  return true;
}

// ── the Healer's repairs: a short fixed set ──
const LIT = String.raw`(?:'(?:[^']|'')*'|-?\d+(?:\.\d+)?|null|datetime\('now'\))`;
const PERSIST = String.raw`json_set\(\s*config\s*,\s*'\$\.persist'\s*,\s*[01]\s*\)`;
// These are MATCHERS for SQL text the Healer may run, not writes the engine makes: each entry pairs
// a SQL column NAME (a string) with the value shape the door accepts for it. They are kept as
// [name, shape] pairs, not object keys, so a matcher is never read as an assignment of that field
// (the schedule census in tracker/__tests__/schedule-echo-seam.test.ts scans for field writes).
const REPAIR_COLUMNS: Record<string, { where: string; cols: ReadonlyArray<readonly [string, string]> }> = {
  agents: { where: 'id', cols: [['model_id', LIT], ['status', LIT], ['config', PERSIST]] },
  work: { where: 'id', cols: [['state', LIT], ['next_run_at', LIT], ['schedule_status', LIT], ['updated_at', LIT]] },
  config: { where: 'key', cols: [['value', LIT], ['updated_at', LIT]] },
};
const WAL_CHECKPOINT = /^\s*pragma\s+wal_checkpoint\s*(?:\(\s*(?:passive|full|restart|truncate)\s*\))?\s*$/i;

/** Split at commas outside parentheses and literals. */
function topLevelCommas(s: string): string[] {
  const out: string[] = []; let depth = 0; let cur = ''; let q = false;
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Is this one statement one of the Healer's fixed repairs? */
export function isHealerRepair(stmt: string): boolean {
  const s = stmt.trim();
  if (WAL_CHECKPOINT.test(s)) return true;
  const m = /^update\s+(\w+)\s+set\s+([\s\S]+?)\s+where\s+(\w+)\s*=\s*'(?:[^']|'')*'\s*$/i.exec(s);
  if (!m) return false;
  const spec = REPAIR_COLUMNS[m[1].toLowerCase()];
  if (!spec || m[3].toLowerCase() !== spec.where) return false;
  return topLevelCommas(m[2]).every((a) => {
    const am = /^(\w+)\s*=\s*([\s\S]+)$/.exec(a);
    const valueShape = am ? spec.cols.find(([name]) => name === am[1].toLowerCase())?.[1] : undefined;
    return !!valueShape && new RegExp(`^${valueShape}$`, 'i').test(am![2].trim());
  });
}

/** Are these words a metadata look: a program from METADATA_PROGRAMS (bare, or from a system bin
 *  folder) and plain words after it? `wc` passes only as a byte count. */
function isMetadataLook(words: readonly Word[]): boolean {
  const head = words[0];
  if (!head || !head.plain) return false;
  const base = path.basename(head.value);
  const dir = path.dirname(head.value);
  if (!METADATA_PROGRAMS.has(base) || (head.value !== base && !SYSTEM_BIN.has(dir))) return false;
  const rest = words.slice(1);
  if (rest.some((w) => w.expands)) return false;
  if (base === 'wc') {
    const flags = rest.filter((w) => w.value.startsWith('-'));
    return flags.length > 0 && flags.every((w) => w.value === '-c' || w.value === '--bytes');
  }
  return true;
}

// ── the verdict ──
/** The verdict on one sqlite3 command's words, already known to be the exact shape. */
function sqlVerdict(sql: string, role: DoorRole): DoorVerdict {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { outcome: 'refused', message: FACT_REFUSAL };
  const db = openDb();
  const repair = role === 'healer' && statements.length === 1 && isHealerRepair(statements[0]);
  // The credential check first, so a statement that names a credential table is refused with the
  // sentence that names it; then the read-only check, which fails closed.
  for (const s of statements) {
    const refused = refuseDeniedSql(s, db);
    if (refused) return { outcome: 'credential', message: refused };
  }
  if (!repair && !statements.every((s) => isAdmittedRead(s, db))) return { outcome: 'refused', message: FACT_REFUSAL };
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
  const sql = words[i + 1];
  if (!sql || i + 2 !== words.length || sql.expands || !sql.quotedWhole) return null;
  return sql.value;
}

/**
 * The door's verdict on a command, given as a shell line (string) or an argv vector (array), for
 * an agent in the given role. A pure function of the command and the role, apart from reading the
 * home path and, for the credential check, the database's schema.
 */
export function dojoDoorVerdict(command: string | readonly string[], role: DoorRole): DoorVerdict {
  const text = typeof command === 'string' ? command : command.join(' ');
  // The words as the shell will unquote them count too, so `~/.do''jo/...` is still the folder.
  const lexed = typeof command === 'string' ? lex(command) : null;
  const unquoted = lexed ? lexed.segments.flatMap((seg) => seg.words.map((w) => w.value)).join(' ') : '';
  if (!refersToDojoDatabase(text) && !refersToDojoDatabase(unquoted)) return { outcome: 'untouched' };
  if (role === 'worker') return { outcome: 'refused', message: WORKER_REFUSAL };
  if (typeof command !== 'string') {
    // No shell: every element is literal text, so nothing expands and the SQL element is whole.
    const words = command.map((value) => ({ value, plain: !/\s/.test(value), quotedWhole: true, expands: false, tilde: value.startsWith('~/') }));
    if (isMetadataLook(words)) return { outcome: 'allowed' };
    const sql = shapeSql(words);
    return sql === null ? { outcome: 'refused', message: FACT_REFUSAL } : sqlVerdict(sql, role);
  }
  if (!lexed || lexed.special) return { outcome: 'refused', message: FACT_REFUSAL };
  let result: DoorVerdict = { outcome: 'allowed' };
  for (const seg of lexed.segments) {
    if (!refersToDojoDatabase(seg.text) && !refersToDojoDatabase(seg.words.map((w) => w.value).join(' '))) continue;
    if (!seg.pipedIn && isMetadataLook(seg.words)) continue;   // a look at the file, not its rows
    const sql = seg.pipedIn ? null : shapeSql(seg.words);
    if (sql === null) return { outcome: 'refused', message: FACT_REFUSAL };
    const v = sqlVerdict(sql, role);
    if (v.outcome !== 'allowed') return v;
    result = v;
  }
  return result;
}

/**
 * The refusal for a command the broker ALLOWED, or null to let it run. Asked only after the
 * broker allowed the call, so it can refuse and never permit. `command` is the shell script text,
 * or the argv vector of the exec door (never its space-joined display, which loses the quoting).
 */
export function redirectDojoQuestion(agentId: string, command: string | readonly string[]): Verdict | null {
  const role: DoorRole = isPrimaryAgent(agentId) ? 'main' : isHealerAgent(agentId) ? 'healer' : 'worker';
  const v = dojoDoorVerdict(command, role);
  if (v.outcome === 'untouched' || v.outcome === 'allowed') return null;
  if (v.outcome === 'credential') return deny('ladder-parity', 'dojo-db-credential-read', 'the Dojo database\'s credential tables stay hidden', v.message ?? FACT_REFUSAL);
  if (role === 'worker') return deny('ladder-parity', 'dojo-db-shell-read', 'the Dojo database is reached through the shell by the main agent and the Healer only', v.message ?? WORKER_REFUSAL);
  return deny('ladder-parity', 'dojo-db-shell-shape', 'only a plain read-only sqlite3 SELECT of the Dojo database runs from the shell', v.message ?? FACT_REFUSAL);
}
