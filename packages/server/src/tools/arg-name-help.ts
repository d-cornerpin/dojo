import { canonicalToken, editDistance } from './name-help.js';

// ── B11 (#22) — the argument NAMES a call probably meant ───────────────────
// The sibling of `suggestToolNames`, one level down: a call whose every argument
// is unknown gets the declared name each one is closest to. Lexical only, for the
// same reason as the tool-name scorer above (no synonym table, no guessing what a
// word "means"): an edit distance of two or less, or a shared stem — a whole
// underscore-separated word, singularized ("labels" is the tail of "add_labels").
// One-and-two-letter words never count as a stem ("id" is in half the schemas).

function argTokens(name: string): string[] {
  return name.toLowerCase().split('_').filter((t) => t.length >= 3).map(canonicalToken);
}

/**
 * For each unknown argument name, the declared name(s) it most likely meant. A
 * close spelling wins over a shared stem; a stem that fits several declared names
 * (`labels` ~ `add_labels`, `remove_labels`) returns every one, in declared order,
 * rather than picking one. An argument with nothing close returns nothing.
 */
export function suggestArgNames(
  unknown: string[],
  declared: readonly string[],
): Array<{ given: string; meant: string }> {
  const out: Array<{ given: string; meant: string }> = [];
  for (const given of unknown) {
    const g = given.toLowerCase();
    let bestDistance = Infinity;
    let close: string[] = [];
    for (const d of declared) {
      const dl = d.toLowerCase();
      if (Math.min(g.length, dl.length) < 4) continue;
      const distance = editDistance(g, dl);
      if (distance > 2) continue;
      if (distance < bestDistance) { bestDistance = distance; close = [d]; }
      else if (distance === bestDistance) close.push(d);
    }
    let meant = close;
    if (meant.length === 0) {
      const givenTokens = new Set(argTokens(given));
      meant = declared.filter((d) => argTokens(d).some((t) => givenTokens.has(t)));
    }
    for (const m of meant) out.push({ given, meant: m });
  }
  return out;
}
