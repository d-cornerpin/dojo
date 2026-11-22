// The gates that can refuse a call before it runs: the reminder-delivery lane, the main agent's warn-once
// hurdle, the repeat-send stop, the never-mind hold and the start-line hold, plus the hoarding advisory, which refuses nothing.
// A refusal comes back as `{ state, refusal }` and `run-one.ts` returns it as the call's result.

import { broadcast } from '../../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { wouldWreck } from '../../../destructive-gate.js';
import { identicalCallSignature } from '../../repeat-rule.js';
import { isOwnerIMessageRecipient } from '../../../../services/safe-senders.js';
import { LOADING_GATE_THRESHOLD, isStructuringTool } from '../../classifiers/hoarding.js';
import { persistEngineSteer } from '../../engine-steer.js';
import type { AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { replyChannelWords, userWords } from '../../turn-address.js';
import { personShownALineThisTurn } from '../../person-shown-this-turn.js';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { SENT_TEXT_MAX_CHARS } from '../../../../receipts/store.js';
import { recipientIdsMatch } from '../../../recipient-identity.js';
import { outboundRecipientForTool } from '../../outbound.js';
import { resolveAgentRef } from '../../../tool-helpers.js';
import { ownerWords, ROW_COLS } from '../../../../tracker/owner-words.js';
import type { TurnContext } from '../../../turn-context.js';
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

/** The `sent_text` each send door stores, from the call's arguments; '' for a door that stores none. */
const sentTextOf = (tool: string, a: Record<string, unknown>): string =>
  tool === 'imessage_send' ? String(a.message ?? '') : tool === 'sms_send' ? String(a.body ?? '')
    : tool === 'gmail_send' || tool === 'outlook_send' ? `${String(a.subject ?? '')}: ${String(a.body ?? '').slice(0, 300)}` : '';

/** Loop protection, never a block: a send this request made on an earlier turn is refused once; the identical repeat goes. */
function repeatSend(agentId: string, tc: ToolCall, turnCtx: TurnContext, refusedOnceSigs: Set<string>): PendingToolResult | null {
  const { root, turnNumber: turn } = turnCtx;
  if (root?.kind !== 'ask' || turn === undefined) return null;
  const args = (tc.arguments ?? {}) as Record<string, unknown>;
  const tool = tc.name.replace(/^user_/, '');
  const text = sentTextOf(tool, args).slice(0, SENT_TEXT_MAX_CHARS);
  const recipient = outboundRecipientForTool(tc.name, args);
  const sig = `repeat|${identicalCallSignature(tc.name, tc.arguments)}`;
  if (!text || !recipient || refusedOnceSigs.has(sig)) return null;
  const prior = (getDb().prepare(
    `SELECT turn_number AS n, recipient FROM tool_receipts WHERE agent_id = ? AND created_at >= datetime('now', '-1 day')
        AND tool = ? AND sent_text = ? AND root_kind = 'ask' AND root_id = ? AND turn_number < ? ORDER BY turn_number DESC`,
  ).all(agentId, tool, text, root.id, turn) as Array<{ n: number; recipient: string | null }>)
    .find((r) => recipientIdsMatch(recipient, r.recipient));
  if (!prior) return null;
  refusedOnceSigs.add(sig);
  return { toolCallId: tc.id, name: tc.name, isError: true, content: `[Engine: not sent] Turn ${prior.n} already sent this same `
    + `message to ${recipient} for this request. If you mean to send it again, repeat the exact same call now and it will go.` };
}

/** "Never mind", with no model: in a turn on the owner's new message, the main agent's first message (not a new job)
 *  to a helper still working another of his requests is held once, naming that request and the door that ends it. */
function neverMindHold(agentId: string, tc: ToolCall, turnCtx: TurnContext, refusedOnceSigs: Set<string>): PendingToolResult | null {
  const a = (tc.arguments ?? {}) as Record<string, unknown>;
  if (tc.name !== 'send_to_agent' || String(a.intent).toUpperCase() === 'ASSIGN' || !isPrimaryAgent(agentId) || turnCtx.root?.kind !== 'ask'
    || !turnCtx.address?.isOwner || refusedOnceSigs.has('never-mind')) return null;
  const helper = resolveAgentRef(String(a.agent ?? ''));
  const other = helper.ok ? (getDb().prepare(`SELECT a.id, a.title, m.* FROM work p JOIN work a ON a.id = p.parent_id AND a.kind = 'ask' AND a.id <> ?
      AND a.state IN ('blocked', 'claimed', 'open') JOIN (SELECT id AS mid, ${ROW_COLS} FROM messages) m ON m.mid = a.root_id
    WHERE p.root_kind = 'a2a_thread' AND p.agent_id = ? AND p.assignee_agent = ? AND p.state IN ('open', 'claimed', 'blocked') ORDER BY p.opened_at DESC`)
    .all(`ask:${turnCtx.root.id}`, agentId, helper.id) as Array<Parameters<typeof ownerWords>[0] & { id: string; title: string | null }>).find((r) => ownerWords(r, 0) !== null) : undefined;
  if (!other) return null;
  refusedOnceSigs.add('never-mind');
  return { toolCallId: tc.id, name: tc.name, isError: true, content: `[Engine: not sent yet] ${String(a.agent)} is working on his earlier request ${other.title ? `"${other.title}" ` : ''}[${other.id}]. If his message calls it off, end it with `
    + `work_close_request(id="${other.id}", disposition="dropped", note=<his exact words>): the Dojo stops the job and nothing more comes back. If not, send your message again; it will go.` };
}

/** `refusal` non-null means the call does NOT run and this is its result. */
export function runRefusalGates(
  state: AgentTurnState,
  tc: ToolCall,
  ctx: ExecuteContext,
): { state: AgentTurnState; refusal: PendingToolResult | null } {
  const { agentId, turnNumber, turnCtx, refusedOnceSigs } = ctx;

  // The start-line hold, once per turn: a person who has heard nothing gets the line before this pass's work runs.
  if (turnCtx.startAckSteersInjected === 2 && turnCtx.startAckSteerInjectedAtLoop === state.loopCount
      && !turnCtx.engineStartAckDeliveredThisTurn && !personShownALineThisTurn(agentId, turnNumber)) {
    return { state, refusal: { toolCallId: tc.id, name: tc.name, isError: true, content:
      `[Engine: nothing ran] ${userWords(turnCtx.address, true)} has heard nothing from you yet. Write your one line to them first, as plain text, then make the calls again.` } };
  }
  const warning = hurdle(agentId, tc, refusedOnceSigs);
  if (warning) return { state, refusal: warning };
  const repeated = repeatSend(agentId, tc, turnCtx, refusedOnceSigs) ?? neverMindHold(agentId, tc, turnCtx, refusedOnceSigs);
  if (repeated) return { state, refusal: repeated };

  // Reminder lane: a turn serving a kind='reminder' task delivers to whoever asked for it (the owner when no one
  // else did), so a send naming anyone else is refused once (an identical re-send goes through).
  // A send to the owner is never refused: the channel choice is the agent's.
  if ((tc.name === 'imessage_send' || tc.name === 'sms_send')) {
    const served = turnCtx.servedWork;
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(a.recipient ?? a.to ?? '').trim();
    const addr = turnCtx.address;
    const asker = addr && !addr.isOwner && addr.senderId ? addr : null;
    const who = asker?.name ?? 'the owner';
    const recipIsAsked = recip ? isOwnerIMessageRecipient(recip) || (asker !== null && recipientIdsMatch(recip, asker.senderId)) : false;
    if (served?.taskKind === 'reminder' && recip && !recipIsAsked) {
      const laneSig = `${tc.name}|${recip}`;
      if (!refusedOnceSigs.has(laneSig)) {
        refusedOnceSigs.add(laneSig);
        return { state, refusal: {
          toolCallId: tc.id,
          name: tc.name,
          content:
            `Refused once: this turn is delivering a reminder for ${who}, and "${recip}" is not ${who}. ` +
            `Reminders are delivered to whoever asked: write it as your reply (the engine delivers it to ${who} by ${replyChannelWords(addr)}), ` +
            `or send to ${who}'s own address. If ${who} explicitly asked for this reminder to be delivered to "${recip}", ` +
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
  return { state, refusal: null };
}
