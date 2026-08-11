// ════════════════════════════════════════
// PHASE-6 T5 (CUT 5) — THE MODEL CALL ITSELF, moved from `loop.ts` with its
// bodies byte-unchanged: the retry-and-fallback ladder, the streaming sinks, and
// the two exits that ABANDON THE TURN.
//
// ── THE TWO CONTROL-FLOW CONVERSIONS, AND THEY ARE THE ONLY ONES ──
// The stopped and preempted arms of the model call's own `catch` were `return`
// statements of `runV2TurnBody`: they leave the TURN, not the loop, so finalize
// never runs for them and only the `finally` does. A module cannot `return` from
// its caller, so each becomes `abandonTurn(...)` with its own named reason and the
// driver honours it by returning. CUT 4's finalize contract pins the same two exits
// from the driver's side, at exactly two; this file is the other half of that pin.
//
// Everything else is the same bytes: the 3-vs-2 attempt ladder, the stream-idle
// rule ("the ONLY error that earns the second attempt"), the credential read point
// (PHASE-5 T6B / RULING P5-R11 — still the only one in the engine, held by a
// clause), every `logger` line and the N-1 hand-back on both give-up paths.
// ════════════════════════════════════════

import type { ModelCallParams } from '../../../model.js';

/** The array the assembler hands over and the injections append to. */
type ModelMessage = ModelCallParams['messages'][number];
import { callModel, STREAM_IDLE_TIMEOUT_ERROR } from '../../../model.js';
import { advance, type AgentTurnState } from '../../state.js';
import { abandonTurn, type StepOutcome } from '../step-outcome.js';
import { broadcast } from '../../../../gateway/ws.js';
import { activeAbortControllers, stoppedAgents, preemptedAgents } from '../../../shared-state.js';
import { hydrateCredentialsInMessages } from '../../../../credentials/secret-values.js';
import { noteDeclaredSecretsFromToolCalls } from '../../../../credentials/secret-fields.js';
import { AgentError } from '../../../errors.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { AgentStatus } from '@dojo/shared';
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
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
  readonly assembled: AssembledContext;
  readonly routerTier: string | null;
  readonly counterparty: TurnCounterparty;
}

/** Either the turn is abandoned, or the call produced a result and a (possibly
 *  fallen-back) model id. The union is what keeps the abandon arm unmissable. */
export type ModelCallResultOrAbandon =
  | { readonly abandoned: StepOutcome }
  | { readonly abandoned?: undefined; readonly state: AgentTurnState; readonly result: Awaited<ReturnType<typeof callModel>>; readonly modelId: string };

export async function callWithRetryAndFallback(
  stateIn: AgentTurnState,
  modelIdIn: string,
  input: ModelCallInputs,
): Promise<ModelCallResultOrAbandon> {
  const { agentId, turnCtx, messageId, messages, systemPrompt, useTools, isAutoRouted, isA2ATurn, excludedModels, revertTriggerStampOnAbort, setAgentStatus, assembled: ctx, routerTier, counterparty } = input;
  let state = stateIn;
  let modelId = modelIdIn;
  // ── Call model with retry-and-fallback (matches v1 runtime.ts:1028-1116) ──
  // For auto-routed agents, try up to 3 different models in the tier.
  // For fixed-model agents, throw on first failure.
  // Fixed-model agents get ONE attempt normally, PLUS one same-model retry
  // when the stream idle watchdog aborted a hung provider call (model.ts,
  // 2026-07-10): the request died on the wire, not in the model, and a
  // fresh attempt typically succeeds in seconds (the 602s production hang's
  // silent retry completed in 3s).
  const maxAttempts = isAutoRouted ? 3 : 2;
  let result: Awaited<ReturnType<typeof callModel>> | undefined;
  let callSucceeded = false;

  /** UX-REPAIR T37 — the turn's ONE stop-abandon, said twice with two truthful
   *  reasons. Kept as one call so the step's abandon census (its contract test
   *  counts `abandonTurn` in this file) still reads TWO: this and the preempt. */
  const abandonForStop = (reason: 'stopped-before-call' | 'stopped-mid-call'): { abandoned: StepOutcome } => {
    setAgentStatus(agentId, 'idle');
    return { abandoned: abandonTurn(state, reason) };
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // ── UX-REPAIR T37: THE WINDOW BETWEEN THE GATE AND THE WIRE ──
    //
    // `stopAgent` can only abort a call that is ALREADY in flight — it aborts
    // whatever is in `activeAbortControllers`. Between the pre-call gate that
    // read the flag and the `set` below sits the whole of assemble (vector
    // search, context build, injections) plus, on the first round, the tool
    // batch that preceded it. A stop landing in there hit nothing: no
    // checkpoint to see it, no controller to abort. Measured on the dev box
    // 2026-08-11 (control C3): stop at 07:34:19.429 — 70 ms after that
    // iteration's gate — and the provider call went out at 07:34:19.506 and ran
    // 27 s to completion, followed by a whole tool batch; the turn did not
    // actually stop until the NEXT gate at 07:35:08.284, 49 s later.
    //
    // Reading the flag at the instant the call becomes interruptible closes the
    // window from the other side: either the stop was already recorded and we
    // never dial, or the controller is registered and the abort reaches the
    // fetch. There is no third state.
    const beforeCall = stoppedAgents.has(agentId) ? abandonForStop('stopped-before-call') : null;
    if (beforeCall) return beforeCall;

    const abortController = new AbortController();
    activeAbortControllers.set(agentId, abortController);

    try {
      // RC-4.4: mark the model call in flight so the start-ack streaming-race grace
      // can defer firing while the reply is still streaming. Cleared in the finally.
      result = await callModel({
        agentId,
        modelId,
        // PHASE-5 T6B (RULING P5-R11): THE CREDENTIAL READ POINT, and the
        // ONLY one. Assembly rebuilds this array from the STORED rows every
        // iteration, so from the second iteration on the model was reading
        // its own prior call with the placeholder in it and copying that
        // forward — the credential worked once per turn and then stopped.
        // The value goes back HERE, at the provider boundary, so assembly,
        // the context receipt and the dev instruments all keep the
        // placeholder and no stored byte is rewritten. A no-op returning
        // this very array when no placeholder is present, hence no effect on
        // the cached prefix (OR7/#10). Full rationale + the three properties
        // that make it safe: `credentials/secret-values.ts`.
        messages: hydrateCredentialsInMessages(agentId, messages),
        systemPrompt,
        // C28 P-2: system-side volatile lane (empty after P-1). Trails the
        // cached stable system block so it can't invalidate the cached prefix.
        systemVolatile: ctx.systemVolatile,
        tools: useTools,
        routerTier: routerTier ?? undefined,
        // Real abort signal, when stopAgent fires controller.abort(), the
        // underlying SDK call (Anthropic/OpenAI/Ollama) actually cancels
        // the in-flight fetch and throws here. Without this signal, stop
        // would only halt the runtime loop AFTER the model call finished.
        abortSignal: abortController.signal,
        // TRUE streaming, broadcast each chunk as it arrives.
        onChunk: (chunk) => {
          if (abortController.signal.aborted) return;
          // Inter-agent turns must NOT stream to the user's chat. The turn's
          // persisted message is hidden from the dashboard (source='a2a', via
          // the origin classifier), but the live chat:chunk path bypasses that
          // filter, streaming the agent-to-agent prose live produced a "reply
          // to no one" bubble that then vanished on refresh (the refetch
          // correctly hides the A2A row). Suppress the live stream at the
          // source so inter-agent coordination never reaches the user's chat,
          // live OR on reload. The phone/TTS accumulation below is unaffected:
          // an inter-agent turn never has turnCtx.phoneStreamCallSid set.
          if (!isA2ATurn && counterparty.kind !== 'agent') {
            broadcast({
              type: 'chat:chunk',
              agentId,
              messageId,
              content: chunk,
              done: false,
            });
          }
          // v2.9.23, phone-call streaming TTS. Accumulate chunks
          // into a buffer and flush each completed sentence to
          // CallSession.queueAgentSay as it appears. Effect: audio
          // starts playing on the first sentence, instead of
          // waiting for the full model response. Same idea as
          // voice mode's clause splitter but landing on the
          // Twilio CallSession's TTS queue instead of the voice
          // WS stream.
          if (turnCtx.phoneStreamCallSid) {
            turnCtx.phoneStreamBuffer += chunk;
            // Boundary: sentence-end punctuation followed by
            // whitespace. Sentence-level keeps the synth boundary
            // clean for both Kokoro and Hume.
            const flushParts: string[] = [];
            let last = 0;
            const re = /[.!?\n]+\s+/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(turnCtx.phoneStreamBuffer)) !== null) {
              const end = m.index + m[0].length;
              const part = turnCtx.phoneStreamBuffer.slice(last, end).trim();
              if (part) flushParts.push(part);
              last = end;
            }
            if (last > 0) turnCtx.phoneStreamBuffer = turnCtx.phoneStreamBuffer.slice(last);
            if (flushParts.length > 0) {
              // B-2 (comms-audit): set the streamed flag SYNCHRONOUSLY the moment
              // we decide to flush, BEFORE the detached async IIFE. The old code
              // set it inside the IIFE after an awaited import, so the turn-end
              // check could read it as false (microtask not yet run) and fall to
              // the one-shot full-reply fallback → the caller heard the reply
              // TWICE. Setting it here is safe even though the enqueue is deferred:
              // queueAgentSay only no-ops when the session is gone or ENDED, and
              // `ended` is a one-way latch, so if the session is still live at
              // turn-end (the only path that reads this flag, after re-checking
              // !session / isEnded()), it was live at IIFE time too and the parts
              // WERE enqueued. There is no live-call-hears-silence window here.
              turnCtx.phoneStreamFlushedAny = true;
              // v2.10.1, queueAgentSay is now just an enqueue
              // (the CallSession runs a single-flight drain
              // worker), so synchronous push is fine and order
              // is preserved by the worker. No IIFE / no
              // parallel synths.
              void (async () => {
                try {
                  const { getCallSession } = await import('../../../../twilio/call-session.js');
                  const session = getCallSession(turnCtx.phoneStreamCallSid as string);
                  if (!session || session.isEnded()) return;
                  for (const part of flushParts) {
                    if (abortController.signal.aborted) return;
                    // Fire-and-forget: queueAgentSay enqueues
                    // and returns; the drain worker handles
                    // serial synthesis.
                    void session.queueAgentSay(part);
                  }
                } catch { /* best effort; one-shot fallback runs at turn end */ }
              })();
            }
          }
        },
        // Reasoning / thinking chunks (DeepSeek native, OpenRouter
        // unified). The dashboard renders these in a collapsible
        // "Thinking…" panel above the assistant bubble, separate
        // from the final-answer text stream.
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
      activeAbortControllers.delete(agentId);
      callSucceeded = true;
      break;
    } catch (err) {
      activeAbortControllers.delete(agentId);

      // UX-REPAIR T37: READ, never delete. The flag's owner is the run's own
      // exit path in `runtime.ts` — see `shared-state.ts`'s header on
      // `stoppedAgents`. The preempt below still consumes at its checkpoint,
      // and must: a preempt exists so the QUEUED WAKEUP CAN FIRE.
      if (stoppedAgents.has(agentId)) return abandonForStop('stopped-mid-call');
      if (preemptedAgents.has(agentId)) {
        preemptedAgents.delete(agentId);
        logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
        setAgentStatus(agentId, 'idle');
        return { abandoned: abandonTurn(state, 'preempted-mid-call') };
      }

      // Fixed-model path: the ONLY error that earns the second attempt is
      // the stream-idle watchdog abort (same model, fresh connection).
      // Everything else rethrows immediately, exactly as before.
      if (!isAutoRouted) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts - 1 && msg.includes(STREAM_IDLE_TIMEOUT_ERROR)) {
          logger.warn('v2: model stream idle timeout; retrying the same model once on a fresh connection', {
            attempt, modelId,
          }, agentId);
          continue;
        }
        revertTriggerStampOnAbort(); // N-1: model call failed with no answer, re-arm the ask
        throw err;
      }
      // Auto-routed and exhausted attempts, rethrow.
      // (v1's catch path in handleMessage handles further recovery, 
      // Dreamer overflow, provider 4xx, healer notification, etc. Phase 6
      // moves all of that into agent/v2/recovery.ts.)
      if (attempt >= maxAttempts - 1) {
        revertTriggerStampOnAbort(); // N-1: model call failed with no answer, re-arm the ask
        throw err;
      }

      // Auto-routed: try the next model in the fallback chain.
      excludedModels.push(modelId);
      // Clear model lock so fallback can pick a different model.
      state = advance(state, { lockedModelId: null, lockedTier: null });
      const { selectModel } = await import('../../../../router/selector.js');
      const fallbackTier = routerTier ?? state.lockedTier ?? 'standard';
      const fallback = selectModel(fallbackTier, agentId, excludedModels, ['tools']);
      if (!fallback) {
        logger.error('v2 auto-router: no fallback models available', {
          failedModel: modelId, tier: fallbackTier, excludedModels, attempt,
        }, agentId);
        revertTriggerStampOnAbort(); // N-1: all fallbacks exhausted, no answer, re-arm the ask
        throw err;
      }
      logger.warn(`v2 auto-router: ${modelId} failed → falling back to ${fallback.modelId}`, {
        failedModel: modelId,
        fallbackModel: fallback.modelId,
        tier: routerTier,
        error: err instanceof Error ? err.message.slice(0, 100) : String(err),
      }, agentId);
      // Phone streaming: this failed model's stream is discarded, so
      // drop its un-flushed tail and clear the "already streamed"
      // latch before the fallback attempt runs. The buffer only ever
      // holds the CURRENT stream's unsent tail (the sent prefix is
      // stripped in onChunk), and that stream is gone. The latch
      // means "this turn's answer already streamed"; the fallback
      // attempt re-latches it if IT streams. Resetting the latch here
      // prefers a rare duplication (a partial already spoken plus the
      // full answer spoken one-shot when the fallback does NOT stream)
      // over ever leaving the caller without the final answer. Audio
      // already handed to queueAgentSay stays committed by design;
      // there is no dequeue and none should be added.
      if (turnCtx.phoneStreamCallSid) { turnCtx.phoneStreamBuffer = ''; turnCtx.phoneStreamFlushedAny = false; }
      modelId = fallback.modelId;
      state = advance(state, { modelId });
    } finally {
      // RC-4.4: the model call for this attempt has settled (success break, retry
      // continue, or throw); it is no longer in flight. A retry sets it true again.
    }
  }

  if (!callSucceeded || !result) {
    // Defensive guard only, in practice unreachable: the retry loop above exits
    // either by `break` (callSucceeded=true) or by throwing on the final failed
    // attempt (the catch's give-up paths). The N-1 stamp-revert therefore lives at
    // those actual throw sites (revertTriggerStampOnAbort), NOT here, so a model-call
    // failure re-arms the human's ask on the path that genuinely runs.
    revertTriggerStampOnAbort();
    throw new AgentError('Model call failed after all attempts', agentId, { code: 'MODEL_CALL_FAILED' });
  }

  // PHASE-4 T5b (P4-R2): learn this result's DECLARED secrets here, once,
  // before it reaches any persist / index / broadcast seam below. The live
  // tool call keeps the real value; every stored copy gets the sentinel.
  noteDeclaredSecretsFromToolCalls(agentId, result.toolCalls);

  return { state, result, modelId };
}
