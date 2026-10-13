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
import { estimateTokens, SystemPromptTooLargeError } from '../../../../memory/budget.js';
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
  /** t140 round 2 (re-review N1): a FALLBACK candidate is being tried, and another may follow.
   *  A pick whose window cannot hold the system prompt and tools is then refused WITHOUT the
   *  owner's "cannot hold a conversation" card — that card says the agent is broken until it is
   *  reconfigured, which is false while another pick may answer. The caller says so once no
   *  model is left. Absent (the router's own pick, the budget redirect's only free model), the
   *  refusal cards exactly as the assembler's own check does. */
  readonly anotherPickMayFollow?: boolean;
}

export interface ReassembleForFitResult {
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly assembled: AssembledContext;
  readonly volatileFrom: number;
}

/**
 * `null` when nothing needs to change — the array already assembled fits the budget of the
 * model about to be dialed: ITS window, ITS output cap, and its provider ceiling when it
 * declares one. The common path costs one policy derivation (the tool payload measurement is
 * memoised) and nothing else; `assembleContext` runs only when the array does not fit.
 *
 * ── t140: EVERY PICK, NOT ONLY A DECLARED-CEILING ONE (tracker #13) ──────────────────────
 * This used to return `null` for any model that declared no provider ceiling, so for every
 * ordinary routed or fallback pick the array went to the provider boundary exactly as it was
 * assembled — for the `'__auto__'` stand-in window, not for the model being dialed. When the
 * pick's own window was smaller, the boundary's lane repair cut the difference out of the array
 * a whole lane at a time, ending with `lane.fresh-tail`: the call went out without the agent's
 * live conversation. The window is a fact of EVERY model, so the check is now made for every
 * model, and the ceiling is applied on top of it only where one is declared — the T82a case is
 * a special case of this one, not a separate door.
 *
 * When it DOES re-assemble: the current iteration's own loop-appended tail (technique
 * hints, the multistep scaffold, the delegation hint, the drained steer — everything the
 * `assemble` step appended past `volatileFrom`) is preserved verbatim by slicing it off the
 * OLD array and splicing it onto the NEW cacheable prefix, never re-derived — re-running
 * those injection functions a second time would double-fire their one-shot side effects
 * (consumed flags, steer delivery marks).
 */
export async function reassembleForFitIfNeeded(input: ReassembleForFitInput): Promise<ReassembleForFitResult | null> {
  const { agentId, modelId, messages, systemPrompt, volatileFrom, assemblyTurnContext, anotherPickMayFollow } = input;
  const { getProviderCeilingTokens, getContextWindow, getModelOutputCap } = await import('../../../model.js');
  const [{ contextWindowPolicy }, { measureAgentToolPayloadTokens }] = await Promise.all([
    import('../../../../memory/budget.js'),
    import('../../../../tools/tool-docs.js'),
  ]);
  const assembledEstimate = estimateAssembledArrayTokens(systemPrompt, messages);
  const policy = contextWindowPolicy(getContextWindow(modelId), {
    toolPayloadTokens: await measureAgentToolPayloadTokens(agentId),
    maxOutputTokens: getModelOutputCap(modelId),
    providerCeilingTokens: getProviderCeilingTokens(modelId),
  });
  if (assembledEstimate <= policy.assemblyBudgetTokens) return null;
  // t140 round 2 (re-review N1): whether this pick can hold the system prompt and tools at all is
  // answered HERE, from the policy above — the same numbers the assembler's own check reads — and
  // before any context is rebuilt. A pick that cannot is refused by name without assembling.
  const systemTokens = estimateTokens(systemPrompt);
  if (systemTokens > policy.assemblyBudgetTokens) {
    if (!anotherPickMayFollow) {
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
    import('../../../../memory/compaction.js'),
  ]);
  // t140 round 2 (re-review C1; replaces fix round 1's background M3 fold): a re-fit for a smaller
  // pick may take rows out of the view for THAT window — floor rows included — and they are folded
  // before this pick is dialed, through the same door as the turn's own assembly.
  const reassembled = await assembleWithNothingOutOfViewUnsummarised(agentId, policy.contextWindow,
    () => assembleContext(agentId, modelId, assemblyTurnContext));
  const tail = messages.slice(volatileFrom ?? messages.length);
  return {
    messages: [...reassembled.messages, ...tail],
    systemPrompt: reassembled.systemPrompt,
    assembled: reassembled,
    volatileFrom: reassembled.messages.length,
  };
}
