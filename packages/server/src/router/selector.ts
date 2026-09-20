// ════════════════════════════════════════
// Model Selector with Fallback
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { createLogger } from '../logger.js';
import { isRateLimited } from './rate-limits.js';
import { getDailySpend } from '../costs/tracker.js';
import { checkBudget } from '../costs/budget.js';
import { getModelCapabilities } from '../services/capabilities.js';
import type { DimensionScore } from './types.js';
// T82a fix wave (round 2) — a LEAF import, deliberately not `agent/model.js`: see
// `providerCeilingTokensFor` below for why the query is mirrored here instead.
import { resolveStreamPatience, resolveDoomCeiling, providerAwareBudgetTokens } from '../agent/stream-patience.js';

const logger = createLogger('selector');

export interface SelectedModel {
  modelId: string;
  providerId: string;
  apiModelId: string;
  fallbackUsed: boolean;
}

// Tier fallback order: every tier can fall back downward. A rate-limited
// Opus (heavy) should fall back to Sonnet (standard), not crash the agent.
const TIER_FALLBACK: Record<string, string[]> = {
  light: ['light', 'standard', 'heavy'],
  standard: ['standard', 'heavy', 'light'],
  heavy: ['heavy', 'standard', 'light'],
};

interface TierModelRow {
  model_id: string;
  provider_id: string;
  api_model_id: string;
  priority: number;
  input_cost_per_m: number | null;
  output_cost_per_m: number | null;
}

function getTierModels(tierId: string): TierModelRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT tm.model_id, m.provider_id, m.api_model_id, tm.priority,
           m.input_cost_per_m, m.output_cost_per_m
    FROM router_tier_models tm
    JOIN models m ON m.id = tm.model_id
    WHERE tm.tier_id = ? AND m.is_enabled = 1
    ORDER BY tm.priority ASC
  `).all(tierId) as TierModelRow[];
}

/**
 * The "system" router tier holds the model used for background/system tasks
 * (the multi-step classifier today; watchdog smart-alerts to follow). It is
 * NOT score-routed — it's resolved explicitly here. Returns the top-priority
 * enabled model id assigned to the tier, or null when none is configured (in
 * which case callers fall back to their non-LLM behavior). Separate from the
 * PM agent model (`pm_agent_model`) by design.
 */
export function getSystemModel(): string | null {
  const models = getTierModels('system');
  return models.length > 0 ? models[0].model_id : null;
}

function estimateRequestCost(model: TierModelRow): number {
  // Rough estimate: 2k input, 1k output per request.
  // D-H: an unknown (NULL) price estimates as $0, matching how the biller
  // records it, so near the budget wall an unpriced model is not over-gated as
  // if it were the Sonnet premium. The "price unknown" state stays visible via
  // the per-model dashboard flag and the biller's once-per-model warn; this is
  // only the pre-call estimate side. Explicit prices are used as-is.
  const inputCost = ((model.input_cost_per_m ?? 0) / 1_000_000) * 2000;
  const outputCost = ((model.output_cost_per_m ?? 0) / 1_000_000) * 1000;
  return inputCost + outputCost;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T82a FIX WAVE (round 2) — THE FALLBACK PICK LEARNS THE BOX TOO.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Round 1 taught `agent/v2/steps/call-llm/index.ts` to re-check the ROUTER'S INITIAL pick
// against the array it inherited. The same hole exists one layer deeper: when that pick's
// dial FAILS and `model-call.ts` asks THIS function for a fallback, the fallback candidate
// is filtered on capability/rate-limit/budget and nothing else — a tier mixing cloud rows
// (no ceiling) with a declared-local row (600s/180tps) can hand back the local row for the
// SAME oversized array, unchecked. This is that same gap, reachable from a second door.
//
// `inputEstimate` is OPTIONAL and every existing call site omits it — that is the R6
// byte-preservation control (every caller before this task, unchanged) AND, separately, the
// `selector-latency.test.ts` sub-2ms guard: the fit check below never runs, never queries
// the two ceiling columns, when the caller doesn't supply an estimate.
//
// WHY A LOCAL, MIRRORED QUERY AND NOT `agent/model.js`'s `getProviderCeilingTokens`: the
// EXACT precedent `agent/v2/steps/pre-call-gates/turn-budget.ts`'s
// `readProviderUnattendedBudgetMinutes` states for the identical situation — `agent/model.ts`
// carries the Anthropic/OpenAI SDKs and undici, and this selector has never needed any of
// that for the sake of two already-declared columns. It also keeps `selectModel` SYNCHRONOUS:
// `getProviderCeilingTokens` only ever does a synchronous indexed read, so mirroring it here
// costs nothing async and every one of this function's three existing callers, none of which
// await it today, keeps working unchanged.
function providerCeilingTokensFor(modelId: string): number | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT p.first_chunk_timeout_ms AS first_chunk_timeout_ms, p.prefill_tokens_per_sec AS prefill_tokens_per_sec
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.id = ?
    `).get(modelId) as { first_chunk_timeout_ms: number | null; prefill_tokens_per_sec: number | null } | undefined;
    if (!row) return null;
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: row.first_chunk_timeout_ms, streamIdleTimeoutMs: null });
    // R6, mirrored from `getProviderCeilingTokens`: a declared throughput alone, with no
    // declared patience, is not "this provider declared both halves" — leave it unconstrained.
    if (!patience.firstChunkDeclared) return null;
    return resolveDoomCeiling(patience.firstChunkMs, row.prefill_tokens_per_sec);
  } catch {
    return null;
  }
}

/**
 * Whether `modelId` can serve a prompt of `inputEstimate` tokens at all, per its own
 * declared ceiling. `null` ceiling (undeclared, or only one half declared) means
 * unconstrained — every candidate before T82a, and every fast/cloud one since.
 *
 * `providerAwareBudgetTokens(Infinity, ceiling)` rather than a bare `floor(ceiling * 0.5)`:
 * the arithmetic is `agent/stream-patience.ts`'s ONE named constant
 * (`PROVIDER_CEILING_SAFETY`), reused rather than re-derived a second time with its own
 * literal `0.5` a different module could tune out of step with the first. `Infinity` stands
 * in for "this candidate's own admission budget", which this synchronous, per-candidate
 * filter cannot afford to compute (that needs an async tool-payload measurement per
 * candidate) — the ceiling term is the one that actually binds for a declared-slow box, which
 * is the whole shape of the incident this filter exists to catch.
 */
function fitsProviderCeiling(modelId: string, inputEstimate: number): boolean {
  const ceiling = providerCeilingTokensFor(modelId);
  if (ceiling === null) return true;
  return inputEstimate <= providerAwareBudgetTokens(Number.POSITIVE_INFINITY, ceiling);
}

export function selectModel(
  tier: string | null | undefined,
  agentId: string,
  excludeModels?: string[],
  requireCapabilities?: string[],
  /**
   * T82a fix wave (round 2): the current assembled input, in tokens. When present, a
   * candidate whose declared ceiling cannot cover it is excluded — mirroring the existing
   * rate-limit/budget filters, one more predicate in the same walk. `undefined` (every
   * caller before this task) skips the check entirely: R6's byte-preservation control.
   */
  inputEstimate?: number,
): SelectedModel | null {
  const excluded = new Set(excludeModels ?? []);
  const required = requireCapabilities ?? [];

  // Defensive: callers occasionally pass null/undefined/unknown tier (e.g.,
  // when fallback fires mid-tool-loop and scoring was skipped this iteration).
  // Without this, TIER_FALLBACK[null] is undefined and we end up searching
  // a single tier with id 'null', which finds nothing and forces an injury.
  // Default to 'standard' so we still try every tier via the fallback chain.
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
      // Skip excluded models
      if (excluded.has(model.model_id)) continue;

      // Skip models lacking required capabilities (e.g., tools, vision)
      if (required.length > 0) {
        const caps = getModelCapabilities(model.model_id);
        // Only filter if the model has known capabilities (non-empty).
        // Models with no capability data (empty) are allowed through
        // since we don't want a missing probe to block selection.
        if (caps.length > 0 && required.some(req => !caps.includes(req as never))) {
          logger.debug('Model lacks required capabilities, skipping', {
            modelId: model.model_id, required, caps,
          }, agentId);
          continue;
        }
      }

      // Skip rate-limited models
      if (isRateLimited(model.model_id)) {
        logger.debug('Model rate-limited, skipping', { modelId: model.model_id }, agentId);
        continue;
      }

      // Check budget
      const estimatedCost = estimateRequestCost(model);
      const budgetCheck = checkBudget(agentId, estimatedCost);
      if (!budgetCheck.allowed) {
        logger.warn('Model exceeds budget, skipping', {
          modelId: model.model_id,
          reason: budgetCheck.reason,
        }, agentId);
        continue;
      }

      // T82a fix wave (round 2): skip a candidate whose own declared ceiling cannot cover
      // what is already assembled. Mirrors the budget check immediately above — same shape,
      // same log level, one more predicate a starved selection can be diagnosed from.
      if (inputEstimate !== undefined && !fitsProviderCeiling(model.model_id, inputEstimate)) {
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

    // If we've exhausted this tier and it wasn't the requested one, mark fallback
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
      // P6b execution lineage: the per-turn request id (shared with the
      // cost_records rows this decision produced) and the turn's root.
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
