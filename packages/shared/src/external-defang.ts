// The fence's second line of defence: the opening bracket of anything marker-SHAPED in a body (forged
// opening, look-alike end, any width, case, look-alike letters or invisible padding) becomes "(".
// It runs synchronously on every outside text, in one bounded pass, so a hostile line cannot hold the event loop.

/** Any opening bracket a reader could take for a marker's: ASCII, full-width, and the CJK/math kin. */
export const OPENERS = /[[［【〔〖〘〚⟦⟨⦃⦅⦇⦉⦋⦍⦏⦑⦓⦕⦗]/g;
export const CLOSERS = /[\]］】〕〗〙〛⟧⟩⦄⦆⦈⦊⦌⦎⦐⦒⦔⦖⦘]/g;
/** Invisible characters: soft hyphen, joiners, bidi controls, variation selectors, TAG characters. */
export const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** Cyrillic and Greek letters that look like the Latin letters of a marker, folded to them. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u04AE': 'Y',
  '\u0430': 'a', '\u0435': 'e', '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u04BB': 'h', '\u0501': 'd', '\u0578': 'n',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03BF': 'o', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x',
};
const SMALL_CAPS: Readonly<Record<string, string>> = {
  '\u1D00': 'A', '\u0299': 'B', '\u1D04': 'C', '\u1D05': 'D', '\u1D07': 'E', '\uA730': 'F', '\u0262': 'G', '\u029C': 'H', '\u026A': 'I',
  '\u1D0A': 'J', '\u1D0B': 'K', '\u029F': 'L', '\u1D0D': 'M', '\u0274': 'N', '\u1D0F': 'O', '\u1D18': 'P', '\u0280': 'R', '\uA731': 'S',
  '\u1D1B': 'T', '\u1D1C': 'U', '\u1D20': 'V', '\u1D21': 'W', '\u028F': 'Y', '\u1D22': 'Z', '\u13AC': 'E', '\u13AA': 'A', '\u13DF': 'C',
};
/** Fold one character: invisible vanishes, marks and width forms fold, look-alikes become Latin, lower case. */
const ONE_INVISIBLE = new RegExp(INVISIBLE.source, 'u');
function foldChar(c: string): string {
  if (ONE_INVISIBLE.test(c)) return '';
  return c.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
    .replace(/./gu, (x) => CONFUSABLE[x] ?? SMALL_CAPS[x] ?? x).toLowerCase();
}
const OPENER_CHARS = new Set('[［【〔〖〘〚⟦⟨⦃⦅⦇⦉⦋⦍⦏⦑⦓⦕⦗');
/** A run of separators is ONE symbol: SEP for spaces, `_` and `-`; PUNCT if it also holds `/ \ | * : .`. */
const SEP = '\u0001';
const PUNCT = '\u0002';
const OTHER = '\u0003';
const SEP_CHAR = /[\s_-]/;
const PUNCT_CHAR = /[/\\|*:.]/;
// What follows the bracket in a marker-shaped line, in the folded stream. Its longest match plus one
// look-ahead symbol is DEFANG_LOOKAHEAD, the only stretch a bracket's test reads.
const MARKER_AT = new RegExp(`[${SEP}${PUNCT}]?(?:(?:end|close|closing|stop)${SEP}?(?:of${SEP}?)?(?:the${SEP}?)?)?external(?![a-z])`, 'y');

/** The longest marker (24 symbols) plus one symbol for the `(?![a-z])` look-ahead. */
const DEFANG_LOOKAHEAD = 1 + 7 + 1 + 2 + 1 + 3 + 1 + 8 + 1;

// One pass: each character is folded once, so padding of any length cannot hide a marker, and each bracket
// reads only a bounded stretch after it. A marker never spans a line end.
export function defangExternalMarkers(body: string): string {
  const parts: string[] = [];
  let len = 0;
  let run = '';   // the separator run being read: '', SEP or PUNCT (written once it ends)
  const put = (sym: string): void => {
    if (run !== '') { parts.push(run); len += 1; run = ''; }
    parts.push(sym);
    len += sym.length;
  };
  const symbol = (d: string): void => {
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
  if (at.length === 0) return body;
  if (run !== '') parts.push(run);
  const stream = parts.join('');
  let out = '';
  let from = 0;
  for (let k = 0; k < at.length; k++) {
    const window = stream.slice(next[k], next[k] + DEFANG_LOOKAHEAD);
    MARKER_AT.lastIndex = 0;
    if (!MARKER_AT.test(window)) continue;
    out += `${body.slice(from, at[k])}(`;
    from = at[k] + 1;
  }
  return out + body.slice(from);
}
