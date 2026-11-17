// Budget enforcement and owner alerts.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getDailySpend, agentPeriodSpend } from './spend.js';   // spend readers live in a leaf module
export { exceededBudget } from './spend.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { windowOf, budgetKey, endBudgetCard, endBudgetCardOnChange, latestToldAt } from './budget-cards.js';
import { ownerWords } from './budget-words.js';
import { budgetStopKey, ownerConditionCleared, tellLimitReachedWithoutCard, tellOwner } from '../healer/owner-notices.js';
export { budgetStopToTell } from './budget-cards.js';

const logger = createLogger('budget');

// Alerts: at most ONE text per threshold per budget window, restart-safe. Each `alert_NN_sent` column holds 0
// (not told in this window) or the unix second the owner was told. A threshold texts again only when its window
// has turned over (24 h, 7 d, 30 d: the window the spend is summed over) or the limit or period is changed (the
// setters below clear the flags). Small rolling drops never re-arm; the flags live in the budgets row.

// One window per budget period: every budget is a rolling sum, and the post-cost alert check and the pre-call
// `checkBudget` must read the SAME window (`windowOf`). The windows and the budget's owner card live in
// ./budget-cards.ts (light: the scheduler tick loads it).


interface BudgetScope {
  /** `global` or the agent id. */
  scope: string;
  budgetId: string;
  period: string;
}

const THRESHOLDS: ReadonlyArray<{ pct: number; field: 'alert_50_sent' | 'alert_75_sent' | 'alert_90_sent' }> = [
  { pct: 0.90, field: 'alert_90_sent' },
  { pct: 0.75, field: 'alert_75_sent' },
  { pct: 0.50, field: 'alert_50_sent' },
];

function checkAndSendAlerts(b: BudgetScope, currentSpend: number, limitUsd: number): void {
  const db = getDb();
  const row = db.prepare(`
    SELECT alert_50_sent, alert_75_sent, alert_90_sent FROM budgets WHERE id = ?
  `).get(b.budgetId) as { alert_50_sent: number | null; alert_75_sent: number | null; alert_90_sent: number | null } | undefined;

  if (!row) return;

  const ratio = limitUsd > 0 ? currentSpend / limitUsd : 0;
  const nowS = Math.floor(Date.now() / 1000);
  const windowS = windowOf(b.period).seconds;
  let highestCrossed: number | null = null;
  if (nowS - latestToldAt(row) >= windowS) endBudgetCard(b.budgetId);   // the window turned over: that incident is over

  for (const { pct, field } of THRESHOLDS) {
    // At or over the line and not told within this window: record when BEFORE telling, so a crash between
    // the two can never tell the owner twice.
    const toldAt = row[field] ?? 0;
    if (ratio >= pct && (toldAt === 0 || nowS - toldAt >= windowS)) {
      db.prepare(`UPDATE budgets SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(nowS, b.budgetId);
      highestCrossed = Math.max(highestCrossed ?? 0, pct);
    }
  }

  if (highestCrossed === null) return;

  // One crossing event per check: a single call that jumps from 40% to 95% is ONE thing that
  // happened, told once at the highest level it reached (every threshold it passed is latched).
  const pctLabel = Math.round(highestCrossed * 100);
  logger.warn(`Budget alert: ${b.scope} at ${pctLabel}%`, {
    scope: b.scope,
    currentSpend: currentSpend.toFixed(4),
    limitUsd,
    percentage: pctLabel,
  });
  // The card and the text carry the same words; a new crossing is a new card, whatever was dismissed before.
  const words = ownerWords(b, currentSpend, limitUsd);
  ownerConditionCleared(budgetKey(b.budgetId));
  tellOwner(budgetKey(b.budgetId), words);
  // "The limit is reached" is one fact per budget window, whichever door gets there first: when this text said
  // it, the honest stop that parks an agent in the same window has nothing to add.
  if (currentSpend >= limitUsd) tellLimitReachedWithoutCard(budgetStopKey(b.budgetId), windowOf(b.period).seconds * 1000);
  void sendAlert(words, 'notice', { kind: 'budget' });
}

// Post-cost alert check: called after a cost record is inserted, so alerts fire as soon as a line is crossed.

export function checkAlertsAfterCost(agentId: string): void {
  const db = getDb();

  const globalBudget = db.prepare(`
    SELECT limit_usd FROM budgets WHERE id = 'global_daily'
  `).get() as { limit_usd: number } | undefined;

  if (globalBudget) {
    const dailySpend = getDailySpend();
    const pct = (dailySpend / globalBudget.limit_usd) * 100;
    logger.info(`Post-cost budget check: $${dailySpend.toFixed(4)} of $${globalBudget.limit_usd} (${pct.toFixed(0)}%)`, {
      dailySpend,
      limit: globalBudget.limit_usd,
      percentage: pct,
    });
    checkAndSendAlerts({ scope: 'global', budgetId: 'global_daily', period: 'daily' }, dailySpend, globalBudget.limit_usd);
  }

  const agentBudget = db.prepare(`
    SELECT limit_usd, period FROM budgets WHERE id = ?
  `).get(`agent_${agentId}`) as { limit_usd: number; period: string } | undefined;

  if (agentBudget) {
    const agentSpend = agentPeriodSpend(agentId, agentBudget.period);
    checkAndSendAlerts({ scope: agentId, budgetId: `agent_${agentId}`, period: agentBudget.period }, agentSpend, agentBudget.limit_usd);
  }
}


export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  budgetExceeded?: boolean;       // true if the budget is exceeded (but free models may be available)
  dailySpend?: number;
  dailyLimit?: number;
  freeModelFallback?: FreeModel | null;     // populated when budget exceeded but free models exist: the first
  /** Every free model, in the order they are offered; the wall walks them until one answers. */
  freeModelFallbacks?: FreeModel[];
}

export interface FreeModel { modelId: string; modelName: string; providerId: string }

/**
 * Find a free model (input AND output cost an explicit 0) to fall back to when the budget is exceeded.
 * A NULL price ("unknown") is excluded, never COALESCEd to 0: the biller bills it $0, but offering it as the
 * free lifeline would cross the paid boundary without consent when a true rate merely failed to sync.
 */
function findFreeModels(): FreeModel[] {
  const db = getDb();
  // The '__system__' provider is the 'auto' router pointer, not a callable model. Generation and embedding models
  // can't hold a chat (empty capabilities pass). Media models list 0/0 token prices but bill per unit or
  // megapixel, so the lifeline must be $0 on every axis (a NULL per-unit price is a chat model's normal state).
  const rows = db.prepare(`
    SELECT m.id, m.name, m.provider_id
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.is_enabled = 1
      AND p.id != '__system__'
      AND m.capabilities NOT LIKE '%generation%'
      AND m.capabilities NOT LIKE '%embedding%'
      AND m.input_cost_per_m = 0
      AND m.output_cost_per_m = 0
      AND (m.cost_per_unit IS NULL OR m.cost_per_unit = 0)
      AND (m.cost_per_megapixel IS NULL OR m.cost_per_megapixel = 0)
    ORDER BY m.name ASC
  `).all() as Array<{ id: string; name: string; provider_id: string }>;

  return rows.map((row) => ({ modelId: row.id, modelName: row.name, providerId: row.provider_id }));
}

export function checkBudget(agentId: string, estimatedCost: number): BudgetCheckResult {
  const db = getDb();

  const globalBudget = db.prepare(`
    SELECT limit_usd FROM budgets WHERE id = 'global_daily'
  `).get() as { limit_usd: number } | undefined;

  if (globalBudget) {
    const dailySpend = getDailySpend();
    checkAndSendAlerts({ scope: 'global', budgetId: 'global_daily', period: 'daily' }, dailySpend, globalBudget.limit_usd);

    if (dailySpend + estimatedCost > globalBudget.limit_usd) {
      const freeModels = findFreeModels();
      return {
        allowed: false,
        budgetExceeded: true,
        dailySpend,
        dailyLimit: globalBudget.limit_usd,
        reason: `Daily budget limit reached ($${dailySpend.toFixed(2)} spent of $${globalBudget.limit_usd.toFixed(2)} limit).`,
        freeModelFallback: freeModels[0] ?? null,
        freeModelFallbacks: freeModels,
      };
    }
  }

  const agentBudget = db.prepare(`
    SELECT limit_usd, period FROM budgets WHERE id = ?
  `).get(`agent_${agentId}`) as { limit_usd: number; period: string } | undefined;

  if (agentBudget) {
    const agentSpend = agentPeriodSpend(agentId, agentBudget.period);

    checkAndSendAlerts({ scope: agentId, budgetId: `agent_${agentId}`, period: agentBudget.period }, agentSpend, agentBudget.limit_usd);

    if (agentSpend + estimatedCost > agentBudget.limit_usd) {
      return {
        allowed: false,
        reason: `Agent budget exceeded: $${agentSpend.toFixed(4)} spent of $${agentBudget.limit_usd} limit (${agentBudget.period})`,
      };
    }
  }

  return { allowed: true };
}

// The pure half of `checkBudget` (same two comparisons, no alerts) is `exceededBudget` in ./spend.ts. An honest
// stop (agent/v2/honest-stop.ts) asks it when a turn is stopped and again when a limit is raised or a window
// turns over, so the lock lifts on the real event and never on a timer.

export type { ExceededBudget } from './spend.js';

/** The pre-call estimate the pinned-model wall (agent/model.ts) charges: one call's worth, flat. A routed
 *  model is judged by the router's own per-model estimate instead (router/selector.ts, `routedCandidateCosts`). */
export const WALL_ESTIMATE_USD = 0.01;



export interface Budget {
  id: string;
  scope: string;
  limitUsd: number;
  period: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBudget extends Budget {
  agentId: string;
}

/** The budget row plus what the dashboard's `getBudgets` reads: the spend in the budget's window. */
export interface BudgetWithSpend extends Budget {
  spentUsd: number;
}

export interface AgentBudgetWithSpend extends AgentBudget {
  spentUsd: number;
  agentName: string;
}

export function getBudgets(): { global: BudgetWithSpend | null; agents: AgentBudgetWithSpend[] } {
  const db = getDb();

  const globalRow = db.prepare(`
    SELECT id, scope, limit_usd, period, created_at, updated_at FROM budgets WHERE id = 'global_daily'
  `).get() as { id: string; scope: string; limit_usd: number; period: string; created_at: string; updated_at: string } | undefined;

  const globalBudget: BudgetWithSpend | null = globalRow ? {
    id: globalRow.id,
    scope: globalRow.scope,
    limitUsd: globalRow.limit_usd,
    period: globalRow.period,
    createdAt: globalRow.created_at,
    updatedAt: globalRow.updated_at,
    spentUsd: getDailySpend(),
  } : null;

  const agentRows = db.prepare(`
    SELECT id, scope, limit_usd, period, created_at, updated_at FROM budgets
    WHERE id LIKE 'agent_%'
  `).all() as Array<{ id: string; scope: string; limit_usd: number; period: string; created_at: string; updated_at: string }>;

  const agents: AgentBudgetWithSpend[] = agentRows.map(r => {
    const agentId = r.id.replace('agent_', '');
    const nameRow = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
    return {
      id: r.id,
      scope: r.scope,
      limitUsd: r.limit_usd,
      period: r.period,
      agentId,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      spentUsd: agentPeriodSpend(agentId, r.period),
      agentName: nameRow?.name ?? agentId,
    };
  });

  return { global: globalBudget, agents };
}

/** The owner CHANGED the limit or the period: every threshold is re-armed (a new line, told
 *  afresh). Saving the same values again changes nothing. SQLite evaluates every right-hand
 *  side against the OLD row, so the comparison sees the values being replaced. */
const CLEAR_FLAGS_ON_CHANGE = ['alert_50_sent', 'alert_75_sent', 'alert_90_sent']
  .map((f) => `${f} = CASE WHEN budgets.limit_usd = excluded.limit_usd AND budgets.period = excluded.period THEN budgets.${f} ELSE 0 END`)
  .join(', ');

export function setGlobalBudget(limitUsd: number): void {
  const db = getDb();
  endBudgetCardOnChange('global_daily', limitUsd, 'daily');
  db.prepare(`
    INSERT INTO budgets (id, scope, limit_usd, period, created_at, updated_at)
    VALUES ('global_daily', 'global', ?, 'daily', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET ${CLEAR_FLAGS_ON_CHANGE}, limit_usd = excluded.limit_usd, updated_at = datetime('now')
  `).run(limitUsd);
  logger.info('Global daily budget set', { limitUsd });
}

export function setAgentBudget(agentId: string, limitUsd: number, period: string): void {
  const db = getDb();
  const id = `agent_${agentId}`;
  endBudgetCardOnChange(id, limitUsd, period);
  db.prepare(`
    INSERT INTO budgets (id, scope, limit_usd, period, created_at, updated_at)
    VALUES (?, 'agent', ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET ${CLEAR_FLAGS_ON_CHANGE},
      limit_usd = excluded.limit_usd, period = excluded.period, updated_at = datetime('now')
  `).run(id, limitUsd, period);
  logger.info('Agent budget set', { agentId, limitUsd, period });
}

/** No limit: the budget row goes, and with it its card and its "limit reached" notice. */
export function removeBudget(budgetId: string): void {
  endBudgetCard(budgetId);
  ownerConditionCleared(budgetStopKey(budgetId));
  getDb().prepare('DELETE FROM budgets WHERE id = ?').run(budgetId);
  logger.info('Budget removed', { budgetId });
}
