// ════════════════════════════════════════
// Cost API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import { createLogger } from '../../logger.js';
import { getCostSummary } from '../../costs/tracker.js';
import { getBudgets, setGlobalBudget, setAgentBudget } from '../../costs/budget.js';
import { releaseClearedBudgetStops } from '../../agent/v2/honest-stop-lock.js';

const logger = createLogger('costs-routes');
const costsRouter = new Hono();

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

  if (!body || typeof body.limitUsd !== 'number' || body.limitUsd <= 0) {
    return c.json({ ok: false, error: 'limitUsd (positive number) is required' }, 400);
  }

  try {
    setGlobalBudget(body.limitUsd);
    await releaseClearedBudgetStops();   // A changed limit lifts the honest stop it was holding
    return c.json({ ok: true, data: { scope: 'global', limitUsd: body.limitUsd, period: 'daily' } });
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

  if (!body || typeof body.limitUsd !== 'number' || body.limitUsd <= 0) {
    return c.json({ ok: false, error: 'limitUsd (positive number) is required' }, 400);
  }

  const period = body.period ?? 'daily';
  const validPeriods = ['daily', 'weekly', 'monthly'];
  if (!validPeriods.includes(period)) {
    return c.json({ ok: false, error: 'Invalid period. Use: daily, weekly, monthly' }, 400);
  }

  try {
    setAgentBudget(agentId, body.limitUsd, period);
    await releaseClearedBudgetStops();   // A changed limit lifts the honest stop it was holding
    return c.json({ ok: true, data: { agentId, limitUsd: body.limitUsd, period } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to set agent budget', { error: msg, agentId });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { costsRouter };
