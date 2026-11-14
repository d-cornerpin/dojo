// Sudo is a policy, not a wall: `blocked | gated | free`, per box, default `gated`.
// Safety: strip sudo, re-authorize the INNER command fully, then apply policy; grants are never widened.

import { getSudoPolicyRaw, isPrimaryAgent } from '../../config/platform.js';
import { INERT_PROGRAMS, SHELL_INTERPRETERS, commandWords, execSimpleCommands, withoutDataBodies } from '../exec-grammar.js';
// types.js is a leaf; proc.ts imports THIS module, so the verdict helpers come from the leaf, not proc.
import { allow, deny, type Verdict } from './types.js';
import {
  SUDO_BLOCKED_REASON, SUDO_INTERACTIVE_SHELL_REASON, SUDO_NOT_PRIMARY_REASON, SUDO_POLICY_DEFAULT,
  SUDO_UNPARSEABLE_REASON, type SudoPolicy,
} from './sudo-copy.js';

/** An unrecognised value reads as the default, never as `free`: a bad row must not widen authority. */
export function getSudoPolicy(): SudoPolicy {
  const raw = getSudoPolicyRaw();
  return raw === 'blocked' || raw === 'gated' || raw === 'free' ? raw : SUDO_POLICY_DEFAULT;
}

// Options that CONSUME the next argument; a missed one leaves its value as the inner command.
const SUDO_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
  '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-U', '--other-user',
  '-r', '--role', '-t', '--type',
]);

/** Options whose VALUE IS THE COMMAND: read it, never skip it; the floor must see this text. */
const COMMAND_OPTS: ReadonlySet<string> = new Set(['-c', '--command']);

/** The value INSIDE the quotes is the command; unlike bareWord it must not come back basenamed. */
function unquoteValue(word: string): string {
  const w = word.startsWith('\\') ? word.slice(1) : word;
  if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) {
    return w.slice(1, -1).trim();
  }
  return w;
}

/** Interactive root-shell options: nothing to authorize, refused under every policy. */
const SUDO_SHELL_OPTS: ReadonlySet<string> = new Set(['-i', '--login', '-s', '--shell']);

/** su's grammar, NOT sudo's: su's `-s` takes a value, and `-c` is su's only command source. */
const SU_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-c', '--command', '-s', '--shell', '-g', '--group', '-G', '--supp-group',
  '-w', '--whitelist-environment',
]);

export interface ParsedSudo {
  readonly inner: string;
  readonly interactiveShell: boolean;
  readonly nonInteractive: boolean;
  /** True when an option's value carried a quote, so the whitespace split cannot be trusted. */
  readonly quotedOptionValue: boolean;
}

/**
 * THE SOUND FLOOR: a privilege token anywhere in the raw line, case-insensitive; may over-report.
 * The set MUST equal PRIVILEGE_PROGRAMS or `$(su ...)` escapes; `sudo` precedes `su`.
 */
const PRIVILEGE_TOKEN_RE =
  /(^|[\s;|&()<>{}`$'"\\/])\\?['"]?(sudo|doas|osascript|su)['"]?($|[\s;|&()<>=]|['"])/i;

export function mentionsPrivilegeToken(raw: string): boolean {
  return PRIVILEGE_TOKEN_RE.test(raw) || mentionsAdminPrivileges(raw);
}

/** The AppleScript admin door, case- and whitespace-liberal: one policy governs every admin door. */
const ADMIN_PRIVILEGES_RE = /\bwith\s+admin(?:istrator)?\s+privileges\b/i;

export function mentionsAdminPrivileges(raw: string): boolean {
  return ADMIN_PRIVILEGES_RE.test(raw);
}

/** Programs that EXEC the next word: a privilege token after one is still in program position. */
const EXEC_WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'command', 'nice', 'nohup', 'timeout', 'time', 'stdbuf', 'setsid', 'xargs', 'ionice',
]);

function bareWord(word: string): string {
  let w = word.startsWith('\\') ? word.slice(1) : word;
  if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) w = w.slice(1, -1);
  return w.includes('/') ? w.slice(w.lastIndexOf('/') + 1) : w;
}

/** THE ONE resolver for the privilege word's index, so recognition and stripping cannot disagree. */
/** Past a wrapper the walk continues; outside one the first program ends it, `echo sudo` being data. */
function wrappedProgramIndex(words: readonly string[], wanted: (bare: string) => boolean): number | null {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const w = bareWord(words[i]).toLowerCase();
    if (wanted(w)) return i;
    if (EXEC_WRAPPERS.has(w)) { wrapped = true; i += 1; continue; }
    if (wrapped) { i += 1; continue; }
    return null;
  }
  return null;
}

/** One walk for every privilege question: two readers of one fact is how wrapper cases escape. */
function privilegeWordIndex(words: readonly string[]): number | null {
  return wrappedProgramIndex(words, (w) => PRIVILEGE_PROGRAMS.has(w));
}

export const PRIVILEGE_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'doas', 'osascript', 'su']);

export function isSudoLine(trimmed: string): boolean {
  const words = commandWords(trimmed);
  const at = privilegeWordIndex(words);
  if (at === null) return false;
  if (bareWord(words[at]).toLowerCase() !== 'osascript') return true;
  if (mentionsAdminPrivileges(trimmed)) return true;
  return osascriptBodyIsUnseeable(words.slice(at + 1));
}

/** An admin-capable interpreter on content the broker cannot read is NOT proven inert: policy governs. */
/** Proving it inert needs a content hash (a TOCTOU window); until that plumbing closes, such bodies hold. */
export function osascriptBodyIsUnseeable(operands: readonly string[]): boolean {
  const body = interpreterBody(['osascript', ...operands].join(' '));
  return body === null ? false : body.kind !== 'readable';
}

const INTERPRETERS: ReadonlySet<string> = new Set([...SHELL_INTERPRETERS, 'eval', 'source', '.']);
const EXECUTING_CONTEXT_RE = /\$\(|\$\{|`/;

/** Default REFUSE: true only when every occurrence is proven inert, by program or by the precise walk. */
export function privilegeTokenIsQuotedData(raw: string, segments: readonly string[]): boolean {
  if (segments.some((seg) => INTERPRETERS.has(bareWord(seg.trim().split(/\s+/)[0] ?? '').toLowerCase()))) {
    return false;
  }
  const occurrences: Array<{ word: string; index: number; program: string; seg: string }> = [];
  for (const seg of segments) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const program = bareWord(words[0] ?? '').toLowerCase();
    words.forEach((word, index) => {
      if (PRIVILEGE_TOKEN_RE.test(word)) occurrences.push({ word, index, program, seg });
    });
    // The phrase spans words, so the per-word scan cannot see it: collect it as ONE occurrence.
    if (mentionsAdminPrivileges(seg)) {
      const at = words.findIndex((w) => /^\W*with$/i.test(w) || /^\W*with\b/i.test(w));
      occurrences.push({ word: seg, index: at <= 0 ? 0 : at, program, seg });
    }
  }
  // Mentioned in the raw line but carried by no word is unproven: an empty conjunction proves nothing.
  if (occurrences.length === 0) return false;
  return occurrences.every((o) => {
    // EXECUTING CONTEXT BINDS FIRST: the tokenizer hands `$(sudo whoami)` back as one word at index 0.
    if (EXECUTING_CONTEXT_RE.test(o.word)) return false;
    if (o.index === 0) return !isSudoLine(o.seg);
    return INERT_PROGRAMS.has(o.program);
  });
}

/** The same two walls: role wall first, policy after; `gated` allows here, its hold is filed upstream. */
export function authorizeAdminPrivilegeRequest(agentId: string): Verdict {
  if (!isPrimaryAgent(agentId)) {
    return deny('ladder-parity', 'admin-privileges-not-primary', SUDO_NOT_PRIMARY_REASON);
  }
  const policy = getSudoPolicy();
  if (policy === 'blocked') {
    return deny('ladder-parity', 'admin-privileges-policy:blocked', SUDO_BLOCKED_REASON);
  }
  return allow(`admin-privileges-policy:${policy}`);
}

/** Strip sudo and its options to what it would run; crude by design, recursing on nested `sudo`. */
export function parseSudo(trimmed: string): ParsedSudo {
  const tokens = commandWords(trimmed);
  const at = privilegeWordIndex(tokens);
  let i = (at ?? 0) + 1;
  let nonInteractive = false;
  let quotedOptionValue = false;
  // su takes a bare USERNAME as its first operand: step over exactly one, then keep reading options.
  const isSu = bareWord(tokens[at ?? 0] ?? '').toLowerCase() === 'su';
  let sawSuUser = false;
  let commandFromOption: string | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { i += 1; break; }
    if (!t.startsWith('-')) {
      if (isSu && !sawSuUser) { sawSuUser = true; i += 1; continue; }   // a USERNAME, not a command
      break;
    }
    if (COMMAND_OPTS.has(t)) {
      // STOP reading options: every later token must reach the check below as itself, not as a flag.
      commandFromOption = unquoteValue(tokens[i + 1] ?? '');
      i += 2; break;
    }
    if (t.startsWith('--command=')) {
      // One option must not have a caught spelling and an uncaught one: `=` gets the same reading as `-c`.
      commandFromOption = unquoteValue(t.slice('--command='.length));
      i += 1; break;
    }
    if (t === '-n' || t === '--non-interactive') { nonInteractive = true; i += 1; continue; }
    if (!isSu && SUDO_SHELL_OPTS.has(t)) {
      // `sudo -i`/`-s` may take a command; nothing after means a shell. su differs: `-s` takes a value.
      const rest = tokens.slice(i + 1).join(' ');
      return rest.length === 0
        ? { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue }
        : finish(rest, nonInteractive, quotedOptionValue);
    }
    if (t.includes('=')) {
      // A quote in ANY option spelling defeats the whitespace split; both forms share one check.
      if (/['"]/.test(t.slice(t.indexOf('=') + 1))) quotedOptionValue = true;
      i += 1; continue;
    }
    if ((isSu ? SU_OPTS_WITH_VALUE : SUDO_OPTS_WITH_VALUE).has(t)) {
      if (/['"]/.test(tokens[i + 1] ?? '')) quotedOptionValue = true;
      i += 2; continue;
    }
    i += 1;                                               // an ordinary boolean flag
  }
  // THE COMMAND OPTION WINS over trailing operands: there the tail is the username, not a command.
  if (commandFromOption !== null) {
    // AT MOST a username may follow the command value; more means this parser fails the line closed.
    const after = tokens.slice(i);
    if (after.length > 1 || after.some((w) => w.startsWith('-'))) quotedOptionValue = true;
    return finish(commandFromOption, nonInteractive, quotedOptionValue);
  }
  const rest = tokens.slice(i).join(' ');
  // `su` WITHOUT `-c` IS A ROOT PROMPT; inner keeps the tail so the floor can name the pattern.
  if (isSu) return { inner: rest, interactiveShell: true, nonInteractive, quotedOptionValue };
  if (rest.length === 0) return { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue };
  return finish(rest, nonInteractive, quotedOptionValue);
}

/** EVERY command a privileged line would run, one interpreter deeper; privileged-only by design. */
export function privilegedInnerCommands(trimmed: string): string[] {
  if (!isSudoLine(trimmed)) return [];
  const parsed = parseSudo(trimmed);
  return parsed.inner.length === 0 ? [] : unwrapBodies(parsed.inner).commands;
}

export interface Unwrapped {
  readonly commands: string[];
  /** A body at ANY depth whose quotes do not balance: what was extracted is not what runs. */
  readonly unparseable: boolean;
  /** A body at ANY depth that is a root prompt or arrives on a stream. */
  readonly interactive: boolean;
}

/** Per operand: a prefix floor misses `rm -rf x /`; privileged only so `echo "rm -rf /"` still works. */
function operandCandidates(words: readonly string[]): string[] {
  if (words.length === 0) return [];
  const [program, ...rest] = words;
  const flags = rest.filter((w) => w.startsWith('-'));
  const operands = rest.filter((w) => !w.startsWith('-'));
  const out: string[] = [];
  for (const operand of operands) {
    if (operands.length > 1) out.push([program, ...flags, operand].join(' '));
    // ONE FLAG AT A TIME too: `rm -rf --no-preserve-root /` has a single operand no splitting reaches.
    for (const flag of flags) out.push([program, flag, operand].join(' '));
  }
  return out;
}

function perOperandCandidates(command: string): string[] {
  return operandCandidates(commandWords(command)).filter((c) => c !== command.trim());
}

/** ONE walk returning commands AND findings; calls no parser above it, or the recursion never ends. */
function unwrapBodies(command: string, depth = 0): Unwrapped {
  const commands: string[] = [];
  let unparseable = false;
  let interactive = false;
  const push = (cmd: string): void => {
    commands.push(cmd);
    commands.push(...perOperandCandidates(cmd));
  };
  // The WHOLE TEXT as well as its segments: a metacharacter split can leave the operand pass nothing.
  if (depth > 0) push(command);
  for (const seg of execSimpleCommands(command)) {
    push(seg);
    const body = interpreterBody(seg);
    if (body === null) continue;
    if (body.kind === 'unparseable') unparseable = true;
    if (body.kind === 'interactive') interactive = true;
    if (depth >= 3 || body.inline === null || body.inline.text.length === 0) continue;
    const deeper: string[] = [];
    if (body.inline.language === 'shell') deeper.push(body.inline.text);
    else {
      const literals = quotedLiterals(body.inline.text);
      deeper.push(...literals);
      // The literals JOINED as well: the argv form spells one command across several of them.
      if (literals.length > 1) deeper.push(literals.join(' '));
    }
    for (const text of deeper) {
      const below = unwrapBodies(text, depth + 1);
      commands.push(...below.commands);
      unparseable = unparseable || below.unparseable;
      interactive = interactive || below.interactive;
    }
  }
  return { commands, unparseable, interactive };
}

/**
 * Quoted runs in a non-shell body ARE the reach: crude, a missed one can be root.
 * Not covered: runtime-built payloads, shell-free language APIs, spellings the floor's 3 patterns lack.
 */
const CODE_INTERPRETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['python', ['-c']], ['python3', ['-c']], ['python2', ['-c']],
  ['perl', ['-e', '-E']], ['ruby', ['-e']], ['node', ['-e', '--eval', '-p', '--print']],
  ['php', ['-r']], ['osascript', ['-e', '--expression']],
]);
const isInterpreterName = (bare: string): boolean =>
  SHELL_INTERPRETERS.has(bare) || CODE_INTERPRETERS.has(bare) || PROGRAM_TEXT_INTERPRETERS.has(bare);

/** `awk`'s program is its first bare operand rather than an option's value. */
const PROGRAM_TEXT_INTERPRETERS: ReadonlySet<string> = new Set(['awk', 'gawk', 'nawk']);

/** Value-taking options to step over; misreading one names a body that is not the body. */
const INTERPRETER_METADATA_OPTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['osascript', ['-l', '--language', '-s']],
  ['sh', ['-o']], ['bash', ['-o', '--rcfile', '--init-file']], ['zsh', ['-o']],
  ['dash', ['-o']], ['ksh', ['-o']], ['ash', ['-o']],
  ['python', ['-W', '-X']], ['python3', ['-W', '-X']], ['python2', ['-W', '-X']],
  ['node', ['-r', '--require', '--input-type']], ['perl', ['-I', '-M']],
  ['ruby', ['-I', '-r']], ['php', ['-d']], ['awk', ['-v', '--assign']],
  ['gawk', ['-v', '--assign']], ['nawk', ['-v', '--assign']],
]);
/** And the options whose value is a PROGRAM FILE: the body, in a place the broker cannot read. */
const INTERPRETER_FILE_OPTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['awk', ['-f', '--file']], ['gawk', ['-f', '--file']], ['nawk', ['-f', '--file']],
  ['php', ['-f']], ['python', ['-m']], ['python3', ['-m']], ['python2', ['-m']],
]);

export interface PrivilegedBody {
  /** `interactive`: a root PROMPT or a STREAM. `unparseable`: what was extracted is not what runs. */
  readonly kind: 'readable' | 'unseeable' | 'interactive' | 'unparseable';
  /** The inline body when there is one, EVEN IF `kind` is not `readable`: the floor still reads it. */
  readonly inline: { readonly language: 'shell' | 'code'; readonly text: string } | null;
}

/** A stream has no name to inspect on a card, so it is refused under every policy, `free` included. */
function isStreamName(word: string): boolean {
  const bare = word.replace(/^['"]|['"]$/g, '');
  return /^\/dev\/(std\w*|fd\/\d+|tty\w*)$/.test(bare);
}

export function interpreterBody(seg: string): PrivilegedBody | null {
  const words = commandWords(seg);
  const at = wrappedProgramIndex(words, isInterpreterName);
  if (at === null) return null;
  const program = bareWord(words[at]).toLowerCase();
  const isShell = SHELL_INTERPRETERS.has(program);
  const bodyOpts = CODE_INTERPRETERS.get(program);
  const programText = PROGRAM_TEXT_INTERPRETERS.has(program);
  const language: 'shell' | 'code' = isShell ? 'shell' : 'code';
  const metadata = INTERPRETER_METADATA_OPTS.get(program) ?? [];
  const fileOpts = INTERPRETER_FILE_OPTS.get(program) ?? [];
  const carriesBody = (word: string): boolean => isShell
    // ANY short-flag cluster CONTAINING `c`: `-lc` and `-cx` carry the same body as `-c`.
    ? (word === '--command' || /^-[a-z]*c[a-z]*$/i.test(word))
    : (bodyOpts?.includes(word) ?? false);
  let inline: { language: 'shell' | 'code'; text: string } | null = null;
  let unreadable: 'stream' | 'file' | null = null;
  for (let w = at + 1; w < words.length; w += 1) {
    const word = words[w];
    const eq = word.indexOf('=');
    if (carriesBody(word)) {
      inline ??= { language, text: unquoteValue(words[w + 1] ?? '') };
      w += 1; continue;
    }
    if (eq > 0 && carriesBody(word.slice(0, eq))) {
      inline ??= { language, text: unquoteValue(word.slice(eq + 1)) };
      continue;
    }
    if (fileOpts.includes(word) || (eq > 0 && fileOpts.includes(word.slice(0, eq)))) {
      unreadable ??= 'file';                                            // the body, but in a file
      if (eq < 0) w += 1;
      continue;
    }
    if (metadata.includes(word)) { w += 1; continue; }                  // a value we do not care about
    if (eq > 0 && metadata.includes(word.slice(0, eq))) continue;
    if (word === '<<<') { inline ??= { language, text: unquoteValue(words[w + 1] ?? '') }; w += 1; continue; }
    // A lone `<` is a process substitution (`bash <(..)`), a pipe nobody can name; `< file` is a file.
    if (word.startsWith('<')) {
      unreadable = words[w + 1] === undefined ? 'stream' : (unreadable ?? 'file');
      continue;
    }
    if (word === '-' || isStreamName(word) || (isShell && word === '-s')) { unreadable = 'stream'; continue; }
    if (word.startsWith('-')) continue;                                 // an ordinary flag
    if (programText) { inline ??= { language, text: unquoteValue(word) }; continue; }
    unreadable ??= 'file';                                              // a FILE operand
  }
  // An escaped quote can split a body across tokens: an unbalanced fragment is refused, not judged.
  if (inline !== null && !quotesBalance(inline.text)) return { kind: 'unparseable', inline };
  if (unreadable === 'stream') return { kind: 'interactive', inline };
  if (unreadable === 'file') return { kind: 'unseeable', inline };
  // No body at all is a root prompt: `sudo sh` is `sudo -i` by another name.
  return inline === null ? { kind: 'interactive', inline: null } : { kind: 'readable', inline };
}

const unescape = (text: string): string => text.replace(/\\(.)/g, '$1');

/** Payload reader ONLY: decodes `\xNN`, unicode and octal escapes; never the mask or the parity test. */
const decodeCharEscapes = (s: string): string => s
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\0([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
  .replace(/\\t/g, '\t');

function quotesBalance(text: string): boolean {
  // A quote operator that never closes counts too: the parity test cannot see one without a stray quote.
  if (scanQuotedText(text).unclosed) return false;
  const bare = unescape(text);
  return (bare.split('"').length - 1) % 2 === 0 && (bare.split("'").length - 1) % 2 === 0;
}

/** All forms spelling a command as text: single, double, backtick (Perl/Ruby/PHP shell calls), q, %q. */
const DELIMITER_PAIRS: ReadonlyMap<string, string> = new Map([['{', '}'], ['(', ')'], ['[', ']'], ['<', '>']]);

const SIMPLE_SPAN_RE = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;

const Q_PAIRED_START_RE = /(?:\b(?:qq|qx|qw|q)|%[qQxXwWiI]?)\s*([{(\[<])/g;

/** And on ANY OTHER delimiter, `qx#...#`: the letter is required, as a bare `%` is usually printf. */
const Q_FREE_START_RE = /(?:\b(?:qq|qx|qw|q)|%[qQxXwWiI])\s*([^\w\s'"`{(\[<])/g;

interface ScannedText {
  readonly literals: string[];
  readonly unclosed: boolean;
}

/** Escapes blanked, SAME LENGTH: the structure scan reads the MASK, the payload reader decodes. */
function maskEscapes(text: string): string {
  return text.replace(/\\[\s\S]/g, (m) => 'X'.repeat(m.length));
}

/** Balanced scan over the MASK, bodies from the SOURCE: an escape must not forge a closer. */
/** TWO READINGS UNIONED: a backslash has two owners (shell: spent; language: live); mask gives unclosed. */
function scanQuotedText(text: string): ScannedText {
  const masked = scanOneReading(text, maskEscapes(text));
  const shellUnescaped = unescape(text);
  const plain = scanOneReading(shellUnescaped, shellUnescaped);
  return {
    literals: [...new Set([...masked.literals, ...plain.literals])],
    unclosed: masked.unclosed,
  };
}

function scanOneReading(src: string, mask: string): ScannedText {
  const literals: string[] = [];
  let unclosed = false;
  const add = (raw: string): void => {
    const decoded = unescape(decodeCharEscapes(raw)).trim();
    if (decoded.length > 0) literals.push(decoded);
  };

  const spans: Array<readonly [number, number]> = [];
  for (const m of mask.matchAll(SIMPLE_SPAN_RE)) {
    const from = (m.index ?? 0) + 1;
    const to = (m.index ?? 0) + m[0].length - 1;
    spans.push([from - 1, to]);
    add(src.slice(from, to));
  }
  const insideSpan = (at: number): boolean => spans.some(([a, b]) => at > a && at < b);

  for (const m of mask.matchAll(Q_PAIRED_START_RE)) {
    if (insideSpan(m.index ?? 0)) continue;
    const open = m[1];
    const close = DELIMITER_PAIRS.get(open) as string;
    const from = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let at = from;
    while (at < mask.length) {
      if (mask[at] === open) depth += 1;
      else if (mask[at] === close) { depth -= 1; if (depth === 0) break; }
      at += 1;
    }
    if (depth > 0) { unclosed = true; add(src.slice(from)); continue; }
    add(src.slice(from, at));
    // The GREEDY reading too: an extra candidate can only ever refuse a floor pattern, never pass one.
    const last = mask.lastIndexOf(close);
    if (last > at) add(src.slice(from, last));
  }

  for (const m of mask.matchAll(Q_FREE_START_RE)) {
    if (insideSpan(m.index ?? 0)) continue;
    const open = m[1];
    const from = (m.index ?? 0) + m[0].length;
    const end = mask.indexOf(open, from);
    if (end < 0) { unclosed = true; add(src.slice(from)); continue; }
    add(src.slice(from, end));
  }

  return { literals, unclosed };
}

function quotedLiterals(text: string): string[] {
  return scanQuotedText(text).literals;
}

function parseInner(rest: string): { inner: string; interactiveShell: boolean; unparseable: boolean } {
  if (isSudoLine(rest)) {
    const again = parseSudo(rest);
    return { inner: again.inner, interactiveShell: again.interactiveShell, unparseable: again.quotedOptionValue };
  }
  const found = unwrapBodies(rest);
  return { inner: rest, interactiveShell: found.interactive, unparseable: found.unparseable };
}

function finish(rest: string, nonInteractive: boolean, quotedOptionValue: boolean): ParsedSudo {
  const p = parseInner(rest);
  return {
    inner: p.inner,
    interactiveShell: p.interactiveShell,
    nonInteractive,
    quotedOptionValue: quotedOptionValue || p.unparseable,
  };
}

/**
 * THE DECISION; the ORDER is the property: inner re-authorized first, role wall next, policy last.
 * The sensitive scan is NOT re-run: it is position-independent and already sees inside a sudo line.
 * `gated` ALLOWS: its hold is filed upstream on the owner's card; a deny would refuse the retry.
 */
export function authorizeSudoLine(
  trimmed: string,
  agentId: string,
  // `reauthorize` is passed in: the broker imports this module, so importing it back would cycle.
  reauthorize: (inner: string) => Verdict,
): Verdict {
  const parsed = parseSudo(trimmed);
  if (parsed.interactiveShell || parsed.inner.length === 0) {
    return deny('ladder-parity', 'sudo-interactive-shell', SUDO_INTERACTIVE_SHELL_REASON);
  }
  // FAIL CLOSED when the parse was defeated: a stray quote hides the inner command from a PREFIX floor.
  if (parsed.quotedOptionValue) {
    return deny('ladder-parity', 'sudo-unparseable-options', SUDO_UNPARSEABLE_REASON);
  }
  const inner = reauthorize(parsed.inner);
  if (!inner.allowed) return inner;
  // Role wall: a non-primary agent's sudo is refused under every policy; policy governs the primary only.
  if (!isPrimaryAgent(agentId)) {
    return deny('ladder-parity', 'sudo-not-primary', SUDO_NOT_PRIMARY_REASON);
  }
  const policy = getSudoPolicy();
  if (policy === 'blocked') return deny('ladder-parity', 'sudo-policy:blocked', SUDO_BLOCKED_REASON);
  return allow(`sudo-policy:${policy}(${inner.rule})`);
}

/** Approval needed only for `gated` plus a privileged line; `blocked` never reaches this point. */
export function isSudoHoldRequired(toolName: string, args: Record<string, unknown>): boolean {
  // String work first: this runs on every tool call; a throwing config read must not down the turn.
  const raw = toolName === 'shell' || toolName === 'applescript_run' ? args.script
    : Array.isArray(args.argv) ? (args.argv as unknown[]).join(' ')
      : args.command;
  if (!(typeof raw === 'string' && raw.length > 0)) return false;
  // SEGMENTED: isSudoLine on the WHOLE script tests only its head word, and `true; sudo x` would run
  // unseen. The SOUND FLOOR decides the hold unless the precise walk proves the mention inert.
  if (mentionsAdminPrivileges(withoutDataBodies(raw))) return getSudoPolicy() === 'gated';
  const segments = execSimpleCommands(raw.trim());
  const privileged = segments.some((seg) => isSudoLine(seg));
  if (!privileged) {
    if (!mentionsPrivilegeToken(withoutDataBodies(raw))) return false;
    if (privilegeTokenIsQuotedData(raw, segments)) return false;
  }
  // The policy decides, and an unreadable policy HOLDS rather than runs: a failed read must not run root.
  try {
    return getSudoPolicy() === 'gated';
  } catch {
    return true;
  }
}

