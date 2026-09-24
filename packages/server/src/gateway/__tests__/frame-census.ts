// ════════════════════════════════════════════════════════════════════════════════════════
// THE FRAME-TYPE READER — ONE SCANNER, EVERY FRAME CENSUS (DOJO-REPORT, final review FR-5).
//
// A frame census asks "what CAN this server broadcast", which a behavioural sweep cannot
// answer — a sweep only ever proves what DID fire. So the censuses read source, and a source
// census is only as good as its reader.
//
// ── WHY THIS IS ONE FUNCTION AND NOT ONE PER CENSUS ──
// It used to be two. T4/T5's `github:` census was beaten twice and ended up with a real
// balanced-object scanner and a nineteen-row spelling table; T6/T7's `report:` census was
// written afterwards, described itself as following "T4/T5's pattern", and was a bare
// `/type\s*:\s*['"`](report:[a-z_]+)['"`]/`. Measured side by side on the same inputs, the
// second was blind where the first was loud: `broadcast({ type: 'report:' + kind })`, and any
// type carrying a capital, a digit or a hyphen, were all invisible to it — an unbounded family
// of frame types could have shipped at full green.
//
// The lesson the branch kept re-learning is that a copied INSTRUMENT drifts from its original
// the moment one of the two is improved. So there is one reader, in one place, and each census
// keeps its own fixture table pinning what that reader does with ITS prefix. Improving the
// reader now improves both censuses, and a fixture table in either one can refute it.
//
// ── WHAT IT SEES, AND WHAT IT DECLARES ITSELF BLIND TO ──
// Anchored on `broadcast(` and on a literal object after it. Any quote, any key order, any
// whitespace. Strings are consumed properly, so a brace inside a literal cannot end the object
// early, and depth-1 keys only, so a nested `{ meta: { type: 'x' } }` is not read as a frame
// type. It cannot see a type held in a variable, a literal used as the SUFFIX of a
// concatenation, a quoted key, or a ternary — each of which is pinned as a BLIND row in the
// fixture tables of both callers, so the blindness is a written claim rather than a silence.
//
// It lives under `__tests__/` for a reason that is load-bearing rather than tidy: both censuses
// walk the server source and skip every directory named `__tests__`, so the reader cannot
// appear in its own census.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every frame type a file can `broadcast(…)`, IN EVERY SPELLING THE REPO CAN WRITE.
 *
 * ── T5 / FINDING N2: WHY THIS REPLACED A ONE-LINE REGEX ──
 * The github census used `/broadcast\(\s*\{\s*type:\s*'(github:[^']+)'/`, which sees
 * SINGLE-QUOTED, `type`-FIRST keys and nothing else. `type: "github:x"`, a backtick, and
 * `broadcast({ error, type: 'github:x' })` were all invisible — so the clause that claims to
 * pin "every frame this feature can emit" was silently narrower than its own sentence, and a
 * fifth frame type could have shipped by being punctuated differently. That is the same defect
 * the device-flow file's own literal scanner already had once, and T3's answer to it is the one
 * taken here: a real (small) scanner, plus a FIXTURE TABLE in every caller that pins the
 * spellings it sees and the ones it declares itself blind to.
 *
 * Returns the RAW type strings, unfiltered. Each census filters by its own prefix, which is
 * what lets one reader serve a `github:` census and a `report:` census without either of them
 * inheriting the other's declared set.
 */
export function frameTypesIn(code: string): string[] {
  const out: string[] = [];
  const CALL = 'broadcast(';
  for (let i = code.indexOf(CALL); i !== -1; i = code.indexOf(CALL, i + 1)) {
    let j = i + CALL.length;
    while (j < code.length && /\s/.test(code[j])) j++;
    // `broadcast(frame)` — a variable. Declared blind spot: there is no literal to read.
    if (code[j] !== '{') continue;
    let depth = 0;
    let flat = '';
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === "'" || c === '"' || c === '`') {
        let lit = c;
        for (j++; j < code.length && code[j] !== c; j++) {
          if (code[j] === '\\') { lit += code[j]; j++; if (j >= code.length) break; }
          lit += code[j];
        }
        lit += c;
        flat += depth === 1 ? lit : ' ';
        continue;
      }
      if (c === '{') { depth++; flat += depth === 1 ? '{' : ' '; continue; }
      if (c === '}') { depth--; if (depth === 0) break; flat += ' '; continue; }
      flat += depth === 1 ? c : ' ';
    }
    for (const m of flat.matchAll(/(?:^|[{,\s])type\s*:\s*(['"`])([^'"`]+)\1/g)) out.push(m[2]);
  }
  return out;
}

/**
 * Comments dropped, the way every census in this tree reads a file: a census that counted a
 * file's own documentation as a violation would teach the next author to delete the
 * explanation. An over-read from a TRAILING comment is left in deliberately — it fails SAFE,
 * by forcing a declaration rather than hiding one.
 */
export const codeOf = (text: string): string =>
  text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
