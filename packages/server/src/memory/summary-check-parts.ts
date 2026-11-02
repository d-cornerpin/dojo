// ════════════════════════════════════════════════════════════════════════════
// v3.5 B4, fix round 4 (NB-4) — THE SUMMARY CHECK OVER A SOURCE LARGER THAN THE DECISION MODEL'S WINDOW
// (split from `summary-check.ts`): its parts, and the parts' verdicts as one.
// ════════════════════════════════════════════════════════════════════════════

import { MAX_DECISION_BODY_BYTES, decide, type Answer, type DecideOpts, type FailureClass, type Question } from '../agent/decide.js';
import { decideCountedBytes, fencedState } from '../agent/decide-sizing.js';
import { NUM_CTX_MARGIN_TOKENS } from '../agent/utility-dial.js';

// ── NB-4 (fix round 4): A SOURCE LARGER THAN THE DECISION MODEL'S WINDOW IS CHECKED IN PARTS, NEVER CUT ──
// The window is `decisionWindowTokens()` — the derived tag's real window, the number the memory fit sets aside.
// t268 ruling 2: a part fits that window counted at this box's density (`charsPerToken`, B5 measured ~2.5, not
// 4) less the template slack every window carries (`NUM_CTX_MARGIN_TOKENS`), AND Ollama's 64 KiB body limit
// (measured: HTTP 413), counted as Ollama counts them (`decideCountedBytes`; proof-fix P). A part is as many whole rows (the `---`
// lines the callers join rows with) as fit beside the summary and the questions; a single row larger than that
// is split by characters. Joined back with the same separator, the parts are exactly the source.
const ROW_SEPARATOR = '\n---\n';
/** A text's bytes inside the JSON body (escapes included), without its quotes: additive over concatenation. */
const bodyBytes = (t: string): number => Buffer.byteLength(JSON.stringify(t)) - 2;
/** The source's parts, or null when the summary alone leaves no room. */
export function sourceParts(
  source: string, summary: string, windowTokens: number, questions: Record<string, Question>, charsPerToken: number,
): string[] | null {
  // Everything the request carries but the part, with `source_part` at its widest (no more parts than characters).
  const frame = { source_rows: '', summary, source_part: `${source.length} of ${source.length}` };
  const charRoom = Math.floor((windowTokens - NUM_CTX_MARGIN_TOKENS) * charsPerToken)
    - JSON.stringify(fencedState(frame)).length - JSON.stringify(questions).length;
  const byteRoom = MAX_DECISION_BODY_BYTES - decideCountedBytes(frame, questions);
  if (charRoom <= 0 || byteRoom <= 0) return null;
  const fits = (chars: number, bytes: number): boolean => chars <= charRoom && bytes <= byteRoom;
  if (fits(source.length, bodyBytes(source))) return [source];
  const sep = bodyBytes(ROW_SEPARATOR);
  const parts: string[] = [];
  let current: { text: string; bytes: number } | null = null;
  for (const piece of source.split(ROW_SEPARATOR)) {
    const bytes = bodyBytes(piece);
    if (current && fits(current.text.length + ROW_SEPARATOR.length + piece.length, current.bytes + sep + bytes)) {
      current = { text: current.text + ROW_SEPARATOR + piece, bytes: current.bytes + sep + bytes };
      continue;
    }
    if (current) parts.push(current.text);
    if (fits(piece.length, bytes)) { current = { text: piece, bytes }; continue; }
    // One row larger than the room: split by characters (the longest slice that fits both), the last slice carried on.
    let rest = piece;
    while (!fits(rest.length, bodyBytes(rest))) {
      // Fix round 1 (M-1): not even one character fits the bytes left: no parts (recorded unavailable), never a spin.
      if (bodyBytes(rest.slice(0, 1)) > byteRoom || bodyBytes(rest.slice(0, 2)) > byteRoom && /[\uD800-\uDBFF]/.test(rest[0])) return null;
      let n = Math.min(rest.length, charRoom);
      while (bodyBytes(rest.slice(0, n)) > byteRoom) n = Math.max(1, Math.min(n - 1, Math.floor((n * byteRoom) / bodyBytes(rest.slice(0, n)))));
      if (n > 1 && /[\uD800-\uDBFF]/.test(rest[n - 1])) n--;   // never between the two halves of one character
      parts.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    current = { text: rest, bytes: bodyBytes(rest) };
  }
  if (current) parts.push(current.text);
  return parts;
}

/**
 * The parts' verdicts as one (fix round 5, NB4-6: stated, not implied).
 *   · "dropped" and "stated_current": the HIGHEST part score. A request any one part holds and the summary left
 *     out was left out; a "pending" claim is in the summary whichever part is beside it. One part judged so fails
 *     the summary — that is the intent.
 *   · "invented" (the summary says what the source does not): the LOWEST part score. One part judging a claim
 *     invented does NOT fail the summary, because the claim may come from another part; it fails only when every
 *     part judges it invented. The known cost: a summary that draws on several parts can read as invented to each
 *     of them and fail. That is the safe direction (the rows stay whole, never a wrong record), and it is rare —
 *     leaf chunks are sized to the window, so a check in parts happens only at its edge.
 *   · any part unanswered → the whole check is unanswered (kept and logged 'unavailable', like a down model).
 */
export function combineParts(answers: Array<Record<string, Answer> | null>): Record<string, Answer> | null {
  if (answers.some((a) => a === null)) return null;
  // Only the questions asked (fix round 1, M-3: a question held to the rule is not asked at all).
  const asked = Object.keys(answers[0]!);
  const noul = (q: string): number[] => answers.map((a) => (a![q]?.type === 'noul' ? (a![q] as { noul: number }).noul : 0));
  return Object.fromEntries(asked.map((q) => [q, { type: 'noul', noul: q === 'invented' ? Math.min(...noul(q)) : Math.max(...noul(q)) } as Answer]));
}

/**
 * A part the decision model refused as too large, in two (proof-fix S): at the row divider nearest its middle, else by
 * characters (never between the two halves of one character). Joined back with the divider the halves are exactly the
 * part. Null when it is a single character: nothing smaller exists, so the splitting ends there.
 */
function halvePart(part: string): [string, string] | null {
  if (part.length < 2) return null;
  const mid = part.length >> 1;
  const before = part.lastIndexOf(ROW_SEPARATOR, mid);
  const after = part.indexOf(ROW_SEPARATOR, mid);
  const at = [before, after].filter((i) => i > 0).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  if (at !== undefined) return [part.slice(0, at), part.slice(at + ROW_SEPARATOR.length)];
  const cut = /[\uD800-\uDBFF]/.test(part[mid - 1]) ? mid + 1 : mid;
  return cut >= part.length ? null : [part.slice(0, cut), part.slice(cut)];
}

/**
 * One part through decide(), and (proof-fix S) a part the model refuses as too large (its HTTP 413, or the pre-send
 * count) is split in two and the pieces are checked, each through decide() as any part is. A piece nothing smaller
 * exists for is unanswered, as ever. The splitting ends by itself: every piece is shorter than the part it came from,
 * and one unanswered piece makes the part unanswered, so the other is not asked.
 */
export async function checkPart(
  part: string, label: string | null, summary: string, questions: Record<string, Question>,
  opts: (state: unknown, onFailure: (f: FailureClass) => void) => DecideOpts,
): Promise<Array<Record<string, Answer> | null>> {
  const s = label === null ? { source_rows: part, summary } : { source_rows: part, summary, source_part: label };
  let tooLarge = false;
  const got = await decide(s, questions, opts(s, (f) => { tooLarge = f === 'too_large'; }));
  const halves = got === null && tooLarge ? halvePart(part) : null;
  if (!halves) return [got];
  const base = label ?? '1 of 1';
  const first = await checkPart(halves[0], `${base}, first half`, summary, questions, opts);
  if (first.includes(null)) return first;
  return [...first, ...await checkPart(halves[1], `${base}, second half`, summary, questions, opts)];
}
