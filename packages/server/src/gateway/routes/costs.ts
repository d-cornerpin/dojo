// ════════════════════════════════════════
// Cost API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import { createLogger } from '../../logger.js';
import { getCostSummary } from '../../costs/tracker.js';
import { getBudgets, setGlobalBudget, setAgentBudget, removeBudget } from '../../costs/budget.js';
import { releaseClearedBudgetStops } from '../../agent/v2/honest-stop-lock.js';

const logger = createLogger('costs-routes');
const costsRouter = new Hono();

// A limit of 0 or null means no limit (the budget row is removed); any other limit must be a number above 0.
const LIMIT_ERROR = 'limitUsd must be a number above 0, or 0 or null for no limit';
function limitOf(body: unknown): number | null | undefined {
  const v = (body as { limitUsd?: unknown } | null)?.limitUsd;
  if (v === null || v === 0) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return undefined;
}

// GET /summary, cost summary by period
costsRouter.get('/summary', (c) => {
  const period = (c.req.query('period') ?? '24h') as '24h' | '7d' | '30d' | 'all';
  const validPeriods = ['24h', '7d', '30d', 'all'];

  if (!validPeriods.includes(period)) {
    return c.json({ ok: false, error: 'Invalid period. Use: 24h, 7d, 30d, all' }, 400);
  }

  try {
    const summary = getCostSummary(period);
    return c.json({ ok: true, data: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to get cost summary', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /budget, get budgets
costsRouter.get('/budget', (c) => {
  try {
    const budgets = getBudgets();
    return c.json({ ok: true, data: budgets });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to get budgets', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /budget/global, set global budget
costsRouter.put('/budget/global', async (c) => {
  const body = await c.req.json().catch(() => null);

  const limitUsd = limitOf(body);
  if (limitUsd === undefined) {
    return c.json({ ok: false, error: LIMIT_ERROR }, 400);
  }

  try {
    if (limitUsd === null) removeBudget('global_daily');
    else setGlobalBudget(limitUsd);
    await releaseClearedBudgetStops();   // A changed limit lifts the honest stop it was holding
    return c.json({ ok: true, data: { scope: 'global', limitUsd, period: 'daily' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to set global budget', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /budget/agent/:agentId, set agent budget
costsRouter.put('/budget/agent/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const body = await c.req.json().catch(() => null);

  const limitUsd = limitOf(body);
  if (limitUsd === undefined) {
    return c.json({ ok: false, error: LIMIT_ERROR }, 400);
  }

  const period = body.period ?? 'daily';
  const validPeriods = ['daily', 'weekly', 'monthly'];
  if (!validPeriods.includes(period)) {
    return c.json({ ok: false, error: 'Invalid period. Use: daily, weekly, monthly' }, 400);
  }

  try {
    if (limitUsd === null) removeBudget(`agent_${agentId}`);
    else setAgentBudget(agentId, limitUsd, period);
    await releaseClearedBudgetStops();   // A changed limit lifts the honest stop it was holding
    return c.json({ ok: true, data: { agentId, limitUsd, period } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to set agent budget', { error: msg, agentId });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { costsRouter };
