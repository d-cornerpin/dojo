// A budget's windows (one per period, see costs/budget.ts) and the owner's card for its crossing.
// The card (`budget:<id>`) ends when its window turns over, the limit or period changes, or the agent is purged.

import { getDb } from '../db/connection.js';
import { budgetStopKey, ownerConditionCleared, tellOwnerOncePerWindow, wordsOf } from '../healer/owner-notices.js';

export type BudgetWindow = { sqlite: string; words: string; seconds: number };
const DAY_S = 86_400;
const PERIOD_WINDOW: Record<string, BudgetWindow> = {
  daily: { sqlite: '-1 day', words: 'the last 24 hours', seconds: DAY_S },
  weekly: { sqlite: '-7 days', words: 'the last 7 days', seconds: 7 * DAY_S },
  monthly: { sqlite: '-30 days', words: 'the last 30 days', seconds: 30 * DAY_S },
};
/** The Ledger route accepts only the three periods above; anything else reads as daily. */
export const windowOf = (period: string): BudgetWindow => PERIOD_WINDOW[period] ?? PERIOD_WINDOW.daily;

type Latches = { alert_50_sent: number | null; alert_75_sent: number | null; alert_90_sent: number | null };
export const latestToldAt = (r: Latches): number => Math.max(r.alert_50_sent ?? 0, r.alert_75_sent ?? 0, r.alert_90_sent ?? 0);

export function budgetStopToTell(budget: { budgetId: string; period: string } | null, tell: (words: string) => void): void {
  const key = budgetStopKey(budget?.budgetId ?? 'global_daily');
  if (tellOwnerOncePerWindow(key, wordsOf(key), windowOf(budget?.period ?? 'daily').seconds * 1000)) tell(wordsOf(key));
}

export const budgetKey = (budgetId: string): string => `budget:${budgetId}`;
export const endBudgetCard = (budgetId: string): void => ownerConditionCleared(budgetKey(budgetId));

/** Call BEFORE saving a new limit or period: it diffs the stored row and ends the old card on a change. */
export function endBudgetCardOnChange(budgetId: string, limitUsd: number, period: string): void {
  const row = getDb().prepare('SELECT limit_usd, period FROM budgets WHERE id = ?').get(budgetId) as { limit_usd: number; period: string } | undefined;
  if (!row || (row.limit_usd === limitUsd && row.period === period)) return;
  endBudgetCard(budgetId);
  ownerConditionCleared(budgetStopKey(budgetId));   // a new line is a new window for "the limit is reached" too
}
