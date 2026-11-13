// Standing filters and cost estimate shared by the selector and `standardTierChain`: same models offered.

import { createLogger } from '../logger.js';
import { mayDialProvider } from '../providers/billing-breaker.js';
import { isRateLimited } from './rate-limits.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { exceededBudget } from '../costs/spend.js';
import { TIER_FALLBACK, getTierModels, type TierModelRow } from './tier-chain.js';

const logger = createLogger('selector');
export const agentFloor = { mayRun: (_modelId: string): boolean => false };   // the 32K floor, set by router-window.ts so this file stays clear of agent/model.js; refuses until set

export function estimateRequestCost(model: TierModelRow): number {
  // 2k input + 1k output per request; an unknown (NULL) price counts as $0, as the biller records it.
  const inputCost = ((model.input_cost_per_m ?? 0) / 1_000_000) * 2000;
  const outputCost = ((model.output_cost_per_m ?? 0) / 1_000_000) * 1000;
  return inputCost + outputCost;
}

export type RoutedSkip = 'provider_down' | 'capability' | 'rate_limit' | 'budget' | 'excluded' | 'too_small';

/** Why the standing filters turn a candidate away; `null` when they do not. */
export function standingSkip(model: TierModelRow, required: string[], agentId?: string): RoutedSkip | null {
  // A provider whose breaker is open (out of money) is not a candidate: it would only cost a round trip to a 402.
  if (!mayDialProvider(model.provider_id)) {
    logger.debug('Model skipped: its provider is circuit-broken (permanent failure)', {
      modelId: model.model_id, providerId: model.provider_id,
    }, agentId);
    return 'provider_down';
  }
  if (required.includes('tools') && !agentFloor.mayRun(model.model_id)) return 'too_small';   // an agent turn, never a helper job

  if (required.length > 0) {
    const caps = getModelCapabilities(model.model_id);
    // A model with no capability data passes: a missing probe must not block selection.
    if (caps.length > 0 && required.some(req => !caps.includes(req as never))) {
      logger.debug('Model lacks required capabilities, skipping', {
        modelId: model.model_id, required, caps,
      }, agentId);
      return 'capability';
    }
  }

  if (isRateLimited(model.model_id)) {
    logger.debug('Model rate-limited, skipping', { modelId: model.model_id }, agentId);
    return 'rate_limit';
  }
  return null;
}

/** An auto agent's standard-tier walk (its own model for summaries): same order, standing filters and budget. */
export const standardTierChain = (agentId = ''): string[] => [...new Set(TIER_FALLBACK.standard.flatMap(getTierModels)
  .filter((m) => standingSkip(m, [], agentId || undefined) === null && exceededBudget(agentId, estimateRequestCost(m)) === null)
  .map((m) => m.model_id))];
