// Cost calculation and recording.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { createLogger } from '../logger.js';
import { checkAlertsAfterCost } from './budget.js';
import { recalibrateFromLedgerRow } from './ledger-calibration.js';
import { CHARS_PER_TOKEN } from '../memory/budget.js';
import { invalidateDailySpendCache } from './spend.js';

const logger = createLogger('costs');


export type PricingUnit = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';

export interface RecordCostParams {
  agentId: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  requestType?: string;
  /**
   * What this call was, on its own axis: the purpose the call site declared, whatever the router did, so
   * "how big is a real turn" is one predicate (`call_purpose = 'agent_turn'`). Undefined (an engine dial
   * that declares nothing) stores NULL, meaning "this row did not say". Never derived from `requestType`
   * here: a writer must not reconstruct a fact the caller withheld.
   */
  callPurpose?: string;
  // Megapixel-priced image models: the caller passes raw dimensions and MP = width * height / 1_000_000.
  imageWidth?: number;
  imageHeight?: number;
  // Per-unit count for every other non-token unit (second, character, minute, or a flat 'item'); the model
  // row's pricing_unit says which. If unset the recorder falls through to token math; for 'item' a missing
  // count is 1.
  units?: number;
  // USD per character for speech priced outside the models table (the cloud voice's plan rate); `units` is
  // the character count.
  characterRate?: number;
  // Prompt-cache tokens (token-priced calls only), DISJOINT from inputTokens (the UNCACHED input): reads
  // bill at 0.1x the input rate, creation at 1.25x. Undefined (provider reports none) persists as NULL,
  // which a hit-ratio reader must not treat as a miss.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** What the estimator said this call's input would cost, beside what the provider charged. Undefined where
   *  no estimate is computed (ollama, agent-sdk), stored NULL and never 0, which would read as a perfect
   *  prediction. */
  estimatedInputTokens?: number;
  /**
   * The divisor that really produced `estimatedInputTokens`, which only the caller knows
   * (`estimateRequestTokens` divides each population by its own reading). `estimated_input_tokens *
   * estimator_chars_per_token` must recover THIS request's character count, because
   * costs/ledger-calibration.ts divides that by the billed tokens; recording a flat 4 beside an estimate
   * that did not use it would make every reading measure our own error. Omitted beside an
   * estimate it falls back to the constant; with no estimate the stored divisor is NULL.
   */
  estimatorCharsPerToken?: number;
  /**
   * True when `inputTokens` is the char-derived fallback rather than a provider-billed count (the no-usage
   * path in agent/model.ts). NOT stored: the prefill speedometer reads it to refuse such a row, since an
   * inflated numerator tips its quotient above the true rate and the estimator takes a maximum. Cost
   * accounting is unaffected.
   */
  inputTokensEstimated?: boolean;
}

interface ModelPricing {
  unit: PricingUnit;
  inputCostPerM: number;     // token mode; a NULL price bills as $0
  outputCostPerM: number;    // token mode; a NULL price bills as $0
  costPerUnit: number | null; // any non-token unit; null when unknown or token-priced
  // True when the applicable rate is NULL in the DB (not an explicit 0): a token row missing input/output $/M,
  // or a non-token row missing cost_per_unit. Billed as $0; drives the once-per-model warn.
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

  // Prefer cost_per_unit; megapixel rows may carry only the legacy cost_per_megapixel (kept as a fallback).
  const costPerUnit =
    typeof row?.cost_per_unit === 'number'
      ? row.cost_per_unit
      : unit === 'megapixel' && typeof row?.cost_per_megapixel === 'number'
        ? row.cost_per_megapixel
        : null;

  // NULL means "price unknown" and bills as $0 in both directions; explicit prices pass through.
  // priceUnknown flags a paid row with a missing rate (per-model UI flag and once-per-model warn) so it is
  // never silently hidden at $0.
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

// Models already warned about for billing at $0 on a NULL price from a PAID provider: one warn per model
// per process keeps it visible server-side without flooding the log.
const warnedUnknownPriceModels = new Set<string>();

export function recordCost(params: RecordCostParams): void {
  const { agentId, modelId, providerId, inputTokens, outputTokens, latencyMs, requestType, imageWidth, imageHeight, units, characterRate, cacheReadTokens, cacheCreationTokens, estimatedInputTokens, inputTokensEstimated, callPurpose, estimatorCharsPerToken } = params;

  try {
    const pricing: ModelPricing = characterRate === undefined ? getModelPricing(modelId) : {
      unit: 'character', inputCostPerM: 0, outputCostPerM: 0, costPerUnit: characterRate, priceUnknown: false, providerType: '',
    };

    // Resolve the unit count from the model's pricing_unit (megapixel from the image dimensions, the rest
    // from `units`). A missing rate or count falls through to token math rather than recording a silent $0.
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
      // Flat per-item pricing: one generation call is one item unless the caller passes a count.
      unitCount = typeof units === 'number' && units > 0 ? units : 1;
    }

    let costUsd: number;
    let costMode: PricingUnit = 'token';
    if (pricing.unit !== 'token' && unitCount !== null && pricing.costPerUnit !== null) {
      costUsd = unitCount * pricing.costPerUnit;
      costMode = pricing.unit;
    } else {
      // Token math with prompt-cache tiers: reads bill at 0.1x the input rate, creation at 1.25x; absent fields cost zero.
      const inRate = pricing.inputCostPerM / 1_000_000;
      const inputCost = inputTokens * inRate;
      const cacheReadCost = (cacheReadTokens ?? 0) * 0.1 * inRate;
      const cacheCreationCost = (cacheCreationTokens ?? 0) * 1.25 * inRate;
      const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerM;
      costUsd = inputCost + cacheReadCost + cacheCreationCost + outputCost;
    }

    // ONE resolution of the divisor for this row, spent twice below (the stored column and the calibration
    // sample), so the two can never disagree.
    const divisorUsed = estimatedInputTokens === undefined
      ? null
      : (typeof estimatorCharsPerToken === 'number' && Number.isFinite(estimatorCharsPerToken)
          && estimatorCharsPerToken > 0 ? estimatorCharsPerToken : CHARS_PER_TOKEN);

    const db = getDb();
    db.prepare(`
      INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                cost_usd, latency_ms, request_type,
                                cache_read_tokens, cache_creation_tokens, request_id,
                                estimated_input_tokens, estimator_chars_per_token,
                                call_purpose, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      cacheReadTokens ?? null,
      cacheCreationTokens ?? null,
      // Joins this spend to the router decision (router_log.request_id); NULL for out-of-turn calls by design.
      turnContext(agentId)?.modelRequestId ?? null,
      estimatedInputTokens ?? null,
      divisorUsed,
      callPurpose ?? null,
    );

    // A free call changes no total: the spend cache and the budget alerts are left alone.
    if (costUsd > 0) invalidateDailySpendCache();

    // Self-calibration: this row holds both instrument readings (uncached input over latency bounds the
    // prefill rate from below; the estimate beside the billed count is the divisor the estimator should
    // have used). A no-op below either sample floor, and never allowed to fail a recorded cost.
    try {
      recalibrateFromLedgerRow(providerId, { inputTokens, latencyMs, inputTokensEstimated, estimatedInputTokens, cacheReadTokens, cacheCreationTokens, callPurpose, divisorUsed });
    } catch {
      // Best-effort, exactly like the alert check below.
    }

    // An unknown (NULL) price bills as $0, so warn once per model per process for a paid-type provider
    // (ollama/local are legitimately free); the per-model UI flag carries it in the dashboard.
    const paidProvider = pricing.providerType !== 'ollama' && pricing.providerType !== 'local';
    if (pricing.priceUnknown && paidProvider && !warnedUnknownPriceModels.has(modelId)) {
      warnedUnknownPriceModels.add(modelId);
      logger.warn('Recorded cost for a paid-provider model with an unknown (NULL) price; the missing rate billed as $0 (set a rate in Settings → Models)', {
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
    if (costUsd > 0) {
      try {
        checkAlertsAfterCost(agentId);
      } catch {
      }
    }
  } catch (err) {
    logger.error('Failed to record cost', {
      error: err instanceof Error ? err.message : String(err),
      agentId,
      modelId,
    }, agentId);
  }
}


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

  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records cr WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
  `).get() as { total: number };

  let days = periodToDays(period);
  if (period === 'all') {
    const earliest = db.prepare(`
      SELECT MIN(created_at) as earliest FROM cost_records
    `).get() as { earliest: string | null };
    if (earliest.earliest) {
      // created_at is zoneless `datetime('now')` UTC text; read it as UTC so the
      // day count does not depend on the box's own zone.
      days = Math.max(1, Math.ceil((Date.now() - new Date(earliest.earliest.replace(' ', 'T') + 'Z').getTime()) / (1000 * 60 * 60 * 24)));
    }
  }

  const byModel = db.prepare(`
    SELECT cr.model_id as modelId, COALESCE(m.name, 'Unknown Model (' || substr(cr.model_id, 1, 6) || ')') as modelName,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost, COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN models m ON m.id = cr.model_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.model_id ORDER BY totalCost DESC
  `).all() as Array<{ modelId: string; modelName: string; totalCost: number; requestCount: number }>;

  const byAgent = db.prepare(`
    SELECT cr.agent_id as agentId, COALESCE(a.name, 'Deleted Agent (' || substr(cr.agent_id, 1, 6) || ')') as agentName,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost, COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.agent_id ORDER BY totalCost DESC
  `).all() as Array<{ agentId: string; agentName: string; totalCost: number; requestCount: number }>;

  // By tier: group by the tier the auto-router ACTUALLY chose for each call (request_type), not a
  // model->tier join, which miscounts untagged models and models assigned to several tiers.
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

// Daily spend lives in `costs/spend.ts`, a leaf so the router's standing filters can judge the budget.
export { getDailySpend, invalidateDailySpendCache } from './spend.js';
