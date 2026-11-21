// The executor choke point: one tool call, start to finish. The once-guard and the repeat rule
// sit here, on either side of the single `executeTool` call.

import type { ToolCall } from '@dojo/shared';
import { refusalForTerminated } from '../../../ended-mid-run.js';
import { broadcast } from '../../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { classifyToolResult } from '../../../tool-outcome.js';
import { executeTool, toolResultOf } from '../../../tools/index.js';
import { LIFT_TOOL, fingerprint, identicalCallSignature, isSignatureTerminal, noteRepeatResult, repeatStopRefusal } from '../../repeat-rule.js';
import { markToolsLoaded } from '../../../../tools/tool-session-set.js';
import { isTrackerFamilyCall } from '../../../../tools/work-verbs.js';
import { createLogger } from '../../../../logger.js';
import { FIRE_AND_FORGET_GEN_TOOLS, SEND_TO_PEOPLE_SET } from './tool-sets.js';
import { wordsStepRefusal } from './media-words-step.js';
import { appendBookkeepingNudgeIfRelevant, appendVisibilityHintIfRelevant, userRequestedCloseWantsReply } from './result-notes.js';
import { runRefusalGates } from './refusal-gates.js';
import { recordDispatchAndHold } from './dispatch-bookkeeping.js';
import { recordToolResultEffects } from './post-result.js';
import { runUnlessStopped } from './stop-race.js';
import type { ExecuteContext, ExecuteScratch, PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');

/** One call; the scratch carries what every call in the response shares (state, signatures, flags). */
export async function runOneToolCall(tc: ToolCall, ctx: ExecuteContext, sc: ExecuteScratch): Promise<PendingToolResult> {
  const {
    agentId, turnCtx, triggerRow, hasUnansweredUser, counterparty,
    startAckArmed, startAckArmedAtMs, engineStartAckDeliveredThisTurn, fireStartAckIfOwed,
    engineStartAckAfterMs,
  } = ctx;
  const ENGINE_START_ACK_AFTER_MS = engineStartAckAfterMs;
  const onceGuardExecuted = sc.onceGuardExecuted;
  let { state } = sc;
  /** Every return goes through here so the shared scratch is written back exactly once per call. */
  const done = (r: PendingToolResult): PendingToolResult => {
    sc.state = state;
    return r;
  };

  // A terminated agent runs nothing (see `refusalForTerminated`).
  const ended = refusalForTerminated(tc, agentId, sc.calledCompleteTask);
  if (ended) return done(ended);


  // On an A2A turn the send is the only reply (its text is suppressed), so it is exempt from the repeat
  // rule; the turn ends after an executed send (`index.ts`), so the exemption cannot loop.
  const isA2AReplyTool =
    counterparty.kind === 'agent' && (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group');
  const callSig = identicalCallSignature(tc.name, tc.arguments);

  // Once-per-response guard, pre-execution half.
  const isNonIdempotent = FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name);
  if (isNonIdempotent && onceGuardExecuted.has(callSig)) {
    return done({
      toolCallId: tc.id,
      name: tc.name,
      content:
        `Already executed in this response: an identical ${tc.name} call ran moments ago and its side effect is real ` +
        `(${onceGuardExecuted.get(callSig)}). It was NOT run again; re-running would duplicate the ` +
        `send/generation. Reference the first result. If you genuinely intend a second identical ${tc.name}, ` +
        `issue it in your NEXT response.`,
      isError: true,
    });
  }

  // The gates that can refuse this call before it runs; a refusal is returned as the call's result.
  const gated = runRefusalGates(state, tc, ctx);
  state = gated.state;
  sc.state = state;
  if (gated.refusal) return done(gated.refusal);

  // The moment of dispatch: broadcast, send accounting, gate flags and the destructive hold.
  const dispatched = await recordDispatchAndHold(state, tc, ctx);
  state = dispatched.state;
  sc.state = state;
  if (dispatched.refusal) return done(dispatched.refusal);


  // First tool: real work begins. If the user has waited past the start-ack threshold, ack now;
  // under it the armed timer handles it.
  if (!turnCtx.anyToolStartedThisTurn) {
    turnCtx.anyToolStartedThisTurn = true;
    if (startAckArmed && !engineStartAckDeliveredThisTurn &&
        Date.now() - startAckArmedAtMs > ENGINE_START_ACK_AFTER_MS) {
      void fireStartAckIfOwed('first-tool');
    }
  }
  let toolResult;
  // Repeat rule, pre-execution half: a stopped call is not run again until the agent lifts the stop.
  // The main agent can lift even a stop that ended the tool phase: its lift runs and the phase reopens.
  if (turnCtx.toolPhaseEndedByRepeats && tc.name === LIFT_TOOL && isPrimaryAgent(agentId)) turnCtx.toolPhaseEndedByRepeats = false;
  const refusal = turnCtx.toolPhaseEndedByRepeats
    ? '[Engine: the tool phase for this turn ended after an identical call was refused repeatedly. No further tools will run this turn. Answer in text with what you have.]'
    : wordsStepRefusal(turnCtx, tc.name)
      ?? (isA2AReplyTool ? null : repeatStopRefusal(agentId, turnCtx, tc.name, tc.arguments));
  try {
    if (refusal) {
      // Only the repeat rule's terminal arm is marked TIMEOUT; the per-signature arm is unmarked on purpose.
      toolResult = toolResultOf(classifyToolResult({
        toolCallId: tc.id, name: tc.name, content: refusal, isError: true,
        ...(turnCtx.toolPhaseEndedByRepeats ? { errorCode: 'TIMEOUT' as const } : {}),
      }));
      if (!turnCtx.toolPhaseEndedByRepeats) {
        logger.warn('v2: repeat rule refused re-execution', {
          agentId, tool: tc.name, sig: callSig.slice(0, 120),
        }, agentId);
        if (isSignatureTerminal(agentId, turnCtx, tc.name, tc.arguments)) {
          // Resubmitted unchanged past the terminal count: nothing real is blocked, stop paying for it.
          turnCtx.toolPhaseEndedByRepeats = true;
          logger.warn('v2: repeat rule ended the tool phase for this turn (identical refused call resubmitted repeatedly)', {
            agentId, tool: tc.name, sig: callSig.slice(0, 200),
          }, agentId);
        }
      }
    } else {
      const raced = await runUnlessStopped(agentId, tc, () => executeTool(agentId, tc));
      if (raced.stopped) return done(raced.result); // the owner's Stop cut it (`stop-race.ts`)
      toolResult = toolResultOf(raced.outcome);
      // Count sends that succeeded: only those end an A2A turn and mark the turn as sent (`index.ts`).
      if ((tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') && toolResult.isError !== true) sc.a2aSendsExecuted += 1;
    }
    // Once-guard, post-result half: a successful non-idempotent call registers its signature.
    if ((FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name)) && toolResult.isError !== true) {
      const preview = typeof toolResult.content === 'string' ? toolResult.content.slice(0, 140) : 'executed';
      onceGuardExecuted.set(callSig, preview);
    }
    // Repeat rule, post-result half: count an executed call's result, content blocks included; at a stop the notice
    // offers the lift tool, which joins the session's tools then.
    if (!refusal && !isA2AReplyTool) {
      const blocks = (tc as unknown as Record<string, unknown>).__contentBlocks;
      const work = !toolResult.isError && tc.name !== LIFT_TOOL && !isTrackerFamilyCall(tc.name, tc.arguments);
      const repeatNotice = noteRepeatResult(agentId, turnCtx, tc.name, tc.arguments, fingerprint(toolResult.content, blocks), work);
      if (repeatNotice && typeof toolResult.content === 'string') {
        toolResult = { ...toolResult, content: toolResult.content + repeatNotice };
        markToolsLoaded(agentId, [LIFT_TOOL]);
      }
    }
    // Transfer content blocks from the tool call (set by file_read for images/PDFs)
    const contentBlocks = (tc as unknown as Record<string, unknown>).__contentBlocks as
      | Array<{ type: string; [key: string]: unknown }>
      | undefined;
    if (contentBlocks) {
      (toolResult as { contentBlocks?: unknown }).contentBlocks = contentBlocks;
    }
    // Visibility note for the primary only: sub-agents' results go to their parent, not the user.
    if (isPrimaryAgent(agentId)) {
      toolResult = appendVisibilityHintIfRelevant(toolResult);
    }
    // The [no-reply] nudge only on engine/background turns: on a turn serving a waiting human it can
    // lead the model to [no-reply] and discard a deferred genuine answer.
    if (!triggerRow && !hasUnansweredUser) {
      // A close of a still-unanswered user-requested task gets the reply-now note (`result-notes.ts`).
      const userRequestedClose = userRequestedCloseWantsReply(
        tc.name, (tc.arguments ?? {}) as Record<string, unknown>, agentId,
      );
      toolResult = appendBookkeepingNudgeIfRelevant(toolResult, userRequestedClose);
    }
  } catch (toolErr) {
    const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
    logger.error('v2: tool crashed', { tool: tc.name, error: errMsg }, agentId);
    toolResult = {
      toolCallId: tc.id,
      name: tc.name,
      content: `Error: Tool "${tc.name}" crashed: ${errMsg}. Try a different approach or skip this step.`,
      isError: true,
    };
  }

  // Everything the engine records once a result exists.
  const recorded = await recordToolResultEffects(state, tc, toolResult, ctx);
  state = recorded.state;
  sc.state = state;
  toolResult = recorded.toolResult;

  try {
    broadcast({
      type: 'chat:tool_result',
      agentId,
      tool: tc.name,
      result: toolResult.content.slice(0, 500),
    });
  } catch { /* best effort */ }
  // Only a successful complete_task ends the turn: a refused one leaves the agent alive, and it needs
  // the loop to act on the guidance.
  if (tc.name === 'complete_task' && !toolResult.isError) sc.calledCompleteTask = true;
  // Only a successful generator ends the turn (after any words step, `media-words-step.ts`); an error
  // result leaves the turn running so the agent can re-call with corrected values.
  if (FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) && !toolResult.isError) sc.calledFireAndForgetGen = true;
  return done(toolResult);
}
