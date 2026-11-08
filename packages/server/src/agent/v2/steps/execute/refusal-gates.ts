// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THE GATES THAT CAN REFUSE A CALL BEFORE IT RUNS, moved
// byte-faithfully out of `loop.ts`'s `execute` span: the reminder-delivery lane,
// the A2A re-send cap, the thrash gate, the anti-hoarding
// ADVISORY (which refuses nothing — it nudges and falls through, and its own
// comment says so), and the pre-turn close-out gate.
//
// THE ONE CONVERSION: inside the loop each of these returned a tool result
// straight out of `runOne`. A module cannot return from its caller, so the gates
// hand back `{ state, refusal }` and `run-one.ts` returns the refusal if there is
// one. The refusal VALUES are the same bytes, including every threshold and every
// word of every refusal text.
//
// The owner check they use is the shared one (`services/safe-senders.ts`, t146).
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
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

// D16 recipient comparison moved to agent/recipient-identity.ts (P5c rekey:
// canonical contact/safe-sender identity first, digit-tail heuristic only as
// the both-unknown fallback).

// Reminder-delivery lane (2026-07-21, battery root-cause find; P1 spine
// consumer #1). A reminder task is BY DESIGN a delivery to the owner (or a
// household member the owner named). Production/battery incident: on an
// engine turn serving a reminder, the floor model resolved "deliver this to
// the user" to the most RECENT human it had chatted with (a third-party
// iMessage contact) and texted owner-bound content there, recipient chosen
// explicitly by the model, so no recency-map fix could catch it. "Is this
// recipient the owner?" is answered by the ONE owner rule
// (`services/safe-senders.ts:isOwnerIMessageRecipient`, t146), address or
// record name, phone-tolerant via recipientIdsMatch.

/** `refusal` non-null means the call does NOT run and this is its result. */
export function runRefusalGates(
  state: AgentTurnState,
  tc: ToolCall,
  ctx: ExecuteContext,
  isA2AReplyTool: boolean,
): { state: AgentTurnState; refusal: PendingToolResult | null } {
  const { agentId, turnNumber, turnCtx, counterparty, reminderLaneRefusedSigs } = ctx;


  // ── Reminder-delivery lane (destination-from-root) ──
  // A refuse-once guard on channel sends, costing legitimate
  // work at most one corrective round (an identical re-send proceeds):
  //  1. Reminder lane: this turn serves a kind='reminder' task (read
  //     structurally off the claimed trigger's task_id, migration 112).
  //     Reminder output belongs to the OWNER; a send naming someone who
  //     is not the owner is refused once with guidance ("remind my
  //     wife" repeats and goes through).
  //  A send TO the owner is never refused (owner ruling 2026-10-27, GitHub #27/#28): the
  //  presence switch is not proof the owner is watching, and on a turn rooted in someone
  //  else's text the "chat reply" goes to that person. The channel choice is the agent's.
  if ((tc.name === 'imessage_send' || tc.name === 'sms_send')) {
    const served = turnCtx.servedWork;
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(a.recipient ?? a.to ?? '').trim();
    const recipIsOwner = recip ? isOwnerIMessageRecipient(recip) : false;
    if (served?.taskKind === 'reminder' && recip && !recipIsOwner) {
      const laneSig = `${tc.name}|${recip}`;
      if (!reminderLaneRefusedSigs.has(laneSig)) {
        reminderLaneRefusedSigs.add(laneSig);
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

  // ── A2A re-send cap (per recipient per turn) ──
  // Inter-agent replies are ASYNC, the recipient answers on its OWN
  // later turn, never synchronously in this one. An agent that doesn't
  // get an instant reply re-sends the same ask, REWORDING it each time,
  // which defeats the content-signature dedup (every rewording is a new
  // signature) and spams the recipient (observed: 29 send_to_agent calls
  // to one agent in a single turn). Cap it at A2A_SEND_CAP_PER_RECIPIENT
  // per recipient per turn, set well ABOVE any genuine case (two distinct
  // messages to one agent, a retry after a transient failure) so it only
  // catches a pathological re-send loop, never real multi-send. Different
  // recipients are independent, and the first several sends always pass.
  if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') {
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(
      a.to_agent ?? a.agent ?? a.to ?? a.recipient ?? a.group ?? a.group_id ?? '',
    ).trim().toLowerCase();
    if (recip && (state.sendsPerAgentThisTurn[recip] ?? 0) >= A2A_SEND_CAP_PER_RECIPIENT) {
      // Audit round (#4): facts, not orders and not the escape hatch.
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

  // ── Thrash-gate refusal (per-canonical-signature) ──
  // The iteration-top thrash detector added this signature to the gate when it caught the
  // agent repeating the same call. The gate refuses ONLY this exact (tool, args) combo — the
  // agent can keep calling the same tool with DIFFERENT args — and the message names the exact
  // call so DeepSeek can't miss it (unlike a buried system message). Refusal count tracks how
  // many times the agent ignored the gate. WHAT THE MESSAGE MAY CLAIM IS BOUNDED BY WHAT THE
  // SIGNATURE MEASURES (owner ruling 2026-09-22, argued in full at `pre-call-gates/thrash-gate.ts`):
  // it may say the result is already here only because `canonicalToolSignature` carries EVERY argument.
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
  // ── Anti-hoarding gate (v2.5.43) ──
  // Refuse loading-tool calls past LOADING_GATE_THRESHOLD when no
  // structuring (work_open, file_write/append/patch,
  // scratchpad_set, work_update(action="status"), etc.) has happened
  // this turn. Engine enforcement of the corpus-synthesis pattern
  //, prompt-level guidance was being ignored on prod by
  // DeepSeek V4 Pro. See classifiers/hoarding.ts for full
  // rationale. The structuring call itself is NEVER refused
  // (we check loading-only), and once any structuring happens
  // the gate is permanently off for the rest of the turn.
  //
  // v2.7.8, carve-out: trainer reading from its own techniques
  // directory doesn't count. The trainer's job IS reading the
  // technique files it manages; the gate fired on a trainer
  // doing exactly that (reading the 4 scripts + TECHNIQUE.md
  // of its own technique) and forced it to open a confused
  // "Edit Technique" tracker for what was a one-shot ask.
  // D3: anti-hoarding is now a NON-BLOCKING compaction-proximity advisory,
  // not a count-based refusal. The old gate refused the (THRESHOLD+1)th
  // read of a turn until a tracker/file write landed, which blocked
  // legitimate multi-source work ("check my inboxes", 6-source research,
  // exec-heavy asks), taxed weak models by effort-count (a weaker model
  // needs MORE reads for the same job), and even demanded "open a tracker
  // project" in order to read email. The real hazard is context PRESSURE
  // (loaded sources summarized into confabulation at compaction), which the
  // engine already measures (lastContextRatio). So when many unscaffolded
  // loads have happened AND context is genuinely near compaction, nudge
  // ONCE (advice, framed as an engine hint, never a refusal) to write the
  // sources down now, then let the read through. Reads are never blocked.
  // The count (heavyLoadsThisTurn) reflects the SIZE of prior results this
  // turn (see the post-result accounting below); the trigger no longer
  // keys on whether THIS call is a "loading tool" (that name-set is gone).
  // We only skip nudging on the very call that structures (isStructuringTool),
  // since telling the agent to write things down as it writes them down is
  // noise; !structuringToolCalledThisTurn already covers "already structured".
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
    // Phase 0.4: route the [Engine hint] through persistEngineSteer so the
    // advice reaches the model (the steer queue, drained as a synthetic user
    // message next iteration) AND keeps the dashboard row. The old bare
    // role='system' INSERT was stripped by the assembler, so the advisory
    // never reached the model at all (INVISIBLE by choice, but the model
    // could not act on advice it never saw). This stays ADVICE, not a block:
    // the tool still executes below (no refusal, no `continue`), the nudge
    // just rides along to the next iteration. Already gated once per turn by
    // the queue's own `hoarding-advisory` latch.
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
  // ── UX-REPAIR ROUND 12 T47 — THE PRE-TURN COMPILE GATE ──
  //
  // The owner is owed a compiled reply, every delegated piece is back, and the redrive ladder
  // has already come back for it at least once. Round-12 S5: three steers each saying "Do NOT
  // search, open files, run commands, or call any tools first" were answered with
  // `load_tool_docs`, `history_search`, `history_get`, `work_update` (errored ×2) and
  // `history_get`, across 12m26s, with no reply. Persuasion failed 3/3; this is the same duty
  // made mechanical, in the shape of the gate directly above that already worked.
  //
  // The re-validation is the DISARM: the decision re-reads `compile_pending` at the moment it
  // would refuse, so the model's own answer, T48's engine relay, a fail-closed notice and a
  // bare flag clear all take the gate down without knowing it exists.
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
  // T68b: armed, genuinely owed, and the assembly could NOT confirm the pieces are in front
  // of the model. The refusal below would tell the model they are, which is the sentence that
  // burned three full output budgets on 2026-08-31, so the call runs. Logged at WARN because
  // reaching here means an ENGINE defect: the compile order was written and did not arrive.
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
