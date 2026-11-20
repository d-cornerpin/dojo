// The model call: the retry-and-fallback ladder, the streaming sinks, and the turn's only two abandon
// exits (stop, preempt). A module cannot return from its caller, so each is an `abandonTurn(...)` the
// driver honours by returning; finalize does not run for them, only the `finally`.

import type { ModelCallParams } from '../../../model.js';

type ModelMessage = ModelCallParams['messages'][number];
import { callModel, getContextWindow, STREAM_IDLE_TIMEOUT_ERROR, STREAM_NO_FINISH_ERROR } from '../../../model.js';
import { advance, type AgentTurnState } from '../../state.js';
import { abandonTurn, type StepOutcome } from '../step-outcome.js';
import { latchEngineCut } from '../../engine-exit.js';
import { isOutputCut } from '../../classifiers/output.js';
import { broadcast } from '../../../../gateway/ws.js';
import { isStopFenced, preemptedAgents } from '../../../shared-state.js';
import { hydrateCredentialsInMessages } from '../../../../credentials/secret-values.js';
import { noteDeclaredSecretsFromToolCalls } from '../../../../credentials/secret-fields.js';
import { revetOpenAskTitles } from '../../../../work/ask-title.js';
import { AgentError } from '../../../errors.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';
import { reassembleForFitIfNeeded, estimateAssembledArrayTokens } from './reassemble-for-fit.js';
import { forgetTurnArray } from './append-only-turn.js';
import { SystemPromptTooLargeError } from '../../../../memory/budget.js';
import { stripLeadingTimeStamp } from '../../../../memory/message-stamp.js';
import { freeFallbackDown } from './free-fallback-down.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

export interface ModelCallInputs {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly messageId: string;
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly useTools: boolean;
  readonly isAutoRouted: boolean;
  readonly isA2ATurn: boolean;
  readonly excludedModels: string[];
  readonly revertTriggerStampOnAbort: () => void;
  readonly assembled: AssembledContext;
  readonly routerTier: string | null;
  readonly counterparty: TurnCounterparty;
  readonly volatileFrom: number | undefined;
  readonly assemblyTurnContext: PromptTurnContext;
  /** The FIRST attempt sends this (append-only); a retry, fallback or re-fit sends `messages`. */
  readonly firstSend?: ModelMessage[];
}

/** Either the turn is abandoned, or a result and the (possibly fallen-back) model id. */
export type ModelCallResultOrAbandon =
  | { readonly abandoned: StepOutcome }
  | { readonly abandoned?: undefined; readonly state: AgentTurnState; readonly result: Awaited<ReturnType<typeof callModel>>; readonly modelId: string };

export async function callWithRetryAndFallback(
  stateIn: AgentTurnState,
  modelIdIn: string,
  input: ModelCallInputs,
): Promise<ModelCallResultOrAbandon> {
  const {
    agentId, turnCtx, messageId, useTools, isAutoRouted, isA2ATurn, excludedModels,
    revertTriggerStampOnAbort, routerTier, counterparty, assemblyTurnContext,
  } = input;
  let state = stateIn;
  let modelId = modelIdIn;
  // A fallback pick may need the array re-fitted; later attempts read these locals, never `input`'s.
  let messages = input.messages;
  let systemPrompt = input.systemPrompt;
  let ctx = input.assembled;
  let volatileFrom = input.volatileFrom;
  // Auto-routed: up to three models. Fixed: one attempt, plus one same-model retry after a stream abort.
  const maxAttempts = isAutoRouted ? 3 : 2;
  let result: Awaited<ReturnType<typeof callModel>> | undefined;
  let callSucceeded = false;

  // The turn's one stop-abandon, with three reasons, so this file holds exactly two `abandonTurn` calls
  // (this and the preempt): a new checkpoint adds a reason, never a call. No idle write here, teardown
  // owns it. The `stop` latch records the owner's press, not the model choosing silence.
  const abandonForStop = (reason: 'stopped-before-call' | 'stopped-mid-call' | 'stopped-after-call'): { abandoned: StepOutcome } => {
    return { abandoned: abandonTurn(latchEngineCut(state, 'stop'), reason) };
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Read the stop fence right before the dial: a recorded stop never dials, and in flight `callModel`'s
    // stop-linked controller aborts the fetch. The controller below also mutes an abandoned stream's sinks.
    const beforeCall = isStopFenced(agentId) ? abandonForStop('stopped-before-call') : null;
    if (beforeCall) return beforeCall;

    turnCtx.retryAt = null;   // a reset an earlier attempt met never labels this one
    const abortController = new AbortController();
    // The one credential read point, as a function of the array, so a re-fitted array is hydrated here too.
    const forTheWire = (arr: ModelMessage[]): ModelMessage[] => hydrateCredentialsInMessages(agentId, arr);
    if (attempt > 0) forgetTurnArray(turnCtx);

    const forceReply = turnCtx.forceReplyPending;
    try {
      result = await callModel({
        agentId,
        modelId,
        // Credentials are restored only here, at the wire: assembly, the receipt and stored rows keep the
        // placeholder. A no-op without a placeholder, so the cached prefix is unaffected.
        messages: forTheWire(attempt === 0 && input.firstSend ? input.firstSend : messages),
        systemPrompt,
        // The budget redirect inside `callModel` dials a free model this array was not sized for; re-fit it.
        refitFor: async (pick) => {
          const r = await reassembleForFitIfNeeded({ agentId, modelId: pick, messages, systemPrompt, volatileFrom, assemblyTurnContext });
          if (r) forgetTurnArray(turnCtx);
          return r ? { messages: forTheWire(r.messages), systemPrompt: r.systemPrompt } : null;
        },
        outputRoomAsk: state.outputTokensEscalated,
        systemVolatile: ctx.systemVolatile,
        tools: useTools,
        // Declared, never inferred from `tools`: the capability gate in `runtime.ts` can turn tools off.
        purpose: 'agent_turn',
        routerTier: routerTier ?? undefined,
        abortSignal: abortController.signal,
        // The required reply is not streamed: it is shown once, when it is persisted.
        forceReply,
        onChunk: forceReply ? undefined : (chunk) => {
          if (abortController.signal.aborted) return;
          // Agent-to-agent reply text is never streamed into the owner's chat, wordy or not; the client hides their reasoning and tool frames (`turnKind`) outside wordy mode.
          if (!isA2ATurn && counterparty.kind !== 'agent') {
            broadcast({
              type: 'chat:chunk',
              agentId,
              messageId,
              content: chunk,
              done: false,
            });
          }
          // Phone call: flush completed sentences to the call's TTS queue, so audio starts early. The buffer
          // releases text only where markdown is balanced; the call cleans it at its own door.
          if (turnCtx.phoneStreamCallSid) {
            const raw = turnCtx.phoneStreamBuffer.pushRaw(chunk);
            // An echoed time stamp opens the reply, so only the first spoken part carries it.
            const part = (turnCtx.phoneStreamFlushedAny ? raw : stripLeadingTimeStamp(raw)).trim();
            if (part) {
              // Set before the async enqueue, or the turn-end check could read false and replay the reply.
              // Safe: `ended` is a one-way latch, so a session live at turn end was live when parts queued.
              turnCtx.phoneStreamFlushedAny = true;
              void (async () => {
                try {
                  const { getCallSession } = await import('../../../../twilio/call-session.js');
                  const session = getCallSession(turnCtx.phoneStreamCallSid as string);
                  if (!session || session.isEnded() || abortController.signal.aborted) return;
                  // Enqueue only; the session's single-flight drain worker synthesises in order.
                  void session.queueAgentSay(part);
                } catch { /* best effort; one-shot fallback runs at turn end */ }
              })();
            }
          }
        },
        onReasoningChunk: (chunk) => {
          if (abortController.signal.aborted) return;
          broadcast({
            type: 'chat:reasoning_chunk',
            agentId,
            messageId,
            content: chunk,
            done: false,
          });
        },
      });
      callSucceeded = true;
      break;
    } catch (err) {

      // Read the stop flag, never clear it (`runtime.ts` owns it); the preempt is consumed so the wakeup fires.
      if (isStopFenced(agentId)) return abandonForStop('stopped-mid-call');
      if (preemptedAgents.has(agentId)) {
        preemptedAgents.delete(agentId);
        logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
        return { abandoned: abandonTurn(latchEngineCut(state, 'preempt'), 'preempted-mid-call') };
      }

      // Fixed model: only the stream-idle abort earns the second attempt. A declared first-chunk timeout
      // deliberately does not match: a cold re-dial would rerun the whole prompt and hit the same bound.
      if (!isAutoRouted) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts - 1 && (msg.includes(STREAM_IDLE_TIMEOUT_ERROR) || (msg.includes(STREAM_NO_FINISH_ERROR) && !turnCtx.phoneStreamFlushedAny))) {   // a hung-up answer gets the same one retry, unless a caller already heard part of it (that audio cannot be recalled; a re-dial would say it twice)
          logger.warn('v2: model stream idle timeout; retrying the same model once on a fresh connection', {
            attempt, modelId,
          }, agentId);
          // Phone: the retry speaks from the first word, so the abandoned attempt's unspoken fragment goes.
          if (turnCtx.phoneStreamCallSid) { turnCtx.phoneStreamBuffer.takeRaw(); turnCtx.phoneStreamFlushedAny = false; }
          continue;
        }
        revertTriggerStampOnAbort(); // model call failed with no answer, re-arm the ask
        throw err;
      }
      if (attempt >= maxAttempts - 1) {
        revertTriggerStampOnAbort(); // model call failed with no answer, re-arm the ask
        throw freeFallbackDown(err, agentId, routerTier ?? state.lockedTier ?? 'standard', [...excludedModels, modelId]);
      }

      excludedModels.push(modelId);
      // Clear model lock so fallback can pick a different model.
      state = advance(state, { lockedModelId: null, lockedTier: null });
      const { selectModel } = await import('../../../../router/selector.js');
      const fallbackTier = routerTier ?? state.lockedTier ?? 'standard';

      // The fallback pick is judged on fit too, against the array in hand (it may already be re-fitted for
      // another model), as one more predicate in the selector's walk.
      const tooSmallToHold: string[] = [];
      let fallback = selectModel(
        fallbackTier, agentId, excludedModels, ['tools'],
        estimateAssembledArrayTokens(systemPrompt, messages), getContextWindow,
      );

      if (!fallback) {
        // Rescue: when the fit filter empties the pick, select ignoring fit and re-fit that candidate; one
        // whose window cannot hold the prompt and tools is excluded and the next tried, bounded.
        for (let rescue = 0; rescue < 8 && !fallback; rescue++) {
          const fitExcluded = selectModel(fallbackTier, agentId, excludedModels, ['tools']);
          if (!fitExcluded) break;
          let reassembly: Awaited<ReturnType<typeof reassembleForFitIfNeeded>>;
          try {
            reassembly = await reassembleForFitIfNeeded({
              agentId, modelId: fitExcluded.modelId, messages, systemPrompt, volatileFrom, assemblyTurnContext,
              anotherPickMayFollow: true,
            });
          } catch (refitErr) {
            if (!(refitErr instanceof SystemPromptTooLargeError)) throw refitErr;
            excludedModels.push(fitExcluded.modelId);
            tooSmallToHold.push(fitExcluded.modelId);
            continue;
          }
          if (reassembly) {
            messages = reassembly.messages;
            systemPrompt = reassembly.systemPrompt;
            ctx = reassembly.assembled;
            volatileFrom = reassembly.volatileFrom;
          }
          // Select again with the new estimate: the smaller array may now fit a higher-priority candidate.
          fallback = selectModel(
            fallbackTier, agentId, excludedModels, ['tools'],
            estimateAssembledArrayTokens(systemPrompt, messages), getContextWindow,
          );
          if (!fallback) break;
        }
      }

      // Every fallback pick is re-fitted to its own window before the dial; one that cannot hold the prompt
      // and tools is excluded and the fit-aware selection asked again, bounded.
      for (let pickTry = 0; fallback && pickTry < 8; pickTry++) {
        try {
          const refit = await reassembleForFitIfNeeded({
            agentId, modelId: fallback.modelId, messages, systemPrompt, volatileFrom, assemblyTurnContext,
            anotherPickMayFollow: true,
          });
          if (refit) {
            messages = refit.messages;
            systemPrompt = refit.systemPrompt;
            ctx = refit.assembled;
            volatileFrom = refit.volatileFrom;
          }
          break;
        } catch (refitErr) {
          if (!(refitErr instanceof SystemPromptTooLargeError)) throw refitErr;
          excludedModels.push(fallback.modelId);
          tooSmallToHold.push(fallback.modelId);
          fallback = selectModel(
            fallbackTier, agentId, excludedModels, ['tools'],
            estimateAssembledArrayTokens(systemPrompt, messages), getContextWindow,
          );
        }
      }

      if (!fallback) {
        logger.error('v2 auto-router: no fallback models available', {
          failedModel: modelId, tier: fallbackTier, excludedModels, attempt,
        }, agentId);
        revertTriggerStampOnAbort(); // all fallbacks exhausted, no answer, re-arm the ask
        // Out of candidates because none could hold the agent: say so, keeping the code recovery reads.
        if (tooSmallToHold.length > 0) {
          const named = `No model this agent could fall back to can hold this agent's instructions and tools `
            + `(${tooSmallToHold.join(', ')}: window too small) after ${modelId} failed: `
            + (err instanceof Error ? err.message : String(err));
          throw err instanceof AgentError
            ? new AgentError(named, agentId, { code: err.code, retryable: err.retryable, provider: err.provider, preDialRefusal: err.preDialRefusal, cause: err })
            : new Error(named, { cause: err });
        }
        throw freeFallbackDown(err, agentId, fallbackTier, [...excludedModels, modelId]);
      }
      logger.warn(`v2 auto-router: ${modelId} failed → falling back to ${fallback.modelId}`, {
        failedModel: modelId,
        fallbackModel: fallback.modelId,
        tier: routerTier,
        error: err instanceof Error ? err.message.slice(0, 100) : String(err),
      }, agentId);
      // Phone: drop the failed stream's unsent tail and the streamed latch before the fallback. A rare
      // duplicate (partial plus full one-shot) beats a caller without the answer; queued audio stays.
      if (turnCtx.phoneStreamCallSid) { turnCtx.phoneStreamBuffer.takeRaw(); turnCtx.phoneStreamFlushedAny = false; }
      modelId = fallback.modelId;
      state = advance(state, { modelId });
    } finally {
      // Nothing to release: `callModel`'s own `finally` releases its stop registration by identity.
    }
  }

  if (!callSucceeded || !result) {
    // Unreachable in practice: the loop breaks on success or throws; the ask is re-armed at those throws.
    revertTriggerStampOnAbort();
    throw new AgentError('Model call failed after all attempts', agentId, { code: 'MODEL_CALL_FAILED' });
  }

  // The stop fence on the success path: a stop pressed after the stream ended keeps the reply from being
  // persisted or broadcast. A stop after the row is persisted deletes nothing; the person keeps it.
  if (isStopFenced(agentId)) return abandonForStop('stopped-after-call');
  // The required reply ends the turn's work: a tool call on it (a transport that could not require the reply) never runs.
  if (turnCtx.forceReplyPending) result = { ...result, toolCalls: [] };
  turnCtx.forceReplyPending = false;

  // Learn declared secrets once, before any persist, index or broadcast; stored copies get the sentinel.
  noteDeclaredSecretsFromToolCalls(agentId, result.toolCalls);
  // A value is first learned here, so ask titles minted before it are re-vetted (`work/ask-title.ts`).
  revetOpenAskTitles(agentId);

  // Extra output room is for the one retry: a call not cut off has spent it; one cut off again keeps the
  // mark, telling the ladder the room was already given.
  if (state.outputTokensEscalated > 0 && !isOutputCut(result.stopReason)) state = advance(state, { outputTokensEscalated: 0 });
  return { state, result, modelId };
}
