// The summary check over a source larger than the decision model's window: the source in parts, never cut.

import { MAX_DECISION_BODY_BYTES, decide, type Answer, type Question } from '../agent/decide.js';
import { decideCountedBytes, fencedState } from '../agent/decide-sizing.js';
import { NUM_CTX_MARGIN_TOKENS } from '../agent/utility-dial.js';

// A part fits the decision model's window (the number the memory fit sets aside) counted at its measured density
// less the template slack every window carries (`NUM_CTX_MARGIN_TOKENS`), AND Ollama's 64 KiB body limit, counted as
// Ollama counts them (`decideCountedBytes`). A part is as many whole rows (the `---`
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
      // Not even one character fits the bytes left: no parts (recorded unavailable), never a spin.
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
 * A part the decision model refused as too large, in two: at the row divider nearest its middle, else by
 * characters (never between the two halves of one character). Joined back with the divider the halves are exactly the
 * part. Null when it is a single character: nothing smaller exists, so the splitting ends there.
 */
export function halvePart(part: string): [string, string] | null {
  if (part.length < 2) return null;
  const mid = part.length >> 1;
  const before = part.lastIndexOf(ROW_SEPARATOR, mid);
  const after = part.indexOf(ROW_SEPARATOR, mid);
  const at = [before, after].filter((i) => i > 0 && i + ROW_SEPARATOR.length < part.length).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  if (at !== undefined) return [part.slice(0, at), part.slice(at + ROW_SEPARATOR.length)];
  const cut = /[\uD800-\uDBFF]/.test(part[mid - 1]) ? mid + 1 : mid;
  return cut >= part.length ? null : [part.slice(0, cut), part.slice(cut)];
}

/**
 * One part through decide(), and a part the model refuses as too large (its HTTP 413, or the pre-send
 * count) is split in two and the pieces are checked, each through decide() as any part is. A piece nothing smaller
 * exists for is unanswered, as ever. The splitting ends by itself: every piece is shorter than the part it came from,
 * and one unanswered piece makes the part unanswered, so the other is not asked.
 */
export async function checkPart(
  part: string, label: string | null, summary: string, questions: Record<string, Question>, agentId: string,
): Promise<Array<Record<string, Answer> | null>> {
  const s = label === null ? { source_rows: part, summary } : { source_rows: part, summary, source_part: label };
  let tooLarge = false;
  const got = await decide(s, questions, { purpose: 'summary_check', agentId, onFailure: (f) => { tooLarge = f === 'too_large'; } });
  // Measured stop: when the request is too large even with NO source in it, the source is not what is too big.
  const emptied = { ...s, source_rows: '' };
  const halves = got === null && tooLarge && decideCountedBytes(emptied, questions) <= MAX_DECISION_BODY_BYTES ? halvePart(part) : null;
  if (!halves) return [got];
  const base = label ?? '1 of 1';
  const first = await checkPart(halves[0], `${base}, first half`, summary, questions, agentId);
  if (first.includes(null)) return first;
  return [...first, ...await checkPart(halves[1], `${base}, second half`, summary, questions, agentId)];
}
