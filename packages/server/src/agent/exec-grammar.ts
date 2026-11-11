// Shell control-flow grammar, for the exec permission check: it classifies a command
// line by its FIRST WORD, so the shell's own grammar reads as a program name, yet exec
// runs the line through /bin/zsh, so the construct was always EXECUTABLE. This answers
// which COMMANDS a control-flow line actually runs; each is checked exactly as a plain
// line. Grammar widens, authority does not. NOT a shell parser: null when no keyword
// (plain behavior), EMPTY when a construct hides no command (the caller re-checks the
// whole line, deny-by-default survives), and never inside `$( )` or backticks.

interface Tok { text: string; op: boolean }

// Detection uses these words alone, so a bare `in` or `!` in a plain line flips nothing.
const CONSTRUCT_WORDS = new Set([
  'for', 'while', 'until', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'case', 'esac', 'select',
]);

const GRAMMAR_WORDS = new Set([...CONSTRUCT_WORDS, 'in', 'time', '!', '{', '}']);

// A segment opening with these is a HEADER (a word list): it contributes no command.
const HEADER_WORDS = new Set(['for', 'select', 'case']);

// Builtins that execute no program; without them `while [ ... ]` is unusable.
// ABSENT on purpose: eval, exec, source, `.`, export run or re-point real code.
const NO_AUTHORITY_WORDS = new Set([
  '[', '[[', ']', ']]', 'test', 'true', 'false', ':', 'break', 'continue', 'read',
]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/;
const REDIRECT_RE = /^\d*(&)?[<>]/;

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

/** Words and separators; quoted spans ride verbatim, so grammar inside a string is never grammar. */
function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let i = 0;
  const flushWord = (): void => { if (cur) { toks.push({ text: cur, op: false }); cur = ''; } };

  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line.slice(i, i + 2); i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const end = scanQuoted(line, i); cur += line.slice(i, end); i = end; continue; }
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

/** The command a segment runs, or null when it is pure grammar: a loop header, a
 *  `then`, a `done`, a bare condition, an assignment, a redirect. */
function segmentCommand(seg: Tok[]): string | null {
  let k = 0;
  while (k < seg.length && GRAMMAR_WORDS.has(seg[k].text)) {
    if (HEADER_WORDS.has(seg[k].text)) return null;
    k++;
  }
  while (k < seg.length && REDIRECT_RE.test(seg[k].text)) {
    const bare = /[<>]$/.test(seg[k].text);
    k += bare ? 2 : 1;
  }
  if (k >= seg.length) return null;
  // `i=0` alone is grammar. An assignment FOLLOWED by a command keeps its head word
  // (`PATH=/tmp/x`), which no allowlist holds: an override cannot re-point a name.
  let a = k;
  while (a < seg.length && ASSIGNMENT_RE.test(seg[a].text)) a++;
  if (a >= seg.length) return null;
  if (NO_AUTHORITY_WORDS.has(seg[k].text) || seg[k].text.startsWith('((')) return null;
  return seg.slice(k).map((t) => t.text).join(' ');
}

/** Words of one simple command, quoted spans whole. Shared with sudo-policy: never split on whitespace. */
export function commandWords(command: string): string[] {
  return tokenize(command).filter((t) => !t.op).map((t) => t.text);
}

/** EVERY SIMPLE COMMAND THE LINE CONTAINS: the FLOOR and sudo view, unlike
 *  `execInnerCommands`' GRANT QUESTION. Widening that one changes what an agent may run;
 *  this one can only refuse, never take away a legitimate capability. */
export function execSimpleCommands(command: string): string[] {
  const toks = tokenize(command);
  const commands: string[] = [];
  let seg: Tok[] = [];
  const flush = (): void => {
    const cmd = segmentCommand(seg);
    if (cmd) commands.push(cmd);
    seg = [];
  };
  for (const t of toks) {
    if (t.op) flush();
    else seg.push(t);
  }
  flush();
  return commands.length > 0 ? commands : [command.trim()];
}

/** The commands a control-flow line runs; null with no construct, empty when it names none. */
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
