// ════════════════════════════════════════
// Router API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { scoreQuery, clearDimensionCache } from '../../router/scorer.js';
import type { RouterConfig, TierConfig } from '../../router/types.js';

const logger = createLogger('router-routes');
const routerRouter = new Hono();

// GET /config — tiers + dimensions
routerRouter.get('/config', (c) => {
  const db = getDb();

  const tiers = db.prepare(`
    SELECT id, display_name, description, score_min, score_max FROM router_tiers
  `).all() as Array<{
    id: string;
    display_name: string;
    description: string | null;
    score_min: number | null;
    score_max: number | null;
  }>;

  const tierConfigs: TierConfig[] = tiers.map(t => {
    const models = db.prepare(`
      SELECT rtm.model_id, rtm.priority, m.name as model_name, p.name as provider_name
      FROM router_tier_models rtm
      LEFT JOIN models m ON rtm.model_id = m.id
      LEFT JOIN providers p ON m.provider_id = p.id
      WHERE rtm.tier_id = ? ORDER BY rtm.priority ASC
    `).all(t.id) as Array<{ model_id: string; priority: number; model_name: string | null; provider_name: string | null }>;

    return {
      id: t.id,
      displayName: t.display_name,
      description: t.description,
      scoreMin: t.score_min,
      scoreMax: t.score_max,
      models: models.map(m => ({
        modelId: m.model_id,
        modelName: m.model_name ?? m.model_id,
        providerName: m.provider_name ?? '',
        priority: m.priority,
      })),
    };
  });

  const dimensions = db.prepare(`
    SELECT id, display_name, weight, is_enabled FROM router_dimensions
  `).all() as Array<{
    id: string;
    display_name: string;
    weight: number;
    is_enabled: number;
  }>;

  const config: RouterConfig = {
    tiers: tierConfigs,
    dimensions: dimensions.map(d => ({
      id: d.id,
      displayName: d.display_name,
      weight: d.weight,
      isEnabled: d.is_enabled === 1,
    })),
  };

  return c.json({ ok: true, data: config });
});

// GET /available-models — all enabled models (models can appear in multiple tiers)
routerRouter.get('/available-models', (c) => {
  const db = getDb();

  const models = db.prepare(`
    SELECT m.id, m.name, m.api_model_id, p.name as provider_name
    FROM models m
    JOIN providers p ON m.provider_id = p.id
    WHERE m.is_enabled = 1
    ORDER BY p.name, m.name
  `).all() as Array<{
    id: string;
    name: string;
    api_model_id: string;
    provider_name: string;
  }>;

  return c.json({ ok: true, data: models });
});

// PUT /tiers/:tierId/models — reorder models in tier
routerRouter.put('/tiers/:tierId/models', async (c) => {
  const tierId = c.req.param('tierId');
  const body = await c.req.json().catch(() => null);

  if (!body || !Array.isArray(body.models)) {
    return c.json({ ok: false, error: 'models (array of { modelId, priority }) is required' }, 400);
  }

  const db = getDb();

  // Verify tier exists
  const tier = db.prepare('SELECT id FROM router_tiers WHERE id = ?').get(tierId);
  if (!tier) {
    return c.json({ ok: false, error: 'Tier not found' }, 404);
  }

  try {
    const deleteStmt = db.prepare('DELETE FROM router_tier_models WHERE tier_id = ?');
    const insertStmt = db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');

    const transaction = db.transaction(() => {
      deleteStmt.run(tierId);
      for (const model of body.models as Array<{ modelId: string; priority: number }>) {
        insertStmt.run(tierId, model.modelId, model.priority);
      }
    });

    transaction();

    logger.info('Tier models updated', { tierId, modelCount: body.models.length });
    return c.json({ ok: true, data: { tierId, models: body.models } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update tier models', { error: msg, tierId });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /dimensions/:dimensionId — update weight
routerRouter.put('/dimensions/:dimensionId', async (c) => {
  const dimensionId = c.req.param('dimensionId');
  const body = await c.req.json().catch(() => null);

  if (!body) {
    return c.json({ ok: false, error: 'Request body required' }, 400);
  }

  const db = getDb();

  const existing = db.prepare('SELECT id FROM router_dimensions WHERE id = ?').get(dimensionId);
  if (!existing) {
    return c.json({ ok: false, error: 'Dimension not found' }, 404);
  }

  try {
    if (typeof body.weight === 'number') {
      db.prepare('UPDATE router_dimensions SET weight = ?, updated_at = datetime(\'now\') WHERE id = ?').run(body.weight, dimensionId);
    }
    if (typeof body.isEnabled === 'boolean') {
      db.prepare('UPDATE router_dimensions SET is_enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(body.isEnabled ? 1 : 0, dimensionId);
    }

    // Clear the scorer's cached weights
    clearDimensionCache();

    const updated = db.prepare('SELECT id, display_name, weight, is_enabled FROM router_dimensions WHERE id = ?').get(dimensionId) as {
      id: string; display_name: string; weight: number; is_enabled: number;
    };

    logger.info('Dimension updated', { dimensionId, weight: updated.weight, isEnabled: updated.is_enabled });
    return c.json({
      ok: true,
      data: {
        id: updated.id,
        displayName: updated.display_name,
        weight: updated.weight,
        isEnabled: updated.is_enabled === 1,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update dimension', { error: msg, dimensionId });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /test — test scorer with a prompt
routerRouter.post('/test', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.prompt !== 'string') {
    return c.json({ ok: false, error: 'prompt (string) is required' }, 400);
  }

  const systemPrompt = (body.systemPrompt as string) ?? '';
  const messages = [{ role: 'user', content: body.prompt as string }];

  const result = scoreQuery(systemPrompt, messages);

  return c.json({ ok: true, data: result });
});

// GET /stats — routing statistics
routerRouter.get('/stats', (c) => {
  const db = getDb();
  const period = c.req.query('period') ?? '24h';

  let filter = '';
  switch (period) {
    case '24h': filter = "WHERE created_at >= datetime('now', '-1 day')"; break;
    case '7d': filter = "WHERE created_at >= datetime('now', '-7 days')"; break;
    case '30d': filter = "WHERE created_at >= datetime('now', '-30 days')"; break;
    default: filter = '';
  }

  const totalDecisions = (db.prepare(`
    SELECT COUNT(*) as count FROM router_log ${filter}
  `).get() as { count: number }).count;

  const byTier = db.prepare(`
    SELECT tier_id as tierId, COUNT(*) as count,
           ROUND(AVG(latency_ms), 2) as avgLatencyMs,
           ROUND(AVG(raw_score), 4) as avgRawScore
    FROM router_log ${filter}
    GROUP BY tier_id
  `).all() as Array<{ tierId: string; count: number; avgLatencyMs: number; avgRawScore: number }>;

  const fallbackCount = (db.prepare(`
    SELECT COUNT(*) as count FROM router_log ${filter ? filter + ' AND' : 'WHERE'} fallback_used = 1
  `).get() as { count: number }).count;

  const byModel = db.prepare(`
    SELECT selected_model_id as modelId, COUNT(*) as count
    FROM router_log ${filter}
    GROUP BY selected_model_id ORDER BY count DESC
    LIMIT 10
  `).all() as Array<{ modelId: string; count: number }>;

  return c.json({
    ok: true,
    data: {
      totalDecisions,
      fallbackCount,
      fallbackRate: totalDecisions > 0 ? fallbackCount / totalDecisions : 0,
      byTier,
      byModel,
    },
  });
});

export { routerRouter };
