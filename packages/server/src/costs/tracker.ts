// ════════════════════════════════════════
// Cost Calculation and Recording
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { checkAlertsAfterCost } from './budget.js';

const logger = createLogger('costs');

// ── Record Cost ──

export type PricingUnit = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';

export interface RecordCostParams {
  agentId: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  requestType?: string;
  // For megapixel-priced image-gen models. The unit count is derived
  // from (imageWidth * imageHeight) / 1_000_000 so the caller passes the
  // raw dimensions and we compute MP here.
  imageWidth?: number;
  imageHeight?: number;
  // Generic per-unit count for every other non-token pricing unit:
  //   second, duration of generated media (video / audio gen)
  //   character, characters of input text (TTS)
  //   minute, minutes of input audio (transcription)
  //   item, flat per-generated-item (a song, an image, a clip)
  // The model row's pricing_unit field disambiguates what this number
  // means. If unset, the recorder falls through to token math. For 'item'
  // a missing count defaults to 1 (one generation call = one item).
  units?: number;
  // Prompt-cache tokens (token-priced calls only). Passed DISJOINT from
  // inputTokens per C28 P-7: inputTokens is the UNCACHED input; cache reads
  // bill at 0.1x the input rate, cache creation at 1.25x. Leave undefined
  // when the provider does not report cache figures (persists as NULL, which
  // a hit-ratio reader must not treat as a miss).
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface ModelPricing {
  unit: PricingUnit;
  inputCostPerM: number;     // token mode; a NULL price bills as $0 (D-H)
  outputCostPerM: number;    // token mode; a NULL price bills as $0 (D-H)
  costPerUnit: number | null; // any non-token unit; null when unknown or token-priced
  // True when the rate that applies to this model is NULL in the DB (not an
  // explicit 0): a token row missing input/output $/M, or a non-token row
  // missing cost_per_unit. Billed as $0 per D-H; drives the once-per-model warn.
  priceUnknown: boolean;
  providerType: string;      // parent provider type; 'ollama'/'local' are unpaid
}

function getModelPricing(modelId: string): ModelPricing {
  const db = getDb();
  // LEFT JOIN so an orphaned model (provider deleted) still bills rather than
  // dropping the record; providerType then falls back to '' (treated as paid).
  const row = db.prepare(`
    SELECT m.input_cost_per_m, m.output_cost_per_m, m.pricing_unit, m.cost_per_unit, m.cost_per_megapixel,
           p.type AS provider_type
    FROM models m
    LEFT JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId) as {
    input_cost_per_m: number | null;
    output_cost_per_m: number | null;
    pricing_unit: string | null;
    cost_per_unit: number | null;
    cost_per_megapixel: number | null;
    provider_type: string | null;
  } | undefined;

  const rawUnit = row?.pricing_unit;
  const unit: PricingUnit =
    rawUnit === 'megapixel' || rawUnit === 'second' ||
    rawUnit === 'character' || rawUnit === 'minute' || rawUnit === 'item'
      ? rawUnit
      : 'token';

  // Prefer cost_per_unit (post-migration 061). For megapixel rows added
  // pre-061, cost_per_unit may still be null but cost_per_megapixel
  // holds the legacy value, keep the fallback during the compat window.
  const costPerUnit =
    typeof row?.cost_per_unit === 'number'
      ? row.cost_per_unit
      : unit === 'megapixel' && typeof row?.cost_per_megapixel === 'number'
        ? row.cost_per_megapixel
        : null;

  // D-H: NULL means "price unknown", billed as $0 (both directions), NOT the
  // old Sonnet premium (3/15). Explicit prices pass through unchanged. The
  // priceUnknown flag preserves the protection the 3/15 default gave: a paid
  // row with a missing rate is surfaced (per-model UI flag + once-per-model
  // warn) rather than silently hidden at $0.
  const inputNull = row?.input_cost_per_m === null || row?.input_cost_per_m === undefined;
  const outputNull = row?.output_cost_per_m === null || row?.output_cost_per_m === undefined;
  const priceUnknown = unit === 'token' ? (inputNull || outputNull) : costPerUnit === null;

  return {
    unit,
    inputCostPerM: row?.input_cost_per_m ?? 0,
    outputCostPerM: row?.output_cost_per_m ?? 0,
    costPerUnit,
    priceUnknown,
    providerType: row?.provider_type ?? '',
  };
}

// Models we've already warned about billing at $0 due to a NULL (unknown)
// price on a PAID provider. One warn per model per process keeps the
// condition visible server-side without flooding the log on every call. Per
// D-H the old 3/15 premium default is gone; the persistent per-model UI flag
// (priceUnknown) plus this warn are the replacement protection so a
// misconfigured paid row is never SILENTLY hidden at $0.
const warnedUnknownPriceModels = new Set<string>();

export function recordCost(params: RecordCostParams): void {
  const { agentId, modelId, providerId, inputTokens, outputTokens, latencyMs, requestType, imageWidth, imageHeight, units, cacheReadTokens, cacheCreationTokens } = params;

  try {
    const pricing = getModelPricing(modelId);

    // Resolve the unit count for this call based on the model's
    // pricing_unit. For megapixel we compute from the image dimensions
    // the caller passed; for every other non-token unit we read the
    // generic `units` param. If anything is missing (no rate, no count)
    // we fall through to token math so a misconfigured row still
    // produces a sensible record rather than silently $0.
    let unitCount: number | null = null;
    if (pricing.unit === 'megapixel') {
      if (typeof imageWidth === 'number' && imageWidth > 0 && typeof imageHeight === 'number' && imageHeight > 0) {
        unitCount = (imageWidth * imageHeight) / 1_000_000;
      }
    } else if (pricing.unit === 'second' || pricing.unit === 'character' || pricing.unit === 'minute') {
      if (typeof units === 'number' && units > 0) {
        unitCount = units;
      }
    } else if (pricing.unit === 'item') {
      // Flat per-item pricing (per song / image / clip). One generation
      // call is one item unless the caller passes an explicit count.
      unitCount = typeof units === 'number' && units > 0 ? units : 1;
    }

    let costUsd: number;
    let costMode: PricingUnit = 'token';
    if (pricing.unit !== 'token' && unitCount !== null && pricing.costPerUnit !== null) {
      costUsd = unitCount * pricing.costPerUnit;
      costMode = pricing.unit;
    } else {
      // Token math with prompt-cache tiers (C28 P-7). inputTokens is the
      // UNCACHED input; cache reads bill at 0.1x the input rate and cache
      // creation at 1.25x. Absent cache fields fall through as zero cost,
      // leaving the plain input+output math unchanged.
      const inRate = pricing.inputCostPerM / 1_000_000;
      const inputCost = inputTokens * inRate;
      const cacheReadCost = (cacheReadTokens ?? 0) * 0.1 * inRate;
      const cacheCreationCost = (cacheCreationTokens ?? 0) * 1.25 * inRate;
      const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerM;
      costUsd = inputCost + cacheReadCost + cacheCreationCost + outputCost;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                cost_usd, latency_ms, request_type,
                                cache_read_tokens, cache_creation_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      modelId,
      providerId,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs ?? null,
      requestType ?? null,
      // NULL when the provider did not report (undefined) vs 0 when it
      // reported zero: keep the distinction so the reader does not count a
      // non-reporting provider as a cache miss.
      cacheReadTokens ?? null,
      cacheCreationTokens ?? null,
    );

    // Invalidate daily spend cache so next budget check gets fresh data
    invalidateDailySpendCache();

    // D-H visibility: an unknown (NULL) price now bills as $0 rather than the
    // old Sonnet premium, so a genuinely-paid model whose price lookup failed
    // would bill silently at $0. Warn once per model per process for a
    // paid-type provider (ollama/local are legitimately free) so the condition
    // is visible server-side too. The persistent per-model UI flag carries it
    // in the dashboard.
    const paidProvider = pricing.providerType !== 'ollama' && pricing.providerType !== 'local';
    if (pricing.priceUnknown && paidProvider && !warnedUnknownPriceModels.has(modelId)) {
      warnedUnknownPriceModels.add(modelId);
      logger.warn('Recorded cost for a paid-provider model with an unknown (NULL) price; the missing rate billed as $0 (set a rate in Settings > Models)', {
        agentId,
        modelId,
        providerId,
        providerType: pricing.providerType,
        costMode,
        costUsd: costUsd.toFixed(6),
      }, agentId);
    }

    logger.info(`Cost recorded: $${costUsd.toFixed(4)} for agent ${agentId} (${costMode})`, {
      agentId,
      modelId,
      costMode,
      unitCount: unitCount ?? null,
      imageWidth: imageWidth ?? null,
      imageHeight: imageHeight ?? null,
      units: units ?? null,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens ?? null,
      cacheCreationTokens: cacheCreationTokens ?? null,
      costUsd: costUsd.toFixed(6),
    }, agentId);

    // Check budget alerts AFTER recording (fires alerts when thresholds are crossed)
    try {
      checkAlertsAfterCost(agentId);
    } catch {
      // Alert check is best-effort
    }
  } catch (err) {
    logger.error('Failed to record cost', {
      error: err instanceof Error ? err.message : String(err),
      agentId,
      modelId,
    }, agentId);
  }
}

// ── Cost Summary ──

export interface CostSummary {
  totalSpend: number;
  dailyAvg: number;
  byModel: Array<{ modelId: string; modelName: string; totalCost: number; requestCount: number }>;
  byAgent: Array<{ agentId: string; agentName: string; totalCost: number; requestCount: number }>;
  byTier: Array<{ tier: string; totalCost: number; requestCount: number }>;
}

function periodToSql(period: '24h' | '7d' | '30d' | 'all'): string {
  switch (period) {
    case '24h': return "AND created_at >= datetime('now', '-1 day')";
    case '7d': return "AND created_at >= datetime('now', '-7 days')";
    case '30d': return "AND created_at >= datetime('now', '-30 days')";
    case 'all': return '';
  }
}

function periodToDays(period: '24h' | '7d' | '30d' | 'all'): number {
  switch (period) {
    case '24h': return 1;
    case '7d': return 7;
    case '30d': return 30;
    case 'all': return 1; // Will compute actual days
  }
}

export function getCostSummary(period: '24h' | '7d' | '30d' | 'all'): CostSummary {
  const db = getDb();
  const filter = periodToSql(period);

  // Total spend
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records cr WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
  `).get() as { total: number };

  // Days for average
  let days = periodToDays(period);
  if (period === 'all') {
    const earliest = db.prepare(`
      SELECT MIN(created_at) as earliest FROM cost_records
    `).get() as { earliest: string | null };
    if (earliest.earliest) {
      days = Math.max(1, Math.ceil((Date.now() - new Date(earliest.earliest).getTime()) / (1000 * 60 * 60 * 24)));
    }
  }

  // By model (with name lookup)
  const byModel = db.prepare(`
    SELECT cr.model_id as modelId, COALESCE(m.name, 'Unknown Model (' || substr(cr.model_id, 1, 6) || ')') as modelName,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost, COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN models m ON m.id = cr.model_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.model_id ORDER BY totalCost DESC
  `).all() as Array<{ modelId: string; modelName: string; totalCost: number; requestCount: number }>;

  // By agent (with name lookup)
  const byAgent = db.prepare(`
    SELECT cr.agent_id as agentId, COALESCE(a.name, 'Deleted Agent (' || substr(cr.agent_id, 1, 6) || ')') as agentName,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost, COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.agent_id ORDER BY totalCost DESC
  `).all() as Array<{ agentId: string; agentName: string; totalCost: number; requestCount: number }>;

  // By tier, group by the tier the auto-router ACTUALLY chose for each call
  // (request_type), not a model->tier join. The old join mis-counted badly:
  // untagged models all fell into 'unknown' (the bulk of records), and a model
  // assigned to multiple tiers had its cost counted once per tier (identical
  // phantom totals). request_type is the real per-call routing decision.
  const byTier = db.prepare(`
    SELECT cr.request_type as tier,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost,
           COUNT(*) as requestCount
    FROM cost_records cr
    WHERE cr.request_type IN ('light', 'standard', 'heavy') ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.request_type ORDER BY totalCost DESC
  `).all() as Array<{ tier: string; totalCost: number; requestCount: number }>;

  return {
    totalSpend: totalRow.total,
    dailyAvg: totalRow.total / days,
    byModel,
    byAgent,
    byTier,
  };
}

// ── Cost Records ──

export interface CostRecord {
  id: string;
  agentId: string;
  agentName: string;
  modelId: string;
  modelName: string;
  providerId: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  requestType: string | null;
  createdAt: string;
}

export function getCostRecords(filter?: {
  agentId?: string;
  modelId?: string;
  limit?: number;
  offset?: number;
}): { records: CostRecord[]; total: number } {
  const db = getDb();
  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (filter?.agentId) {
    conditions.push('cr.agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter?.modelId) {
    conditions.push('cr.model_id = ?');
    params.push(filter.modelId);
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(filter?.limit ?? 50, 500);
  const offset = filter?.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as count FROM cost_records cr WHERE ${where}`).get(...params) as { count: number }).count;

  const rows = db.prepare(`
    SELECT cr.id, cr.agent_id, cr.model_id, cr.provider_id, cr.input_tokens, cr.output_tokens,
           cr.cost_usd, cr.latency_ms, cr.request_type, cr.created_at,
           COALESCE(a.name, 'Deleted Agent (' || substr(cr.agent_id, 1, 6) || ')') as agent_name,
           COALESCE(m.name, 'Unknown Model (' || substr(cr.model_id, 1, 6) || ')') as model_name,
           rl.tier_id as tier
    FROM cost_records cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    LEFT JOIN models m ON m.id = cr.model_id
    LEFT JOIN router_log rl ON rl.selected_model_id = cr.model_id
      AND rl.agent_id = cr.agent_id
      AND rl.created_at = cr.created_at
    WHERE ${where}
    ORDER BY cr.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: string;
    agent_id: string;
    model_id: string;
    provider_id: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    latency_ms: number | null;
    request_type: string | null;
    created_at: string;
    agent_name: string | null;
    model_name: string | null;
    tier: string | null;
  }>;

  const records: CostRecord[] = rows.map(r => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name ?? 'Deleted Agent',
    modelId: r.model_id,
    modelName: r.model_name ?? 'Unknown Model',
    providerId: r.provider_id,
    tier: r.tier ?? r.request_type ?? '--',
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    requestType: r.request_type,
    createdAt: r.created_at,
  }));

  return { records, total };
}

// ── Cache Hit Stats (C28 Part 2) ──

export interface CacheProviderStat {
  provider: string;
  calls: number;          // all calls in the window for this provider
  reportedCalls: number;  // calls where the provider reported cache figures
  readTokens: number;     // sum of cache_read_tokens
  creationTokens: number; // sum of cache_creation_tokens
  inputTokens: number;    // sum of uncached input_tokens over reported calls
  // read / (read + uncached-input) over reported calls; null when no reported
  // calls (provider does not surface cache figures, e.g. Ollama).
  hitRatio: number | null;
}

export interface CacheStats {
  window: number;          // number of most-recent calls examined
  byProvider: CacheProviderStat[];
  overall: { readTokens: number; creationTokens: number; inputTokens: number; hitRatio: number | null };
}

/**
 * Per-provider prompt-cache stats over the last N cost_records.
 * NULL cache columns (provider did not report) are excluded from the ratio
 * denominator so a non-reporting provider is not counted as a cache miss.
 */
export function getCacheStats(limit = 200): CacheStats {
  const db = getDb();
  const window = Math.min(Math.max(1, limit), 5000);

  const rows = db.prepare(`
    SELECT provider_id AS provider,
           COUNT(*) AS calls,
           SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN 1 ELSE 0 END) AS reportedCalls,
           COALESCE(SUM(cache_read_tokens), 0) AS readTokens,
           COALESCE(SUM(cache_creation_tokens), 0) AS creationTokens,
           COALESCE(SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN input_tokens ELSE 0 END), 0) AS inputTokens
    FROM (SELECT provider_id, cache_read_tokens, cache_creation_tokens, input_tokens
          FROM cost_records ORDER BY created_at DESC LIMIT ?)
    GROUP BY provider_id
    ORDER BY calls DESC
  `).all(window) as Array<{
    provider: string; calls: number; reportedCalls: number;
    readTokens: number; creationTokens: number; inputTokens: number;
  }>;

  const byProvider: CacheProviderStat[] = rows.map(r => {
    const denom = r.readTokens + r.inputTokens;
    return {
      provider: r.provider,
      calls: r.calls,
      reportedCalls: r.reportedCalls,
      readTokens: r.readTokens,
      creationTokens: r.creationTokens,
      inputTokens: r.inputTokens,
      hitRatio: r.reportedCalls > 0 && denom > 0 ? Math.round((r.readTokens / denom) * 1000) / 1000 : null,
    };
  });

  const readTokens = byProvider.reduce((a, p) => a + p.readTokens, 0);
  const creationTokens = byProvider.reduce((a, p) => a + p.creationTokens, 0);
  const inputTokens = byProvider.reduce((a, p) => a + p.inputTokens, 0);
  const reported = byProvider.reduce((a, p) => a + p.reportedCalls, 0);
  const overallDenom = readTokens + inputTokens;

  return {
    window,
    byProvider,
    overall: {
      readTokens,
      creationTokens,
      inputTokens,
      hitRatio: reported > 0 && overallDenom > 0 ? Math.round((readTokens / overallDenom) * 1000) / 1000 : null,
    },
  };
}

// ── Daily Spend (cached for 5 seconds to avoid redundant SUM queries) ──

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
