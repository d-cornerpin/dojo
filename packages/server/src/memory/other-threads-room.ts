// ════════════════════════════════════════════════════════════════════════════════════════
// tracker #24 — THE ROOM THE OTHER-THREADS BLOCK IS LAID OUT IN.
//
// t207 made the other-threads block name EVERY waiting thread, and t211 reserved whatever it rendered.
// On a mailbox box every email thread whose last message is inbound is "waiting": about 2,000 lines.
// The reserve ladder may take at most half the room (`reserveLadderFor`), so the ladder was SCALED, the
// block overflowed the budget on every call, nothing else was droppable, the boundary refused to drop
// the live conversation and started a forced condense — one condense per message, a condense that
// failed partway, and a wrong answer.
//
// The block now fits ITSELF in a declared share of the budget left after the system prompt: the rows
// that fit are named (waiting threads first, newest first), the rest are COUNTED and stay reachable by
// the history tools the block names. The assembler reserves for the block as it will be laid out, and
// the loop lays it out in the same room, so the two cannot disagree. A layout share like
// `SUMMARY_SHARE`, not a cap on behaviour; its floor is the literal's covered figure, so a small window
// keeps the room the block had before t207.
// ════════════════════════════════════════════════════════════════════════════════════════

import { estimateTokens } from './budget.js';
import { renderTokens, LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS } from './lanes.js';

export const OTHER_THREADS_ROOM_SHARE = 0.05;

/** The block's room: its share of `assemblyBudgetTokens` minus the system prompt, floored at the literal. */
export function otherThreadsRoomTokens(assemblyBudgetTokens: number, systemPrompt: string): number {
  const available = Math.max(0, assemblyBudgetTokens - estimateTokens(systemPrompt));
  return Math.max(LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS, Math.floor(available * OTHER_THREADS_ROOM_SHARE));
}

/** The line that counts the threads the room could not name. Empty when every thread was named. */
export function unlistedThreadsLine(rest: ReadonlyArray<{ theySpokeLast: boolean }>): string {
  if (rest.length === 0) return '';
  const waiting = rest.filter((t) => t.theySpokeLast).length;
  return `\n… and ${rest.length} more thread${rest.length === 1 ? '' : 's'} not listed `
    + `(${waiting} where they messaged last), all of them in your history`;
}

/**
 * `compose(shown)` with the most rows that fit `roomTokens` (every row when no room is given or all fit;
 * none when even the frame fills it, and the count line still tells the truth).
 */
export function layOutInRoom(total: number, roomTokens: number | undefined, compose: (shown: number) => string): string {
  const cost = (text: string): number => renderTokens([{ role: 'user', content: text }]);
  const whole = compose(total);
  if (roomTokens === undefined || cost(whole) <= roomTokens) return whole;
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(compose(mid)) <= roomTokens) lo = mid; else hi = mid - 1;
  }
  return compose(lo);
}
