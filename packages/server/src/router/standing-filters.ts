// ════════════════════════════════════════════════════════════════════════════
// THE ROUTER'S STANDING FILTERS (moved out of `router/selector.ts` verbatim by t268, fix round 4, N-E): the
// predicates every routed pick passes whatever the call — its provider's billing breaker, its capabilities, its rate
// limit — and the per-request cost estimate the budget is judged by. The selector applies them; so does the walk an
// auto-routed agent's summaries take (`standardTierChain`), so the two never disagree about which model is offered.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { mayDialProvider } from '../providers/billing-breaker.js';
import { isRateLimited } from './rate-limits.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { exceededBudget } from '../costs/spend.js';
import { TIER_FALLBACK, getTierModels, type TierModelRow } from './tier-chain.js';

const logger = createLogger('selector');

export function estimateRequestCost(model: TierModelRow): number {
  // Rough estimate: 2k input, 1k output per request. D-H: an unknown (NULL) price estimates as $0,
  // matching how the biller records it, so near the budget wall an unpriced model is not over-gated
  // as if it were the Sonnet premium (the "price unknown" state stays visible via the dashboard flag
  // and the biller's once-per-model warn). Explicit prices are used as-is.
  const inputCost = ((model.input_cost_per_m ?? 0) / 1_000_000) * 2000;
  const outputCost = ((model.output_cost_per_m ?? 0) / 1_000_000) * 1000;
  return inputCost + outputCost;
}

/** t140 round 7 (H2'): why `selectModel` would not offer a model now. */
export type RoutedSkip = 'provider_down' | 'capability' | 'rate_limit' | 'budget' | 'excluded';

/** Why the standing filters turn a candidate away; `null` when they do not. */
export function standingSkip(model: TierModelRow, required: string[], agentId?: string): RoutedSkip | null {
  // ── v3.2.3 LAYER 3: DO NOT OFFER A PROVIDER THAT IS OUT OF MONEY ──
  // The incident's auto-router kept ranking the CHEAPEST model first, which was the
  // one answering 402 — so every turn paid a full round trip to a wall before falling
  // back. The public report measured that tax at +15-20 s per turn. A provider whose
  // breaker is OPEN is not a candidate: the owner has been carded and nothing here can
  // change the answer. It comes back the moment they clear it or a call succeeds.
  if (!mayDialProvider(model.provider_id)) {
    logger.debug('Model skipped: its provider is circuit-broken (permanent failure)', {
      modelId: model.model_id, providerId: model.provider_id,
    }, agentId);
    return 'provider_down';
  }

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
      return 'capability';
    }
  }

  // Skip rate-limited models
  if (isRateLimited(model.model_id)) {
    logger.debug('Model rate-limited, skipping', { modelId: model.model_id }, agentId);
    return 'rate_limit';
  }
  return null;
}

/** v3.5 (t268, owner 2026-10-24, "The agents model."): what an auto-routed agent's ordinary (standard-tier) request
 *  walks NOW, in the router's own order and through its own filters (fix round 4, N-E: an open billing breaker, a
 *  rate limit, the budget — its pure half, with none of the alerts the turn's own selection sends) — its "own model"
 *  for summaries. */
export const standardTierChain = (agentId = ''): string[] => [...new Set(TIER_FALLBACK.standard.flatMap(getTierModels)
  .filter((m) => standingSkip(m, [], agentId || undefined) === null && exceededBudget(agentId, estimateRequestCost(m)) === null)
  .map((m) => m.model_id))];
