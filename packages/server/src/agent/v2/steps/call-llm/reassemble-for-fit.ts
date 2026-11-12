// The one "does the array fit the model about to be dialed, and if not, rebuild it for that model" check,
// shared by the router's pick (`index.ts`) and every fallback pick (`model-call.ts`).

import type { ModelCallParams } from '../../../model.js';
import { estimateTokens, SystemPromptTooLargeError } from '../../../../memory/budget.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

type ModelMessage = ModelCallParams['messages'][number];

/** Content-only token estimate of an assembled array; tools and output are the budget's reserve side. */
export function estimateAssembledArrayTokens(systemPrompt: string, messages: ModelMessage[]): number {
  return estimateTokens(systemPrompt) + messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + estimateTokens(content);
  }, 0);
}

export interface ReassembleForFitInput {
  readonly agentId: string;
  readonly modelId: string;
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  /** Where this iteration's own tail begins in `messages`; it is kept verbatim across a re-assembly. */
  readonly volatileFrom: number | undefined;
  /** The original assembly's turn context, so a re-assembly makes the same content decisions. */
  readonly assemblyTurnContext: PromptTurnContext;
  /** Another pick may follow: a pick too small for the prompt and tools is refused without the owner's
   *  "cannot hold a conversation" card, which would be false while another pick may still answer. */
  readonly anotherPickMayFollow?: boolean;
}

export interface ReassembleForFitResult {
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly assembled: AssembledContext;
  readonly volatileFrom: number;
}

/** `null` when the array already fits the dialed model's window, output cap and provider ceiling; else a
 *  re-assembly with this iteration's tail spliced on verbatim (re-running it would double-fire steers). */
export async function reassembleForFitIfNeeded(input: ReassembleForFitInput): Promise<ReassembleForFitResult | null> {
  const refit = await refitToThePick(input);
  // The routine condense check for this pick, when the gate could not measure it. It runs after the re-fit
  // so the re-fit's own fold is not set aside by a background one started here.
  const gates = await import('../pre-call-gates/context-gates.js');
  if (!gates.routineCheckMeasuredAtGate(input.agentId, input.modelId)) {
    const [{ agentTurnWindow }, { getDb }] = await Promise.all([import('../../../../router/router-window.js'), import('../../../../db/connection.js')]);
    const configured = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(input.agentId) as { model_id: string | null } | undefined)?.model_id;
    await gates.condenseForTheDialedModel({
      agentId: input.agentId, dialedModelId: input.modelId, contextWindow: agentTurnWindow(input.agentId, input.modelId),
      writerModelId: configured ?? input.modelId, systemPromptTokens: estimateTokens(refit?.systemPrompt ?? input.systemPrompt),
    });
  }
  return refit;
}

/** The dialed model's budget (window, output cap, provider ceiling): one derivation for every caller. */
export async function dialedPolicy(agentId: string, modelId: string) {
  const [{ getProviderCeilingTokens, getModelOutputCap }, { agentTurnWindow }] = await Promise.all([import('../../../model.js'), import('../../../../router/router-window.js')]);
  const [{ contextWindowPolicy }, { measureAgentToolPayloadTokens }] = await Promise.all([
    import('../../../../memory/budget.js'),
    import('../../../../tools/tool-docs.js'),
  ]);
  const toolPayloadTokens = await measureAgentToolPayloadTokens(agentId);
  const policy = contextWindowPolicy(agentTurnWindow(agentId, modelId), {   // an auto agent's one router window
    toolPayloadTokens,
    maxOutputTokens: getModelOutputCap(modelId),
    providerCeilingTokens: getProviderCeilingTokens(modelId),
  });
  return { policy, toolPayloadTokens };
}

async function refitToThePick(input: ReassembleForFitInput): Promise<ReassembleForFitResult | null> {
  const { agentId, modelId, messages, systemPrompt, volatileFrom, assemblyTurnContext, anotherPickMayFollow } = input;
  const assembledEstimate = estimateAssembledArrayTokens(systemPrompt, messages);
  const { policy, toolPayloadTokens } = await dialedPolicy(agentId, modelId);
  if (assembledEstimate <= policy.assemblyBudgetTokens) return null;
  // Refuse by name, before rebuilding, a pick whose prompt (as built for it) and tools exceed its budget.
  const systemTokens = await systemTokensFor(agentId, modelId, assemblyTurnContext);
  if (systemTokens > policy.assemblyBudgetTokens) {
    // The card only when no model of the agent's own can hold it, not when one stand-in pick is too small.
    if (!anotherPickMayFollow && !(await anOwnModelHolds(agentId, toolPayloadTokens, assemblyTurnContext))) {
      const { reportStarvedWindow } = await import('../../../../memory/window-starvation-card.js');
      reportStarvedWindow(agentId, systemTokens, policy);
    }
    throw new SystemPromptTooLargeError(systemTokens, policy);
  }

  logger.warn('v2: picked model was not the one this assembly was sized for; re-assembling against its own window', {
    agentId, modelId, assembledEstimate, budget: policy.assemblyBudgetTokens, contextWindow: policy.contextWindow,
  }, agentId);
  const [{ assembleContext }, { assembleWithNothingOutOfViewUnsummarised }] = await Promise.all([
    import('../../../../memory/assembler.js'),
    import('../../../../memory/out-of-view.js'),
  ]);
  // Rows the smaller window drops from view are folded before the dial, through the assembly's own door.
  const reassembled = await assembleWithNothingOutOfViewUnsummarised(agentId, policy.contextWindow,
    () => assembleContext(agentId, modelId, assemblyTurnContext), { dialedModelId: modelId });
  const tail = messages.slice(volatileFrom ?? messages.length);
  return {
    messages: [...reassembled.messages, ...tail],
    systemPrompt: reassembled.systemPrompt,
    assembled: reassembled,
    volatileFrom: reassembled.messages.length,
  };
}

/** The system prompt the assembler builds for `modelId`, by the assembler's own two functions, in tokens. */
async function systemTokensFor(agentId: string, modelId: string, turnContext: PromptTurnContext): Promise<number> {
  const { buildAssemblyContext, assembleSystemFromRegistry } = await import('../../../../prompt/registry/assembler.js');
  return estimateTokens(assembleSystemFromRegistry(buildAssemblyContext(agentId, modelId, turnContext)).text);
}

/** Whether the agent's configured model, or (auto) any model the router opens a tier on, can hold it. */
export async function anOwnModelHolds(agentId: string, toolPayloadTokens: number, turnContext: PromptTurnContext): Promise<boolean> {
  const [{ getDb }, { routedFirstPicks }] = await Promise.all([
    import('../../../../db/connection.js'), import('../../../../router/selector.js'),
  ]);
  const configured = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id;
  if (!configured) return false;
  for (const own of configured === 'auto' ? routedFirstPicks() : [configured]) {
    if (await modelHoldsAgent(agentId, own, toolPayloadTokens, turnContext)) return true;
  }
  return false;
}

export async function modelHoldsAgent(agentId: string, modelId: string, toolPayloadTokens: number, turnContext: PromptTurnContext): Promise<boolean> {
  return (await refusalFor(agentId, modelId, toolPayloadTokens, turnContext)) === null;
}

/** The refusal the assembler would raise for `modelId` (prompt and tools exceed its budget), or null.
 *  Asked before an auto-routed turn is assembled, so a too-small pick is passed over without a card. */
export async function refusalFor(agentId: string, modelId: string, toolPayloadTokens: number, turnContext: PromptTurnContext): Promise<SystemPromptTooLargeError | null> {
  const [{ contextWindowPolicy }, model, { agentTurnWindow }] = await Promise.all([import('../../../../memory/budget.js'), import('../../../model.js'), import('../../../../router/router-window.js')]);
  const policy = contextWindowPolicy(agentTurnWindow(agentId, modelId), {
    toolPayloadTokens, maxOutputTokens: model.getModelOutputCap(modelId), providerCeilingTokens: model.getProviderCeilingTokens(modelId),
  });
  const systemTokens = await systemTokensFor(agentId, modelId, turnContext);
  return systemTokens > policy.assemblyBudgetTokens ? new SystemPromptTooLargeError(systemTokens, policy) : null;
}
