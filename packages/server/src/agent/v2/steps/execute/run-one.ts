// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THE EXECUTOR CHOKE POINT. One tool call, start to finish,
// moved byte-faithfully out of `loop.ts`'s `execute` span, where it was a 921-line
// closure inside the batch loop.
//
// WHY IT IS SPLIT AT ALL, and where: RULING P6-R1 caps every file in a step package
// at 400 lines, so the closure could not land whole. The seams are the ones it
// already had — measured before the cut rather than invented at it: 38 top-level
// statements, 8 top-level locals, and a maximum of FOUR live locals crossing any
// statement boundary in the whole closure. This file keeps the three sections that
// share those locals (the loop-break check and the once-guard that read
// `loopCheck`; the brake and the execution that produce `toolResult`; the terminal
// flags that read it) and calls the three that do not.
//
// THE PLAN'S OWN DUTY FOR THIS TRANCHE IS HERE, IN ONE PLACE: "once-guard + brake
// stay at the executor choke point". Both halves of each are in this file, on
// either side of the single `executeTool` call, and the contract test asserts them
// against the step.
//
// AND THE LANDMINE STAYS INTACT: `identicalCallSignature` (the brake's, below) and
// `canonicalToolSignature` (the thrash gate's and the cross-turn record's) are
// DISTINCT functions with different thresholds behind them. Global Constraints
// names unifying them as a documented landmine; a contract clause pins them apart.
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { classifyToolResult } from '../../../tool-outcome.js';
import { executeTool, toolResultOf } from '../../../tools/index.js';
import { RECENT_TOOL_WINDOW, loopDetector } from '../../classifiers/loop.js';
import { checkIdenticalCallRefusal, identicalCallSignature, isSignatureTerminal, recordIdenticalCallResult } from '../../identical-call-brake.js';
import { bumpLoopSignature, type AgentTurnState } from '../../state.js';
import { createLogger } from '../../../../logger.js';
import { FIRE_AND_FORGET_GEN_TOOLS, SEND_TO_PEOPLE_SET } from './tool-sets.js';
import { appendBookkeepingNudgeIfRelevant, appendVisibilityHintIfRelevant, userRequestedCloseWantsReply } from './result-notes.js';
import { runRefusalGates } from './refusal-gates.js';
import { recordDispatchAndHold } from './dispatch-bookkeeping.js';
import { recordToolResultEffects } from './post-result.js';
import type { ExecuteContext, ExecuteScratch, PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');

/** One call. The scratch carries what the whole RESPONSE shares — the running
 *  state, the loop-signature window, the once-guard's per-response map and the two
 *  terminal flags — because those are shared by every call in the batch, not by
 *  this one. Inside the loop they were the closure's captured locals; a module
 *  gets them by hand rather than by lexical accident. */
export async function runOneToolCall(tc: ToolCall, ctx: ExecuteContext, sc: ExecuteScratch): Promise<PendingToolResult> {
  const {
    agentId, turnCtx, triggerRow, hasUnansweredUser, counterparty, identicalCallState,
    startAckArmed, startAckArmedAtMs, engineStartAckDeliveredThisTurn, fireStartAckIfOwed,
    engineBlockEscapeHatch, engineStartAckAfterMs,
  } = ctx;
  const ENGINE_BLOCK_ESCAPE_HATCH = engineBlockEscapeHatch;
  const ENGINE_START_ACK_AFTER_MS = engineStartAckAfterMs;
  const onceGuardExecuted = sc.onceGuardExecuted;
  let { state, recentSigs } = sc;
  /** Every early return of the original closure goes through here, so the shared
   *  scratch is written back exactly once per call on every path. */
  const done = (r: PendingToolResult): PendingToolResult => {
    sc.state = state;
    sc.recentSigs = recentSigs;
    return r;
  };

  // ── Technique-acknowledgement gate (v2.7.6) ──
  // D6: the technique-acknowledgement HARD GATE is removed. It used to
  // refuse EVERY tool except a 7-tool allowlist until the agent wrote a
  // >=100-char paraphrase, a persistent, cross-turn GLOBAL tool lock that
  // (a) deadlocked with the close-out gate (their allowlists were disjoint,
  // so with both armed every tool was refused by one or the other), and
  // (b) survived turns via agents.config, so an unrelated "what's on my
  // calendar?" tomorrow was refused tool-by-tool with no expiry. A forced
  // paraphrase doesn't make a model comply (it emits boilerplate); the
  // inline injection of the technique text (see the technique-injection
  // block earlier in the turn) already puts the technique in front of the
  // model. technique_acknowledge remains an OPTIONAL affordance the agent
  // may call; it just no longer blocks anything. Cross-turn hydration and
  // the config persistence are dropped too (see initialPendingTechniqueAck
  // and the arming site).

  // On an A2A turn, send_to_agent / broadcast_to_group IS the agent's
  // single legitimate reply, it must never be thrash-gated. The gates'
  // premise ("stop verifying, respond to the USER with text") doesn't
  // apply: there is no user, and A2A-turn text is suppressed, so blocking
  // the reply leaves the agent with no valid exit and it loops (observed:
  // 12 send_to_agent calls ignoring the STOP). The hard turn-end after a
  // successful send (further below) keeps this single-shot, so exempting
  // it from the gates cannot itself cause a loop.
  const isA2AReplyTool =
    counterparty.kind === 'agent' && (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group');

  // Loop-break check
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
      content: loopCheck.refusalMessage! + '\n\n' + ENGINE_BLOCK_ESCAPE_HATCH,
      isError: true,
    });
  }

  // ── P3 once-per-response guard (non-idempotent duplicate) ──
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

  // The gates that can refuse this call before it runs. Inside the loop each of
  // them returned straight out of this closure; a module cannot do that, so the
  // refusal comes back as a value and is returned here instead.
  const gated = runRefusalGates(state, tc, ctx, isA2AReplyTool);
  state = gated.state;
  sc.state = state;
  if (gated.refusal) return done(gated.refusal);

  // The moment of dispatch: the broadcast, the send accounting, the gate flags,
  // and the destructive hold — whose refusal is honoured the same way.
  const dispatched = await recordDispatchAndHold(state, tc, ctx);
  state = dispatched.state;
  sc.state = state;
  if (dispatched.refusal) return done(dispatched.refusal);


  // First-tool hook for the work-gated start ack: real work is now
  // beginning. If the user has already been waiting past the ack
  // threshold (a slow model that thought before acting), speak now;
  // under the threshold the armed timer handles it.
  if (!turnCtx.anyToolStartedThisTurn) {
    turnCtx.anyToolStartedThisTurn = true;
    if (startAckArmed && !engineStartAckDeliveredThisTurn &&
        Date.now() - startAckArmedAtMs > ENGINE_START_ACK_AFTER_MS) {
      void fireStartAckIfOwed('first-tool');
    }
  }
  // Execute (with safety wrapper)
  let toolResult;
  // Identical-call brake, pre-execution half: an exact call that has
  // already failed REFUSE_AT times this turn is not executed again
  // (no side effects, no provider cost); the refusal text is the result.
  const brakeSig = identicalCallSignature(tc.name, tc.arguments);
  const refusal = turnCtx.toolPhaseEndedBySpinBrake
    ? '[Engine: the tool phase for this turn ended after an identical call was refused repeatedly. No further tools will run this turn. Answer in text with what you have.]'
    : checkIdenticalCallRefusal(identicalCallState, brakeSig);
  try {
    if (refusal) {
      // PHASE-4 T3: `cancelled` gets its producer on the TERMINAL arm only (the
      // phase is over, the call abandoned before an answer). The per-signature arm
      // is deliberately unmarked — argument in `agent/tool-outcome.ts`'s header.
      toolResult = toolResultOf(classifyToolResult({
        toolCallId: tc.id, name: tc.name, content: refusal, isError: true,
        ...(turnCtx.toolPhaseEndedBySpinBrake ? { errorCode: 'TIMEOUT' as const } : {}),
      }));
      if (!turnCtx.toolPhaseEndedBySpinBrake) {
        logger.warn('v2: identical-call brake refused re-execution', {
          agentId, tool: tc.name, sig: brakeSig.slice(0, 120),
        }, agentId);
        if (isSignatureTerminal(identicalCallState, brakeSig)) {
          // Refused, taught, and resubmitted unchanged three times:
          // nothing real is blocked (nothing was executing); stop
          // paying for attempts that cannot succeed. Text untouched.
          turnCtx.toolPhaseEndedBySpinBrake = true;
          logger.warn('v2: spin brake TERMINAL, tool phase ended for this turn (identical refused call resubmitted repeatedly)', {
            agentId, tool: tc.name, sig: brakeSig.slice(0, 200),
          }, agentId);
        }
      }
    } else {
      toolResult = toolResultOf(await executeTool(agentId, tc));
    }
    // P3 once-guard, post-result half: a SUCCESSFUL non-idempotent
    // execution registers its signature for the rest of this response.
    if ((FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name)) && toolResult.isError !== true) {
      const preview = typeof toolResult.content === 'string' ? toolResult.content.slice(0, 140) : 'executed';
      onceGuardExecuted.set(loopCheck.signature, preview);
    }
    // Identical-call brake, post-result half: count consecutive identical
    // failures; at WARN_AT append the corrective notice so the model
    // changes course; a success resets the signature.
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
    // v2.5.9, Just-in-time visibility hint. When a tool result
    // contains a URL or a shared-uploads file path, append a small
    // informational note reminding the agent that tool results are
    // only visible to itself, not to the user. Informational only, 
    // does NOT pressure the agent to share anything, just makes
    // sure it knows the user can't "see above". Skips sub-agents
    // (their results go to their parent agent, not the user).
    if (isPrimaryAgent(agentId)) {
      toolResult = appendVisibilityHintIfRelevant(toolResult);
    }
    // v2.7.22, soft nudge toward [no-reply] after bookkeeping tools.
    // C22: NEVER append this nudge on a turn serving a waiting human. On the
    // weak model, "Booked for Tuesday." + work_update(action="status") in one iteration
    // defers the text (G-SUP-2); the tool result then carries the "end with
    // [no-reply]" nudge; iteration 2 emits [no-reply] as instructed → the REG-3
    // clear discards the deferred genuine answer → the user gets silence. Gating
    // on !triggerRow && !hasUnansweredUser confines the nudge to engine/background
    // turns where silence is the correct outcome, stopping the conflict at the
    // source rather than hoping the reworded prompt holds on a weak model.
    if (!triggerRow && !hasUnansweredUser) {
      // When this close targets a still-unanswered USER-REQUESTED task, the
      // note must ask for the outcome + link, not offer [no-reply] (which is
      // what let the floor model close a user-requested doc task and go
      // silent). An already-answered cross-turn close falls back to the
      // generic note (silence is correct there).
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

  // Broadcast result
  try {
    broadcast({
      type: 'chat:tool_result',
      agentId,
      tool: tc.name,
      result: toolResult.content.slice(0, 500),
    });
  } catch { /* best effort */ }
  // FN-8: only a SUCCESSFUL complete_task is a lifecycle exit. When the
  // engine guard refuses the call (a persistent agent that shouldn't be
  // able to self-terminate emitted it), the tool returns an error and the
  // agent is NOT terminated, so the loop must keep running to let it act
  // on the guidance (report the block / use work_update(action="status")) rather
  // than end the turn silently. Mirrors the fire-and-forget check below.
  if (tc.name === 'complete_task' && !toolResult.isError) sc.calledCompleteTask = true;
  // Only a SUCCESSFUL generator call is terminal (the job started and
  // the asset arrives later via async delivery). An error result, 
  // e.g. the param validator kicking the call back for a missing or
  // out-of-range value, must NOT exit the loop, or the agent never
  // gets the turn it needs to re-call with corrected values.
  if (FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) && !toolResult.isError) sc.calledFireAndForgetGen = true;
  return done(toolResult);
}
