// The summary check over a source larger than the decision model's window: the source in parts, never cut.

import { MAX_DECISION_BODY_BYTES, decide, decideCountedBytes, fencedState, type Answer, type Question } from '../agent/decide.js';
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

/** One part through decide(). A part the model still refuses is unanswered, so the summary is kept unchecked:
 *  `sourceParts` is the one place that sizes a part. */
export async function checkPart(
  part: string, label: string | null, summary: string, questions: Record<string, Question>, agentId: string,
): Promise<Record<string, Answer> | null> {
  const s = label === null ? { source_rows: part, summary } : { source_rows: part, summary, source_part: label };
  return decide(s, questions, { purpose: 'summary_check', agentId });
}
