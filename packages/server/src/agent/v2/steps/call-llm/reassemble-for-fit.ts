// ════════════════════════════════════════════════════════════════════════════════════════
// T82a FIX WAVE — THE ONE RE-ASSEMBLE-AGAINST-THE-TRUTH HELPER.
//
// Extracted from `index.ts`'s round-1 fix (the router's INITIAL pick re-checks the budget
// it was assembled without) once round 2 found the same hole one layer deeper: a same-turn
// FALLBACK pick, after a failed dial, can be a declared-slow model too, and
// `callWithRetryAndFallback` (`model-call.ts`) dials whatever array it already has,
// unchecked. Both sites need the identical answer to "does this model's declared ceiling
// cover what's already assembled, and if not, what does the ONE assembler produce for it" —
// so the answer lives here, once, and both call it.
//
// `estimateAssembledArrayTokens` is exported too, for the SAME reason: round 2's selector
// fit-filter needs "how big is the array right now" BEFORE it knows whether a re-assembly
// will happen, and re-deriving that reducer a second time is the exact duplication this
// extraction exists to prevent.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { ModelCallParams } from '../../../model.js';
import { estimateTokens } from '../../../../memory/budget.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

/** The array the assembler hands over and both call sites' injections append to. */
type ModelMessage = ModelCallParams['messages'][number];

/**
 * The estimator both call sites need to decide whether a re-assembly is warranted, and that
 * `router/selector.ts`'s fit filter needs to decide whether a fallback candidate should be
 * excluded in the first place. Mirrors `agent/model.ts`'s own `finalInputEstimate` shape
 * (content-only; tool schemas and output are the RESERVE side of the same budget, not this
 * side) — the same composition of the ONE estimator (`memory/budget.ts`'s `estimateTokens`),
 * for the SAME reason that reducer is not folded into `estimateTokens` itself: it is a
 * caller-specific composition, not a second implementation of what a character costs.
 */
export function estimateAssembledArrayTokens(systemPrompt: string, messages: ModelMessage[]): number {
  return estimateTokens(systemPrompt) + messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + estimateTokens(content);
  }, 0);
}

export interface ReassembleForFitInput {
  readonly agentId: string;
  /** The model that is ABOUT to be dialed — the router's initial pick (round 1) or a
   *  same-turn fallback pick (round 2). */
  readonly modelId: string;
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  /** Where THIS iteration's own loop-appended tail begins in `messages` — preserved
   *  verbatim across a re-assembly; see the splice note below. */
  readonly volatileFrom: number | undefined;
  /** The exact turn context the ORIGINAL `assembleContext` call used, so a re-assembly
   *  reproduces the same content decisions instead of silently diverging from them. */
  readonly assemblyTurnContext: PromptTurnContext;
}

export interface ReassembleForFitResult {
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly assembled: AssembledContext;
  readonly volatileFrom: number;
}

/**
 * `null` when nothing needs to change — either `modelId` declared no provider ceiling
 * (every fast/cloud pick, and the whole world before T82a) or the array already assembled
 * fits its provider-aware budget. This is the cheap short-circuit both call sites rely on:
 * the common path costs one indexed read (`getProviderCeilingTokens`) and nothing else —
 * `contextWindowPolicy`, `measureAgentToolPayloadTokens` and `assembleContext` are all
 * deferred behind that one check.
 *
 * When it DOES re-assemble: the current iteration's own loop-appended tail (technique
 * hints, the multistep scaffold, the delegation hint, the drained steer — everything the
 * `assemble` step appended past `volatileFrom`) is preserved verbatim by slicing it off the
 * OLD array and splicing it onto the NEW cacheable prefix, never re-derived — re-running
 * those injection functions a second time would double-fire their one-shot side effects
 * (consumed flags, steer delivery marks).
 */
export async function reassembleForFitIfNeeded(input: ReassembleForFitInput): Promise<ReassembleForFitResult | null> {
  const { agentId, modelId, messages, systemPrompt, volatileFrom, assemblyTurnContext } = input;
  const { getProviderCeilingTokens, getContextWindow, getModelOutputCap } = await import('../../../model.js');
  const providerCeiling = getProviderCeilingTokens(modelId);
  if (providerCeiling === null) return null;

  const [{ contextWindowPolicy }, { measureAgentToolPayloadTokens }] = await Promise.all([
    import('../../../../memory/budget.js'),
    import('../../../../tools/tool-docs.js'),
  ]);
  const assembledEstimate = estimateAssembledArrayTokens(systemPrompt, messages);
  const policy = contextWindowPolicy(getContextWindow(modelId), {
    toolPayloadTokens: await measureAgentToolPayloadTokens(agentId),
    maxOutputTokens: getModelOutputCap(modelId),
    providerCeilingTokens: providerCeiling,
  });
  if (assembledEstimate <= policy.assemblyBudgetTokens) return null;

  logger.warn('v2: picked model was not the one this assembly was sized for; re-assembling against its provider-aware budget', {
    agentId, modelId, assembledEstimate, budget: policy.assemblyBudgetTokens,
  }, agentId);
  const { assembleContext } = await import('../../../../memory/assembler.js');
  const reassembled = await assembleContext(agentId, modelId, assemblyTurnContext);
  const tail = messages.slice(volatileFrom ?? messages.length);
  return {
    messages: [...reassembled.messages, ...tail],
    systemPrompt: reassembled.systemPrompt,
    assembled: reassembled,
    volatileFrom: reassembled.messages.length,
  };
}
