// ════════════════════════════════════════
// THE MODEL THIS ITERATION DIALS, chosen BEFORE it is assembled (t212, v3.4 D11). Moved from
// `loop.ts` at PHASE-6 T5 (matches v1 `runtime.ts:954-988`); called by the `assemble` step, which
// then builds the turn once, for this model.
//
// Auto-routed: the locked model mid-task, else the router's pick from the newest rows
// (`router/routing-view.ts`; it used to read an array assembled for a stand-in window, which is
// why every smaller pick was assembled twice). A pick that cannot hold this agent's instructions
// and tools is passed over like a fallback (t140 round 6), before anything is built for it; when
// no reachable pick holds it, the owner is told why (round 7, `no-pick-holds.ts`).
// The shadow probe downstream needs the tier, the confidence and whether this was a FRESH
// decision (a locked-model reuse never probes), so they ride on the selection.
// ════════════════════════════════════════

import { advance, type AgentTurnState } from '../../state.js';
import { createLogger } from '../../../../logger.js';
import { AgentError } from '../../../errors.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';

const logger = createLogger('v2-loop');

export interface ModelSelection {
  readonly modelId: string;
  readonly routerTier: string | null;
  readonly routerConfidence: number;
  readonly routerFreshDecision: boolean;
  /** Picks passed over this iteration; the fallback ladder never offers them again. */
  readonly excludedModels: string[];
}

export interface SelectModelInput {
  readonly agentId: string;
  readonly isAutoRouted: boolean;
  readonly configuredModelId: string;
  /** The turn's authoritative ask, clean of engine injections; null on an engine or peer turn. */
  readonly lastUserMessageContent: string | null;
  readonly conversationId: string | null;
  readonly turnNumber: number;
  readonly turnContext: PromptTurnContext;
  readonly revertTriggerStampOnAbort: () => void;
}

/** The selection, or the words the owner was told when no pick the router can reach holds the agent. */
export type ModelSelectionOutcome =
  | { readonly state: AgentTurnState; readonly selection: ModelSelection; readonly said?: undefined }
  | { readonly state: AgentTurnState; readonly said: string };

export async function selectModel(stateIn: AgentTurnState, input: SelectModelInput): Promise<ModelSelectionOutcome> {
  const { agentId, isAutoRouted, configuredModelId, turnContext } = input;
  let state = stateIn;
  let modelId = configuredModelId;
  let routerTier: string | null = null;
  let routerConfidence = 0;
  let routerFreshDecision = false;
  const excludedModels: string[] = [];

  if (isAutoRouted && state.lockedModelId && state.loopCount > 1) {
    modelId = state.lockedModelId;
    routerTier = state.lockedTier;
    logger.info('v2 auto-router: using locked model (mid-task)', { modelId, tier: routerTier }, agentId);
  } else if (isAutoRouted) {
    const [{ decideTier }, selector, { routingView }] = await Promise.all([
      import('../../../../router/decide.js'), import('../../../../router/selector.js'), import('../../../../router/routing-view.js'),
    ]);
    // Layered decision (structural rules -> semantic classifier -> keyword fallback), on the newest rows.
    const view = routingView(agentId, { conversationId: input.conversationId, query: input.lastUserMessageContent });
    const decision = await decideTier(view, agentId, input.lastUserMessageContent);
    routerTier = decision.tier;
    routerConfidence = decision.confidence;
    routerFreshDecision = true;
    const selected = selector.selectModel(decision.tier, agentId, undefined, ['tools']);
    if (!selected) {
      input.revertTriggerStampOnAbort(); // N-1: no answer produced, re-arm the ask
      throw new AgentError('Auto-router: no models available in any tier', agentId, { code: 'NO_MODEL' });
    }
    modelId = selected.modelId;
    logger.info(`v2 auto-router: tier=${decision.tier} (${decision.method}) → ${modelId}`, {
      tier: decision.tier, method: decision.method, confidence: Number(decision.confidence.toFixed(3)), modelId, fallbackUsed: selected.fallbackUsed,
    }, agentId);
    // One decision per task for the Router tab; the locked branch above reuses it and is not logged.
    selector.logRouterDecision(agentId, decision.scores, decision.rawScore, decision.tier, modelId, selected.fallbackUsed,
      decision.latencyMs, decision.method, decision.confidence, decision.headVersion, decision.queryPreview);
  }

  if (isAutoRouted) {
    const [{ refusalFor }, { measureAgentToolPayloadTokens }, selector] = await Promise.all([
      import('./reassemble-for-fit.js'), import('../../../../tools/tool-docs.js'), import('../../../../router/selector.js'),
    ]);
    const toolPayloadTokens = await measureAgentToolPayloadTokens(agentId);
    for (let refusal = await refusalFor(agentId, modelId, toolPayloadTokens, turnContext); refusal;
      refusal = await refusalFor(agentId, modelId, toolPayloadTokens, turnContext)) {
      excludedModels.push(modelId);
      const next = selector.selectModel(routerTier, agentId, excludedModels, ['tools']);
      if (!next) {
        const { tellOwnerNoPickHolds } = await import('./no-pick-holds.js');
        const said = await tellOwnerNoPickHolds({ agentId, turnNumber: input.turnNumber, tier: routerTier, excluded: [], turnContext, refusal, revertTrigger: input.revertTriggerStampOnAbort });
        return { state, said };
      }
      logger.warn('v2 auto-router: the pick cannot hold this agent\'s instructions and tools; passed over', { passedOver: modelId, next: next.modelId, tier: routerTier }, agentId);
      modelId = next.modelId;
    }
  }
  state = advance(state, { modelId, routerTier });
  return { state, selection: { modelId, routerTier, routerConfidence, routerFreshDecision, excludedModels } };
}
