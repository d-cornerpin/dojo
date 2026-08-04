// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THE GATES THAT CAN REFUSE A CALL BEFORE IT RUNS, moved
// byte-faithfully out of `loop.ts`'s `execute` span: the reminder-delivery lane
// and its owner-drift arm, the A2A re-send cap, the thrash gate, the anti-hoarding
// ADVISORY (which refuses nothing — it nudges and falls through, and its own
// comment says so), and the pre-turn close-out gate.
//
// THE ONE CONVERSION: inside the loop each of these returned a tool result
// straight out of `runOne`. A module cannot return from its caller, so the gates
// hand back `{ state, refusal }` and `run-one.ts` returns the refusal if there is
// one. The refusal VALUES are the same bytes, including every threshold and every
// word of every refusal text.
//
// `recipientIsChannelOwner` came WITH them: its only use was inside this span.
// ════════════════════════════════════════

import { getDb } from '../../../../db/connection.js';
import { broadcast } from '../../../../gateway/ws.js';
import { getPresence } from '../../../../services/presence.js';
import { parseSafeSenders } from '../../../../services/imessage-bridge.js';
import { toolOpKey } from '../../../../tools/work-verbs.js';
import { recipientIdsMatch } from '../../../recipient-identity.js';
import { LOADING_GATE_THRESHOLD, isStructuringTool } from '../../classifiers/hoarding.js';
import { canonicalToolSignature } from '../../classifiers/loop.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { closeOutGateDecision } from '../../stale-work-ids.js';
import { advance, type AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
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
// explicitly by the model, so no recency-map fix could catch it. This helper
// answers "is this recipient the owner?" from the channel's own approved
// sender records (is_primary), phone-tolerant via recipientIdsMatch.
function recipientIsChannelOwner(toolName: string, recipient: string): boolean {
  try {
    const db = getDb();
    const raw = (db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined)?.value ?? null;
    // Lazy import avoided: parseSafeSenders is a pure parser; require the
    // bridge module statically below via the existing import surface.
    const senders = parseSafeSenders(raw);
    const owners = senders.filter((x) => x.is_primary);
    for (const o of owners) {
      if (recipientIdsMatch(recipient, o.address) || recipientIdsMatch(recipient, o.name)) return true;
    }
  } catch { /* conservative: unknown = not owner */ }
  return false;
}

/** `refusal` non-null means the call does NOT run and this is its result. */
export function runRefusalGates(
  state: AgentTurnState,
  tc: ToolCall,
  ctx: ExecuteContext,
  isA2AReplyTool: boolean,
): { state: AgentTurnState; refusal: PendingToolResult | null } {
  const { agentId, turnNumber, turnCtx, counterparty, reminderLaneRefusedSigs, engineBlockEscapeHatch } = ctx;
  const ENGINE_BLOCK_ESCAPE_HATCH = engineBlockEscapeHatch;


  // ── Reminder-delivery lane + owner-drift arm (destination-from-root) ──
  // Two refuse-once guards on channel sends, each costing legitimate
  // work at most one corrective round (an identical re-send proceeds):
  //  1. Reminder lane: this turn serves a kind='reminder' task (read
  //     structurally off the claimed trigger's task_id, migration 112).
  //     Reminder output belongs to the OWNER; a send naming someone who
  //     is not the owner is refused once with guidance ("remind my
  //     wife" repeats and goes through).
  //  2. Owner-drift, GENERAL form (P6 destination-from-root; the battery
  //     found the A2A gap: an A2A-poked turn about owner-rooted work
  //     texted the owner a completion report while the owner sat at the
  //     dashboard, and the old engine-served-only arm never fired). Any
  //     turn, ANY lane (engine, A2A, dashboard): a send TO the owner
  //     while the owner is IN the dojo belongs in chat, unless the turn
  //     itself is rooted in the owner's own text conversation (the
  //     owner texted us; replying in-channel is the conversation).
  if ((tc.name === 'imessage_send' || tc.name === 'sms_send')) {
    const served = turnCtx.servedWork;
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(a.recipient ?? a.to ?? '').trim();
    const recipIsOwner = recip ? recipientIsChannelOwner(tc.name, recip) : false;
    if (served?.taskKind === 'reminder' && recip && !recipIsOwner) {
      const laneSig = `${tc.name}|${recip}`;
      if (!reminderLaneRefusedSigs.has(laneSig)) {
        reminderLaneRefusedSigs.add(laneSig);
        return { state, refusal: {
          toolCallId: tc.id,
          name: tc.name,
          content:
            `Refused once: this turn is delivering the owner's reminder, and "${recip}" is not the owner. ` +
            `Reminders are delivered to the owner: reply in chat (the owner is watching the dashboard conversation this reminder came from), ` +
            `or send to the owner's own address. If the owner explicitly asked for this reminder to be delivered to "${recip}", ` +
            `repeat the exact same send and it will go through.`,
          isError: true,
        } };
      }
    } else if (
      recip && recipIsOwner && getPresence() === 'in_dojo' &&
      !(counterparty.kind === 'user' && counterparty.relation === 'owner' &&
        (counterparty.channel === 'imessage' || counterparty.channel === 'sms'))
    ) {
      const driftSig = `owner-drift|${tc.name}|${recip}`;
      if (!reminderLaneRefusedSigs.has(driftSig)) {
        reminderLaneRefusedSigs.add(driftSig);
        const rootNote = served?.originConvKey === 'owner'
          ? 'This work was asked for in the owner\'s dashboard conversation and the owner is currently IN the dojo'
          : 'The owner is currently IN the dojo (at the dashboard)';
        return { state, refusal: {
          toolCallId: tc.id,
          name: tc.name,
          content:
            `Refused once: ${rootNote}, so deliver this to the owner as your chat reply (just say it); ` +
            `no channel send is needed. ` +
            `If the owner explicitly asked to be texted, repeat the exact same send and it will go through.`,
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
      const refusal =
        `[System: you have already sent "${recip}" ${A2A_SEND_CAP_PER_RECIPIENT} messages this turn. ` +
        `Inter-agent replies are ASYNCHRONOUS, "${recip}" answers on their OWN next turn, not in this one. ` +
        `Re-sending the same ask (even reworded) does NOT get a faster reply; it only spams them. ` +
        `End your turn now; you will see their reply when it arrives. ${ENGINE_BLOCK_ESCAPE_HATCH}]`;
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
  // The iteration-top thrash detector added this signature to the
  // gate when it caught the agent repeating the same call. The
  // gate refuses ONLY this exact (tool, normalized_args) combo, 
  // the agent can keep calling the same tool with DIFFERENT args.
  // The refusal message names the exact call so DeepSeek can't
  // miss it (unlike a buried system message). Refusal count tracks
  // how many times the agent ignored the gate.
  if (state.thrashGatedSignatures.length > 0 && !isA2AReplyTool) {
    const thisSig = canonicalToolSignature(tc.name, tc.arguments);
    if (state.thrashGatedSignatures.includes(thisSig)) {
      const argsPart = thisSig.includes(':') ? thisSig.slice(thisSig.indexOf(':') + 1) : '{}';
      const refusal =
        `BLOCKED by engine thrash gate, \`${tc.name}(${argsPart})\` is refused. ` +
        `You've already called this exact signature multiple times and have the result from the first call.\n\n` +
        `Pick a different next action:\n` +
        `  (a) Call \`${tc.name}\` with DIFFERENT args (a different id / target) if you have more to read.\n` +
        `  (b) Call work_update(action="status", status='complete', result='...', evidence=[...]) using the data you've already gathered.\n` +
        `  (c) Call work_update(action="status", status='blocked', notes='<specific obstacle>') if you genuinely cannot proceed.\n` +
        `  (d) Send the user a direct question if you need clarification.\n\n` +
        ENGINE_BLOCK_ESCAPE_HATCH;
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
  // ── Pre-turn close-out gate (v2.5.46) ──
  // Refuse non-tracker tool calls when the agent has dangling
  // in_progress tasks from a previous turn. The agent MUST
  // engage with the tracker (status update, complete_step, or
  // add_notes for "still working") before doing other work.
  // Once any qualifying tracker call lands, the gate disengages
  // for the rest of the turn (re-arms next turn if there are
  // still danglers).
  //
  // HAND-PICKED, NOT DERIVABLE, and legitimately so: this is a work-FAMILY
  // allowlist (the stable tracker surface plus load_tool_docs so the agent
  // can fetch a close-out tool's schema). Its domain is the work family,
  // which does not span the google/microsoft/_ms/user_ tool explosion that
  // drifts, so it does not have the defect-class disease. No display/effect
  // classifier encodes "counts as engaging with your dangling tasks"; that
  // is exactly this gate's private rule.
  //
  // PHASE-2 T8V: keyed on OPERATIONS. Allowing the bare verb `work_update`
  // would let the agent past the gate with anything that verb can do; the
  // ops below are exactly the retired names this list used to carry, and
  // the two obligation ops are deliberately NOT here (closing a promise is
  // not engaging with a dangling task).
  //
  // PHASE-6 T0D: the three conditions are unchanged and tested in the same
  // order; the gate re-validates against the spine before it refuses, so a
  // dangler deleted mid-turn can no longer trap the agent. Why, and what it
  // costs: `stale-work-ids.ts`.
  const closeOut = closeOutGateDecision(
    state.danglingTaskIds, state.closeOutGateSatisfied, toolOpKey(tc.name, tc.arguments),
  );
  if (closeOut.live.length !== state.danglingTaskIds.length) {
    state = advance(state, { danglingTaskIds: closeOut.live });
    logger.info('v2: close-out gate dropped dangling ids whose rows are gone', {
      agentId, remaining: closeOut.live.length,
    }, agentId);
  }
  if (closeOut.refuse) {
    const taskListShort = closeOut.live.slice(0, 5).map((id) => id.slice(0, 8)).join(', ');
    const refusalText = (
      `Refused: engine close-out gate. You have ${closeOut.live.length} in_progress ` +
      `task(s) from a previous turn that you never closed (ids: ${taskListShort}${closeOut.live.length > 5 ? '...' : ''}). ` +
      `Before any other tool call, resolve at least one with work_update(action="complete_step"), ` +
      `work_update(action="status", status="complete" | "blocked" | "paused"), or, if you're genuinely still working ` +
      `on it across turns, work_note to signal "in flight." After ANY one of those, the gate ` +
      `disengages for the rest of this turn and "${tc.name}" will work normally. ` +
      `Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.\n\n` +
      ENGINE_BLOCK_ESCAPE_HATCH
    );
    try {
      broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
      broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusalText.slice(0, 500) });
    } catch { /* best effort */ }
    logger.info('v2: close-out gate refused call', {
      agentId, tool: tc.name, danglingCount: closeOut.live.length,
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
