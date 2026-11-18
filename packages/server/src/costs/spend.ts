// What has been spent, and which limit it is over. A leaf: it reads the cost ledger and the budget rows and
// sends nothing, so router/standing-filters.ts can judge the budget without reaching the iMessage bridge
// (costs/budget.ts does).

import { getDb } from '../db/connection.js';
import { windowOf } from './budget-cards.js';

// Daily spend, cached for 5 seconds to avoid redundant SUM queries.

let dailySpendCache: { value: number; cachedAt: number } = { value: 0, cachedAt: 0 };
const DAILY_SPEND_CACHE_MS = 5000;

export function getDailySpend(): number {
  const now = Date.now();
  if (now - dailySpendCache.cachedAt < DAILY_SPEND_CACHE_MS) {
    return dailySpendCache.value;
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM cost_records
    WHERE created_at >= datetime('now', '-1 day')
  `).get() as { total: number };

  dailySpendCache = { value: row.total, cachedAt: now };
  return row.total;
}

/** Invalidate the daily spend cache (call after recording a cost) */
export function invalidateDailySpendCache(): void {
  dailySpendCache.cachedAt = 0;
}

// The budget table's per-agent spend for its period, over the period's one window.
export function agentPeriodSpend(agentId: string, period: string): number {
  return (getDb().prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records
    WHERE agent_id = ? AND created_at >= datetime('now', ?)
  `).get(agentId, windowOf(period).sqlite) as { total: number }).total;
}

export interface ExceededBudget {
  budgetId: string;
  scope: 'global' | 'agent';
  period: string;
  spend: number;
  limitUsd: number;
}

/** Which limit a call of `estimatedCost` would go over, or null. A call that costs nothing is never over a limit. */
export function exceededBudget(agentId: string, estimatedCost: number): ExceededBudget | null {
  if (estimatedCost <= 0) return null;
  const db = getDb();
  const globalBudget = db.prepare(`SELECT limit_usd FROM budgets WHERE id = 'global_daily'`).get() as { limit_usd: number } | undefined;
  if (globalBudget) {
    const spend = getDailySpend();
    if (spend + estimatedCost > globalBudget.limit_usd) {
      return { budgetId: 'global_daily', scope: 'global', period: 'daily', spend, limitUsd: globalBudget.limit_usd };
    }
  }
  const agentBudget = db.prepare('SELECT limit_usd, period FROM budgets WHERE id = ?').get(`agent_${agentId}`) as { limit_usd: number; period: string } | undefined;
  if (agentBudget) {
    const spend = agentPeriodSpend(agentId, agentBudget.period);
    if (spend + estimatedCost > agentBudget.limit_usd) {
      return { budgetId: `agent_${agentId}`, scope: 'agent', period: agentBudget.period, spend, limitUsd: agentBudget.limit_usd };
    }
  }
  return null;
}
