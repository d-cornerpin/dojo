// The executor choke point: one tool call, start to finish. The once-guard and the identical-call brake
// sit here, on either side of the single `executeTool` call. `identicalCallSignature` (brake) and
// `canonicalToolSignature` (thrash gate, cross-turn record) are distinct on purpose: never unify them.

import type { ToolCall } from '@dojo/shared';
import { refusalForTerminated } from '../../../ended-mid-run.js';
import { broadcast } from '../../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { classifyToolResult } from '../../../tool-outcome.js';
import { executeTool, toolResultOf } from '../../../tools/index.js';
import { RECENT_TOOL_WINDOW, loopDetector } from '../../classifiers/loop.js';
import { checkIdenticalCallRefusal, identicalCallSignature, isSignatureTerminal, recordIdenticalCallResult } from '../../identical-call-brake.js';
import { bumpLoopSignature } from '../../state.js';
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
    agentId, turnCtx, triggerRow, hasUnansweredUser, counterparty, identicalCallState,
    startAckArmed, startAckArmedAtMs, engineStartAckDeliveredThisTurn, fireStartAckIfOwed,
    engineStartAckAfterMs,
  } = ctx;
  const ENGINE_START_ACK_AFTER_MS = engineStartAckAfterMs;
  const onceGuardExecuted = sc.onceGuardExecuted;
  let { state, recentSigs } = sc;
  /** Every return goes through here so the shared scratch is written back exactly once per call. */
  const done = (r: PendingToolResult): PendingToolResult => {
    sc.state = state;
    sc.recentSigs = recentSigs;
    return r;
  };

  // A terminated agent runs nothing (see `refusalForTerminated`).
  const ended = refusalForTerminated(tc, agentId, sc.calledCompleteTask);
  if (ended) return done(ended);


  // On an A2A turn the send is the only reply (its text is suppressed), so it is exempt from the loop and
  // thrash gates; the turn ends after an executed send (`index.ts`), so the exemption cannot loop.
  const isA2AReplyTool =
    counterparty.kind === 'agent' && (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group');

  const loopCheck = loopDetector(tc, recentSigs);
  recentSigs = bumpLoopSignature(recentSigs, loopCheck.signature, RECENT_TOOL_WINDOW);
  if (loopCheck.decision === 'block' && !isA2AReplyTool) {
    try {
      broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
      broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: loopCheck.refusalMessage!.slice(0, 500) });
    } catch { /* best effort */ }
    return done({
      toolCallId: tc.id,
      name: tc.name,
      content: loopCheck.refusalMessage!,
      isError: true,
    });
  }

  // Once-per-response guard, pre-execution half.
  const isNonIdempotent = FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name);
  if (isNonIdempotent && onceGuardExecuted.has(loopCheck.signature)) {
    return done({
      toolCallId: tc.id,
      name: tc.name,
      content:
        `Already executed in this response: an identical ${tc.name} call ran moments ago and its side effect is real ` +
        `(${onceGuardExecuted.get(loopCheck.signature)}). It was NOT run again; re-running would duplicate the ` +
        `send/generation. Reference the first result. If you genuinely intend a second identical ${tc.name}, ` +
        `issue it in your NEXT response.`,
      isError: true,
    });
  }

  // The gates that can refuse this call before it runs; a refusal is returned as the call's result.
  const gated = runRefusalGates(state, tc, ctx, isA2AReplyTool);
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
  // Identical-call brake, pre-execution half: an exact call that failed REFUSE_AT times is not run again.
  const brakeSig = identicalCallSignature(tc.name, tc.arguments);
  const refusal = turnCtx.toolPhaseEndedBySpinBrake
    ? '[Engine: the tool phase for this turn ended after an identical call was refused repeatedly. No further tools will run this turn. Answer in text with what you have.]'
    : wordsStepRefusal(turnCtx, tc.name) ?? checkIdenticalCallRefusal(identicalCallState, brakeSig);
  try {
    if (refusal) {
      // Only the spin-brake terminal arm is marked TIMEOUT; the per-signature arm is unmarked on purpose.
      toolResult = toolResultOf(classifyToolResult({
        toolCallId: tc.id, name: tc.name, content: refusal, isError: true,
        ...(turnCtx.toolPhaseEndedBySpinBrake ? { errorCode: 'TIMEOUT' as const } : {}),
      }));
      if (!turnCtx.toolPhaseEndedBySpinBrake) {
        logger.warn('v2: identical-call brake refused re-execution', {
          agentId, tool: tc.name, sig: brakeSig.slice(0, 120),
        }, agentId);
        if (isSignatureTerminal(identicalCallState, brakeSig)) {
          // Resubmitted unchanged past the terminal count: nothing real is blocked, stop paying for it.
          turnCtx.toolPhaseEndedBySpinBrake = true;
          logger.warn('v2: spin brake TERMINAL, tool phase ended for this turn (identical refused call resubmitted repeatedly)', {
            agentId, tool: tc.name, sig: brakeSig.slice(0, 200),
          }, agentId);
        }
      }
    } else {
      // Count executed sends: the A2A turn ends on an executed send only (`index.ts`).
      if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') sc.a2aSendsExecuted += 1;
      const raced = await runUnlessStopped(agentId, tc, () => executeTool(agentId, tc));
      if (raced.stopped) return done(raced.result); // the owner's Stop cut it (`stop-race.ts`)
      toolResult = toolResultOf(raced.outcome);
    }
    // Once-guard, post-result half: a successful non-idempotent call registers its signature.
    if ((FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name)) && toolResult.isError !== true) {
      const preview = typeof toolResult.content === 'string' ? toolResult.content.slice(0, 140) : 'executed';
      onceGuardExecuted.set(loopCheck.signature, preview);
    }
    // Brake, post-result half: count identical failures, append the notice at WARN_AT; success resets.
    {
      const errText = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content ?? '');
      const brakeNotice = recordIdenticalCallResult(identicalCallState, brakeSig, toolResult.isError === true, errText);
      if (brakeNotice && typeof toolResult.content === 'string') {
        toolResult = { ...toolResult, content: toolResult.content + brakeNotice };
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
