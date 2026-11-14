// THE PROCESS BROKER: the exec permission checks and the sensitive-file scan in one place, asked
// of a resolved command. Refusals: the global exec deny on the WHOLE line before any construct is
// unpacked (so it cannot hide in a for header; sudo is a per-box policy, not a floor item), the
// secrets.yaml substring (every spelling a file_write deny cannot see: tilde, absolute, $HOME,
// basename, inside $() or backticks, either side of a redirect), the sensitive-file command scan.
// Refusal text rides verbatim on the verdict: the agent loop keys retry off [BLOCKED]. Control
// is grammar, not a program: authority runs per simple command, refusal names it; a line naming
// no command is checked whole. Grammar widens; authority does not.

import path from 'node:path';
import { foldPath } from '../fs-case.js';
import { resolveHomePath as resolvePath } from '../path-resolve.js';
import { GLOBAL_EXEC_DENY_SUBSTRINGS, containsSensitiveLocation, isSensitivePath } from './deny.js';
import { lexShellLine, shellUnquoted } from './shell-words.js';
import {
  authorizeSudoLine, isSudoLine, mentionsPrivilegeToken, privilegeTokenIsQuotedData,
  privilegedInnerCommands,
} from './sudo-policy.js';
import { SUDO_UNPLACEABLE_REASON } from './sudo-copy.js';
import { SHELL_INTERPRETERS, execSimpleCommands } from '../exec-grammar.js';
import {
  evaluateRules, matchCommandPattern, matchCommandDenyPattern, type Grant,
} from './grants.js';
import type { ResolvedArgv, ResolvedCommand } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

/** Hard-coded, unoverridable, NOT a grant_rule row: the platform's floor. These three still bite
 *  inside a sudo line under every policy: the wrapper comes off and this pipeline re-runs first. */
const GLOBAL_EXEC_DENY: readonly string[] = ['rm -rf /', 'rm -rf ~', 'chmod 777 *'];

const SENSITIVE_FILE_READING_COMMANDS: ReadonlySet<string> = new Set<string>([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'nl', 'strings', 'sort', 'jq',
  'cp', 'mv', 'rsync', 'scp', // exfiltration shapes
  'sed', 'awk', 'grep', 'rg', 'ag', 'fgrep', 'egrep',
  'xxd', 'od', 'hexdump',
]);

/** Options of readers whose first operand is TEXT (a grep pattern, a sed/awk script): the pattern
 *  is skipped ONLY when every option word is known EXACTLY: forms a table cannot list exist, and a
 *  misread must only widen the scan. Fields: flags = no-value letters; values = letters taking a
 *  value; text/file = the pattern or script / a FILE of it; long names; longNoText = no pattern. */
interface ReaderOptions {
  flags: string; values: string; text: string; file: string;
  longFlags: readonly string[]; longValues: readonly string[]; longText: readonly string[]; longFile: readonly string[];
  longNoText?: readonly string[];
}
const GREP_OPTIONS: ReaderOptions = {
  flags: 'abcEFGHhIiJLlnoOpqRrSsUuVvwxZz', values: 'ABCmdD', text: 'e', file: 'f',
  longFlags: ['ignore-case', 'no-ignore-case', 'invert-match', 'word-regexp', 'line-regexp', 'count', 'files-with-matches', 'files-without-match',
    'line-number', 'no-filename', 'with-filename', 'only-matching', 'quiet', 'silent', 'extended-regexp', 'fixed-strings', 'basic-regexp',
    'perl-regexp', 'recursive', 'dereference-recursive', 'null', 'text', 'byte-offset', 'initial-tab', 'null-data', 'no-messages'],
  longValues: ['include', 'exclude', 'exclude-dir', 'context', 'after-context', 'before-context', 'max-count', 'binary-files', 'label', 'color', 'colour', 'directories', 'devices'],
  longText: ['regexp'], longFile: ['file'],
};
const READER_OPTIONS: Readonly<Record<string, ReaderOptions>> = {
  grep: GREP_OPTIONS, egrep: GREP_OPTIONS, fgrep: GREP_OPTIONS,
  rg: {
    flags: 'abcFHhiIlLnNopqsSuUvwxz0', values: 'ABCmgtTjMrE', text: 'e', file: 'f',
    longFlags: ['files', 'hidden', 'no-ignore', 'ignore-case', 'smart-case', 'case-sensitive', 'fixed-strings', 'word-regexp', 'line-regexp',
      'line-number', 'no-line-number', 'count', 'files-with-matches', 'files-without-match', 'json', 'no-heading', 'heading', 'follow',
      'multiline', 'only-matching', 'invert-match', 'no-messages', 'null', 'text', 'vimgrep', 'with-filename', 'no-filename'],
    longValues: ['glob', 'iglob', 'type', 'type-not', 'threads', 'context', 'after-context', 'before-context', 'max-count', 'color', 'colors',
      'encoding', 'replace', 'max-depth', 'max-filesize', 'sort', 'sortr'],
    longText: ['regexp'], longFile: ['file'], longNoText: ['files', 'type-list'],
  },
  ag: { flags: 'ailLnoQsSUvwz', values: 'ABCmGg', text: '', file: '', longFlags: [], longValues: [], longText: [], longFile: [] },
  ack: { flags: 'hiIlLnovwx', values: 'ABCm', text: '', file: '', longFlags: [], longValues: [], longText: [], longFile: [] },
  sed: {
    flags: 'nrEsuz', values: 'l', text: 'e', file: 'f',
    longFlags: ['quiet', 'silent', 'regexp-extended', 'separate', 'unbuffered', 'null-data', 'debug', 'sandbox', 'posix'],
    longValues: ['line-length'], longText: ['expression'], longFile: ['file'],
  },
  awk: { flags: '', values: 'vF', text: '', file: 'f', longFlags: [], longValues: [], longText: [], longFile: [] },
};

function fileOperands(cmd: string, words: readonly string[]): string[] {
  const spec = READER_OPTIONS[cmd];
  if (!spec) return words.filter((w) => !w.startsWith('-'));
  const values: string[] = [];
  const operands: string[] = [];
  let textGiven = false;
  let unknown = false;
  let operandsOnly = false;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (operandsOnly || !w.startsWith('-') || w === '-') { operands.push(w); continue; }
    if (w === '--') { operandsOnly = true; continue; }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      const value = eq < 0 ? undefined : w.slice(eq + 1);
      if (spec.longText.includes(name)) { textGiven = true; if (value === undefined) k++; continue; }   // the text itself
      if (spec.longFile.includes(name)) { textGiven = true; const v = value ?? words[++k]; if (v !== undefined) values.push(v); continue; }
      if (spec.longValues.includes(name)) { const v = value ?? words[++k]; if (v !== undefined) values.push(v); continue; }
      if (value === undefined && spec.longNoText?.includes(name)) { textGiven = true; continue; }
      if (value === undefined && spec.longFlags.includes(name)) continue;
      unknown = true; continue;
    }
    for (let c = 1; c < w.length; c++) {
      const letter = w[c];
      const rest = (): string | undefined => (c < w.length - 1 ? w.slice(c + 1) : words[++k]);
      if (letter === spec.text) { textGiven = true; if (c === w.length - 1) k++; break; }   // -e TEXT / -eTEXT
      if (letter === spec.file) { textGiven = true; const v = rest(); if (v !== undefined) values.push(v); break; }
      if (spec.values.includes(letter)) { const v = rest(); if (v !== undefined) values.push(v); break; }
      if (!spec.flags.includes(letter)) { unknown = true; break; }
    }
  }
  if (unknown) return [...words];   // an option not known exactly: every word may be a path
  return [...values, ...(textGiven ? operands : operands.slice(1))];
}

/** Readers that always walk a folder, and the option forms that make the others walk one. */
const ALWAYS_RECURSIVE: ReadonlySet<string> = new Set(['rg', 'ag', 'ack', 'mv']);
const RECURSIVE_SHORT: Readonly<Record<string, string>> = { grep: 'rR', egrep: 'rR', fgrep: 'rR', cp: 'rRa', scp: 'r', rsync: 'ra' };
const RECURSIVE_LONG: ReadonlySet<string> = new Set(['recursive', 'dereference-recursive', 'archive']);

/** Does this reader walk the folders it is given? A recursive read reads every file under it, so a
 *  folder holding a sensitive location is refused for it; an unknown long option counts as recursive. */
function readsRecursively(cmd: string, words: readonly string[]): boolean {
  if (ALWAYS_RECURSIVE.has(cmd)) return true;
  const letters = RECURSIVE_SHORT[cmd];
  if (letters === undefined) return false;
  const spec = READER_OPTIONS[cmd];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w === '--') break;
    if (!w.startsWith('-') || w === '-') continue;
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      if (RECURSIVE_LONG.has(name)) return true;
      if (name === 'directories' && (eq < 0 ? words[k + 1] : w.slice(eq + 1)) === 'recurse') return true;
      if (!spec || ![...spec.longFlags, ...spec.longValues, ...spec.longText, ...spec.longFile].includes(name)) return true;
      continue;
    }
    for (let c = 1; c < w.length; c++) {
      if (letters.includes(w[c])) return true;
      if (spec && spec.values.includes(w[c]) && w[c] === 'd' && (c < w.length - 1 ? w.slice(c + 1) : words[k + 1]) === 'recurse') return true;
      if (spec && (spec.values.includes(w[c]) || w[c] === spec.text || w[c] === spec.file)) break;
    }
  }
  return false;
}

/** Copy-style readers whose LAST operand is the destination: written, not read. */
const WRITES_TO_LAST: ReadonlySet<string> = new Set(['cp', 'mv', 'rsync', 'scp']);

function readerReadsSensitive(cmd: string, words: readonly string[]): { blocked: true; reason: string } | null {
  const files = fileOperands(cmd, words);
  const recursive = readsRecursively(cmd, words);
  const destination = WRITES_TO_LAST.has(cmd) && files.length > 1 ? files.length - 1 : -1;
  for (let k = 0; k < files.length; k++) {
    const word = files[k];
    const expanded = resolvePath(word);
    const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (isSensitivePath(abs)) return { blocked: true, reason: `path "${word}" is on the sensitive-files block list` };
    if (recursive && k !== destination && containsSensitiveLocation(abs)) {
      return { blocked: true, reason: `path "${word}" is, or holds, a folder on the sensitive-files block list` };
    }
  }
  return null;
}

/** The same line with its PROGRAM spelled as a basename: an absolute path is the same program, so
 *  the deny asks both spellings. Only DENY normalises; a wider allow is the owner's capability call. */
function basenameNormalized(trimmed: string): string | null {
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (!head.includes('/')) return null;
  const base = path.basename(head);
  if (!base || base === head) return null;
  return base + (firstSpace === -1 ? '' : trimmed.slice(firstSpace));
}

/** Deny over ONE spelling; basis says whether basename normalising added the refusal. */
function globalExecDenyOneSpelling(trimmed: string, basis: 'ladder-parity' | 'bypass-hardening'): Verdict | null {
  for (const pattern of GLOBAL_EXEC_DENY) {
    if (matchCommandDenyPattern(pattern, trimmed)) {
      const prefix = pattern.endsWith(' *') ? pattern.slice(0, -2) : null;
      return deny(
        basis,
        `global-exec-deny:${pattern}`,
        prefix && trimmed !== pattern
          ? `Global deny: command starting with "${prefix}" is prohibited`
          : `Global deny: command "${trimmed}" is prohibited`,
      );
    }
  }
  // Folded so `cat ~/.dojo/Secrets.yaml` (the same file on APFS) is caught.
  return secretsSubstringDeny(trimmed, basis);
}

/** The secrets-file substring over one spelling of the line, one voice for its refusal. */
function secretsSubstringDeny(spelling: string, basis: 'ladder-parity' | 'bypass-hardening'): Verdict | null {
  for (const needle of GLOBAL_EXEC_DENY_SUBSTRINGS) {
    if (foldPath(spelling).includes(needle)) {
      return deny(
        basis,
        `global-exec-substring:${needle}`,
        `Global deny: shell commands cannot read or modify ${needle} — this file holds API keys and is protected. Use Settings → Providers in the dashboard to change credentials.`,
      );
    }
  }
  return null;
}

/** ONE VOICE for the sensitive-read refusal: two places, identical words, different basis. */
function sensitiveReadDeny(reason: string, basis: 'ladder-parity' | 'bypass-hardening'): Verdict {
  return deny(
    basis,
    'exec-sensitive-read',
    reason,
    `[BLOCKED] exec refused: ${reason}. The DOJO never echoes secret files into the conversation. If you need a value from secrets.yaml (API key, OAuth token, etc.), ask the person you are talking to, those values live in process memory only, not in agent context.`,
  );
}

/** SHELL authority for a line (a script, a do shell script payload): every simple command in it needs an allow row;
 *  the deny rows also read `runs`, every command the line runs, a shell's here-document body included. */
export function authorizeShellCommandText(grant: Grant, line: string, commands = execSimpleCommands(line), runs = execSimpleCommands(line, false)): Verdict {
  let verdict = allow('exec-grant');
  for (const command of commands) {
    verdict = authorizeOneCommand(grant, command, 'shell', [line, ...runs]);
    if (!verdict.allowed) break;
  }
  return verdict;
}

/** The deny scan, exported so the AppleScript broker's do shell script payload meets the same floor. */
export function globalExecDeny(trimmed: string): Verdict | null {
  const asTyped = globalExecDenyOneSpelling(trimmed, 'ladder-parity');
  if (asTyped) return asTyped;
  const normalized = basenameNormalized(trimmed);
  if (normalized) {
    const v = globalExecDenyOneSpelling(normalized, 'bypass-hardening');
    if (v) return v;
  }
  return secretsSubstringUnquoted(trimmed);
}

/** The substring is also asked of the UNQUOTED line, never the prefix denies: quoted data stays data. */
function secretsSubstringUnquoted(trimmed: string): Verdict | null {
  const unquoted = shellUnquoted(trimmed);
  if (unquoted === null || unquoted === trimmed) return null;
  return secretsSubstringDeny(unquoted, 'bypass-hardening');
}

/** The tokenized sensitive-path scan, crude on purpose: the substring covers what matters. */
export function commandReadsSensitiveFile(command: string): { blocked: true; reason: string } | { blocked: false } {
  // Same scan over the words as the shell will unquote them, so a path split by quotes is still the path.
  for (const seg of lexShellLine(command)?.segments ?? []) {
    const scan = argvReadsSensitiveFile(seg.words.map((w) => w.value));
    if (scan.blocked) return scan;
  }
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { blocked: false };
  for (let i = 0; i < tokens.length; i++) {
    const cmd = path.basename(tokens[i]);
    if (!SENSITIVE_FILE_READING_COMMANDS.has(cmd)) continue;
    const operands: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j];
      if (arg === '|' || arg === '||' || arg === '&&' || arg === ';' || arg === '>') break;
      operands.push(arg);
    }
    const found = readerReadsSensitive(cmd, operands);
    if (found) return found;
  }
  return { blocked: false };
}

/** One simple command's authority: deny rows on it or on `runs`, the line and all it runs (a deny may span a pipe,
 *  and can only refuse), then allow rows on the command alone, glob on it or its base command. */
function authorizeOneCommand(grant: Grant, command: string, kind: 'proc' | 'shell' = 'shell', runs: readonly string[] = []): Verdict {
  const trimmed = command.trim();
  const lexable = kind === 'proc' || lexShellLine(trimmed) !== null;   // a shell quote left open: only `*` admits it
  const globals = globalExecDeny(trimmed);
  if (globals) return globals;

  // SUDO: a transparent wrapper. Strip it, re-run THIS function over the inner command, policy last.
  if (isSudoLine(trimmed)) return authorizeSudoLine(trimmed, grant.agentId, (i) => authorizeOneCommand(grant, i, kind));

  const baseCommand = trimmed.split(/\s+/)[0];
  const verdict = evaluateRules(grant, kind, (pattern, mode) =>
    mode === 'deny'
      ? [trimmed, ...runs].some((run) => matchCommandDenyPattern(pattern, run.trim()))
      : (lexable || pattern === '*') && matchCommandPattern(pattern, trimmed, baseCommand));

  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  if (verdict.decided && !verdict.allowed) {
    const prefix = verdict.pattern.endsWith(' *') ? verdict.pattern.slice(0, -2) : null;
    return deny(
      'ladder-parity',
      `exec-deny:${verdict.pattern}`,
      prefix && trimmed !== verdict.pattern
        ? `Command denied by agent policy: starts with "${prefix}"`
        : `Command denied by agent policy: "${command}"`,
    );
  }
  const allowedList = (
    kind === 'shell'
      ? (grant.manifest.shell_allow ?? grant.manifest.exec_allow ?? [])
      : (grant.manifest.exec_allow ?? [])
  ).join(', ');
  return deny(
    'ladder-parity',
    kind === 'shell' ? 'no-shell-grant' : 'no-exec-grant',
    `Command "${baseCommand}" is not allowed. Your permitted commands are: ${allowedList}`,
  );
}

/** Programs that are not programs: shell builtins with no binary to run. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set<string>([
  'eval', 'source', '.', 'exec', 'command',
]);

const INLINE_SCRIPT_FLAGS: ReadonlySet<string> = new Set<string>(['-c', '--command', '-lc', '-ic']);

/**
 * INLINE SCRIPT TEXT IS NOT AN ARGUMENT, AND THAT IS THE ONLY THING THE ARGV DOOR REFUSES: `sh -c`
 * is a shell script in argv's clothes, refused over EVERY element (`env FOO=1 sh -c` re-points the
 * program after argv[0] was read). Running a script FILE still runs: refusing it is a capability loss.
 */
function isInlineShellScript(argv: readonly string[]): boolean {
  return argv.some((a) => SHELL_INTERPRETERS.has(path.basename(a))) && argv.some((a) => INLINE_SCRIPT_FLAGS.has(a));
}

/** The argv door. Refusals in order: builtins and -c on the program; global deny and secrets substring
 *  on the rebuilt line; the sensitive-read scan over the elements. Then the proc rows, deny before
 *  allow; no row means deny. */
export function authorizeArgv(grant: Grant, resource: ResolvedArgv): Verdict {
  if (SHELL_BUILTINS.has(resource.base)) {
    return deny(
      'ladder-parity',
      `argv-builtin:${resource.base}`,
      `"${resource.base}" is a shell builtin, not a program`,
      `[BLOCKED] exec refused: "${resource.base}" is a shell builtin, not a program, so there is nothing for exec to run. If you need shell behaviour use the shell tool — shell({script:"…"}) runs the whole line under /bin/zsh.`,
    );
  }
  if (isInlineShellScript(resource.argv)) {
    return deny(
      'ladder-parity',
      'argv-inline-script',
      'exec runs one program with literal arguments; inline shell script text belongs at the shell door',
      `[BLOCKED] exec refused: this is inline shell script text ("-c"), and exec({argv:[…]}) runs one program with literal arguments and no shell — pipes, redirects, loops and substitution do not work there. Use shell({script:"…"}) instead, which runs the whole line under /bin/zsh. Running a script FILE is fine here: exec({argv:["sh","/path/to/script.sh"]}) works.`,
    );
  }

  const globals = globalExecDeny(resource.display);
  if (globals) return globals;

  const scan = argvReadsSensitiveFile(resource.argv);
  if (scan.blocked) {
    return deny(
      'ladder-parity',
      'exec-sensitive-read',
      scan.reason,
      `[BLOCKED] exec refused: ${scan.reason}. The DOJO never echoes secret files into the conversation. If you need a value from secrets.yaml (API key, OAuth token, etc.), ask the person you are talking to, those values live in process memory only, not in agent context.`,
    );
  }

  return authorizeOneCommand(grant, resource.display, 'proc');
}

/** Same scan over a vector: token boundaries come from the caller, no whitespace guess. */
export function argvReadsSensitiveFile(argv: readonly string[]): { blocked: true; reason: string } | { blocked: false } {
  if (argv.length === 0) return { blocked: false };
  for (let i = 0; i < argv.length; i++) {
    const cmd = path.basename(argv[i]);
    if (!SENSITIVE_FILE_READING_COMMANDS.has(cmd)) continue;
    const found = readerReadsSensitive(cmd, argv.slice(i + 1));
    if (found) return found;
  }
  return { blocked: false };
}

/** The command door. scanSensitiveReads keeps the legacy type:'exec' shape (the exact call the
 *  destructive-approval seam records) answering its identical question; the shell door asks ON. */
export function authorizeProc(
  grant: Grant,
  resource: ResolvedCommand,
  scanSensitiveReads = false,
): Verdict {
  // The WHOLE line meets the global deny first: a construct's header is not one of the inner
  // commands, and `secrets.yaml` must not become reachable by hiding it in one.
  const wholeLine = globalExecDeny(resource.trimmed);
  if (wholeLine) return wholeLine;

  if (scanSensitiveReads) {
    const scan = commandReadsSensitiveFile(resource.raw);
    if (scan.blocked) return sensitiveReadDeny(scan.reason, 'ladder-parity');
  }

  // THE PRIVILEGE PASS, BEFORE the grant pass, over EVERY simple command the line contains.
  // 1. the sound floor: a privilege token anywhere in the RAW line, asked before any parse.
  // 2. the precise walk: simple commands from the shared grammar, wrappers unwrapped; a privileged
  //    segment gets full sudo authorization; floor fired and walk placed nothing: UNPLACEABLE, refused.
  const segments = execSimpleCommands(resource.raw);
  const runs = execSimpleCommands(resource.raw, false);
  let privilegedSeen = false;
  for (const seg of runs) {
    // The floor PER SEGMENT, not just the head program of the line (an unoverridable floor must
    // not be escapable by a pipe); its items are the catastrophic only, so this cannot lose a capability.
    const floored = globalExecDeny(seg);
    if (floored) return floored;
    if (!isSudoLine(seg)) continue;
    privilegedSeen = true;
    // The floor again ONE INTERPRETER DEEPER: the pass above floors what the segment grammar can
    // see, and a command inside `sh -c "..."` is one quoted word to that grammar.
    for (const innerCommand of privilegedInnerCommands(seg)) {
      const flooredInner = globalExecDeny(innerCommand);
      if (flooredInner) return flooredInner;
      // The sensitive-read scan for the INNER command too: the outer scan splits the raw line on
      // whitespace: a reader in a quoted span (su root -c "cat ~/.ssh/id_rsa") matches nothing.
      if (!scanSensitiveReads) continue;
      const innerScan = commandReadsSensitiveFile(innerCommand);
      if (innerScan.blocked) return sensitiveReadDeny(innerScan.reason, 'bypass-hardening');
    }
    const v = authorizeSudoLine(seg, grant.agentId, (i) => authorizeOneCommand(grant, i));
    if (!v.allowed) return v;
  }
  if (!privilegedSeen && mentionsPrivilegeToken(resource.raw)) {
    // The token is in the line and no segment owns it: a substitution, a nested quote, an opaque
    // construct. HARMLESS DATA is the one exemption: quoted spans only, and no interpreter runs them.
    if (!privilegeTokenIsQuotedData(resource.raw, segments)) {
      return deny('bypass-hardening', 'sudo-unplaceable', SUDO_UNPLACEABLE_REASON);
    }
  }

  return authorizeShellCommandText(grant, resource.raw, segments, runs);
}

/** THE SHELL DOOR: shell({script}) under /bin/zsh -c, authorizeProc with the scan ON over shell rows. */
export function authorizeShellScript(grant: Grant, resource: ResolvedCommand): Verdict {
  return authorizeProc(grant, resource, true);
}
