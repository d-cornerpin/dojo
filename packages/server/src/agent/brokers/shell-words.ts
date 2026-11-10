// ONE quote-aware reading of a shell line, shared by the doors that ask what a line names:
// a shell rejoins `secr''ets.yaml`, `"secrets".yaml` and `secr\ets.yaml` back into `secrets.yaml`
// before the program sees it, so a check reading the line as typed misses the name.
// dojo-redirect.ts and proc.ts share this one lexer so the two readings cannot drift apart.
// It never builds a command to run; a path assembled while the command runs is beyond any reading.

export interface Word {
  value: string;
  plain: boolean;
  quotedWhole: boolean;
  /** Contains something the shell expands or substitutes ($name, glob, brace, backtick). */
  expands: boolean;
  tilde: boolean;
}
export interface Segment { words: Word[]; text: string; pipedIn: boolean }
export interface Lexed { segments: Segment[]; special: boolean }

/** Split a line into simple commands joined by ; && || | and newlines, or null when a quote is
 *  left open. `special` is set by any redirect, here-doc, subshell, substitution, background job
 *  or comment: syntax the allowlist does not admit on a line that refers to the database. */
export function lexShellLine(line: string): Lexed | null {
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

/** The line as the shell will unquote it: each simple command's words joined by spaces, the
 *  commands joined by ` ; `. Null when a quote is left open (the caller keeps the line as typed). */
export function shellUnquoted(line: string): string | null {
  const lexed = lexShellLine(line);
  return lexed ? lexed.segments.map((seg) => seg.words.map((w) => w.value).join(' ')).join(' ; ') : null;
}
