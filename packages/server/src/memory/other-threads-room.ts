// The other-threads block fits itself in a share of the budget left after the system prompt; rows that do not
// fit are counted, not named. The assembler reserves and the loop lays out in this one room, so they agree.

import { estimateTokens } from './budget.js';
import { renderTokens, LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS } from './lanes.js';

export const OTHER_THREADS_ROOM_SHARE = 0.05;

export function otherThreadsRoomTokens(assemblyBudgetTokens: number, systemPrompt: string): number {
  const available = Math.max(0, assemblyBudgetTokens - estimateTokens(systemPrompt));
  return Math.max(LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS, Math.floor(available * OTHER_THREADS_ROOM_SHARE));
}

export function unlistedThreadsLine(rest: ReadonlyArray<{ theySpokeLast: boolean }>): string {
  if (rest.length === 0) return '';
  const waiting = rest.filter((t) => t.theySpokeLast).length;
  return `\n… and ${rest.length} more thread${rest.length === 1 ? '' : 's'} not listed `
    + `(${waiting} where they messaged last), all of them in your history`;
}

/** The most rows that fit `roomTokens`; none when even the frame fills it (the count line still tells the truth). */
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
