// ════════════════════════════════════════════════════════════════════════════
// THE FENCE'S SECOND LINE OF DEFENCE (v3.5 K33): marker-SHAPED text in a body loses its bracket.
//
// The fence's own code (external-content.ts) is what makes its end unforgeable; this turns the
// opening bracket of anything that LOOKS like a fence line (a forged opening, a look-alike end, in
// any width, case, look-alike letters or invisible padding) into "(", so a reader is not misled by
// it either. It runs on every outside text the door admits, synchronously, so it reads each body
// once (fix round 4, ruling 1: one hostile line had held the event loop for seconds per 10 KB).
// ════════════════════════════════════════════════════════════════════════════

/** Any opening bracket a reader could take for a marker's: ASCII, full-width, and the CJK/math kin. */
export const OPENERS = /[[［【〔〖〘〚⟦⟨⦃⦅⦇⦉⦋⦍⦏⦑⦓⦕⦗]/g;
export const CLOSERS = /[\]］】〕〗〙〛⟧⟩⦄⦆⦈⦊⦌⦎⦐⦒⦔⦖⦘]/g;
/** Characters a reader does not see: soft hyphen, joiners and marks, bidi embeddings, overrides and
 *  ISOLATES, the Mongolian and Khmer invisibles, Hangul fillers, variation selectors (both planes)
 *  and the TAG characters (the known "ASCII smuggling" carrier). */
export const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** Cyrillic and Greek letters that look like the Latin letters of a marker, folded to them. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u04AE': 'Y',
  '\u0430': 'a', '\u0435': 'e', '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u04BB': 'h', '\u0501': 'd', '\u0578': 'n',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03BF': 'o', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x',
};
/** Small capitals (U+1D00 block and kin) as the capitals they imitate (fix round 3, N7). */
const SMALL_CAPS: Readonly<Record<string, string>> = {
  '\u1D00': 'A', '\u0299': 'B', '\u1D04': 'C', '\u1D05': 'D', '\u1D07': 'E', '\uA730': 'F', '\u0262': 'G', '\u029C': 'H', '\u026A': 'I',
  '\u1D0A': 'J', '\u1D0B': 'K', '\u029F': 'L', '\u1D0D': 'M', '\u0274': 'N', '\u1D0F': 'O', '\u1D18': 'P', '\u0280': 'R', '\uA731': 'S',
  '\u1D1B': 'T', '\u1D1C': 'U', '\u1D20': 'V', '\u1D21': 'W', '\u028F': 'Y', '\u1D22': 'Z', '\u13AC': 'E', '\u13AA': 'A', '\u13DF': 'C',
};
/** One character folded on its own: invisible → nothing; marks stripped (decompose, drop every
 *  mark); width and compatibility forms folded; look-alike letters mapped to Latin; lower case. */
const ONE_INVISIBLE = new RegExp(INVISIBLE.source, 'u');
function foldChar(c: string): string {
  if (ONE_INVISIBLE.test(c)) return '';
  return c.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
    .replace(/./gu, (x) => CONFUSABLE[x] ?? SMALL_CAPS[x] ?? x).toLowerCase();
}
const OPENER_CHARS = new Set('[［【〔〖〘〚⟦⟨⦃⦅⦇⦉⦋⦍⦏⦑⦓⦕⦗');
/** In the folded stream a run of separators is ONE symbol: SEP when it holds only spaces, `_` and
 *  `-` (allowed between the words), PUNCT when it also holds `/ \ | * : .` (allowed only right
 *  after the bracket). A literal SEP/PUNCT character in the body is read as an ordinary symbol. */
const SEP = '\u0001';
const PUNCT = '\u0002';
const OTHER = '\u0003';
const SEP_CHAR = /[\s_-]/;
const PUNCT_CHAR = /[/\\|*:.]/;
/** What follows the bracket in anything marker-shaped, in the folded stream: `/`, `END OF THE`, …
 *  EXTERNAL, not followed by a letter. Its longest match is one lead run + `closing` + run + `of` +
 *  run + `the` + run + `external` = 1+7+1+2+1+3+1+8 = 24 symbols, plus one symbol of look-ahead:
 *  that bounded stretch is all a bracket's test reads (an arithmetic consequence of the marker
 *  format, not a limit), so the defang costs one pass over the body. */
const MARKER_AT = new RegExp(`[${SEP}${PUNCT}]?(?:(?:end|close|closing|stop)${SEP}?(?:of${SEP}?)?(?:the${SEP}?)?)?external(?![a-z])`, 'y');

/** The most symbols of the folded stream a bracket's test can read: the 24 of the longest marker
 *  (1 lead + 7 `closing` + 1 + 2 `of` + 1 + 3 `the` + 1 + 8 `external`) plus the one symbol the
 *  `(?![a-z])` look-ahead reads. The test is handed exactly this stretch, so it cannot read more. */
export const DEFANG_LOOKAHEAD = 1 + 7 + 1 + 2 + 1 + 3 + 1 + 8 + 1;

/** An optional running count of the work the defang does, for the test that proves it is linear:
 *  one step per body character read, per folded symbol it yields, per character of the folded
 *  stream written, per character a bracket's test is handed, and per character copied out. */
export interface DefangTally { steps: number }

/** Turn the opening bracket of anything marker-shaped in `body` into "(". Nothing else changes.
 *  Fix round 4 (ruling 1): ONE pass. Each character is folded once into a stream in which invisible
 *  characters and marks vanish and every run of separators is one symbol, so no padding or
 *  invisible run, of any length, can push the word out of view — and each bracket is decided by
 *  reading only the bounded stretch after it. A marker never spans a line end. */
export function defangExternalMarkers(body: string): string {
  return defang(body);
}

/** The same defang, adding its work to `tally` (the output is byte-identical; see the test). */
export function defangExternalMarkersCounting(body: string, tally: DefangTally): string {
  return defang(body, tally);
}

function defang(body: string, tally?: DefangTally): string {
  let work = 0;   // a plain local: counting costs one add per step, and nothing when no tally is given
  const parts: string[] = [];
  let len = 0;
  let run = '';   // the separator run being read: '', SEP or PUNCT (written once it ends)
  const put = (sym: string): void => {
    if (run !== '') { parts.push(run); len += 1; run = ''; }
    parts.push(sym);
    len += sym.length;
  };
  const symbol = (d: string): void => {
    work++;
    if (SEP_CHAR.test(d)) run = run === PUNCT ? PUNCT : SEP;
    else if (PUNCT_CHAR.test(d)) run = PUNCT;
    else put(d === SEP || d === PUNCT ? OTHER : d);
  };
  const at: number[] = [];     // each bracket's offset in the body …
  const next: number[] = [];   // … and where the stream after it starts
  const folded = new Map<string, string>();   // this body's distinct characters, folded once each
  for (let i = 0; i < body.length;) {
    const cp = body.codePointAt(i) as number;
    const c = cp > 0xFFFF ? body.slice(i, i + 2) : body[i];
    work++;
    if (c === '\n') put(c);
    else if (OPENER_CHARS.has(c)) { put(c); at.push(i); next.push(len); }
    else if (cp < 0x80) symbol(c.toLowerCase());
    else {
      let f = folded.get(c);
      if (f === undefined) { f = foldChar(c); folded.set(c, f); }
      for (const d of f) symbol(d);
    }
    i += c.length;
  }
  if (at.length === 0) { if (tally) tally.steps += work; return body; }
  if (run !== '') parts.push(run);
  const stream = parts.join('');
  work += stream.length;
  let out = '';
  let from = 0;
  for (let k = 0; k < at.length; k++) {
    const window = stream.slice(next[k], next[k] + DEFANG_LOOKAHEAD);
    work += window.length;
    MARKER_AT.lastIndex = 0;
    if (!MARKER_AT.test(window)) continue;
    out += `${body.slice(from, at[k])}(`;
    from = at[k] + 1;
  }
  const result = out + body.slice(from);
  work += result.length;
  if (tally) tally.steps += work;
  return result;
}
