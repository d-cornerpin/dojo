// The delegation turn-end: on a non-A2A turn a wake-intent send (QUESTION / ASSIGN / BLOCK) that went out, by
// send_to_agent or a spawn's job, is answered on a later turn, so the turn ends here and the question is delegated.

import {
  JOIN_TTL_MINUTES, findJoinChildByThread, openDelegationJoin, threadHopCount, type DelegationThread,
} from '../../../../work/store.js';
import { broadcast } from '../../../../gateway/ws.js';
import type { AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFired } from '../../steer-queue.js';
import { userWords, replyChannelWords } from '../../turn-address.js';
import { createLogger } from '../../../../logger.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { ExecuteContext } from './index.js';
import { turnWindow } from '../post-call-classify/job-turn-end.js';

const logger = createLogger('v2-loop');

export function runDelegationTurnEnd(state: AgentTurnState, ctx: ExecuteContext): StepOutcome {
  const {
    agentId, turnNumber, db, counterparty, triggerRow, triggerWorkId,
    triggerConversationId, persistedContent, deferredDeliveredByAck,
  } = ctx;

  // This turn's reply-warranting sends that went out, whichever tool made them, keyed by turn number on their own
  // delivery rows: a2a rows are stored to the whole second, so a clock bound would sweep in the previous turn's sends.
  // Read per turn, not per response: once the turn has delegated, any later tool step ends it after the one status-line steer.
  const sentRows = counterparty.kind === 'agent' ? [] : db.prepare(
    `SELECT m.a2a_thread_id AS a2a_thread_id, m.agent_id AS agent_id, m.a2a_intent AS a2a_intent
       FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.agent_id = @agentId AND d.turn_number = @turnNumber
        AND d.tool = 'send_to_agent' AND d.outcome = 'delivered'
        AND m.source_agent_id = @agentId AND m.a2a_thread_id IS NOT NULL
        AND m.a2a_intent IN ('QUESTION','ASSIGN','BLOCK')
      ORDER BY m.created_at ASC, m.rowid ASC`,
  ).all({ agentId, turnNumber }) as Array<{ a2a_thread_id: string; agent_id: string; a2a_intent: string | null }>;
  // End the turn now, or the agent re-asks or fabricates the answer. Every send in this one response's batch
  // still goes out, so multi-delegation is not blocked.
  if (sentRows.length > 0) {
    // The ask's work row is already claimed, which stops a re-trigger; the join is child rows with an
    // atomic countdown, and the message row is untouched. On reply the engine relays, never re-asks.
    if (triggerRow && triggerWorkId) {
      try {
        const seen = new Set<string>();
        const threads: DelegationThread[] = [];
        for (const r of sentRows) {
          if (!r.a2a_thread_id || seen.has(r.a2a_thread_id)) continue;
          seen.add(r.a2a_thread_id);
          // A follow-up on a thread whose piece belongs to another request is part of that piece, not a second one.
          const open = findJoinChildByThread(agentId, r.a2a_thread_id);
          if (open && open.parentId !== triggerWorkId) continue;
          threads.push({
            threadId: r.a2a_thread_id,
            assigneeAgent: r.agent_id,
            intent: r.a2a_intent ?? 'ASSIGN',
            hopCount: threadHopCount(r.a2a_thread_id) ?? 0,
          });
        }
        if (threads.length > 0) {
          const opened = openDelegationJoin({
            parentWorkId: triggerWorkId,
            agentId,
            // Copied now, never resolved later: the reply returns on the conversation the ask came on.
            replyConversationId: triggerConversationId,
            ttlAt: Date.now() + JOIN_TTL_MINUTES * 60_000,
            threads,
          });
          logger.info('v2: delegated the owner question, join opened', {
            agentId, work: triggerWorkId, children: opened.length, ownerRowid: triggerRow.rowid,
          }, agentId);
        }
      } catch (err) {
        logger.warn('v2: delegation join could not be opened', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    // A user-triggered turn may not go silent on a hand-off, and this exit bypasses every turn-ending floor:
    // one steer for a status line. If ignored, exit anyway; the park relay still delivers the answer.
    if (
      triggerRow &&
      !state.surfacedReplyThisTurn && !deferredDeliveredByAck &&
      !state.lastAssistantTextForIM &&
      (!persistedContent || persistedContent.trim().length === 0) &&
      !Object.values(state.explicitSendThisTurn).some(Boolean) &&
      !steerFired(state.steerQueue, 'delegation-exit') &&
      turnWindow(state, agentId, 1) !== 'checkpoint'
    ) {
      // A status line that misnames the helpers is not fixed here: judging the model's sentence is banned.
      const exitSteer =
        `[Engine hint: you delegated work on ${userWords(ctx.turnCtx.address)}'s request and are about to end your turn without telling them anything. WRITE ONE short line to them first, as your reply (it goes to ${userWords(ctx.turnCtx.address)} by ${replyChannelWords(ctx.turnCtx.address)}): if you already have their answer, give it now; otherwise say you have handed the pieces off and will report back when they return. Do NOT call imessage_send or any send tool (the engine routes your reply), and do not message any agent again this turn.]`;
      // Persisted as an engine steer: nothing else on this exit records that the status line was asked for.
      state = persistEngineSteer(state, { agentId, content: exitSteer, turnNumber, floor: 'delegation-exit', atLoop: state.loopCount }, { broadcast });
      logger.info('v2 delegation-exit steer: user-triggered hand-off ending silently; one steer for the status line before the async exit', {
        agentId, turnNumber,
      }, agentId);
      return continueLoop(state);
    }
    logger.info('v2: delegation send, exiting loop (reply is async; owner question parked)', { agentId }, agentId);
    return requestExit(state, 'delegation-send-async-exit');
  }
  return proceed(state);
}
