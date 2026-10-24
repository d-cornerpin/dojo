// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C2 — THE SHELL SENDS DOJO QUESTIONS TO dojo_inspect.
//
// The owner, 2026-10-20: the main agent "reaches for exec shell scripts to try to look at
// history of what happens in its own dojo … It shouldn't have to rely on greps and scripts."
// Measured on the dev box: hundreds of shell calls running `sqlite3 ~/.dojo/data/dojo.db …`,
// re-deriving the schema with `pragma table_info` each time, and `tail`/`grep` on the platform
// log. dojo_inspect answers every one of those questions, read-only, with credentials refused and
// secrets blanked; the shell does neither.
//
// SO, asked of a command line the broker ALLOWED (it can only refuse, never permit):
//   • a WRITE to the live database (`dojo.db` and its -wal/-shm/-journal siblings) — a non-read
//     statement or dot-command through sqlite3, or a redirect, copy, move, delete or `dd`/`tee`
//     into those files — is refused for EVERY agent, the Healer included. ORCHESTRATOR RULING
//     2026-10-24: the platform's own tools make repairs; a raw write corrupts every guarantee
//     the engine keeps on its records (the file tools have refused it since T2).
//   • a READ of the live database: an agent that HOLDS dojo_inspect is pointed at the view that
//     answers (`schema` for a schema look, otherwise `sql`); any other agent is refused (same
//     ruling): the file holds the platform's internals and the credential tables, which
//     dojo_inspect refuses and the shell would not.
//   • a read of the platform log (`dojo.log`, `dojo.log.1`): a holder is pointed at `logs`.
//
// WHAT IT LEAVES ALONE, each pinned by a test: a command that looks only at the FILE (ls, stat,
// du, wc, lsof, … — see the program lists below); any other file (another database, a backup like
// `dojo.db.bak`, the other files under ~/.dojo/logs, which dojo_inspect does not read); and a
// non-holder's read of the log.
// ════════════════════════════════════════════════════════════════════════════════════════

import { holdsDojoInspect } from '../../inspect/grant.js';
import { deny, type Verdict } from './types.js';

/** The live database file by its basename, as a whole path segment (not `dojo.db.bak`). */
const DOJO_DB = /(?:^|[\s'"=/:<>(])dojo\.db(?:-wal|-shm|-journal)?(?![\w.-])/i;
/** The plan's `~/.dojo/data/*.db` form: a glob inside the data directory. */
const DATA_GLOB = /\.dojo\/data\/[^/\s'"]*[*?[][^/\s'"]*/;
/** The platform log and its one rotated backup, as a whole path segment. */
const DOJO_LOG = /(?:^|[\s'"=/:<>(])dojo\.log(?:\.1)?(?![\w.-])/i;
/** A statement or dot-command that changes a database, or a pragma that is not a schema look. */
const WRITE_STATEMENT = new RegExp([
  String.raw`\binsert\s+(?:or\s+\w+\s+)?into\b`, String.raw`\bupdate\s+[\w."\x60\[\]]+\s+set\b`, String.raw`\bdelete\s+from\b`,
  String.raw`\breplace\s+into\b`, String.raw`\b(?:drop|alter|create)\s+(?:unique\s+)?(?:table|index|view|trigger)\b`,
  String.raw`\bvacuum\b`, String.raw`\breindex\b`, String.raw`\battach\b`, String.raw`\.(?:import|restore)\b`,
  String.raw`\bpragma\s+(?!(?:table_x?info|index_list|index_x?info|foreign_key_list)\b)\w+`,
].join('|'), 'i');
/** A shell redirect INTO the database file, or `dd of=` it. */
const REDIRECT_INTO = /(?:>>?|\bof=)\s*['"]?[^\s'"|;&]*dojo\.db(?:-wal|-shm|-journal)?(?![\w.-])/i;
const SCHEMA_LOOK = /\.(?:schema|tables|indexes|indices)\b|pragma[\s_]+table_x?info|\bsqlite_(?:master|schema)\b/i;

// WHICH PROGRAMS COUNT (t267 review, Important 1): only a command that reads or changes the file's
// CONTENTS. A look at the file itself — ls, stat, du, wc, file, lsof, fuser, find, shasum — is a
// real diagnostic (size, WAL growth, who holds it) that no dojo_inspect view answers, so it passes.
const SQL_PROGRAMS = new Set(['sqlite3', 'python', 'python3', 'node', 'perl', 'ruby', 'deno', 'bun']);
const CONTENT_READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'nl', 'strings', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'sed', 'awk', 'xxd', 'od', 'hexdump', 'base64', 'cp', 'rsync', 'scp', 'tar', 'zip', 'gzip', 'jq', 'sort', 'uniq', 'cut']);
const WRITES_EVERY_OPERAND = new Set(['rm', 'unlink', 'truncate', 'shred', 'tee', 'mv']);
const WRITES_LAST_OPERAND = new Set(['cp', 'rsync', 'install', 'ln', 'scp']);
const PREFIXES = new Set(['sudo', 'env', 'nice', 'nohup', 'time', 'timeout', 'command']);

const unquote = (w: string): string => w.replace(/^['"]+|['"]+$/g, '');
const namesDb = (w: string): boolean => DOJO_DB.test(` ${unquote(w)}`) || DATA_GLOB.test(w);
const namesLog = (w: string): boolean => DOJO_LOG.test(` ${unquote(w)}`);

export type DojoLineClass = 'write' | 'schema' | 'sql' | 'logs';
const RANK: Record<DojoLineClass, number> = { logs: 1, sql: 2, schema: 2, write: 3 };

/** What one simple command does to the Dojo's own database or log, or null. */
function classifySegment(segment: string, line: string): DojoLineClass | null {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) words.shift();
  const program = (words[0] ?? '').split('/').pop() ?? '';
  const operands = words.slice(1).filter((w) => !w.startsWith('-'));
  if (operands.some(namesDb)) {
    if (WRITES_EVERY_OPERAND.has(program)) return 'write';
    if (WRITES_LAST_OPERAND.has(program) && operands.length > 1 && namesDb(operands[operands.length - 1])) return 'write';
    if (program === 'dd') return operands.some((w) => /^if=/.test(w) && namesDb(w)) ? 'sql' : null;
    if (SQL_PROGRAMS.has(program)) return WRITE_STATEMENT.test(line) ? 'write' : SCHEMA_LOOK.test(line) ? 'schema' : 'sql';
    if (CONTENT_READERS.has(program)) return 'sql';
  }
  return operands.some(namesLog) && CONTENT_READERS.has(program) ? 'logs' : null;
}

/** What a command line does to the Dojo's own database or log, or null when it reads and changes neither. */
export function classifyDojoLine(line: string): DojoLineClass | null {
  let out: DojoLineClass | null = REDIRECT_INTO.test(line) ? 'write' : null;
  for (const segment of line.split(/\|\|?|;|&&/)) {
    const c = classifySegment(segment, line);
    if (c && (!out || RANK[c] > RANK[out])) out = c;
  }
  return out;
}

const WRITE_REFUSAL = "Refused: the shell does not change the Dojo's own database (dojo.db and its -wal and -shm files). The platform's own tools make changes and repairs, so its records stay consistent; if no tool can make this change, report it instead.";
const READ_REFUSAL = "Refused: the Dojo's own database is not read through the shell: it holds the platform's internals and its credentials. Ask the main agent if you need something looked up in it.";

const VIEW_CALL = {
  sql: 'dojo_inspect(what="sql", query="…")',
  schema: 'dojo_inspect(what="schema", table="…")',
  logs: 'dojo_inspect(what="logs", pattern="…")',
} as const;

/** The refusal for a line that writes the database, reads it, or asks the log a question; or null.
 *  Asked only after the broker allowed the line. */
export function redirectDojoQuestion(agentId: string, line: string): Verdict | null {
  const cls = classifyDojoLine(line);
  if (!cls) return null;
  if (cls === 'write') return deny('ladder-parity', 'dojo-db-shell-write', 'the shell does not change the Dojo\'s own database', WRITE_REFUSAL);
  const holder = holdsDojoInspect(agentId);
  if (!holder) return cls === 'logs' ? null : deny('ladder-parity', 'dojo-db-shell-read', 'the Dojo\'s own database is not read through the shell', READ_REFUSAL);
  return deny(
    'ladder-parity',
    `dojo-inspect-redirect:${cls}`,
    `the Dojo's ${cls === 'logs' ? 'log' : 'database'} is read through dojo_inspect, not the shell`,
    `Refused: the Dojo's database and logs are read through dojo_inspect, not the shell. For this question: ${VIEW_CALL[cls]}. Call load_tool_docs("dojo_inspect") for the arguments.`,
  );
}
