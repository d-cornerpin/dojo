// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THE DELEGATION TURN-END, moved byte-faithfully out of
// `loop.ts`'s `execute` span. On a NON-A2A turn a wake-intent `send_to_agent`
// (QUESTION / ASSIGN / BLOCK) means the agent asked another agent for something it
// needs, and that reply is ASYNCHRONOUS — it lands on a LATER turn, never in this
// one. The turn ends here, the owner's question is DELEGATED onto the threads the
// sends just created, and the join's countdown is what closes the loop.
//
// TWO OF THE SPAN'S SIX WAYS OUT LIVE HERE, and they are the pair that made this
// block worth its own file: the async exit itself, and the owner-law steer that
// asks for ONE more iteration first so a user-triggered turn cannot go silent on a
// hand-off (2026-07-23, run bmrx5kjitjq — the status line vanished because this
// exit bypasses every turn-ending floor).
// ════════════════════════════════════════

import { JOIN_TTL_MINUTES, openDelegationJoin, threadHopCount, type DelegationThread } from '../../../../work/store.js';
import { broadcast } from '../../../../gateway/ws.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFired } from '../../steer-queue.js';
import { createLogger } from '../../../../logger.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { ExecuteContext } from './index.js';

const logger = createLogger('v2-loop');

export function runDelegationTurnEnd(state: AgentTurnState, ctx: ExecuteContext): StepOutcome {
  const {
    agentId, turnNumber, db, counterparty, result, triggerRow, triggerWorkId,
    triggerConversationId, turnStartedAt, persistedContent, deferredDeliveredByAck,
    maxToolLoops,
  } = ctx;
  const MAX_TOOL_LOOPS = maxToolLoops;

  // ── Delegation turn-end (agent-coordination flow) ──
  // On a NON-A2A turn, a wake-intent send_to_agent (QUESTION / ASSIGN /
  // BLOCK) means the agent asked another agent for something it needs, and
  // that reply is ASYNCHRONOUS, it lands on a LATER turn, never in this one.
  // End the turn now. Without this, the agent loops re-asking (observed: 29
  // send_to_agent calls in one turn) AND/OR fabricates the answer before the
  // reply arrives. The owner's question is parked + resumed when the reply
  // lands (close-the-loop, handled below / in the runtime). The model can
  // still delegate to MULTIPLE agents in this single response's tool batch
  // before the turn ends, so genuine multi-delegation is not blocked.
  const issuedWakeAsk = (result.toolCalls ?? []).some((tc) => {
    if (tc.name !== 'send_to_agent') return false;
    const intent = String((tc.arguments as Record<string, unknown> | undefined)?.intent ?? '').toUpperCase();
    return intent === 'QUESTION' || intent === 'ASSIGN' || intent === 'BLOCK';
  });
  if (counterparty.kind !== 'agent' && issuedWakeAsk) {
    // DELEGATE the owner's question onto the thread(s) we just asked (PHASE-2 T4).
    //
    // What this replaces: the owner's message row used to have its `conv_key` overwritten
    // with `park:<thread>` (or `park:~<t1>|<t2>#<remaining>` for a fan-out) so the question
    // (a) did NOT re-trigger and (b) was NOT falsely treated as answered. That column also
    // carries the conversation's IDENTITY, so parking destroyed the record of where the
    // question came from — research 07 §3's "worst coupling", and the reason the relay had
    // to recover the channel from an `inbound_meta` JSON blob.
    //
    // Both jobs now belong to rows that were built for them: the ask's TICKET is already
    // `claimed` (T3), which is what stops the re-trigger and what says it is not answered;
    // and the join is N CHILD rows under it with an atomic countdown. The message row is
    // not touched at all — requirement 3g/3l, state and identity are separate fields.
    //
    // When a reply comes back the ENGINE closes the loop directly (a2a-transport): it
    // relays a single piece to the owner on their own channel, or holds a fan-out until the
    // LAST piece lands and then steers the model to compile. It does NOT re-fire the
    // model's own question — that proved flaky (the weak model re-reads "ask X" and
    // re-asks: an ask→delegate→answer→re-ask loop).
    if (triggerRow && triggerWorkId) {
      try {
        // T-2 (comms-audit): derive the asked thread(s) STRUCTURALLY from the A2A rows the
        // sends just created (source_agent_id = this agent, this turn), never by
        // regex-scraping the tool-result prose — if the wording ever changed, the regex
        // would miss and the owner's question would be SILENTLY DROPPED.
        // C9: constrain to reply-warranting intents. The weak model routinely batches a
        // real QUESTION/ASSIGN/BLOCK to a worker AND a STATUS/FYI to the PM in one response.
        // Ordering is ASC (oldest first) so the children read in hand-off order.
        // BUG-4: the FULL thread id, never an 8-char prefix — two threads sharing a prefix
        // collided in the relay, and `makeThreadId`'s own comment records that an 8-char
        // prefix of a `thread-<hash>-<seed>` id is ~36 buckets. The short-token minter that
        // forced the old length-sniffing SQL is GONE with this block (3j).
        const sentRows = db.prepare(
          `SELECT a2a_thread_id, agent_id, a2a_intent FROM messages
             WHERE source_agent_id = @agentId AND a2a_thread_id IS NOT NULL
               AND a2a_intent IN ('QUESTION','ASSIGN','BLOCK') AND created_at >= (unixepoch(@turnStartedAt) * 1000)
           ORDER BY created_at ASC, rowid ASC`,
        ).all({ agentId, turnStartedAt }) as Array<{ a2a_thread_id: string; agent_id: string; a2a_intent: string | null }>;
        const seen = new Set<string>();
        const threads: DelegationThread[] = [];
        for (const r of sentRows) {
          if (!r.a2a_thread_id || seen.has(r.a2a_thread_id)) continue;
          seen.add(r.a2a_thread_id);
          threads.push({
            threadId: r.a2a_thread_id,
            // The ASKED agent, recorded HERE where it is known. The string machine had to
            // reconstruct it later by scanning messages around the park's timestamp.
            assigneeAgent: r.agent_id,
            intent: r.a2a_intent ?? 'ASSIGN',
            hopCount: threadHopCount(r.a2a_thread_id) ?? 0,
          });
        }
        if (threads.length > 0) {
          const opened = openDelegationJoin({
            parentWorkId: triggerWorkId,
            agentId,
            // COPIED at delegation time, never resolved later: the reply comes back on the
            // conversation the question arrived on, and that fact is written down now.
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
    // Owner law (2026-07-09) applies at the ASYNC-EXIT path too (2026-07-23,
    // run bmrx5kjitjq: the hand-off status line vanished because this exit
    // bypasses every turn-ending floor). A user-triggered turn may not go
    // silent on a delegation hand-off: one steer for the status line, in
    // the agent's own voice. If the model ghosts it (or delegates yet
    // again), exit as designed; the park relay stays the deterministic
    // backstop for the ANSWER, this net only covers the interim silence.
    if (
      triggerRow &&
      !state.surfacedReplyThisTurn && !deferredDeliveredByAck &&
      !state.lastAssistantTextForIM &&
      (!persistedContent || persistedContent.trim().length === 0) &&
      !Object.values(state.explicitSendThisTurn).some(Boolean) &&
      !steerFired(state.steerQueue, 'delegation-exit') &&
      state.loopCount < MAX_TOOL_LOOPS
    ) {
      const exitSteer =
        '[Engine hint: you delegated work on the user\'s request and are about to end your turn without telling them anything. WRITE ONE short line to them first, directly in this conversation: if you already have their answer, give it now; otherwise say you have handed the pieces off and will report back when they return. Do NOT call imessage_send or any send tool (the engine routes your reply), and do not message any agent again this turn.]';
      // HL3: the RC-19 door — this exit bypasses every turn-ending floor, so nothing else
      // on the turn records that the status line was asked for.
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
