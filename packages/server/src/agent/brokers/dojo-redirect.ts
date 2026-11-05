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
// SCOPE, STATED (fix round 2 ruling): this is a HABIT guard for the common command forms, not a
// security boundary — a text match cannot see through `python3 -c`, a subshell, a variable or a
// script file, and that was as true before v3.5. The grant is the boundary (`inspect/grant.ts`).
//
// SO, asked of a command line the broker ALLOWED (it can only refuse, never permit):
//   • a WRITE to the live database (`dojo.db` and its -wal/-shm/-journal siblings) — a non-read
//     statement or dot-command, or a redirect, copy, move, delete, truncate or `dd`/`tee` into those
//     files — is refused for every agent. The one exemption is the Healer's repair STATEMENTS through
//     sqlite3 (model switch, persist flag, ending an agent, a stuck schedule, a config value, a WAL
//     checkpoint), which have no engine tool and keep working exactly as before v3.5. A file-level
//     write (and sqlite3's `.restore`/`.open`/`.shell`/`.system`, which replace the file or leave sqlite3) is not a repair: refused for
//     the Healer too (orchestrator rulings 2026-10-24, fix rounds 2 and 4).
//   • a READ of the live database or the platform log: ALLOWED for every agent since field fix 3
//     (OR-MAC-BELONGS-TO-THE-AGENT, see `redirectDojoQuestion`). It used to point a dojo_inspect
//     holder at the view and refuse any other agent; the classifier still names the read shapes.
//
// WHAT IT LEAVES ALONE, each pinned by a test: a command that looks only at the FILE (ls, stat,
// du, wc, lsof, … — see the program lists below); any other file (another database, a backup like
// `dojo.db.bak`, the other files under ~/.dojo/logs, which dojo_inspect does not read); and a
// non-holder's read of the log.
// ════════════════════════════════════════════════════════════════════════════════════════

import { isHealerAgent, isPrimaryAgent } from '../../config/platform.js';
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
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);

const unquote = (w: string): string => w.replace(/^['"]+|['"]+$/g, '');
const namesDb = (w: string): boolean => DOJO_DB.test(` ${unquote(w)}`) || DATA_GLOB.test(w);
const namesLog = (w: string): boolean => DOJO_LOG.test(` ${unquote(w)}`);

/** `repair`: a changing statement through sqlite3; `write`: any other write, the file-level ones included. */
export type DojoLineClass = 'write' | 'repair' | 'schema' | 'sql' | 'logs';
const RANK: Record<DojoLineClass, number> = { logs: 1, sql: 2, schema: 2, repair: 3, write: 4 };

// WRAPPERS: a program that launches the command it is given. Each is described by the options it
// owns: SHORT flags (a letter, no value), SHORT values (a letter whose value is the next word, or the
// rest of the same word), LONG flags, LONG values (the value is the next word, or after `=`), and how
// many plain words it takes before the command (timeout's duration). An option the table does not
// list means the door cannot tell where the command begins, so the segment is read conservatively.
interface WrapperSpec { flags: string; values: string; longFlags: string[]; longValues: string[]; positionals?: number; digitFlag?: boolean }
const WRAPPERS: Record<string, WrapperSpec> = {
  timeout: { flags: 'fpv', values: 'ks', longFlags: ['foreground', 'preserve-status', 'verbose'], longValues: ['kill-after', 'signal'], positionals: 1 },
  nice: { flags: '', values: 'n', longFlags: [], longValues: ['adjustment'], digitFlag: true },
  sudo: { flags: 'AbEeHiKklnPSsVvB', values: 'ughpCDRTU', longFlags: ['askpass', 'background', 'preserve-env', 'edit', 'set-home', 'login', 'non-interactive', 'reset-timestamp', 'stdin', 'shell', 'validate', 'remove-timestamp', 'list', 'version', 'help', 'bell'], longValues: ['user', 'group', 'host', 'prompt', 'close-from', 'chdir', 'chroot', 'type', 'role', 'other-user'] },
  env: { flags: 'iv0', values: 'uCPSa', longFlags: ['ignore-environment', 'null', 'debug'], longValues: ['unset', 'chdir', 'split-string', 'argv0'] },
  nohup: { flags: '', values: '', longFlags: [], longValues: [] },
  time: { flags: 'plhav', values: 'fo', longFlags: ['portability', 'verbose', 'append'], longValues: ['format', 'output'] },
  command: { flags: 'pvV', values: '', longFlags: [], longValues: [] },
  setsid: { flags: 'cfwhV', values: '', longFlags: ['ctty', 'fork', 'wait'], longValues: [] },
  stdbuf: { flags: '', values: 'ioe', longFlags: [], longValues: ['input', 'output', 'error'] },
  ionice: { flags: 'tchV', values: 'cnpPu', longFlags: ['ignore'], longValues: ['class', 'classdata', 'pid', 'pgid', 'uid'] },
  exec: { flags: 'cl', values: 'a', longFlags: [], longValues: [] },
  xargs: { flags: 'oprtxZ0', values: 'aEdIJLnPsS', longFlags: ['null', 'open-tty', 'no-run-if-empty', 'interactive', 'verbose', 'exit', 'show-limits', 'process-slot-var'], longValues: ['arg-file', 'eof', 'delimiter', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars'] },
};
const SHELL_VALUE_OPTS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/** The wrapper's own name, from a bare or path-qualified first word. */
const wrapperName = (w: string): string | null => {
  const base = w.split('/').pop() ?? '';
  return Object.prototype.hasOwnProperty.call(WRAPPERS, base) ? base : null;
};

/** One option word of a wrapper: how many following words it takes (0 or 1), or null when unknown. */
function optionTakes(spec: WrapperSpec, w: string): number | null {
  if (w.startsWith('--')) {
    const [name, ...val] = w.slice(2).split('=');
    if (spec.longValues.includes(name)) return val.length > 0 ? 0 : 1;
    return spec.longFlags.includes(name) ? 0 : null;
  }
  if (spec.digitFlag && /^-\d+$/.test(w)) return 0;
  for (let i = 1; i < w.length; i++) {
    if (spec.values.includes(w[i])) return i === w.length - 1 ? 1 : 0;   // the rest of the word is its value
    if (!spec.flags.includes(w[i])) return null;
  }
  return 0;
}

interface Resolved {
  /** What is left: the command and its arguments, or (opaque) everything after the part not understood. */
  words: string[];
  /** A wrapper option the door does not know was met: the command's position is a guess. */
  opaque: boolean;
  /** The command string of a shell run with -c: classified as a line of its own. */
  shellText?: string;
}

/** Remove leading wrappers AND their own arguments, until the first word left is the program itself. */
function resolveCommand(input: string[]): Resolved {
  const words = [...input];
  while (words.length > 0) {
    const head = words[0];
    if (/^\w+=/.test(head)) { words.shift(); continue; }   // a leading FOO=1 assignment
    const shell = SHELLS.has(head.split('/').pop() ?? '');
    const name = wrapperName(head);
    if (!name && !shell) break;
    words.shift();
    if (shell) {
      // A shell run with -c (alone or in a cluster such as -lc): its next word starts the command text.
      while (words.length > 0 && /^[-+]/.test(words[0]) && words[0] !== '--') {
        const flag = words.shift() as string;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) return { words: [], opaque: false, shellText: unquote(words.join(' ')) };
        if (SHELL_VALUE_OPTS.has(flag)) words.shift();
      }
      return { words: [head, ...words], opaque: false };   // a script or stdin: the shell itself is the program
    }
    const spec = WRAPPERS[name as string];
    let positionals = spec.positionals ?? 0;
    while (words.length > 0) {
      const w = words[0];
      if (w === '--') { words.shift(); break; }
      if (/^\w+=/.test(w) && name === 'env') { words.shift(); continue; }
      if (!w.startsWith('-') || w === '-') break;
      const takes = optionTakes(spec, w);
      if (takes === null) return { words, opaque: true };
      words.shift();
      if (takes === 1) {
        const value = words.shift();
        if (name === 'env' && (w === '-S' || w.startsWith('--split-string')) && value !== undefined) words.unshift(...unquote(value).split(/\s+/).filter(Boolean));
      } else if (name === 'env' && (w.startsWith('-S') || w.startsWith('--split-string=')) && w.length > 2) {
        words.unshift(...unquote(w.replace(/^(?:-S|--split-string=)/, '')).split(/\s+/).filter(Boolean));
      }
    }
    for (; positionals > 0 && words.length > 0; positionals--) words.shift();   // timeout's duration
  }
  return { words, opaque: false };
}

/** What a program (first word) and its operands do to the Dojo's own database or log, or null. */
function classifyWords(words: string[], line: string): DojoLineClass | null {
  const program = (words[0] ?? '').split('/').pop() ?? '';
  const operands = words.slice(1).filter((w) => !w.startsWith('-'));
  if (operands.some(namesDb)) {
    if (WRITES_EVERY_OPERAND.has(program)) return 'write';
    if (WRITES_LAST_OPERAND.has(program) && operands.length > 1 && namesDb(operands[operands.length - 1])) return 'write';
    if (program === 'dd') return operands.some((w) => /^if=/.test(w) && namesDb(w)) ? 'sql' : null;
    if (SQL_PROGRAMS.has(program) && WRITE_STATEMENT.test(line)) return program === 'sqlite3' && !/\.(?:restore|shell|system|open)\b/.test(line) ? 'repair' : 'write';
    if (SQL_PROGRAMS.has(program)) return SCHEMA_LOOK.test(line) ? 'schema' : 'sql';
    if (CONTENT_READERS.has(program)) return 'sql';
  }
  return operands.some(namesLog) && CONTENT_READERS.has(program) ? 'logs' : null;
}

const KNOWN_PROGRAMS = new Set([...SQL_PROGRAMS, ...CONTENT_READERS, ...WRITES_EVERY_OPERAND, ...WRITES_LAST_OPERAND, 'dd']);

/** A segment whose wrapper arguments are not understood: find a program the door knows among its
 *  words; failing that, a segment that names the database or log counts as touching it. */
function classifyUnderstood(words: string[], line: string): DojoLineClass | null {
  for (let i = 0; i < words.length; i++) {
    if (!KNOWN_PROGRAMS.has(words[i].split('/').pop() ?? '')) continue;
    const c = classifyWords(words.slice(i), line);
    if (c) return c;
  }
  if (words.some(namesDb)) return WRITE_STATEMENT.test(line) ? 'write' : 'sql';
  return words.some(namesLog) ? 'logs' : null;
}

/** What one simple command does to the Dojo's own database or log, or null. */
function classifySegment(segment: string, line: string): DojoLineClass | null {
  const r = resolveCommand(segment.trim().split(/\s+/).filter(Boolean));
  if (r.shellText !== undefined) return classifyDojoLine(r.shellText);
  return r.opaque ? classifyUnderstood(r.words, line) : classifyWords(r.words, line);
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

// A plain fact (field fix 3, Mac-belongs round): what the file is and what a write does to it.
const WRITE_REFUSAL = "Refused: dojo.db and its -wal and -shm files are the running Dojo's live database, and a write to them from the shell corrupts it. Reading them is allowed.";
const READ_REFUSAL = "Refused: the Dojo's own database is read through the shell by the main agent and the Healer only; it holds the platform's credential tables.";

/**
 * The refusal for a line that WRITES the live database, or null. Asked only after the broker allowed
 * the line.
 *
 * OWNER RULING OR-MAC-BELONGS-TO-THE-AGENT (2026-10-31, verbatim): "The dojo should be able to save
 * wherever it needs to save and create whatever folders it needs to create anywhere on the Mac.
 * Remember, the Mac belongs to the dojo agent. That's the point." This used to refuse a shell READ of
 * the database or the platform log too (pointing a dojo_inspect holder at the view, and refusing any
 * other agent), and on the owner's box it refused the read-only `grep` and `sqlite3 -readonly` he
 * asked his main agent to run. A read is now allowed for every agent. A write to the live database is
 * still refused for every agent: that is the Dojo protecting itself while it runs, not a fence on the
 * Mac (orchestrator's call, 2026-11-04). The Healer's repair STATEMENTS stay exempt exactly as before.
 * `holdsDojoInspect` is no longer read here; the tools guidance still names the view as a fact.
 */
export function redirectDojoQuestion(agentId: string, line: string): Verdict | null {
  const cls = classifyDojoLine(line);
  if (!cls) return null;
  if (cls === 'repair' && isHealerAgent(agentId)) return null;   // the repair agent's statements (fix rounds 2 and 4)
  if (cls === 'write' || cls === 'repair') return deny('ladder-parity', 'dojo-db-shell-write', 'a shell write to the live Dojo database corrupts it', WRITE_REFUSAL);
  // AUDIT ROUND (#3): the owner's words name the MAIN agent ("the main agent owns the Mac they live
  // in"), so the shell read of the live database is the main agent's and the Healer's. A worker's
  // stays refused, as it was before field fix 3; its read of the platform log is unchanged.
  if (cls === 'logs' || isPrimaryAgent(agentId) || isHealerAgent(agentId)) return null;
  return deny('ladder-parity', 'dojo-db-shell-read', 'the Dojo database is read through the shell by the main agent and the Healer only', READ_REFUSAL);
}
