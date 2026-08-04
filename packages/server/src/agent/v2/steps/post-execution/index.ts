// ════════════════════════════════════════
// PHASE-6 T8 — THE `postExecution` STEP
//
// The three floors that run after this iteration's tools have executed and
// before the loop head decides whether to go round again: repetition detection,
// the permission-denial and no-results counters, and the spinning classifier's
// ask-before-breaking nudge. Relocated verbatim from `agent/v2/loop.ts`
// (`:8329`–`:8480` at `b391949`), bounds and wording unchanged.
//
// ── WHAT CHANGED IN THE MOVE, AND IT IS ONLY THIS ──
// The five control-flow statements. Inside the driver's `while` body they were
// two `continue`s and three `break`s; a module cannot `break` its caller's
// loop, so each one became the corresponding directive from `../step-outcome.js`
// and the driver honours it at the call site. That is the exit-request channel,
// and its rules are written where the type lives. Nothing else moved: the
// signature string, the thresholds (the classifier's own constants), the steer
// floors, the log lines and the two `chat:error` codes are the same bytes.
//
// The logger keeps the component name `v2-loop`. It is not a decoration — it is
// what the structured log sink records, and a relocation that renames the field
// its own operators grep by has changed behaviour it did not admit to.
//
// ── INPUTS, MEASURED RATHER THAN GUESSED ──
// The span's free identifiers at `b391949` are `state`, `agentId`, `turnNumber`,
// `result`, `turnToolResults`, and module-level imports. Nothing it declares is
// referenced after the boundary (0 crossings, measured over `runV2TurnBody`
// `:1005`–`:9808`), which is why this tranche is a relocation and needed no
// carrier field on the turn's bag under RULING P6-R3(1).
// ════════════════════════════════════════

import type { WsEvent } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import {
  advance,
  type AgentTurnState,
  type ModelCallResult,
  type ToolResultRecord,
  type TurnPhase,
} from '../../state.js';
import { enqueueSteer, steerFired, steerFireCount } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { progressClassifier, buildSpinningNudge } from '../../classifiers/progress.js';
import { agentCanSelfCompleteById } from '../../../tools/util.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances into before calling this step. */
export const POST_EXECUTION_PHASE: TurnPhase = 'postExecution';

/** Why this step asked the driver to leave the loop. */
export type PostExecutionExitReason = 'stuck-repeating' | 'no-results' | 'spinning-nudge-cap';

export interface PostExecutionContext {
  readonly agentId: string;
  readonly turnNumber: number;
  /** THIS iteration's model result. Read, never written. */
  readonly result: Pick<ModelCallResult, 'content' | 'toolCalls'>;
  /** THIS iteration's tool results, in execution order. Read, never written. */
  readonly turnToolResults: readonly ToolResultRecord[];
  readonly broadcast: (event: WsEvent) => void;
}

/**
 * The post-execution gates. `state` is reassigned exactly as it was inside the
 * loop body — every assignment is still a whole-state `advance`, so `validate()`
 * still runs on each one — and the returned outcome carries the last value.
 */
export function runPostExecution(state: AgentTurnState, ctx: PostExecutionContext): StepOutcome {
  const { agentId, turnNumber, result, turnToolResults, broadcast } = ctx;

  // ── Repetition detection (matches v1 runtime.ts:1622-1634) ──
  // If the model produces the SAME text + SAME tool calls as the last
  // iteration, it's stuck. Nudge once. If still repeating, break with
  // STUCK_REPEATING. The loopDetector catches duplicate-tool-call
  // patterns; this catches duplicate-FULL-response patterns including
  // text-only responses.
  const currentResponseSig =
    (result.content ?? '') +
    '|' +
    result.toolCalls
      .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
      .sort()
      .join(',');
  if (state.lastResponseSig === currentResponseSig) {
    if (!steerFired(state.steerQueue, 'repetition')) {
      logger.warn('v2: agent repeating itself, nudging on next iteration', {
        loopCount: state.loopCount,
      }, agentId);
      state = advance(state, {
        steerQueue: enqueueSteer(state.steerQueue, {
          floor: 'repetition', atLoop: state.loopCount,
          // FN-8: complete_task is not available to every agent, so don't
          // name it here where the filtered tool list isn't in scope. Point
          // at work_update(action="status") (universally available) instead.
          content:
            '[System: You are repeating yourself, your last two responses were identical. ' +
            'Try a different approach. If the task is complete, mark it done (e.g. work_update(action="status")) and stop. ' +
            'If you need help, explain what you are stuck on.]',
        }),
      });
      return continueLoop(state);
    }
    logger.warn('v2: breaking tool loop, agent still repeating after nudge', {
      loopCount: state.loopCount,
    }, agentId);
    broadcast({
      type: 'chat:error',
      agentId,
      error: 'Agent got stuck repeating itself. Send a follow-up to redirect it.',
      code: 'STUCK_REPEATING',
      severity: 'warning',
      retryable: true,
    });
    return requestExit(state, 'stuck-repeating' satisfies PostExecutionExitReason);
  }
  state = advance(state, { lastResponseSig: currentResponseSig });

  // Permission denial counter
  const allBlocked = turnToolResults.every((tr) => tr.isError && tr.content.includes('[BLOCKED]'));
  if (allBlocked && turnToolResults.length > 0) {
    state = advance(state, {
      consecutivePermissionDenials: state.consecutivePermissionDenials + turnToolResults.length,
    });
  } else if (turnToolResults.length > 0) {
    state = advance(state, { consecutivePermissionDenials: 0 });
  }

  // ── No-results detection (matches v1 runtime.ts:1658-1678) ──
  // When search tools (vault_search, history_search, web_search, etc.)
  // repeatedly return "No results found" / "not in memory", the agent
  // is probably looking for something that doesn't exist. Nudge once,
  // then break with a NO_RESULTS error if it persists.
  const allNoResults =
    turnToolResults.length > 0 &&
    turnToolResults.every(
      (tr) =>
        tr.content.includes('No results found') ||
        tr.content.includes('not in memory'),
    );
  if (allNoResults && turnToolResults.every((tr) => !tr.isError)) {
    const nextNoResultsCount = state.consecutiveNoResultTools + 1;
    if (nextNoResultsCount >= 2) {
      if (!steerFired(state.steerQueue, 'no-results')) {
        logger.warn('v2: consecutive empty search results, nudging on next iteration', {
          loopCount: state.loopCount,
          consecutiveNoResultTools: nextNoResultsCount,
        }, agentId);
        state = advance(state, {
          steerQueue: enqueueSteer(state.steerQueue, {
            floor: 'no-results', atLoop: state.loopCount,
            content:
              '[System: Multiple searches returned no results. The information may not exist in memory. ' +
              'Try responding based on what you already know, or ask the user for clarification.]',
          }),
          consecutiveNoResultTools: 0,
        });
        return continueLoop(state);
      }
      // Already nudged, break with NO_RESULTS error
      logger.warn('v2: breaking tool loop, still no results after nudge', {
        loopCount: state.loopCount,
      }, agentId);
      broadcast({
        type: 'chat:error',
        agentId,
        error: 'Agent stopped, searches kept coming up empty. The info may not be in memory yet.',
        code: 'NO_RESULTS',
        severity: 'warning',
        retryable: true,
      });
      return requestExit(state, 'no-results' satisfies PostExecutionExitReason);
    }
    state = advance(state, { consecutiveNoResultTools: nextNoResultsCount });
  } else if (turnToolResults.length > 0) {
    state = advance(state, { consecutiveNoResultTools: 0 });
  }

  // Spinning detection (Part XVIII §F, engine asks model before breaking)
  const progressDecision = progressClassifier({
    toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
    // PHASE-6 T8: these two zeros are LEFT AS THEY ARE, with the measurement
    // that decided it, because the comment they carried ("Phase 4 will track
    // this") is now false and a false comment is a live instruction to the next
    // editor. `consecutiveSmallDeltas` has no producer anywhere in the tree —
    // `git grep consecutiveSmallDeltas -- packages/server/src` finds only these
    // two literals and the classifier's own threshold — so there is no state to
    // wire it to. `consecutiveNoResultTools` DOES have real state, three
    // statements above, and wiring it would be dead by construction: the
    // no-results floor either resets that counter to 0 when it nudges or exits
    // the loop when it reaches 2, and the classifier's NO_RESULTS_THRESHOLD is
    // 3, which the counter can therefore never reach. Wiring it would add a
    // second, unreachable mechanism on a signal that already has one.
    consecutiveSmallDeltas: 0,
    consecutivePermissionDenials: state.consecutivePermissionDenials,
    consecutiveNoResultTools: 0,
    // PHASE-4 T3: the counter IS the latch, and it is now read off the queue's own
    // entries rather than a state field only this floor ever wrote.
    spinningNudgeCount: steerFireCount(state.steerQueue, 'spinning'),
    loopCount: state.loopCount,
  });
  if (!progressDecision.progressing) {
    // If we've already nudged 3 times and the agent kept going, break.
    if (progressDecision.signals?.includes('nudge cap')) {
      logger.warn('v2: spinning nudge cap reached, breaking', { agentId }, agentId);
      return requestExit(state, 'spinning-nudge-cap' satisfies PostExecutionExitReason);
    }
    // Otherwise inject a nudge and continue once.
    // FN-8: the nudge only names complete_task for agents that can actually
    // self-complete; a persistent agent gets "explain the block in your
    // reply" wording instead of being pointed at a tool the guard refuses.
    const nudgeText = buildSpinningNudge({
      toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
      consecutiveSmallDeltas: 0,
      consecutivePermissionDenials: state.consecutivePermissionDenials,
      consecutiveNoResultTools: 0,
      spinningNudgeCount: steerFireCount(state.steerQueue, 'spinning'),
      loopCount: state.loopCount,
    }, agentCanSelfCompleteById(agentId));
    // RC-19: via persistEngineSteer so the "you seem stuck, here is what to do"
    // question reaches the model (the steer queue) AND keeps its dashboard row. The
    // comment above ("engine asks model before breaking") only works if the model
    // actually hears the question; the bare role='system' row the assembler strips
    // meant it never did. The ignored-nudge count is the queue's own fire count, keyed
    // per loop: this floor is deliberately NOT one-shot (cap MAX_SPINNING_NUDGES).
    state = persistEngineSteer(
      state,
      { agentId, content: nudgeText, turnNumber, floor: 'spinning', key: `loop-${state.loopCount}`, atLoop: state.loopCount },
      { broadcast },
    );
  }

  // Loop continues, model will see tool results and respond
  return proceed(state);
}
