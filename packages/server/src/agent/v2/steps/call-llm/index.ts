// The `callLLM` step: mint the turn's message id, re-fit the array to the chosen model, put the volatile
// injections on the tail, call the provider through the retry-and-fallback ladder, then the post-call
// bookkeeping. The message id and result come back on the proceed arm only; the turn's only abandon
// exits live in `model-call.ts`. The step never writes `state.phase`: the driver owns it.

import { v4 as uuidv4 } from 'uuid';
import type { ModelCallParams } from '../../../model.js';

/** The array the assembler hands over and the injections append to. */
type ModelMessage = ModelCallParams['messages'][number];
import type { callModel } from '../../../model.js';
import type { SteerEntry } from '../../steer-queue.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import { resolveToolAlias } from '../../../../tools/aliases.js';
import { isBareNoReplySentinel } from '@dojo/shared';
import { queueEmbedding } from '../../../../memory/embeddings.js';
import { redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { ModelSelection } from './model-selection.js';
import { injectAndRecord } from './pre-call-injections.js';
import { callWithRetryAndFallback } from './model-call.js';
import { reassembleForFitIfNeeded } from './reassemble-for-fit.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const CALL_LLM_PHASE = 'callLLM' as const;

/** What the step reads from the driver. */
export interface CallLLMContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: import('better-sqlite3').Database;
  readonly counterparty: TurnCounterparty;
  readonly isA2ATurn: boolean;
  readonly isAutoRouted: boolean;
  readonly lastUserMessageContent: string | null;
  /** The model `assemble` chose and built this iteration for, with the router's facts. */
  readonly selection: ModelSelection;
  /** The assembled call, as `assemble` left it. The injections append to this array. */
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly assembled: AssembledContext;
  readonly modelContext: AssemblyContext;
  readonly volatileFrom: number | undefined;
  readonly steerAwaitingConfirm: SteerEntry | null;
  /** The exact turn context `assemble` used, so a re-fit reproduces the same content decisions. */
  readonly assemblyTurnContext: PromptTurnContext;
  /** A driver closure passed as a value: its binding stays live and the step never imports the driver. */
  readonly revertTriggerStampOnAbort: () => void;
}

/** The shared outcome, plus this step's two outputs on the proceed arm ONLY. */
export type CallLLMOutcome =
  | { readonly directive: 'proceed'; readonly state: AgentTurnState; readonly messageId: string; readonly result: Awaited<ReturnType<typeof callModel>> }
  | Exclude<StepOutcome, { directive: 'proceed' }>;

export async function runCallLLM(stateIn: AgentTurnState, ctxIn: CallLLMContext): Promise<CallLLMOutcome> {
  const {
    agentId, turnCtx, turnNumber, counterparty, isA2ATurn, isAutoRouted,
    lastUserMessageContent, assembled: assembledIn, modelContext: mctx,
    steerAwaitingConfirm, assemblyTurnContext, revertTriggerStampOnAbort,
  } = ctxIn;
  let state = stateIn;
  // A re-fit below may replace all four; every later read uses these locals, never `ctxIn`'s originals.
  let messages = ctxIn.messages;
  let systemPrompt = ctxIn.systemPrompt;
  let ctx = assembledIn;
  let volatileFrom = ctxIn.volatileFrom;

  const messageId = uuidv4();
  state = advance(state, { currentMessageId: messageId });

  const { routerTier, routerConfidence, routerFreshDecision, excludedModels, modelId: pick } = ctxIn.selection;
  // The array built for this pick plus this iteration's tail must fit the pick's window, output cap and
  // provider ceiling; if not, the one assembler rebuilds it (shared with `model-call.ts`'s fallback ladder).
  const reassembly = await reassembleForFitIfNeeded({
    agentId, modelId: pick, messages, systemPrompt, volatileFrom, assemblyTurnContext, anotherPickMayFollow: isAutoRouted,
  });
  if (reassembly) {
    messages = reassembly.messages;
    systemPrompt = reassembly.systemPrompt;
    ctx = reassembly.assembled;
    volatileFrom = reassembly.volatileFrom;
  }

  const injected = await injectAndRecord(state, {
    agentId, turnNumber, modelId: pick, messages, systemPrompt,
    ctx, mctx, volatileFrom, counterparty, steerAwaitingConfirm, turnCtx, db: ctxIn.db,
  });
  state = injected.state;

  const called = await callWithRetryAndFallback(state, pick, {
    agentId, turnCtx, turnNumber, messageId, messages, systemPrompt,
    useTools: injected.useTools, isAutoRouted, isA2ATurn, excludedModels,
    revertTriggerStampOnAbort, assembled: ctx, routerTier, counterparty,
    volatileFrom, assemblyTurnContext, firstSend: injected.messages,
  });
  if (called.abandoned) return called.abandoned as CallLLMOutcome;
  state = called.state;
  const { result } = called;
  const modelId = called.modelId;

  // Low-confidence shadow probe: best effort, off by default, only for a fresh text-only router decision.
  if (
    isAutoRouted && routerFreshDecision && routerTier &&
    result.toolCalls.length === 0 && result.content
  ) {
    const probeTier = routerTier;
    const probeConfidence = routerConfidence;
    const probeContent = result.content;
    const probeMsgs = messages as Array<{ role: string; content: string | object[] }>;
    const probeQuery = lastUserMessageContent ?? '';
    void (async () => {
      try {
        const { maybeProbe } = await import('../../../../router/probe.js');
        maybeProbe({
          agentId,
          systemPrompt,
          messages: probeMsgs as Array<{ role: 'user' | 'assistant'; content: string | object[] }>,
          tier: probeTier as 'light' | 'standard' | 'heavy',
          confidence: probeConfidence,
          query: probeQuery,
          realAnswer: probeContent,
        });
      } catch { /* best effort */ }
    })();
  }

  // Pin the auto-routed model for the rest of the turn so tool follow-up calls use the same model.
  if (isAutoRouted && !state.lockedModelId && result.toolCalls.length > 0) {
    state = advance(state, { lockedModelId: modelId, lockedTier: routerTier });
    logger.info('v2 auto-router: locking model for tool loop', { modelId, tier: routerTier }, agentId);
  }

  // `callModel` records the cost; recording it here again would double-bill. It does not queue embeddings,
  // so this does, skipping the no-reply sentinel (its row is never persisted).
  const isNoReplySentinel =
    !!result.content &&
    result.toolCalls.length === 0 &&
    isBareNoReplySentinel(result.content);
  if (result.content && result.content.trim().length > 0 && !isNoReplySentinel) {
    try {
      // Embed what the row will hold (credentials redacted): recall and summaries read the index.
      queueEmbedding('message', messageId, agentId, redactHandedCredentials(agentId, result.content));
    } catch { /* best effort */ }
  }

  // Canonicalize aliased tool names and args before any gate or classifier reads them.
  // Tombstoned tools are left as they are; `executeTool` returns their pointer error at dispatch.
  for (const tc of result.toolCalls) {
    const aliasResolved = resolveToolAlias(tc.name, tc.arguments ?? {});
    if (!aliasResolved.tombstone && aliasResolved.name !== tc.name) {
      tc.name = aliasResolved.name;
      tc.arguments = aliasResolved.args;
    }
  }

  state = advance(state, { lastResponse: result, toolCalls: result.toolCalls });
  return { ...proceed(state), directive: 'proceed', state, messageId, result } as CallLLMOutcome;
}
