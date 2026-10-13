// ════════════════════════════════════════════════════════════════════════════════════════
// A BUDGET'S WINDOWS, AND THE OWNER'S CARD FOR ITS CROSSING (t138 rounds 3-6).
//
// One window per budget period (the reason is in costs/budget.ts, the check that uses it). The
// owner's card is the CURRENT window's incident: it stands while the latest crossing's told-at
// (the same latch that decides "no second text inside the window") is inside the window, and
// the window turning over is its clear — a stale higher latch from an earlier window is not the
// card's line (review C1). This module is kept light (no door, no engine) because the
// scheduler's tick loads it to end turned-over cards live.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { ownerCardEnded } from '../services/owner-card-frames.js';

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

/** The scheduler's tick (scheduler/background-checks.ts): every budget whose window has turned
 *  over since its latest crossing — that incident is over, so its card leaves, live. */
export function endTurnedOverBudgetCards(): void {
  const rows = getDb().prepare(`SELECT id, period, alert_words AS words, alert_50_sent, alert_75_sent, alert_90_sent
    FROM budgets WHERE alert_words IS NOT NULL`).all() as Array<Latches & { id: string; period: string; words: string }>;
  const nowS = Math.floor(Date.now() / 1000);
  for (const r of rows) if (nowS - latestToldAt(r) >= windowOf(r.period).seconds) endBudgetCard(r.id, r.words);
}

/** The budget's card is over (its window turned over, or the owner changed the limit): it
 *  leaves every open dashboard now (services/owner-card-frames.ts). */
export function endBudgetCard(budgetId: string, words: string): void {
  getDb().prepare('UPDATE budgets SET alert_words = NULL WHERE id = ?').run(budgetId);
  ownerCardEnded(words);
}

/** Before a limit or period is saved: if it CHANGES, the card for the old line is over. */
export function endBudgetCardOnChange(budgetId: string, limitUsd: number, period: string): void {
  const row = getDb().prepare('SELECT limit_usd, period, alert_words FROM budgets WHERE id = ?').get(budgetId) as
    { limit_usd: number; period: string; alert_words: string | null } | undefined;
  if (row?.alert_words && (row.limit_usd !== limitUsd || row.period !== period)) endBudgetCard(budgetId, row.alert_words);
}

/**
 * The budget owner cards a dashboard shows on load (t138 round 3, ruling R-V333-13), re-derived
 * from the latches: a budget whose latest crossing is still inside its window, not dismissed.
 * Once the window turns over the incident is over and so is the card.
 */
export function budgetOwnerCards(): Array<{ words: string; severity: 'notice'; dismiss: () => void }> {
  const db = getDb();
  const rows = db.prepare(`SELECT id, period, alert_words AS words,
      MAX(COALESCE(alert_50_sent, 0), COALESCE(alert_75_sent, 0), COALESCE(alert_90_sent, 0)) AS toldAt
    FROM budgets WHERE alert_words IS NOT NULL AND alert_dismissed_at IS NULL`).all() as
    Array<{ id: string; period: string; words: string; toldAt: number }>;
  const nowS = Math.floor(Date.now() / 1000);
  return rows.filter((r) => r.toldAt > 0 && nowS - r.toldAt < windowOf(r.period).seconds).map((r) => ({
    words: r.words,
    severity: 'notice' as const,
    dismiss: () => { db.prepare('UPDATE budgets SET alert_dismissed_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), r.id); },
  }));
}
