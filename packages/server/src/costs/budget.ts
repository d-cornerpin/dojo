// ════════════════════════════════════════
// Budget Enforcement and Alerts
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getDailySpend } from './tracker.js';
import { sendAlert } from '../services/imessage-bridge.js';

const logger = createLogger('budget');

// ── Alert tracking (edge-triggered with hysteresis, restart-safe) ──
//
// FA-PC3: alerts used to reset on every UTC calendar-day boundary via a
// resetAlertsIfNewDay() call plus an in-memory lastAlertResetDate. But daily
// spend is a ROLLING 24h sum (getDailySpend / created_at >= now-1day), not a
// calendar-day sum, so at midnight the flags reset while rolling spend was
// still high and the alert immediately re-fired, and on restart the in-memory
// date reinitialized and re-alerted. Both are gone. A threshold's sent-flag is
// now cleared ONLY when rolling spend falls back below that threshold by more
// than a hysteresis margin, and the flags live in the budgets row (persisted),
// so a restart never re-alerts. Result: exactly one alert per genuine crossing,
// and a real re-crossing after spend genuinely dropped re-alerts.
//
// Hysteresis margin: 2% of the limit. The 90% flag re-arms only once rolling
// spend drops below 88% of the cap (75% below 73%, 50% below 48%). This keeps a
// record aging out of the 24h window from flapping a flag that is hovering at
// exactly the threshold, without hiding a genuine sustained drop-and-recross.
const ALERT_HYSTERESIS = 0.02;

function checkAndSendAlerts(scope: string, currentSpend: number, limitUsd: number): void {
  const db = getDb();
  const budgetId = scope === 'global' ? 'global_daily' : `agent_${scope}`;
  const row = db.prepare(`
    SELECT alert_50_sent, alert_75_sent, alert_90_sent FROM budgets WHERE id = ?
  `).get(budgetId) as { alert_50_sent: number; alert_75_sent: number; alert_90_sent: number } | undefined;

  if (!row) return;

  const ratio = limitUsd > 0 ? currentSpend / limitUsd : 0;
  const thresholds: Array<{ pct: number; field: 'alert_50_sent' | 'alert_75_sent' | 'alert_90_sent' }> = [
    { pct: 0.90, field: 'alert_90_sent' },
    { pct: 0.75, field: 'alert_75_sent' },
    { pct: 0.50, field: 'alert_50_sent' },
  ];

  for (const { pct, field } of thresholds) {
    // Rising edge: crossed the threshold and not yet alerted -> fire + latch.
    if (ratio >= pct && row[field] === 0) {
      db.prepare(`UPDATE budgets SET ${field} = 1, updated_at = datetime('now') WHERE id = ?`).run(budgetId);

      const pctLabel = Math.round(pct * 100);
      logger.warn(`Budget alert: ${scope} at ${pctLabel}%`, {
        scope,
        currentSpend: currentSpend.toFixed(4),
        limitUsd,
        percentage: pctLabel,
      });

      logger.info(`Budget alert triggered: ${pctLabel}% threshold crossed, broadcasting cost:alert`, {
        scope,
        percentage: pctLabel,
      });

      broadcast({
        type: 'cost:alert',
        data: {
          scope,
          percentage: pctLabel,
          currentSpend,
          limitUsd,
        },
      });

      // Send iMessage alert at 90% threshold
      if (pct === 0.90) {
        sendAlert(`Budget alert: 90% of daily budget consumed ($${currentSpend.toFixed(2)} of $${limitUsd.toFixed(2)})`, 'warning');
      }
    // Falling edge: rolling spend dropped genuinely below the threshold (by the
    // hysteresis margin) -> re-arm so a real re-crossing alerts again.
    } else if (ratio < pct - ALERT_HYSTERESIS && row[field] === 1) {
      db.prepare(`UPDATE budgets SET ${field} = 0, updated_at = datetime('now') WHERE id = ?`).run(budgetId);
      logger.info(`Budget alert re-armed: ${scope} fell below ${Math.round(pct * 100)}%`, {
        scope,
        currentSpend: currentSpend.toFixed(4),
        limitUsd,
        percentage: Math.round(pct * 100),
      });
    }
  }
}

// ── Post-Cost Alert Check ──
// Called AFTER a cost record is inserted to fire alerts immediately when thresholds are crossed

export function checkAlertsAfterCost(agentId: string): void {
  const db = getDb();

  // Check global daily budget
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
    checkAndSendAlerts('global', dailySpend, globalBudget.limit_usd);
  }

  // Check agent-specific budget
  const agentBudget = db.prepare(`
    SELECT limit_usd, period FROM budgets WHERE id = ?
  `).get(`agent_${agentId}`) as { limit_usd: number; period: string } | undefined;

  if (agentBudget) {
    const periodFilter = agentBudget.period === 'daily'
      ? "AND created_at >= datetime('now', '-1 day')"
      : '';
    const agentSpend = (db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records
      WHERE agent_id = ? ${periodFilter}
    `).get(agentId) as { total: number }).total;
    checkAndSendAlerts(agentId, agentSpend, agentBudget.limit_usd);
  }
}

// ── Check Budget ──

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  budgetExceeded?: boolean;       // true if the budget is exceeded (but free models may be available)
  dailySpend?: number;
  dailyLimit?: number;
  freeModelFallback?: {           // populated when budget exceeded but free models exist
    modelId: string;
    modelName: string;
    providerId: string;
  } | null;
}

/**
 * Find a free model (input AND output cost EXPLICITLY 0) to fall back to when
 * budget is exceeded. Per D-H the price must be a real 0, not NULL: a NULL
 * ("price unknown") row is billed as $0 by the biller, but offering it as the
 * free lifeline would cross the paid boundary without consent when the true
 * rate simply failed to sync. So require `= 0` (NULL fails the comparison and
 * is excluded), NOT COALESCE(...,0)=0.
 */
function findFreeModel(): { modelId: string; modelName: string; providerId: string } | null {
  const db = getDb();
  // p.id != '__system__': the 'auto' sentinel is a router pointer, not a
  // callable model; the lifeline must return a genuinely callable $0 model.
  // Capability filter: media-generation/embedding models can't hold a chat
  // (empty/unknown capabilities are allowed through, same idiom as the
  // primary-agent fallback). Per-unit filter: media models list 0/0 TOKEN
  // prices while their real billing is per-unit (cost_per_unit, plus the
  // legacy cost_per_megapixel kept from v2.10.4), so the lifeline must be
  // genuinely $0 on EVERY pricing axis AND able to hold a chat. NULL per-unit
  // is fine here: that is the normal state for a token-priced chat model,
  // whose real axis is already required to be an explicit 0 (D-H).
  const row = db.prepare(`
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
    LIMIT 1
  `).get() as { id: string; name: string; provider_id: string } | undefined;

  return row ? { modelId: row.id, modelName: row.name, providerId: row.provider_id } : null;
}

export function checkBudget(agentId: string, estimatedCost: number): BudgetCheckResult {
  const db = getDb();

  // Check global daily budget
  const globalBudget = db.prepare(`
    SELECT limit_usd FROM budgets WHERE id = 'global_daily'
  `).get() as { limit_usd: number } | undefined;

  if (globalBudget) {
    const dailySpend = getDailySpend();
    checkAndSendAlerts('global', dailySpend, globalBudget.limit_usd);

    if (dailySpend + estimatedCost > globalBudget.limit_usd) {
      // Budget exceeded — check for free model fallback
      const freeModel = findFreeModel();
      return {
        allowed: false,
        budgetExceeded: true,
        dailySpend,
        dailyLimit: globalBudget.limit_usd,
        reason: `Daily budget limit reached ($${dailySpend.toFixed(2)} spent of $${globalBudget.limit_usd.toFixed(2)} limit).`,
        freeModelFallback: freeModel,
      };
    }
  }

  // Check agent-specific budget
  const agentBudget = db.prepare(`
    SELECT limit_usd, period FROM budgets WHERE id = ?
  `).get(`agent_${agentId}`) as { limit_usd: number; period: string } | undefined;

  if (agentBudget) {
    const periodFilter = agentBudget.period === 'daily'
      ? "AND created_at >= datetime('now', '-1 day')"
      : agentBudget.period === 'weekly'
        ? "AND created_at >= datetime('now', '-7 days')"
        : '';

    const agentSpend = (db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records
      WHERE agent_id = ? ${periodFilter}
    `).get(agentId) as { total: number }).total;

    checkAndSendAlerts(agentId, agentSpend, agentBudget.limit_usd);

    if (agentSpend + estimatedCost > agentBudget.limit_usd) {
      return {
        allowed: false,
        reason: `Agent budget exceeded: $${agentSpend.toFixed(4)} spent of $${agentBudget.limit_usd} limit (${agentBudget.period})`,
      };
    }
  }

  return { allowed: true };
}

// ── Budget CRUD ──

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

export function getBudgets(): { global: Budget | null; agents: AgentBudget[] } {
  const db = getDb();

  const globalRow = db.prepare(`
    SELECT id, scope, limit_usd, period, created_at, updated_at FROM budgets WHERE id = 'global_daily'
  `).get() as { id: string; scope: string; limit_usd: number; period: string; created_at: string; updated_at: string } | undefined;

  const globalBudget: Budget | null = globalRow ? {
    id: globalRow.id,
    scope: globalRow.scope,
    limitUsd: globalRow.limit_usd,
    period: globalRow.period,
    createdAt: globalRow.created_at,
    updatedAt: globalRow.updated_at,
  } : null;

  const agentRows = db.prepare(`
    SELECT id, scope, limit_usd, period, created_at, updated_at FROM budgets
    WHERE id LIKE 'agent_%'
  `).all() as Array<{ id: string; scope: string; limit_usd: number; period: string; created_at: string; updated_at: string }>;

  const agents: AgentBudget[] = agentRows.map(r => ({
    id: r.id,
    scope: r.scope,
    limitUsd: r.limit_usd,
    period: r.period,
    agentId: r.id.replace('agent_', ''),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return { global: globalBudget, agents };
}

export function setGlobalBudget(limitUsd: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO budgets (id, scope, limit_usd, period, created_at, updated_at)
    VALUES ('global_daily', 'global', ?, 'daily', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET limit_usd = ?, updated_at = datetime('now')
  `).run(limitUsd, limitUsd);
  logger.info('Global daily budget set', { limitUsd });
}

export function setAgentBudget(agentId: string, limitUsd: number, period: string): void {
  const db = getDb();
  const id = `agent_${agentId}`;
  db.prepare(`
    INSERT INTO budgets (id, scope, limit_usd, period, created_at, updated_at)
    VALUES (?, 'agent', ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET limit_usd = ?, period = ?, updated_at = datetime('now')
  `).run(id, limitUsd, period, limitUsd, period);
  logger.info('Agent budget set', { agentId, limitUsd, period });
}
