// The v2 control shell: runV2Turn drives one turn through its step packages (preflight; a loop of pre-call
// gates, assemble, model call, classify, execute, post-execution; then finalize, recovery and teardown).

import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
// classifyTool is the canonical, test-covered effect classifier; a hand list here would drift from the registry.
import { classifyTool } from '@dojo/shared';
// recordError is not called here: handleMessage's catch calls it, and a second count trips the pause early.
import { openTurnContext, turnContext, endTurnContext, type TurnContext } from '../turn-context.js';
// agent-status.ts owns the agents.status transition; never re-export setAgentStatus from this module.
import { setAgentStatus } from '../agent-status.js';
// Gates match `toolOpKey(name, args)`: the operation id for a work verb, the plain name otherwise.
import { toolOpKey, PROGRESS_WORK_OPS } from '../../tools/work-verbs.js';

import { statusHeartbeats } from '../shared-state.js';

// Side-effect import: registers the runtime getter that self-continuation handleMessage() calls need.
import { getAgentRuntime } from '../runtime.js';

import { advance } from './state.js';
import { canonicalToolSignature } from './classifiers/loop.js';
import { runPostExecution } from './steps/post-execution/index.js';
import { runExecute } from './steps/execute/index.js';
import { TEARDOWN_PHASE, runTurnRecovery, runTurnTeardown } from './steps/teardown/index.js';
import { runPreCallGates } from './steps/pre-call-gates/index.js';
import { runAssemble } from './steps/assemble/index.js';
import { runFinalize } from './steps/finalize/index.js';
import { runCallLLM, type CallLLMContext } from './steps/call-llm/index.js';
import { runPostCallClassify } from './steps/post-call-classify/index.js';
import { runPreflight } from './steps/preflight/index.js';
import { noteEngineCheckpoint } from '../../work/engine-checkpoint-note.js';
import { parkJob } from '../../work/job-continuation.js';
import { ensureArtifactDir } from '../artifact-dir.js';

const logger = createLogger('v2-loop');

const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
// An assigned open task disarms untracked-multistep enforcement only if touched within this window, so new work
// cannot ride in under an abandoned task. Same value as `DEADLINES.stale_task_window` (work/work-reaper.ts).
const STALE_TASK_WINDOW_MINUTES = 30;
const MAX_TOOL_LOOPS = 75;
// Start-ack floor on the person's wait: a turn still working after 30s owes an ack; quick lookups stay quiet.
const ENGINE_START_ACK_AFTER_MS = 30000;
// Task-thrash detector: the same canonical call (canonicalToolSignature, so varying one parameter cannot slip
// past) DUPLICATE_SIG_LIMIT times with no progress is thrashing. The window is turn identity (this turn and
// THRASH_TURN_WINDOW before it, as auto-continued spirals span the boundary), never load-dependent wall clock.
const THRASH_TURN_WINDOW = 1; // current turn and this many before it
const DUPLICATE_SIG_LIMIT = 4;

// Exported only so tests drive the real detector; production reaches it through
// `PreCallGatesContext.detectTaskThrashing`, because a step must never import the loop.
export function detectTaskThrashing(agentId: string): {
  thrashing: boolean;
  toolName?: string;
  signature?: string;
  count?: number;
} {
  try {
    const db = getDb();
    // Rows with a NULL turn_number fall out of the window, which fails safe (a detector can only under-count).
    const minTurn = (turnContext(agentId)?.turnNumber ?? 0) - THRASH_TURN_WINDOW;
    const rows = db.prepare(`
      SELECT content FROM messages
      WHERE agent_id = ? AND role = 'assistant'
        AND turn_number >= ?
      ORDER BY created_at ASC, rowid ASC
    `).all(agentId, minTurn) as Array<{ content: string }>;

    // Progress is success-aware: a failed tool_use (per the window's tool_result rows) counts toward thrash,
    // never as progress.
    const failedToolUseIds = new Set<string>();
    try {
      const toolRows = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'tool'
          AND turn_number >= ?
      `).all(agentId, minTurn) as Array<{ content: string }>;
      for (const tr of toolRows) {
        let blocks: unknown;
        try { blocks = JSON.parse(tr.content); } catch { continue; }
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          const blk = b as { type?: string; tool_use_id?: string; is_error?: boolean };
          if (blk?.type === 'tool_result' && blk.is_error && blk.tool_use_id) {
            failedToolUseIds.add(blk.tool_use_id);
          }
        }
      }
    } catch { /* best effort, without result rows, fall back to name-based */ }

    const counts = new Map<string, { count: number; toolName: string }>();
    let madeProgress = false;
    for (const row of rows) {
      let blocks: unknown;
      try { blocks = JSON.parse(row.content); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        const block = b as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
        if (block.type !== 'tool_use') continue;
        const name = String(block.name ?? '');
        if (!name) continue;
        const failed = block.id != null && failedToolUseIds.has(String(block.id));
        // Progress: a status flip, step completion, note, complete_task, or a successful effectful action
        // (classifyTool). An identical effectful re-run still trips loopDetector on its own signature.
        if (
          !failed && (
            PROGRESS_WORK_OPS.has(toolOpKey(name, block.input)) ||
            name === 'complete_task' ||
            classifyTool(name, block.input) === 'effectful-action'
          )
        ) {
          madeProgress = true;
          continue;
        }
        const sig = canonicalToolSignature(name, block.input);
        const cur = counts.get(sig) ?? { count: 0, toolName: name };
        counts.set(sig, { count: cur.count + 1, toolName: name });
      }
    }
    if (madeProgress) return { thrashing: false };
    let topSig = '';
    let topCount = 0;
    let topName = '';
    for (const [sig, v] of counts) {
      if (v.count > topCount) { topCount = v.count; topSig = sig; topName = v.toolName; }
    }
    if (topCount >= DUPLICATE_SIG_LIMIT) {
      return { thrashing: true, toolName: topName, signature: topSig, count: topCount };
    }
    return { thrashing: false };
  } catch {
    return { thrashing: false };
  }
}

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
 *  context (why the clear lives here is written at `endTurnContext`). */
export async function runV2Turn(agentId: string): Promise<void> {
  await ensureArtifactDir(agentId);   // the folder the manifest grants exists before the agent acts
  const turnCtx = openTurnContext(agentId);
  try {
    await runV2TurnBody(agentId, turnCtx);
  } finally {
    endTurnContext(agentId);
  }
}

async function runV2TurnBody(agentId: string, turnCtx: TurnContext): Promise<void> {
  // Preflight builds the turn's state from `(turnCtx, ctx)`; its only exit is `abandon`, honoured by returning
  // before the main `try`, so neither finalize nor teardown runs.
  const preflight = await runPreflight(turnCtx, {
    agentId,
    setAgentStatus, startStatusHeartbeat, stopStatusHeartbeat, detectTaskThrashing,
    engineStartAckAfterMs: ENGINE_START_ACK_AFTER_MS,
  });
  if (preflight.directive === 'abandon') return;
  const {
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, isHumanContinuation, chosenConvKey, triggerRow, lastUserMessageContent,
    triggerWorkId, triggerConversationId, revertTriggerStampOnAbort, latestUserSource,
    latestTtsEngine, inboundChannel, unrepliedAssign, mostRecentInbound, mostRecentIsA2A,
    hasUnansweredUser, isA2ATurn, pendingEngineEvent, isEngineTurn, settledContextWakeTurn,
    isNotificationTurn, a2aReplyContext, a2aReplyAssignMessageId, counterparty, turnNumber,
    turnStartedAt, reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer, identicalCallState,
    reminderLaneRefusedSigs, deliverEngineUserAck, counterpartyIsAgentSender, startAckArmed,
    startAckArmedAtMs, startAckRepliedNow, fireStartAckIfOwed, finalizeContext,
    teardownContext, preCallGatesContext,
  } = preflight.outputs;


  try {
    // Steps rewrite `phase` mid-body, so a mid-body 'done' never survives to this check; the monotone
    // close-out latch and spin-brake grace are read here instead, ending the turn after the iteration ran.
    while (
      turnCtx.state!.phase !== 'done' &&
      turnCtx.state!.loopCount < MAX_TOOL_LOOPS &&
      !turnCtx.state!.taskClosedWithTextThisTurn &&
      !(turnCtx.toolPhaseEndedBySpinBrake && turnCtx.spinBrakeGraceCalls < 0)
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
        counterparty, isA2ATurn, isAutoRouted, lastUserMessageContent, selection,
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

      // After the terminal spin brake ends the tool phase, tool calls return a note unexecuted; a small grace of
      // iterations lets the model converge to text before the turn concludes. Its text is never suppressed.
      if (turnCtx.toolPhaseEndedBySpinBrake && result.toolCalls.length > 0) {
        turnCtx.spinBrakeGraceCalls -= 1;
        if (turnCtx.spinBrakeGraceCalls < 0) {
          logger.warn('v2: spin brake grace exhausted, concluding the turn', { agentId, turnNumber }, agentId);
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
        maxToolLoops: MAX_TOOL_LOOPS,
        // Closures over driver state, passed as values so they keep the bindings they closed over.
        reArmIfStrandedNoAnswer, noteTerminalAnswer, deliverEngineUserAck,
        persistAndBroadcastSystemRow, startAckRepliedNow, stashContinuationIfHuman,
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
        identicalCallState, reminderLaneRefusedSigs,
        startAckArmed, startAckArmedAtMs, fireStartAckIfOwed,
        result, messageId, persistedContent, interAgentTurn, hasXmlFallbackTools,
        effectiveModelIdForPersist,
        staleTaskWindowMinutes: STALE_TASK_WINDOW_MINUTES,
        maxToolLoops: MAX_TOOL_LOOPS,
        engineStartAckAfterMs: ENGINE_START_ACK_AFTER_MS,
      });
      turnCtx.state = executed.state;
      if (executed.directive === 'exit') break;
      if (executed.directive === 'continue') continue;
      const { turnToolResults } = executed;

      turnCtx.state = advance(turnCtx.state!, { phase: 'postExecution' });
      const postExecution = runPostExecution(turnCtx.state!, {
        agentId, turnNumber, result, turnToolResults, broadcast,
      });
      turnCtx.state = postExecution.state;
      if (postExecution.directive === 'exit') break;
      if (postExecution.directive === 'continue') continue;

    }

    if (turnCtx.state!.loopCount >= MAX_TOOL_LOOPS) {
      // Soft tool-loop cap: auto-continue in a fresh turn instead of dead-stopping; the continuity brief and
      // tracker let the agent pick up where it left off.
      logger.warn('v2 hit MAX_TOOL_LOOPS, auto-continuing with fresh turn', {
        agentId, maxLoops: MAX_TOOL_LOOPS,
      }, agentId);
      turnCtx.toolLoopCapReached = true;   // teardown records the cut, not the model's intent
      // Invisible housekeeping (no owner chat row). Square the tracker before the continuation is scheduled, so
      // the next turn's close-out gate does not read the checkpoint as abandonment.
      try {
        noteEngineCheckpoint(agentId, 'tool-loop');
      } catch (checkpointErr) {
        logger.warn('v2: engine-checkpoint tracker note failed (non-fatal)', {
          agentId, error: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
        }, agentId);
      }
      stashContinuationIfHuman(); // carry the human conversation into the continuation
      parkJob(agentId, 'tool-loop', 'timer'); // the job travels on this wake; only the run it starts carries it
    }

    turnCtx.state = advance(turnCtx.state!, { phase: 'finalize' });
    turnCtx.state = (await runFinalize(turnCtx.state!, finalizeContext())).state;
  } catch (err) {
    // A module cannot express catch/finally for its caller, so the driver keeps the construct and the step the body.
    turnCtx.state = (await runTurnRecovery(turnCtx.state!, teardownContext(), err)).state;
  } finally {
    // Runs on every exit; the advance into teardown is here so validate() runs on it and the step never writes phase.
    turnCtx.state = advance(turnCtx.state!, { phase: TEARDOWN_PHASE });
    turnCtx.state = (await runTurnTeardown(turnCtx.state!, teardownContext())).state;
  }
}
