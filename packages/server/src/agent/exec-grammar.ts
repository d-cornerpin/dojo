// Shell control-flow grammar, for the exec permission check: which simple COMMANDS a line
// runs, across separators, constructs, subshells and the bodies of `$( )` and backticks; each
// is checked exactly as a plain line. Grammar widens, authority does not. NOT a shell parser:
// a line naming no command comes back whole, so deny-by-default survives.

interface Tok { text: string; op: boolean }

const GRAMMAR_WORDS = new Set([
  'for', 'while', 'until', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'case', 'esac', 'select',
  'in', 'time', '!', '{', '}',
]);

// A segment opening with these is a HEADER (a word list): it contributes no command.
const HEADER_WORDS = new Set(['for', 'select', 'case']);

// Builtins that execute no program; without them `while [ ... ]` is unusable.
// ABSENT on purpose: eval, exec, source, `.`, export run or re-point real code.
const NO_AUTHORITY_WORDS = new Set([
  '[', '[[', ']', ']]', 'test', 'true', 'false', ':', 'break', 'continue', 'read',
]);

/** The shells, whose `-c` text is a script; and the programs that never run their input or arguments as code. */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox']);
export const INERT_PROGRAMS: ReadonlySet<string> = new Set(['echo', 'printf', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'comm', ':', 'true', 'false']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/;
const REDIRECT_RE = /^\d*(&)?[<>]/;

/** An unescaped `$` at k: it opens `$'...'` and `${ }`; `\\$` is a plain character. */
const dollarAt = (line: string, k: number): boolean => line[k] === '$' && /^(\\\\)*$/.test(/\\*$/.exec(line.slice(0, k))![0]);

function scanQuoted(line: string, i: number): number {
  const quote = line[i];
  const escapes = quote !== "'" || dollarAt(line, i - 1);   // `$'...'` reads backslash escapes, `'...'` does not
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\' && escapes) { j += 2; continue; }
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
    if (c === line[i] && (c !== '{' || dollarAt(line, j - 1))) depth++;
    else if (c === (line[i] === '{' ? '}' : ')')) { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return line.length;
}

const HEREDOC_RE = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2(?=[ \t\n;&|<>()]|$)/;

/** Words and separators; quoted spans, `$( )`, `${ }`, `(( ))` ride verbatim and a `#` word comments out its line. A here-document
 *  body is cut out and returned to be read on its own when unquoted with `$( )` or a backtick, or not `data`. */
function tokenize(line: string, data = true): { toks: Tok[]; text: string; bodies: string[] } {
  const toks: Tok[] = [];
  let cur = '';
  let i = 0;
  let rawEnd = false;
  const flushWord = (): void => { if (cur) { toks.push({ text: cur, op: false }); cur = ''; } };
  const heredocs: RegExpExecArray[] = [];
  const bodies: string[] = [];

  while (i < line.length) {
    const c = line[i];
    if (c === '<' && !line.includes("$'") && line[i - 1] !== '<') { const h = HEREDOC_RE.exec(line.slice(i)); if (h) heredocs.push(h); }
    if (c === '\n' && heredocs.length > 0) {
      const rest = line.slice(i + 1).split('\n');
      let k = 0;
      for (const [, dash, quote, delim] of heredocs.splice(0)) {
        const first = k;
        while (k < rest.length && (dash ? rest[k].replace(/^\t+/, '') : rest[k]) !== delim) k++;
        const body = rest.slice(first, k++).join('\n');
        if ((quote === '' && /\$\(|`/.test(body)) || !data) bodies.push(body);
      }
      line = line.slice(0, i + 1) + rest.slice(k).join('\n');
    }
    const redirect = rawEnd && /[<>]$/.test(cur);   // the word so far ends in an unquoted redirect sign
    rawEnd = false;
    if (c === '#' && cur === '') { const nl = line.indexOf('\n', i); i = nl < 0 ? line.length : nl; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line.slice(i, i + 2); i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const end = scanQuoted(line, i); cur += line.slice(i, end); i = end; continue; }
    if ((c === '$' && '({'.includes(line[i + 1] ?? '-')) || (c === '(' && line[i + 1] === '(')) { const end = scanParens(line, c === '$' ? i + 1 : i); cur += line.slice(i, end); i = end; continue; }
    if (c === ' ' || c === '\t') { flushWord(); i++; continue; }
    // `2>&1`, `&>file` and `>|file` are redirects, not a background job or a pipe.
    if ((c === '&' && (redirect || line[i + 1] === '>')) || (c === '|' && redirect && cur.endsWith('>'))) { cur += c; i++; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      flushWord();
      const two = line.slice(i, i + 2);
      const isTwo = two === '&&' || two === '||' || two === ';;' || two === '|&';
      toks.push({ text: isTwo ? two : c, op: true });
      i += isTwo ? 2 : 1;
      continue;
    }
    cur += c;
    rawEnd = true;
    i++;
  }
  flushWord();
  return { toks, text: line, bodies };
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
  return tokenize(command).toks.filter((t) => !t.op).map((t) => t.text);
}

/** The text inside each `$( )` and backtick span of one word; single-quoted spans and `$(( ))`
 *  arithmetic are not commands, a substitution nested in arithmetic still is. */
function substitutionBodies(word: string): string[] {
  const bodies: string[] = [];
  let doubleQuoted = false;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === '\\') i++;
    else if (c === '"') doubleQuoted = !doubleQuoted;
    else if (c === "'" && !doubleQuoted) i = scanQuoted(word, i) - 1;
    else if (c === '`') { const end = scanQuoted(word, i); bodies.push(word.slice(i + 1, end - 1)); i = end - 1; }
    else if (c === '$' && word[i + 1] === '(' && word[i + 2] !== '(') { const end = scanParens(word, i + 1); bodies.push(word.slice(i + 2, end - 1)); i = end - 1; }
  }
  return bodies;
}

/** Bodies are data only when the whole line is one inert command writing its one here-document to one literal file. */
export function bodiesAreData(line: string): boolean {
  const { toks } = tokenize(line);
  const words = toks.filter((t) => !t.op).map((t) => t.text);
  const redirects = words.filter((w) => /^\d*[<>&]/.test(w));
  const out = redirects.find((w) => !w.startsWith('<<')) ?? '';
  const file = /^1?>[>|]?/.test(out) ? out.replace(/^1?>[>|]?/, '') || words[words.indexOf(out) + 1] : '';
  return INERT_PROGRAMS.has(words[0]) && redirects.length === 2 && toks.every((t, n) => !t.op || (t.text === '\n' && n >= words.length))
    && /^(?!(.*\/)?dev\/)(~\/)?[\w./@%+,:=-]+$/i.test(file ?? '');
}

/** The line with every body the floor skips cut out: where a privilege token is looked for. */
export const withoutDataBodies = (line: string): string => { const t = tokenize(line, bodiesAreData(line)); return [t.text, ...t.bodies].join('\n'); };

/** EVERY SIMPLE COMMAND THE LINE CONTAINS, substitution bodies included: what the floor, the
 *  sudo policy and the grant rows are each asked of. The floor reads every body unless `bodiesAreData`. */
export function execSimpleCommands(command: string, cutBodies = true, data = cutBodies || bodiesAreData(command)): string[] {
  const { toks, bodies } = tokenize(command, data);
  const commands: string[] = [];
  let seg: Tok[] = [];
  const flush = (): void => {
    const cmd = segmentCommand(seg);
    if (cmd) commands.push(cmd);
    seg = [];
  };
  for (const t of toks) {
    if (t.op) { flush(); continue; }
    seg.push(t);
    for (const body of substitutionBodies(t.text)) commands.push(...execSimpleCommands(body, cutBodies, cutBodies));
  }
  flush();
  for (const body of bodies) commands.push(...execSimpleCommands(body, cutBodies));
  return commands.length > 0 ? commands : [command.trim()];
}
