// ════════════════════════════════════════
// PHASE-6 T5 (CUT 5) — AUTO-ROUTING MODEL SELECTION, moved from `loop.ts` with
// its bodies byte-unchanged. "Which model answers THIS query, and is it locked
// for the rest of the turn" (matches v1 `runtime.ts:954-988`).
//
// It reads and advances the turn's state and returns the router's own facts,
// because the low-confidence shadow probe downstream needs the tier, the
// confidence and whether this was a FRESH decision — a locked-model reuse must
// never probe.
// ════════════════════════════════════════

import { advance, type AgentTurnState } from '../../state.js';
import { createLogger } from '../../../../logger.js';
import { AgentError } from '../../../errors.js';

const logger = createLogger('v2-loop');

export interface ModelSelection {
  readonly state: AgentTurnState;
  readonly modelId: string;
  readonly routerTier: string | null;
  readonly routerConfidence: number;
  readonly routerFreshDecision: boolean;
  readonly excludedModels: string[];
}

export async function selectModel(
  stateIn: AgentTurnState,
  agentId: string,
  isAutoRouted: boolean,
  configuredModelId: string,
  lastUserMessageContent: string | null,
  systemPrompt: string,
  messages: unknown[],
  revertTriggerStampOnAbort: () => void,
): Promise<ModelSelection> {
  let state = stateIn;
  // ── Auto-routing model selection (matches v1 runtime.ts:954-988) ──
  // For auto-routed agents, pick the right model for THIS query. Lock
  // the model across tool loops so we don't switch mid-task.
  let modelId: string;
  let routerTier: string | null = null;
  // Captured for the (gated, off-by-default) low-confidence shadow probe
  // that harvests over-routing labels. Only the fresh-decision path probes,
  // never the mid-task locked-model reuse.
  let routerConfidence = 0;
  let routerFreshDecision = false;
  const excludedModels: string[] = [];

  if (isAutoRouted) {
    if (state.lockedModelId && state.loopCount > 1) {
      modelId = state.lockedModelId;
      routerTier = state.lockedTier;
      logger.info('v2 auto-router: using locked model (mid-task)', {
        modelId, tier: routerTier,
      }, agentId);
    } else {
      const { decideTier } = await import('../../../../router/decide.js');
      const { selectModel, logRouterDecision } = await import('../../../../router/selector.js');
      // Layered decision: structural rules -> semantic classifier ->
      // keyword heuristic fallback. See router/decide.ts.
      const decision = await decideTier(
        systemPrompt,
        messages as Array<{ role: string; content: string | object[] }>,
        agentId,
        // Authoritative user query, clean of engine injections (technique
        // hints etc.) that ride in the messages array as user-role entries.
        lastUserMessageContent,
      );
      routerTier = decision.tier;
      routerConfidence = decision.confidence;
      routerFreshDecision = true;
      const selected = selectModel(decision.tier, agentId, undefined, ['tools']);
      if (!selected) {
        revertTriggerStampOnAbort(); // N-1: no answer produced, re-arm the ask
        throw new AgentError('Auto-router: no models available in any tier', agentId, { code: 'NO_MODEL' });
      }
      modelId = selected.modelId;
      logger.info(`v2 auto-router: tier=${decision.tier} (${decision.method}) → ${modelId}`, {
        tier: decision.tier,
        method: decision.method,
        confidence: Number(decision.confidence.toFixed(3)),
        modelId,
        fallbackUsed: selected.fallbackUsed,
      }, agentId);
      // Record the decision so the Router tab can chart tier usage over time.
      // Only the scored path is logged (one decision per task), the mid-task
      // locked-model branch above reuses this same decision, so logging it
      // too would double-count.
      logRouterDecision(
        agentId,
        decision.scores,
        decision.rawScore,
        decision.tier,
        modelId,
        selected.fallbackUsed,
        decision.latencyMs,
        decision.method,
        decision.confidence,
        decision.headVersion,
        decision.queryPreview,
      );
    }
  } else {
    modelId = configuredModelId;
  }
  state = advance(state, { modelId, routerTier });
  return { state, modelId, routerTier, routerConfidence, routerFreshDecision, excludedModels };
}
