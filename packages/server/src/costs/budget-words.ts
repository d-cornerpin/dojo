// ════════════════════════════════════════════════════════════════════════════════════════
// THE WORDS OF A BUDGET ALERT (t138, t167). Split from budget.ts, which decides WHEN to tell;
// this decides WHAT the owner reads.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { windowOf } from './budget-cards.js';

/** The words the owner reads. Budget alerts are one of the two classes the platform may send
 *  him directly (OR-V333-SET (3)), so they say what crossed, by how much, over what window.
 *
 *  THE FIGURES ARE THE REAL ONES (t167). The words come from `currentSpend / limitUsd`, never from
 *  the threshold's label: the thresholds stop at 90%, so a limit set under what was already spent
 *  (200%) used to be texted as "90% ... ($33.08 of $16.54)". Under the limit the words name the true
 *  share (rounded down, so "reached" is never said early); at or over it they say plainly that the
 *  limit is reached, by how much, and what happens now. */
export function ownerWords(b: { scope: string; period: string }, currentSpend: number, limitUsd: number): string {
  const spent = `$${currentSpend.toFixed(2)}`;
  const line = `$${limitUsd.toFixed(2)}`;
  const win = windowOf(b.period).words;
  const agentName = b.scope === 'global' ? null
    : ((getDb().prepare('SELECT name FROM agents WHERE id = ?').get(b.scope) as { name: string } | undefined)?.name ?? b.scope);
  if (currentSpend < limitUsd) {
    const share = Math.floor((currentSpend / limitUsd) * 100 + 1e-9);
    const money = `${spent} of ${line} in ${win}`;
    return agentName === null
      ? `Budget alert: ${share}% of your daily budget is used (${money}).`
      : `Budget alert: ${agentName} has used ${share}% of its ${b.period} budget (${money}).`;
  }
  const over = currentSpend - limitUsd;
  const overBy = over >= 0.005 ? `, $${over.toFixed(2)} over` : '';
  if (agentName === null) {
    return `Budget limit reached: you have spent ${spent} of your ${line} daily budget in ${win}${overBy}. `
      + 'Agents switch to a free model; an agent with no free model that answers waits until you raise the limit or the window turns over. Messages are kept.';
  }
  return `Budget limit reached: ${agentName} has spent ${spent} of its ${line} ${b.period} budget in ${win}${overBy}. `
    + 'It waits until you raise its limit or the window turns over. Its messages are kept.';
}
