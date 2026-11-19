// The gates that can refuse a call before it runs: the reminder-delivery lane, the main agent's warn-once
// hurdle and the compile gate, plus the hoarding advisory, which refuses nothing. A refusal comes back as
// `{ state, refusal }` and `run-one.ts` returns it as the call's result.

import { broadcast } from '../../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { wouldWreck } from '../../../destructive-gate.js';
import { identicalCallSignature } from '../../identical-call-brake.js';
import { isOwnerIMessageRecipient } from '../../../../services/safe-senders.js';
import { toolOpKey } from '../../../../tools/work-verbs.js';
import { LOADING_GATE_THRESHOLD, isStructuringTool } from '../../classifiers/hoarding.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { compileOwedGateDecision } from '../../compile-owed-gate.js';
import { advance, type AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { replyChannelWords } from '../../turn-address.js';
import { liveAddress } from '../../turn-address-live.js';
import { createLogger } from '../../../../logger.js';
import { redactDeclaredSecretArgs } from '../../../../credentials/secret-fields.js';
import type { ToolCall } from '@dojo/shared';
import type { ExecuteContext, PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');

/** Hurdle, never a block: a main-agent call that could wreck the Mac or the Dojo is warned once; the identical repeat runs. */
function hurdle(agentId: string, tc: ToolCall, refusedOnceSigs: Set<string>): PendingToolResult | null {
  const loss = isPrimaryAgent(agentId) ? wouldWreck(tc.name, (tc.arguments ?? {}) as Record<string, unknown>) : null;
  const sig = `hurdle|${identicalCallSignature(tc.name, tc.arguments)}`;
  if (!loss || refusedOnceSigs.has(sig)) return null;
  refusedOnceSigs.add(sig);
  return {
    toolCallId: tc.id,
    name: tc.name,
    content: `[Engine warning, nothing ran] This call would ${loss}. If that is what you mean to do, repeat the exact same call in this same turn and it will run.`,
    isError: true,
  };
}

/** `refusal` non-null means the call does NOT run and this is its result. */
export function runRefusalGates(
  state: AgentTurnState,
  tc: ToolCall,
  ctx: ExecuteContext,
): { state: AgentTurnState; refusal: PendingToolResult | null } {
  const { agentId, turnNumber, turnCtx, refusedOnceSigs } = ctx;

  const warning = hurdle(agentId, tc, refusedOnceSigs);
  if (warning) return { state, refusal: warning };

  // Reminder lane: a turn serving a kind='reminder' task delivers to the owner, so a send naming anyone
  // else is refused once (an identical re-send goes through). The owner test is `isOwnerIMessageRecipient`.
  // A send to the owner is never refused: the channel choice is the agent's.
  if ((tc.name === 'imessage_send' || tc.name === 'sms_send')) {
    const served = turnCtx.servedWork;
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(a.recipient ?? a.to ?? '').trim();
    const recipIsOwner = recip ? isOwnerIMessageRecipient(recip) : false;
    if (served?.taskKind === 'reminder' && recip && !recipIsOwner) {
      const laneSig = `${tc.name}|${recip}`;
      if (!refusedOnceSigs.has(laneSig)) {
        refusedOnceSigs.add(laneSig);
        return { state, refusal: {
          toolCallId: tc.id,
          name: tc.name,
          content:
            `Refused once: this turn is delivering the owner's reminder, and "${recip}" is not the owner. ` +
            `Reminders are delivered to the owner: write it as your reply (the engine delivers it to the owner by ${replyChannelWords(liveAddress(turnCtx.address))}), ` +
            `or send to the owner's own address. If the owner explicitly asked for this reminder to be delivered to "${recip}", ` +
            `repeat the exact same send and it will go through.`,
          isError: true,
        } };
      }
    }
  }

  // Hoarding advisory, never a block: after many unscaffolded heavy loads with context near compaction,
  // nudge once to write sources down before compaction summarizes them. Skip the call that structures.
  if (
    !state.structuringToolCalledThisTurn &&
    !steerFired(state.steerQueue, 'hoarding-advisory') &&
    !isStructuringTool(tc.name, tc.arguments) &&
    state.heavyLoadsThisTurn >= LOADING_GATE_THRESHOLD &&
    state.lastContextRatio >= 0.85
  ) {
    const nudge = (
      `[Engine hint: you've pulled ${state.heavyLoadsThisTurn} sources into context this turn and ` +
      `memory is about ${(state.lastContextRatio * 100).toFixed(0)}% full. Compaction may soon summarize ` +
      `the older ones, and a deliverable written from a summary rather than the source can drift. If there ` +
      `are facts here you'll rely on, jot them into scratchpad_set / a file_write / a tracker note now so ` +
      `they survive. This is advice, not a block, keep going.]`
    );
    // Sent as an engine steer so the model sees it (the assembler strips a role='system' row); the
    // queue's `hoarding-advisory` latch keeps it to once per turn.
    state = persistEngineSteer(
      state,
      { agentId, content: nudge, turnNumber, floor: 'hoarding-advisory', atLoop: state.loopCount },
      { broadcast },
    );
    logger.info('v2: hoarding advisory nudged (non-blocking)', {
      agentId, tool: tc.name, heavyLoads: state.heavyLoadsThisTurn, ratio: state.lastContextRatio,
    }, agentId);
    // Fall through: the tool executes normally. No refusal.
  }
  // Compile gate: while the owner is owed a compiled reply and every piece is back, refuse calls outside
  // a closed set. The decision re-reads `compile_pending`, so any way out of the duty takes the gate down.
  const compileOwed = compileOwedGateDecision(
    state.compileOwedAskIds, state.compileGateSatisfied, toolOpKey(tc.name, tc.arguments),
    state.compileOrderReachedModel,
  );
  if (compileOwed.live.length !== state.compileOwedAskIds.length) {
    state = advance(state, { compileOwedAskIds: compileOwed.live });
    logger.info('v2: compile gate dropped asks whose compile is no longer owed', {
      agentId, remaining: compileOwed.live.length,
    }, agentId);
  }
  // Armed and owed, but the assembly could not confirm the pieces reached the model: the refusal would
  // be false, so the call runs, logged at WARN as an engine defect.
  if (compileOwed.standDownUnverified) {
    logger.warn('v2: compile gate stood down — the compile order did not reach the model whole', {
      agentId, tool: tc.name, owedCount: compileOwed.live.length,
      sample: compileOwed.live.slice(0, 3).map((id) => id.slice(0, 8)),
    }, agentId);
  }
  if (compileOwed.refuse) {
    const askListShort = compileOwed.live.slice(0, 3).map((id) => id.slice(0, 8)).join(', ');
    const refusalText = (
      `Refused: engine compile gate. The person who asked is owed the compiled reply for the work you delegated ` +
      `(ask ${askListShort}${compileOwed.live.length > 3 ? '...' : ''}) — every piece is back and the ` +
      `platform has already brought you to it. Compose it — the pieces are in the steer, quoted verbatim. ` +
      `Write the combined reply now, as this turn's message; do not look anything up first. ` +
      `Only two calls run while this is owed: ONE send_to_agent (if a piece is a hand-off rather than a ` +
      `deliverable, ask that agent for the result directly), and a tracker status call. ` +
      `"${tc.name}" works normally again as soon as the reply lands.`
    );
    try {
      broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: redactDeclaredSecretArgs(tc.name, tc.arguments) ?? {} });
      broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusalText.slice(0, 500) });
    } catch { /* best effort */ }
    logger.info('v2: compile gate refused call', {
      agentId, tool: tc.name, owedCount: compileOwed.live.length,
    }, agentId);
    return { state, refusal: {
      toolCallId: tc.id,
      name: tc.name,
      content: refusalText,
      isError: true,
    } };
  }
  return { state, refusal: null };
}
