// The v2 control shell: runV2Turn drives one turn through its step packages (preflight; a loop of pre-call
// gates, assemble, model call, classify, execute, post-execution; then finalize, recovery and teardown).

import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
// recordError is not called here: handleMessage's catch calls it, and a second count trips the pause early.
import { openTurnContext, turnContext, endTurnContext, type TurnContext } from '../turn-context.js';
import { markTurnDied } from './turn-record.js';
// agent-status.ts owns the agents.status transition; never re-export setAgentStatus from this module.
import { setAgentStatus } from '../agent-status.js';

import { statusHeartbeats } from '../shared-state.js';

import { advance } from './state.js';
import { runPostExecution } from './steps/post-execution/index.js';
import { runExecute } from './steps/execute/index.js';
import { TEARDOWN_PHASE, runTurnRecovery, runTurnTeardown } from './steps/teardown/index.js';
import { runPreCallGates } from './steps/pre-call-gates/index.js';
import { runAssemble } from './steps/assemble/index.js';
import { runFinalize } from './steps/finalize/index.js';
import { runCallLLM, type CallLLMContext } from './steps/call-llm/index.js';
import { runPostCallClassify } from './steps/post-call-classify/index.js';
import { runPreflight } from './steps/preflight/index.js';
import { ensureArtifactDir } from '../artifact-dir.js';
import { handBackAsk } from '../../work/ask-settlement.js';
import { forcedReplyDue } from './forced-reply.js';
import { askIdForMessage } from '../../work/store.js';

const logger = createLogger('v2-loop');

const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
// An assigned open task disarms untracked-multistep enforcement only if touched within this window, so new work
// cannot ride in under an abandoned task. The same 30 minutes as `sweepBootStaleness` in work/work-reaper.ts.
const STALE_TASK_WINDOW_MINUTES = 30;
// Start-ack floor on the person's wait: a turn still working after 30s owes an ack; quick lookups stay quiet.
const ENGINE_START_ACK_AFTER_MS = 30000;

function startStatusHeartbeat(agentId: string): void {
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      // Carry the turn kind on every heartbeat: the client treats a missing turnKind as 'user' and would re-show
      // the working UI in the user's chat during inter-agent turns.
      broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: turnContext(agentId)?.kind ?? 'user', userFacing: typeof turnContext(agentId)?.convKey === 'string' });
    } catch {
    }
  }, STATUS_HEARTBEAT_INTERVAL_MS);
  statusHeartbeats.set(agentId, timer);
}

function stopStatusHeartbeat(agentId: string): void {
  const timer = statusHeartbeats.get(agentId);
  if (timer) {
    clearInterval(timer);
    statusHeartbeats.delete(agentId);
  }
}

/** Run one turn on the v2 runtime. This wrapper is the turn's lifetime: it opens and always ends the turn
 *  context (why the clear lives here is written at `endTurnContext`), and the one place every way out of the turn
 *  passes: a turn row its own end did not close (a throw, an abandon) is closed here. */
export async function runV2Turn(agentId: string): Promise<void> {
  await ensureArtifactDir(agentId);   // the folder the manifest grants exists before the agent acts
  const turnCtx = openTurnContext(agentId);
  try {
    await runV2TurnBody(agentId, turnCtx);
  } finally {
    if (turnCtx.turnNumber !== undefined) markTurnDied(agentId, turnCtx.turnNumber);
    endTurnContext(agentId);
  }
}

async function runV2TurnBody(agentId: string, turnCtx: TurnContext): Promise<void> {
  // Preflight builds the turn's state from `(turnCtx, ctx)`; its only exit is `abandon`, honoured by returning
  // before the main `try`, so neither finalize nor teardown runs. A preflight that throws hands the request it
  // picked back as a crash (counted, so one that always throws stands down) and the throw goes on to the runtime.
  let preflight: Awaited<ReturnType<typeof runPreflight>>;
  try {
    preflight = await runPreflight(turnCtx, {
      agentId,
      setAgentStatus, startStatusHeartbeat, stopStatusHeartbeat,
      engineStartAckAfterMs: ENGINE_START_ACK_AFTER_MS,
    });
  } catch (err) {
    // A hand-back that fails is logged; the preflight's own error is the one thrown.
    if (turnCtx.root?.kind === 'ask') {
      try { handBackAsk(askIdForMessage(turnCtx.root.id), { agentId, turnNumber: null, cause: 'crash', actorId: agentId, reason: 'the turn failed before it started' }); }
      catch (backErr) { logger.error('the hand-back after a failed preflight did not apply', { agentId, error: String(backErr).slice(0, 300) }, agentId); }
    }
    throw err;
  }
  if (preflight.directive === 'abandon') return;
  const {
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, isHumanContinuation, chosenConvKey, triggerRow, lastUserMessageContent,
    triggerWorkId, triggerConversationId, revertTriggerStampOnAbort, latestUserSource,
    latestTtsEngine, inboundChannel, unrepliedAssign, mostRecentInbound, mostRecentIsA2A,
    hasUnansweredUser, isA2ATurn, pendingEngineEvent, isEngineTurn, settledContextWakeTurn,
    isNotificationTurn, a2aReplyContext, a2aReplyAssignMessageId, counterparty, turnNumber,
    turnStartedAt, reArmIfStrandedNoAnswer, persistRoutingMarker, noteTerminalAnswer,
    refusedOnceSigs, deliverEngineUserAck, counterpartyIsAgentSender, startAckArmed,
    startAckArmedAtMs, startAckRepliedNow, fireStartAckIfOwed, finalizeContext,
    teardownContext, preCallGatesContext,
  } = preflight.outputs;


  try {
    // The passes run until the turn would end; a silent end with someone owed gets its required reply once.
    for (;;) {
      // Steps rewrite `phase` mid-body, so a mid-body 'done' never survives to this check; the monotone
      // close-out latch and repeat-rule grace are read here instead, ending the turn after the iteration ran.
      while (
        turnCtx.state!.phase !== 'done' &&
        !turnCtx.state!.taskClosedWithTextThisTurn &&
        !(turnCtx.toolPhaseEndedByRepeats && turnCtx.repeatGraceCalls < 0)
      ) {
        turnCtx.state = advance(turnCtx.state!, { loopCount: turnCtx.state!.loopCount + 1, phase: 'preCallGates' });

        // Each step asks to exit through its directive; the driver decides here, where nothing downstream can overwrite it.
        const preCallGates = await runPreCallGates(turnCtx.state!, preCallGatesContext());
        turnCtx.state = preCallGates.state;
        if (preCallGates.directive === 'exit') break;
        if (preCallGates.directive === 'continue') continue;
        turnCtx.state = advance(turnCtx.state!, { phase: 'assemble' });
        // Built per iteration: three of its inputs are rewritten between rounds.
        const assembled = await runAssemble(turnCtx.state!, {
          agentId, turnCtx, turnNumber, db, contextModelId, contextWindow,
          counterparty, counterpartyIsAgentSender, chosenConvKey, hasUnansweredUser,
          isA2ATurn, isEngineTurn, isNotificationTurn, lastUserMessageContent,
          latestTtsEngine, latestUserSource, mostRecentIsA2A, pendingEngineEvent,
          mostRecentInbound,
          waitingConvs, engineStartAckDeliveredThisTurn: turnCtx.engineStartAckDeliveredThisTurn,
          staleTaskWindowMinutes: STALE_TASK_WINDOW_MINUTES,
          startAckRepliedNow, isAutoRouted, revertTriggerStampOnAbort,
        });
        turnCtx.state = assembled.state;
        if (assembled.directive === 'exit') break;
        const { assembled: ctx, messages, systemPrompt, volatileFrom, modelContext: mctx, steerAwaitingConfirm, assemblyTurnContext, selection } = assembled;
        // Capability gate, retry-fallback and true streaming; the model was chosen in `assemble`. `abandon` leaves
        // the turn: returning skips finalize and only the `finally` runs. Six inputs come from `assemble` this round.
        turnCtx.state = advance(turnCtx.state!, { phase: 'callLLM' });
        const callLLMContext: CallLLMContext = {
          agentId, turnCtx, turnNumber, db,
          counterparty, isA2ATurn, isAutoRouted, selection,
          messages, systemPrompt, assembled: ctx, modelContext: mctx, volatileFrom,
          steerAwaitingConfirm, assemblyTurnContext,
          revertTriggerStampOnAbort,
        };
        const callLLM = await runCallLLM(turnCtx.state!, callLLMContext);
        turnCtx.state = callLLM.state;
        if (callLLM.directive === 'abandon') return;
        if (callLLM.directive === 'exit') break;
        if (callLLM.directive === 'continue') continue;
        const { messageId, result } = callLLM;

        // After the repeat rule ends the tool phase, tool calls return a note unexecuted; a small grace of
        // iterations lets the model converge to text before the turn concludes. Its text is never suppressed.
        if (turnCtx.toolPhaseEndedByRepeats && result.toolCalls.length > 0) {
          turnCtx.repeatGraceCalls -= 1;
          if (turnCtx.repeatGraceCalls < 0) {
            logger.warn('v2: repeat-rule grace exhausted, concluding the turn', { agentId, turnNumber }, agentId);
          }
        }

        turnCtx.state = advance(turnCtx.state!, { phase: 'postCallClassify' });
        // Built per iteration: the model result and message id come from `callLLM` this round.
        const classified = await runPostCallClassify(turnCtx.state!, {
          agentId, turnCtx, turnNumber, db, agent, counterparty, counterpartyIsAgentSender,
          chosenConvKey, hasUnansweredUser, triggerRow, isA2ATurn, isEngineTurn,
          isHumanContinuation, mostRecentIsA2A, mostRecentInbound, pendingEngineEvent,
          unrepliedAssign, a2aReplyContext, a2aReplyAssignMessageId, settledContextWakeTurn,
          waitingConvs, inboundChannel, latestUserSource, lastUserMessageContent,
          configuredModelId, turnStartedAt, messageId, result,
          // Closures over driver state, passed as values so they keep the bindings they closed over.
          reArmIfStrandedNoAnswer, noteTerminalAnswer, deliverEngineUserAck, startAckRepliedNow,
        });
        turnCtx.state = classified.state;
        if (classified.directive === 'exit') break;
        if (classified.directive === 'continue') continue;
        const {
          persistedContent, interAgentTurn, hasXmlFallbackTools, effectiveModelIdForPersist,
        } = classified;


        // INVARIANT: never persist any message between an assistant tool_use and its tool_result (the assembler would
        // drop the pair and the model re-issue the call); a transient indicator must be broadcast-only.
        turnCtx.state = advance(turnCtx.state!, { phase: 'execute' });
        // Built per iteration: four inputs come from `postCallClassify` this round.
        const executed = await runExecute(turnCtx.state!, {
          agentId, turnCtx, turnNumber, db, agent, counterparty, counterpartyIsAgentSender,
          chosenConvKey, hasUnansweredUser, triggerRow, triggerWorkId, triggerConversationId,
          turnStartedAt, persistRoutingMarker,
          engineStartAckDeliveredThisTurn: turnCtx.engineStartAckDeliveredThisTurn,
          deferredDeliveredByAck: turnCtx.deferredDeliveredByAck,
          refusedOnceSigs,
          startAckArmed, startAckArmedAtMs, fireStartAckIfOwed,
          result, messageId, persistedContent, interAgentTurn, hasXmlFallbackTools,
          effectiveModelIdForPersist,
          staleTaskWindowMinutes: STALE_TASK_WINDOW_MINUTES,
          engineStartAckAfterMs: ENGINE_START_ACK_AFTER_MS,
        });
        turnCtx.state = executed.state;
        if (executed.directive === 'exit') break;
        if (executed.directive === 'continue') continue;
        const { turnToolResults } = executed;

        turnCtx.state = advance(turnCtx.state!, { phase: 'postExecution' });
        const postExecution = runPostExecution(turnCtx.state!, {
          agentId, turnNumber, turnToolResults, broadcast,
        });
        turnCtx.state = postExecution.state;
        if (postExecution.directive === 'exit') break;
        if (postExecution.directive === 'continue') continue;

      }
      if (!(await forcedReplyDue(turnCtx, { agentId, turnNumber, latestUserSource, counterpartyIsAgentSender }))) break;
    }

    turnCtx.state = advance(turnCtx.state!, { phase: 'finalize' });
    turnCtx.state = (await runFinalize(turnCtx.state!, finalizeContext())).state;
  } catch (err) {
    turnCtx.forceReplyPending ||= turnCtx.forcedReplySpent;   // a turn that threw is handed back, never held as empty
    // A module cannot express catch/finally for its caller, so the driver keeps the construct and the step the body.
    turnCtx.state = (await runTurnRecovery(turnCtx.state!, teardownContext(), err)).state;
  } finally {
    // Runs on every exit; the advance into teardown is here so validate() runs on it and the step never writes phase.
    turnCtx.state = advance(turnCtx.state!, { phase: TEARDOWN_PHASE });
    turnCtx.state = (await runTurnTeardown(turnCtx.state!, teardownContext())).state;
  }
}
