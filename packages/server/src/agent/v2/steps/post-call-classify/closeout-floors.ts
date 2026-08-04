// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE "RESPOND ONCE" FLOORS, moved byte-faithfully out of
// `loop.ts`'s `postCallClassify` span: the REDUNDANT-CLOSEOUT floor (whose authority
// is a delivery RECEIPT since PHASE-2 T6, never the model's prose), the
// proactive-send backoff that demotes unanswered background chatter, and the arm that
// records the first user-facing reply of the turn.
//
// `REDUNDANT_CLOSEOUT_MAX_CHARS` MOVES WITH THE CODE THAT BINDS IT — measured `out=0`
// before the move, so one declaration travelled rather than a second being born. It is
// a LENGTH and not a reading of the text, carried verbatim from the deleted
// `isGenericCloseout`: anything longer is substantive and is never dropped, whatever
// the ledger says.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { WORKING_NOTE_PREFIX } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { turnDeliveredToPerson } from '../../answered-edge.js';
import { PROACTIVE_SEND_DEMOTE_THRESHOLD, bumpProactiveSendStreak, getProactiveSendStreak } from '../../proactive-budget.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The redundant-closeout floor's only narrowing, carried VERBATIM from the deleted
 *  `isGenericCloseout` (PHASE-2 T6, C1). A LENGTH, not a reading of the text: anything
 *  longer is substantive and is never dropped, whatever the delivery ledger says. */
const REDUNDANT_CLOSEOUT_MAX_CHARS = 30;

/** "Respond once": the closeout floors and the surfaced-reply arm. No way out. */
export function runCloseoutFloors(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const { agentId, messageId, result, settledContextWakeTurn, turnCtx, turnNumber } = ctx;
  const { deliberateSurfaceTurn, interAgentTurn } = sc;
  let { persistedContent } = sc;
  // ── Redundant-closeout floor (engine-enforced "respond once") ──
  //
  // PHASE-2 T6 (C1, requirement 1a): the AUTHORITY here is now a RECEIPT.
  //
  // It used to be two guesses stacked: a turn-local boolean for "a reply already
  // surfaced", and a twenty-phrase regex for "this line is only a closeout". Both are
  // gone. The question the floor actually needs answered is "has this turn already put
  // the result in front of this person", and since PHASE-2 T5 that is a row —
  // `deliveries`, written by the transport door that performed the send, for every
  // channel including the dashboard bubble that recorded nothing at all before T5.
  //
  // The ≤30-character bound is carried over VERBATIM from the deleted
  // `isGenericCloseout` (it had the same cap) and is the only narrowing left: it is a
  // length, not a reading of the text, and it is what keeps this from ever dropping a
  // substantive second answer. Nothing was tuned and no threshold was invented (#14).
  //
  // requirement preserved: the person gets ONE answer per turn, and the engine drops a
  // duplicate only when it can point at the answer they already have.
  if (
    persistedContent &&
    persistedContent.trim().length <= REDUNDANT_CLOSEOUT_MAX_CHARS &&
    result.toolCalls.length === 0 &&
    turnDeliveredToPerson(agentId, turnNumber, turnCtx.root?.conversationId ?? null)
  ) {
    persistedContent = null;
    broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
    // T9: the third and last empty-chat:message "drop" hack; no row is written here
    // by design ("No system marker, the agent already replied"), so a retraction is
    // exactly what this is.
    broadcast({ type: 'chat:retract', agentId, messageId });
    logger.info('v2: suppressed a redundant closeout — the engine holds a delivery receipt for this turn, so the person already has the answer', {
      agentId, turnNumber, loopCount: state.loopCount,
    }, agentId);
  }

  // P4b (owner status-truth family): the owed-interrupt near-duplicate
  // swallow that lived here was DELETED. It nulled the granted round's
  // reply on a wording-similarity verdict, prose-as-authority in the
  // suppression direction, and its known worst case silently ate a
  // genuinely different short answer. The round's contract is now audited
  // by identity instead: the owed rows carry served_by_turn +
  // answer_message_id stamps (migration 113), and the worst case of the
  // swallow's absence is a visible duplicate paragraph, never a silent
  // drop. The re-prompt itself (below) is unchanged.

  // ── RC-5.3: proactive-send budget (backoff on unanswered background chatter) ──
  // A settled-context wake (no human waiting, not a deliberate surface) that produces
  // a terminal user-facing reply is an UNPROMPTED ping. Production fired ~10 of these
  // at a silent owner in 24h with no backoff (F-10). Track consecutive such pings in a
  // persistent per-agent streak (reset on any authorized owner inbound); once the
  // agent has already sent PROACTIVE_SEND_DEMOTE_THRESHOLD in a row, DEMOTE the next
  // one to a quiet dashboard working-note row instead of sending, still visible, no
  // ping. Deliberate surfaces (scheduler digests, reminders, completion reports) are
  // exempt (deliberateSurfaceTurn) and never counted. This is lane-attribution, not
  // suppression: the commentary lands in the notices lane, just not as a ping.
  if (
    settledContextWakeTurn &&
    !deliberateSurfaceTurn &&
    !interAgentTurn &&
    result.toolCalls.length === 0 &&
    persistedContent && persistedContent.trim().length > 0
  ) {
    const streak = getProactiveSendStreak(agentId);
    if (streak >= PROACTIVE_SEND_DEMOTE_THRESHOLD) {
      logger.info('v2 RC-5.3: proactive-send budget reached; demoting unsolicited settled-wake outbound to a quiet notices-lane row instead of sending', {
        agentId, turnNumber, streak, threshold: PROACTIVE_SEND_DEMOTE_THRESHOLD,
        preview: persistedContent.slice(0, 80),
      }, agentId);
      try {
        const noteId = uuidv4();
        insertMessageIfAbsent({
          id: noteId, agentId, role: 'system',
          content: `${WORKING_NOTE_PREFIX}${persistedContent}`, turnNumber,
        });
        // Convert the already-streamed dashboard bubble in place into the dimmed note
        // (same demote mechanism as the RC-9 text-with-tools path).
        broadcast({ type: 'chat:workingnote', agentId, messageId, noteId, content: persistedContent });
      } catch { /* cosmetic; never block the turn */ }
      persistedContent = null;
    } else {
      // Allowed proactive delivery: count it toward the streak. It flows through to
      // the persist + routing below and pings as normal.
      bumpProactiveSendStreak(agentId);
    }
  }

  // Arm the floor: once any user-facing reply surfaces this turn, later
  // generic closeouts get suppressed (above). Set AFTER the suppression
  // checks so a just-swallowed closeout (now null) doesn't arm it.
  if (persistedContent && persistedContent.trim().length > 0 && !state.surfacedReplyThisTurn) {
    state = advance(state, { surfacedReplyThisTurn: true });
  }

  sc.persistedContent = persistedContent;
  return proceed(state);
}
