// The words of a budget alert: budget.ts decides when to tell, this decides what the owner reads.

import { getDb } from '../db/connection.js';
import { windowOf } from './budget-cards.js';

/** Says what crossed, by how much and over what window, from the real spend and limit, not a threshold label.
 *  Under the limit it names the true share rounded down (never "reached" early); at or over, it says reached. */
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
