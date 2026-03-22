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

// ── Alert tracking (resets daily) ──

let lastAlertResetDate = '';

function resetAlertsIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastAlertResetDate) {
    lastAlertResetDate = today;
    try {
      const db = getDb();
      db.prepare(`
        UPDATE budgets SET alert_50_sent = 0, alert_75_sent = 0, alert_90_sent = 0,
                           updated_at = datetime('now')
        WHERE period = 'daily'
      `).run();
      logger.info('Daily budget alert flags reset');
    } catch (err) {
      logger.error('Failed to reset alert flags', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function checkAndSendAlerts(scope: string, currentSpend: number, limitUsd: number): void {
  const db = getDb();
  const budgetId = scope === 'global' ? 'global_daily' : `agent_${scope}`;
  const row = db.prepare(`
    SELECT alert_50_sent, alert_75_sent, alert_90_sent FROM budgets WHERE id = ?
  `).get(budgetId) as { alert_50_sent: number; alert_75_sent: number; alert_90_sent: number } | undefined;

  if (!row) return;

  const ratio = currentSpend / limitUsd;
  const thresholds: Array<{ pct: number; field: 'alert_50_sent' | 'alert_75_sent' | 'alert_90_sent' }> = [
    { pct: 0.90, field: 'alert_90_sent' },
    { pct: 0.75, field: 'alert_75_sent' },
    { pct: 0.50, field: 'alert_50_sent' },
  ];

  for (const { pct, field } of thresholds) {
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
      } as never);

      // Send iMessage alert at 90% threshold
      if (pct === 0.90) {
        sendAlert(`Budget alert: 90% of daily budget consumed ($${currentSpend.toFixed(2)} of $${limitUsd.toFixed(2)})`, 'warning');
      }
    }
  }
}

// ── Post-Cost Alert Check ──
// Called AFTER a cost record is inserted to fire alerts immediately when thresholds are crossed

export function checkAlertsAfterCost(agentId: string): void {
  resetAlertsIfNewDay();

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
 * Find a free model (input AND output cost = 0) to fall back to when budget is exceeded.
 */
function findFreeModel(): { modelId: string; modelName: string; providerId: string } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.id, m.name, m.provider_id
    FROM models m
    WHERE m.is_enabled = 1
      AND COALESCE(m.input_cost_per_m, 0) = 0
      AND COALESCE(m.output_cost_per_m, 0) = 0
    ORDER BY m.name ASC
    LIMIT 1
  `).get() as { id: string; name: string; provider_id: string } | undefined;

  return row ? { modelId: row.id, modelName: row.name, providerId: row.provider_id } : null;
}

export function checkBudget(agentId: string, estimatedCost: number): BudgetCheckResult {
  resetAlertsIfNewDay();

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
