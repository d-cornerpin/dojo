// The gates that can refuse a call before it runs: the reminder-delivery lane, the main agent's warn-once
// hurdle, the A2A re-send cap, the thrash gate and the compile gate, plus the hoarding advisory, which
// refuses nothing. A refusal comes back as `{ state, refusal }` and `run-one.ts` returns it as the call's result.

import { broadcast } from '../../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { wouldWreck } from '../../../destructive-gate.js';
import { identicalCallSignature } from '../../identical-call-brake.js';
import { isOwnerIMessageRecipient } from '../../../../services/safe-senders.js';
import { toolOpKey } from '../../../../tools/work-verbs.js';
import { LOADING_GATE_THRESHOLD, isStructuringTool } from '../../classifiers/hoarding.js';
import { canonicalToolSignature } from '../../classifiers/loop.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { compileOwedGateDecision } from '../../compile-owed-gate.js';
import { advance, type AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { replyChannelWords, userWords } from '../../turn-address.js';
import { liveAddress } from '../../turn-address-live.js';
import { createLogger } from '../../../../logger.js';
import { A2A_SEND_CAP_PER_RECIPIENT } from './tool-sets.js';
import type { ToolCall } from '@dojo/shared';
import type { ExecuteContext, PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');



/** `refusal` non-null means the call does NOT run and this is its result. */
export function runRefusalGates(
  state: AgentTurnState,
  tc: ToolCall,
  ctx: ExecuteContext,
  isA2AReplyTool: boolean,
): { state: AgentTurnState; refusal: PendingToolResult | null } {
  const { agentId, turnNumber, turnCtx, counterparty, refusedOnceSigs } = ctx;

  // Hurdle, never a block: a main-agent call that could wreck the Mac or the Dojo is warned once per turn;
  // the identical call repeated runs. `refusedOnceSigs` is the turn's one record of calls warned once.
  const loss = isPrimaryAgent(agentId) ? wouldWreck(tc.name, (tc.arguments ?? {}) as Record<string, unknown>) : null;
  const hurdleSig = `hurdle|${identicalCallSignature(tc.name, tc.arguments)}`;
  if (loss && !refusedOnceSigs.has(hurdleSig)) {
    refusedOnceSigs.add(hurdleSig);
    return { state, refusal: {
      toolCallId: tc.id,
      name: tc.name,
      content: `[Engine warning, nothing ran] This call would ${loss}. If that is what you mean to do, repeat the exact same call and it will run.`,
      isError: true,
    } };
  }



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

  // A2A re-send cap per recipient per turn: replies are async, and a model re-sending reworded asks
  // defeats the signature dedup. The cap sits well above any genuine multi-send.
  if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') {
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(
      a.to_agent ?? a.agent ?? a.to ?? a.recipient ?? a.group ?? a.group_id ?? '',
    ).trim().toLowerCase();
    if (recip && (state.sendsPerAgentThisTurn[recip] ?? 0) >= A2A_SEND_CAP_PER_RECIPIENT) {
      const refusal =
        `Refused: you have already sent "${recip}" ${A2A_SEND_CAP_PER_RECIPIENT} messages this turn. ` +
        `Inter-agent replies are asynchronous: "${recip}" answers on its own next turn, and its reply arrives then. ` +
        `A re-sent or reworded ask does not get a faster reply.`;
      try {
        broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
        broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
      } catch { /* best effort */ }
      logger.info('v2: A2A re-send cap, recipient over per-turn cap', {
        agentId, recipient: recip, cap: A2A_SEND_CAP_PER_RECIPIENT,
      }, agentId);
      return { state, refusal: { toolCallId: tc.id, name: tc.name, content: refusal, isError: true } };
    }
  }

  // Thrash gate: refuses only the exact (tool, args) signature the detector caught. The message may say the
  // result is already here only because `canonicalToolSignature` carries every argument (thrash-gate.ts).
  if (state.thrashGatedSignatures.length > 0 && !isA2AReplyTool) {
    const thisSig = canonicalToolSignature(tc.name, tc.arguments);
    if (state.thrashGatedSignatures.includes(thisSig)) {
      const argsPart = thisSig.includes(':') ? thisSig.slice(thisSig.indexOf(':') + 1) : '{}';
      const refusal =
        `BLOCKED by engine thrash gate, \`${tc.name}(${argsPart})\` is refused. ` +
        `You've already called this tool with these exact arguments; the first call's result is in this conversation.\n\n` +
        `Pick a different next action:\n` +
        `  (a) Continue the work from that result: the next item or step, or \`${tc.name}\` with DIFFERENT args (a different id / target) if you have more to read.\n` +
        `  (b) Call work_update(action="status", status='blocked', notes='<specific obstacle>') if you genuinely cannot proceed.\n` +
        `  (c) Send ${userWords(turnCtx.address)} a direct question if you need clarification.\n` +
        `  (d) Only if the work is done: work_update(action="hand_in", outcome="finished", proof=[...], note='...').`;
      state = advance(state, { thrashGateRefusalCount: state.thrashGateRefusalCount + 1 });
      logger.warn('v2: thrash gate refused tool call', {
        toolName: tc.name, signature: thisSig,
        refusalCount: state.thrashGateRefusalCount,
      }, agentId);
      try {
        broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
        broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
      } catch { /* best effort */ }
      return { state, refusal: {
        toolCallId: tc.id,
        name: tc.name,
        content: refusal,
        isError: true,
      } };
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
      broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
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
