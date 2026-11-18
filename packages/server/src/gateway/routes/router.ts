// Router API routes

import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { refuseAgentModel, refuseSmallMainModel } from '../../agent/main-model-floor.js';
import { createLogger } from '../../logger.js';
import { clearDimensionCache } from '../../router/scorer.js';
import { decideTier } from '../../router/decide.js';
import type { RouterConfig, TierConfig } from '../../router/types.js';

const logger = createLogger('router-routes');
const routerRouter = new Hono();

// GET /config (tiers + dimensions, and the one window every automatic pick runs at)
routerRouter.get('/config', async (c) => {
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
    window: await (await import('../../router/router-window.js')).routerWindowReport(),
  };

  return c.json({ ok: true, data: config });
});

// GET /available-models (all enabled models; a model can appear in multiple tiers)
routerRouter.get('/available-models', (c) => {
  const db = getDb();

  const models = db.prepare(`
    SELECT m.id, m.name, m.api_model_id, p.name as provider_name, p.type as provider_type
    FROM models m
    JOIN providers p ON m.provider_id = p.id
    WHERE m.is_enabled = 1 AND m.capabilities NOT LIKE '%"decision"%'   -- v3.5: the Dojo's decision model runs no tier or opener
    ORDER BY p.name, m.name
  `).all() as Array<{
    id: string;
    name: string;
    api_model_id: string;
    provider_name: string;
    provider_type: string;
  }>;

  return c.json({ ok: true, data: models.map((m) => ({ ...m, tooSmallForAgents: refuseSmallMainModel(m.id) !== null })) });
});

// PUT /tiers/:tierId/models (reorder models in tier)
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

  // The 'system' tier is the Dojo's standard writer, written only by the install routine
  // (`services/local-standard.ts`). Refused here so no door can point it elsewhere.
  if (tierId === 'system') {
    return c.json({ ok: false, error: "The Dojo's writer is fixed; it is installed by setup." }, 409);
  }

  // A local model added to a tier must fit in this box's memory. Models already in the tier are
  // not re-judged (re-saving is never refused).
  const current = new Set((db.prepare('SELECT model_id FROM router_tier_models WHERE tier_id = ?').all(tierId) as Array<{ model_id: string }>).map((r) => r.model_id));
  for (const { modelId } of body.models as Array<{ modelId: string }>) {
    // An agent tier runs agent turns, so a model added to one meets the same check as every agent door.
    const refused = current.has(modelId) ? null : await refuseAgentModel(modelId);
    if (refused) return c.json({ ok: false, error: refused }, 400);
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
    await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged();   // a tier changed; no-fit locks get another look
    return c.json({ ok: true, data: { tierId, models: body.models } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update tier models', { error: msg, tierId });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /dimensions/:dimensionId (update weight)
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

// POST /test: the decision a turn with this prompt would get, and the model it would dial
routerRouter.post('/test', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.prompt !== 'string') {
    return c.json({ ok: false, error: 'prompt (string) is required' }, 400);
  }

  const prompt = body.prompt as string;
  const result = await decideTier([{ role: 'user', content: prompt }], 'router-test', prompt);

  // `scores` are the keyword backup's dimension scores, present only when the backup decided; the panel reads
  // `score` on each, so `raw` is aliased. selectModel can return null when every tier is exhausted; say so.
  const { selectModel } = await import('../../router/selector.js');
  const db = getDb();
  let selectedModel = '(no model available)';
  try {
    const sel = selectModel(result.tier, 'router-test');
    if (sel) {
      // Show the human-readable model NAME, not the internal id. Fall back to
      // the id if the model row is gone.
      const row = db.prepare('SELECT name FROM models WHERE id = ?').get(sel.modelId) as { name: string } | undefined;
      const label = row?.name ?? sel.modelId;
      selectedModel = sel.fallbackUsed ? `${label} (fallback)` : label;
    }
  } catch (err) {
    // Don't fail the test on a selector hiccup - the scoring result
    // is still useful for the user even if model lookup misbehaved.
    selectedModel = `(selector error: ${err instanceof Error ? err.message : String(err)})`;
  }

  return c.json({
    ok: true,
    data: {
      scores: result.scores.map(s => ({
        dimension: s.dimension,
        score: s.raw,
        raw: s.raw,
        weight: s.weight,
        weighted: s.weighted,
      })),
      rawScore: result.rawScore,
      confidence: result.confidence,
      tier: result.tier,
      method: result.method,
      latencyMs: result.latencyMs,
      selectedModel,
    },
  });
});

// GET /stats (routing statistics)
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

  // How the tier was chosen (semantic / heuristic / fallback / structural).
  // Rows logged before migration 074 have a null method.
  const byMethod = db.prepare(`
    SELECT COALESCE(method, 'legacy') as method, COUNT(*) as count
    FROM router_log ${filter}
    GROUP BY COALESCE(method, 'legacy') ORDER BY count DESC
  `).all() as Array<{ method: string; count: number }>;

  // Whether the feature is even active: distinguishes "no agent on auto-router"
  // from "enabled but nothing routed yet" in the dashboard empty state.
  const autoRouterEnabled = (db.prepare(
    "SELECT EXISTS(SELECT 1 FROM agents WHERE model_id = 'auto') AS e"
  ).get() as { e: number }).e === 1;

  return c.json({
    ok: true,
    data: {
      totalDecisions,
      fallbackCount,
      fallbackRate: totalDecisions > 0 ? fallbackCount / totalDecisions : 0,
      byTier,
      byModel,
      byMethod,
      autoRouterEnabled,
    },
  });
});

export { routerRouter };
