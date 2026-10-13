// ════════════════════════════════════════
// Budget Enforcement and Alerts
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getDailySpend } from './tracker.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { windowOf, latestToldAt, endBudgetCard, endBudgetCardOnChange } from './budget-cards.js';
export { budgetOwnerCards, endTurnedOverBudgetCards } from './budget-cards.js';

const logger = createLogger('budget');

// ── Alert tracking: at most ONE text per threshold per budget window, restart-safe ──
//
// FA-PC3: alerts used to reset on every UTC calendar-day boundary via an in-memory date, so
// at midnight (and on every restart) a still-high rolling spend re-alerted. That fix cleared a
// threshold's flag when rolling spend fell 2 points below it — a band sized for a dashboard
// toast. Once budget alerts reached the owner's phone (t138, #8) it was too narrow: a day spent
// in calls of >=2% of the limit, hovering at a line, re-crossed on every record that aged out
// of the rolling window — nine texts in nine turns (t138 review I1; witnessed RED).
//
// So each `alert_NN_sent` column holds 0 (not told in this window) or the unix second the owner
// was told. A threshold texts again only when its WINDOW has turned over since then (24 h,
// 7 d, 30 d — the same window the spend is summed over), or when the owner CHANGES the limit
// or period (the setters below clear the flags). Small rolling drops never re-arm. The flags
// live in the budgets row, so a restart never re-alerts.

// ── One window per budget period ──
//
// Every budget is a ROLLING sum, and both readers — the post-cost alert check and the
// pre-call `checkBudget` — must read the SAME window. They did not: the post-cost check knew
// only 'daily' and summed ALL TIME for weekly/monthly, while `checkBudget` knew daily and
// weekly and summed all time for monthly. On a weekly agent budget with older spend, the
// post-cost check saw a crossing and latched, the next pre-call check saw the week and re-armed
// it, and every turn alerted again — nine dashboard alerts in three turns at 30% of the week
// (t138 witness). One reader now, one window per period.
// The windows, and the budget's owner card, live in ./budget-cards.ts (light: the scheduler tick loads it).

function agentPeriodSpend(agentId: string, period: string): number {
  return (getDb().prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records
    WHERE agent_id = ? AND created_at >= datetime('now', ?)
  `).get(agentId, windowOf(period).sqlite) as { total: number }).total;
}

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

/** The words the owner reads. Budget alerts are one of the two classes the platform may send
 *  him directly (OR-V333-SET (3)), so they say what crossed, by how much, over what window. */
function ownerWords(b: BudgetScope, pctLabel: number, currentSpend: number, limitUsd: number): string {
  const money = `$${currentSpend.toFixed(2)} of $${limitUsd.toFixed(2)} in ${windowOf(b.period).words}`;
  if (b.scope === 'global') return `Budget alert: ${pctLabel}% of your daily budget is used (${money}).`;
  const agent = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(b.scope) as { name: string } | undefined;
  return `Budget alert: ${agent?.name ?? b.scope} has used ${pctLabel}% of its ${b.period} budget (${money}).`;
}

function checkAndSendAlerts(b: BudgetScope, currentSpend: number, limitUsd: number): void {
  const db = getDb();
  const row = db.prepare(`
    SELECT alert_50_sent, alert_75_sent, alert_90_sent, alert_words FROM budgets WHERE id = ?
  `).get(b.budgetId) as { alert_50_sent: number | null; alert_75_sent: number | null; alert_90_sent: number | null; alert_words: string | null } | undefined;

  if (!row) return;

  const ratio = limitUsd > 0 ? currentSpend / limitUsd : 0;
  const nowS = Math.floor(Date.now() / 1000);
  const windowS = windowOf(b.period).seconds;
  let highestCrossed: number | null = null;

  // THE INCIDENT IS THE LATEST CROSSING, LIVE FOR ITS WINDOW (t138 round 6, review C1). The same
  // latches decide the text (no second text inside the window) and so the card: it stands while
  // the latest told-at is inside the window, and the window turning over is the clear. Spend
  // moving inside the window ends nothing; a stale higher latch from an earlier window is not it.
  if (row.alert_words && nowS - latestToldAt(row) >= windowS) endBudgetCard(b.budgetId, row.alert_words);

  for (const { pct, field } of THRESHOLDS) {
    // At or over the line, and not told within this window -> record when, then tell. Recorded
    // BEFORE the owner is told, so a crash between the two can never tell him twice.
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
  // The text and its dashboard card are one thing (the door makes both; the old `cost:alert`
  // toast is gone, t138 round 2). The words are kept on the row so the card outlives the page,
  // and a NEW crossing clears an earlier dismissal (round 3).
  const words = ownerWords(b, pctLabel, currentSpend, limitUsd);
  db.prepare('UPDATE budgets SET alert_words = ?, alert_dismissed_at = NULL WHERE id = ?').run(words, b.budgetId);
  sendAlert(words, 'notice');
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
    checkAndSendAlerts({ scope: 'global', budgetId: 'global_daily', period: 'daily' }, dailySpend, globalBudget.limit_usd);
  }

  // Check agent-specific budget
  const agentBudget = db.prepare(`
    SELECT limit_usd, period FROM budgets WHERE id = ?
  `).get(`agent_${agentId}`) as { limit_usd: number; period: string } | undefined;

  if (agentBudget) {
    const agentSpend = agentPeriodSpend(agentId, agentBudget.period);
    checkAndSendAlerts({ scope: agentId, budgetId: `agent_${agentId}`, period: agentBudget.period }, agentSpend, agentBudget.limit_usd);
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
    checkAndSendAlerts({ scope: 'global', budgetId: 'global_daily', period: 'daily' }, dailySpend, globalBudget.limit_usd);

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
