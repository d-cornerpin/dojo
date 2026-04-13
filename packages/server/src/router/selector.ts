// ════════════════════════════════════════
// Model Selector with Fallback
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isRateLimited } from './rate-limits.js';
import { getDailySpend } from '../costs/tracker.js';
import { checkBudget } from '../costs/budget.js';
import { getModelCapabilities } from '../services/capabilities.js';
import type { DimensionScore } from './types.js';

const logger = createLogger('selector');

export interface SelectedModel {
  modelId: string;
  providerId: string;
  apiModelId: string;
  fallbackUsed: boolean;
}

// Tier fallback order: light -> standard -> heavy
const TIER_FALLBACK: Record<string, string[]> = {
  light: ['light', 'standard', 'heavy'],
  standard: ['standard', 'heavy'],
  heavy: ['heavy'],
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

function estimateRequestCost(model: TierModelRow): number {
  // Rough estimate: 2k input, 1k output per request
  const inputCost = ((model.input_cost_per_m ?? 3.0) / 1_000_000) * 2000;
  const outputCost = ((model.output_cost_per_m ?? 15.0) / 1_000_000) * 1000;
  return inputCost + outputCost;
}

export function selectModel(
  tier: string,
  agentId: string,
  excludeModels?: string[],
  requireCapabilities?: string[],
): SelectedModel | null {
  const excluded = new Set(excludeModels ?? []);
  const required = requireCapabilities ?? [];
  const fallbackChain = TIER_FALLBACK[tier] ?? [tier];
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
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO router_log (id, agent_id, input_preview, dimension_scores, raw_score,
                               tier_id, selected_model_id, fallback_used, latency_ms, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      JSON.stringify(scores),
      rawScore,
      tier,
      modelId,
      fallbackUsed ? 1 : 0,
      Math.round(latencyMs),
    );
  } catch (err) {
    logger.error('Failed to log router decision', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
