// Model selection with tier fallback.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { TIER_FALLBACK, getTierModels, type TierModelRow } from './tier-chain.js';
import { standingSkip, estimateRequestCost, type RoutedSkip } from './standing-filters.js';
import { turnContext } from '../agent/turn-context.js';
import { createLogger } from '../logger.js';
import { checkBudget } from '../costs/budget.js';
import { standardModelRowId } from '../services/local-standard.js';
import type { DimensionScore } from './types.js';
// A leaf import, deliberately not `agent/model.js` (see `providerCeilingTokensFor`).
import { resolveStreamPatience, resolveDoomCeiling, providerAwareBudgetTokens, doomGuardApplies } from '../agent/stream-patience.js';
import { CONTEXT_THRESHOLD } from '../memory/budget.js';

const logger = createLogger('selector');

export interface SelectedModel {
  modelId: string;
  providerId: string;
  apiModelId: string;
  fallbackUsed: boolean;
}

/** The engine's own writing model: the standard writer, else the `system` tier row; null when neither. */
export function getSystemModel(): string | null {
  return standardModelRowId('writer') ?? getTierModels('system')[0]?.model_id ?? null;
}

/** The estimate `selectModel` skips each reachable model on, so a budget stop is judged by the same number. */
export function routedCandidateCosts(): number[] {
  return [...new Map(Object.values(TIER_FALLBACK).flat().flatMap(getTierModels).map((m) => [m.model_id, estimateRequestCost(m)] as const)).values()];
}

// A local mirrored query, not `agent/model.js`'s `getProviderCeilingTokens`: that module carries the Anthropic and
// OpenAI SDKs and undici, and a synchronous indexed read keeps `selectModel` synchronous for its callers.
// `inputEstimate` is optional: without it the fit check never runs and never queries the ceiling columns.
function providerCeilingTokensFor(modelId: string): number | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT p.first_chunk_timeout_ms AS first_chunk_timeout_ms, p.prefill_tokens_per_sec AS prefill_tokens_per_sec,
             p.measured_prefill_tokens_per_sec AS measured_prefill_tokens_per_sec, p.type AS type, p.base_url AS base_url
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.id = ?
    `).get(modelId) as { first_chunk_timeout_ms: number | null; prefill_tokens_per_sec: number | null; measured_prefill_tokens_per_sec: number | null; type: string | null; base_url: string | null } | undefined;
    if (!row) return null;
    // A cloud provider has no doom ceiling (mirrors `getProviderCeilingTokens`).
    if (!doomGuardApplies({ providerType: row.type, providerBaseUrl: row.base_url })) return null;
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: row.first_chunk_timeout_ms, streamIdleTimeoutMs: null });
    // A declared throughput with no declared patience is not both halves: leave it unconstrained.
    if (!patience.firstChunkDeclared) return null;
    // The measured prefill rate is the fallback, read only where the declared one is NULL.
    return resolveDoomCeiling(patience.firstChunkMs, row.prefill_tokens_per_sec, row.measured_prefill_tokens_per_sec);
  } catch {
    return null;
  }
}

/**
 * Whether `modelId` can serve `inputEstimate` tokens per its declared ceiling (null ceiling: unconstrained).
 * The arithmetic is stream-patience.ts's one `PROVIDER_CEILING_SAFETY`; `Infinity` stands for the candidate's own
 * admission budget, which a synchronous per-candidate filter cannot measure.
 */
function fitsProviderCeiling(
  modelId: string, inputEstimate: number, windowOf?: (modelId: string) => number,
): boolean {
  // Also its window: a candidate with no ceiling must not get an array above its window's fill line.
  // `windowOf` is the caller's resolver (this file does not import `agent/model.ts`).
  if (windowOf && inputEstimate > Math.floor(CONTEXT_THRESHOLD * windowOf(modelId))) return false;
  const ceiling = providerCeilingTokensFor(modelId);
  if (ceiling === null) return true;
  return inputEstimate <= providerAwareBudgetTokens(Number.POSITIVE_INFINITY, ceiling);
}

/** The standing filters alone; `routedFirstPicks` uses only these so it agrees with `selectModel`. */
function passesStandingFilters(model: TierModelRow, required: string[], agentId?: string): boolean {
  return standingSkip(model, required, agentId) === null;
}

export type { RoutedSkip };

/** Every model `selectModel` could walk to from `tier`, with the filter turning it away now (null: offered). */
export function routedSkipReasons(
  tier: string | null | undefined, agentId: string, exclude: string[], required: string[],
): Array<{ modelId: string; skip: RoutedSkip | null }> {
  const out: Array<{ modelId: string; skip: RoutedSkip | null }> = [];
  for (const candidateTier of TIER_FALLBACK[tier && TIER_FALLBACK[tier] ? tier : 'standard']) {
    for (const model of getTierModels(candidateTier)) {
      if (out.some((o) => o.modelId === model.model_id)) continue;
      const skip = exclude.includes(model.model_id) ? 'excluded'
        : standingSkip(model, required, agentId)
          ?? (checkBudget(agentId, estimateRequestCost(model)).allowed ? null : 'budget');
      out.push({ modelId: model.model_id, skip });
    }
  }
  return out;
}

/**
 * The model each tier opens on (asked with `tools`): standing filters only, since the budget check has side
 * effects and fit needs an assembled array. Passing skips (rate limit, open breaker) still count as offered, so
 * an agent is not "unable to hold a conversation" because its roomy model is briefly limited.
 */
export function routedFirstPicks(): string[] {
  const picks = new Set<string>();
  for (const chain of Object.values(TIER_FALLBACK)) {
    walk: for (const candidateTier of chain) {
      for (const model of getTierModels(candidateTier)) {
        const skip = standingSkip(model, ['tools']);
        if (skip === null || PASSING.has(skip)) { picks.add(model.model_id); break walk; }
      }
    }
  }
  return [...picks];
}

/** Skips that clear without the agent changing. */
const PASSING = new Set<RoutedSkip>(['rate_limit', 'provider_down']);

export function selectModel(
  tier: string | null | undefined,
  agentId: string,
  excludeModels?: string[],
  requireCapabilities?: string[],
  /** The assembled input in tokens: a candidate whose declared ceiling cannot cover it is skipped. */
  inputEstimate?: number,
  /** The caller's window resolver, checked with `inputEstimate`. */
  windowOf?: (modelId: string) => number,
): SelectedModel | null {
  const excluded = new Set(excludeModels ?? []);
  const required = requireCapabilities ?? [];

  // A null or unknown tier (a fallback firing mid-tool-loop) defaults to 'standard' so every tier is still tried.
  const effectiveTier = (tier && TIER_FALLBACK[tier]) ? tier : 'standard';
  if (effectiveTier !== tier) {
    logger.warn('selectModel called with unknown tier — defaulting to standard fallback chain', {
      requestedTier: tier ?? null,
      effectiveTier,
    }, agentId);
  }

  const fallbackChain = TIER_FALLBACK[effectiveTier];
  let fallbackUsed = false;

  for (const candidateTier of fallbackChain) {
    const models = getTierModels(candidateTier);

    for (const model of models) {
      if (excluded.has(model.model_id)) continue;

      if (!passesStandingFilters(model, required, agentId)) continue;

      const estimatedCost = estimateRequestCost(model);
      const budgetCheck = checkBudget(agentId, estimatedCost);
      if (!budgetCheck.allowed) {
        logger.warn('Model exceeds budget, skipping', {
          modelId: model.model_id,
          reason: budgetCheck.reason,
        }, agentId);
        continue;
      }

      // Skip a candidate whose own declared ceiling cannot cover what is already assembled.
      if (inputEstimate !== undefined && !fitsProviderCeiling(model.model_id, inputEstimate, windowOf)) {
        logger.warn('Model cannot fit the already-assembled input within its declared ceiling, skipping', {
          modelId: model.model_id,
          inputEstimate,
        }, agentId);
        continue;
      }

      return {
        modelId: model.model_id,
        providerId: model.provider_id,
        apiModelId: model.api_model_id,
        fallbackUsed,
      };
    }

    if (candidateTier === tier) {
      fallbackUsed = true;
    }
  }

  logger.warn('No available model found', { tier, agentId, excludedCount: excluded.size }, agentId);
  return null;
}

export function logRouterDecision(
  agentId: string,
  scores: DimensionScore[],
  rawScore: number,
  tier: string,
  modelId: string,
  fallbackUsed: boolean,
  latencyMs: number,
  method?: string,
  confidence?: number,
  headVersion?: string | null,
  inputPreview?: string | null,
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO router_log (id, agent_id, input_preview, dimension_scores, raw_score,
                               tier_id, selected_model_id, fallback_used, latency_ms,
                               method, confidence, head_version, request_id, root_kind, root_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      inputPreview ?? null,
      JSON.stringify(scores),
      rawScore,
      tier,
      modelId,
      fallbackUsed ? 1 : 0,
      Math.round(latencyMs),
      method ?? null,
      confidence ?? null,
      headVersion ?? null,
      // The per-turn request id (shared with the cost_records rows this decision produced) and the turn's root.
      turnContext(agentId)?.modelRequestId ?? null,
      turnContext(agentId)?.root?.kind ?? null,
      turnContext(agentId)?.root?.id ?? null,
    );
  } catch (err) {
    logger.error('Failed to log router decision', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
