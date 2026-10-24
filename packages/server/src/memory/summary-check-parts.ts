// ════════════════════════════════════════════════════════════════════════════
// v3.5 B4, fix round 4 (NB-4) — THE SUMMARY CHECK OVER A SOURCE LARGER THAN THE DECISION MODEL'S WINDOW
// (split from `summary-check.ts`): its parts, and the parts' verdicts as one.
// ════════════════════════════════════════════════════════════════════════════

import { fencedState, type Answer } from '../agent/decide.js';
import { CHARS_PER_TOKEN } from './budget.js';

// ── NB-4 (fix round 4): A SOURCE LARGER THAN THE DECISION MODEL'S WINDOW IS CHECKED IN PARTS, NEVER CUT ──
// The window is `decisionWindowTokens()` — the same number `decide()` sends as `num_ctx` and the memory fit sets
// aside. A part is as many whole rows (the `---` lines the callers join rows with) as fit beside the summary and
// the questions; a single row larger than that is split by characters. Joined back with the same separator, the
// parts are exactly the source.
const ROW_SEPARATOR = '\n---\n';
/** The source's parts, or null when the summary alone leaves no room. `questionChars` is the questions' JSON. */
export function sourceParts(source: string, summary: string, windowTokens: number, questionChars: number): string[] | null {
  // v3.5 K33: decide() fences each text of the state, so the frame counted here is the fenced one.
  const room = windowTokens * CHARS_PER_TOKEN - summary.length - questionChars - JSON.stringify(fencedState({ source_rows: '', summary: '', source_part: '' })).length;
  if (room <= 0) return null;
  if (source.length <= room) return [source];
  const parts: string[] = [];
  let current: string | null = null;
  for (const piece of source.split(ROW_SEPARATOR)) {
    const joined: string = current === null ? piece : current + ROW_SEPARATOR + piece;
    if (joined.length <= room) { current = joined; continue; }
    if (current !== null) parts.push(current);
    if (piece.length <= room) { current = piece; continue; }
    // One row larger than the room: split by characters, the last slice carried on.
    let rest = piece;
    while (rest.length > room) { parts.push(rest.slice(0, room)); rest = rest.slice(room); }
    current = rest;
  }
  if (current !== null) parts.push(current);
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
  const noul = (q: 'invented' | 'dropped' | 'stated_current'): number[] => answers.map((a) => (a![q]?.type === 'noul' ? (a![q] as { noul: number }).noul : 0));
  return {
    invented: { type: 'noul', noul: Math.min(...noul('invented')) },
    dropped: { type: 'noul', noul: Math.max(...noul('dropped')) },
    stated_current: { type: 'noul', noul: Math.max(...noul('stated_current')) },
  };
}
