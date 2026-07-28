// ════════════════════════════════════════
// Shell control-flow grammar, for the exec permission check (EXEC-LOOP).
//
// Owner ruling 2026-07-28, verbatim: "yes an agent should be able to do
// commands. Why wouldn't we allow an agent to do commands if they have shell
// access?" — asked about the permission system refusing
//     for i in $(seq -w 1 20); do echo "=== note-$i.md ==="; cat "…"; done
// with *"Command 'for' is not allowed"*.
//
// The exec check classifies a command line by its FIRST WORD, so the shell's
// own grammar read as a program name. exec runs the line through /bin/zsh
// (agent/tools.ts executeExec), so the construct was always EXECUTABLE; only
// the classifier disagreed. This module answers one question for that
// classifier: which COMMANDS does a control-flow line actually run? The caller
// then checks each of them exactly as it checks a plain line — grammar widens,
// authority does not.
//
// ════ WHAT THIS IS NOT ════
// It is NOT a shell parser and must never be read as one. It knows quoting,
// command substitution, separators and the control-flow keywords, and that is
// all. Everything it cannot name it reports conservatively:
//   · a line with NO control-flow keyword returns null — the caller keeps the
//     first-word behavior it has always had, so nothing about a plain command
//     line moves;
//   · a construct it can find no command inside (grammar plus a substitution,
//     `for i in $(x); do :; done`) returns an EMPTY list, and the caller falls
//     back to the whole line, i.e. the pre-ruling refusal. Deny-by-default for
//     an agent with no shell access survives that way.
// It deliberately does NOT look inside `$( )` / backticks: the check has never
// looked inside a substitution (`echo $(anything)` passes on `echo` today), and
// this ruling is about grammar, not about closing that older hole. Phase 5
// rebuilds exec wholesale and inherits both the ruling and that limitation.
// ════════════════════════════════════════

interface Tok { text: string; op: boolean }

// The words that make a line a CONSTRUCT. Detection uses this set alone, so a
// bare `in` or `!` in an ordinary command line cannot flip the classifier.
const CONSTRUCT_WORDS = new Set([
  'for', 'while', 'until', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'case', 'esac', 'select',
]);

// Grammar words that are skipped when they LEAD a segment. Supersets the above:
// `in`, `time`, `!` and the block braces are grammar too, they just never make a
// line a construct on their own.
const GRAMMAR_WORDS = new Set([...CONSTRUCT_WORDS, 'in', 'time', '!', '{', '}']);

// A segment opening with one of these is a HEADER (`for i in $(seq 1 20)`,
// `case $x in`) — a word list, not a command list. It contributes no command.
const HEADER_WORDS = new Set(['for', 'select', 'case']);

// Builtins that execute no program: conditionals, no-ops, loop plumbing. Without
// them `while [ ... ]` and `if [ ... ]` stay unusable, which would leave the
// ruling half-applied. Deliberately ABSENT: eval, exec, source, `.`, export —
// those run or re-point real code and must be checked like any other command.
const NO_AUTHORITY_WORDS = new Set([
  '[', '[[', ']', ']]', 'test', 'true', 'false', ':', 'break', 'continue', 'read',
]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/;
const REDIRECT_RE = /^\d*(&)?[<>]/;

/** Index just past a quoted span opened at `i` (', " or `). Unterminated → EOL. */
function scanQuoted(line: string, i: number): number {
  const quote = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\' && quote !== "'") { j += 2; continue; }
    if (line[j] === quote) return j + 1;
    j++;
  }
  return line.length;
}

/** Index just past a `(`-opened span at `i`, counting nesting and skipping quotes. */
function scanParens(line: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < line.length) {
    const c = line[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { j = scanQuoted(line, j); continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return line.length;
}

/**
 * Split a command line into word tokens and separator operators. Quoted spans,
 * `$(...)`, `$((...))`, `((...))` and backticks ride inside their word verbatim,
 * so a `;` or a keyword inside a string can never be mistaken for grammar.
 */
function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let i = 0;
  const flushWord = (): void => { if (cur) { toks.push({ text: cur, op: false }); cur = ''; } };

  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line.slice(i, i + 2); i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const end = scanQuoted(line, i); cur += line.slice(i, end); i = end; continue; }
    // `$(...)` / `$((...))` command + arithmetic substitution, and bare `((...))`
    // arithmetic (the C-style `for ((i=0;i<5;i++))` header) — opaque words.
    if (c === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) {
      const end = line[i + 1] === '(' ? scanParens(line, i + 1) : line.indexOf('}', i) + 1 || line.length;
      cur += line.slice(i, end); i = end; continue;
    }
    if (c === '(' && line[i + 1] === '(') { const end = scanParens(line, i); cur += line.slice(i, end); i = end; continue; }
    if (c === ' ' || c === '\t') { flushWord(); i++; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      flushWord();
      const two = line.slice(i, i + 2);
      const isTwo = two === '&&' || two === '||' || two === ';;' || two === '|&';
      toks.push({ text: isTwo ? two : c, op: true });
      i += isTwo ? 2 : 1;
      continue;
    }
    cur += c;
    i++;
  }
  flushWord();
  return toks;
}

/**
 * The command a segment runs, or null when the segment is pure grammar (a loop
 * header, a `then`, a `done`, a bare condition, an assignment, a redirect).
 */
function segmentCommand(seg: Tok[]): string | null {
  let k = 0;
  while (k < seg.length && GRAMMAR_WORDS.has(seg[k].text)) {
    if (HEADER_WORDS.has(seg[k].text)) return null;
    k++;
  }
  // Leading redirections (`done > out.txt`, `2>&1 cmd`): the operator and, when
  // no target is glued to it, the word after it.
  while (k < seg.length && REDIRECT_RE.test(seg[k].text)) {
    const bare = /[<>]$/.test(seg[k].text);
    k += bare ? 2 : 1;
  }
  if (k >= seg.length) return null;
  // Assignments: `i=0` alone is grammar (a counter). Assignments FOLLOWED by a
  // command are left exactly as the classifier saw them before this module
  // existed — the head word is `PATH=/tmp/x`, which no allowlist holds — so a
  // one-shot environment override cannot be used to re-point a permitted name.
  let a = k;
  while (a < seg.length && ASSIGNMENT_RE.test(seg[a].text)) a++;
  if (a >= seg.length) return null;
  if (NO_AUTHORITY_WORDS.has(seg[k].text) || seg[k].text.startsWith('((')) return null;
  return seg.slice(k).map((t) => t.text).join(' ');
}

/**
 * The commands a shell control-flow line actually runs.
 *
 * Returns null when the line uses no control-flow construct — the caller then
 * classifies the line exactly as it always has. Returns an empty array when a
 * construct contains no nameable command; the caller treats that as "fall back
 * to the whole line" rather than "nothing to check".
 */
export function execInnerCommands(command: string): string[] | null {
  const toks = tokenize(command);
  if (!toks.some((t) => !t.op && CONSTRUCT_WORDS.has(t.text))) return null;

  const commands: string[] = [];
  let seg: Tok[] = [];
  const flushSegment = (): void => {
    const cmd = segmentCommand(seg);
    if (cmd) commands.push(cmd);
    seg = [];
  };
  for (const t of toks) {
    if (t.op) flushSegment();
    else seg.push(t);
  }
  flushSegment();
  return commands;
}
