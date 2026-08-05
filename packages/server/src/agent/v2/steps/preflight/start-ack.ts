// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §6: THE F10 WALL-CLOCK START-ACK.
//
// The person who sent a fresh ask hears something at `ENGINE_START_ACK_AFTER_MS` if
// nothing has landed by then. A TIMER, not a loop-boundary check — and that is the
// whole reason this section is the sharpest statement of the tranche's carrier.
//
// ⚠ `startAckRepliedNow` IS READ FROM THE TIMER CALLBACK, MINUTES AFTER THIS SECTION
// RETURNS. `loop.ts` said it about itself in its own words — "`state` is read at fire
// time, so this sees the flag set during the loop" — and by value the timer would read
// the state as it was BORN, with every `explicitSendThisTurn` false, so a turn whose
// agent already relayed the answer through a send TOOL is acked anyway: the observed
// double-ack and the stray "On it" after a relay. `turnCtx.state` is a live binding on
// both sides, which is what makes this section legal as a module at all.
//
// `ENGINE_START_ACK_AFTER_MS` arrives as an INPUT rather than as an import: it is
// declared at `loop.ts`'s module level and read OUTSIDE this span too (the `execute`
// context), so one declaration is handed across rather than a second being born —
// CUT 6's `STALE_TASK_WINDOW_MINUTES` shape, and the local keeps the constant's own
// spelling so every line that reads it is the line that read it before.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';
import type { TurnCounterparty, WaitingConversation } from '../../counterparty.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
export interface StartAckInputs {
  readonly db: Database;
  readonly counterparty: TurnCounterparty;
  readonly triggerRow: WaitingConversation['latest'];
  readonly turnNumber: number;
}

/** What this section hands the sections after it, and the `execute` step through
 *  them. The TIMER itself is not among them: its handle is on the turn's bag, where
 *  the teardown step both reads and clears it (PHASE-6 T9b's carrier). */
export interface StartAckOutputs {
  readonly counterpartyIsAgentSender: boolean;
  readonly startAckArmed: boolean;
  readonly startAckArmedAtMs: number;
  readonly startAckRepliedNow: () => boolean;
  readonly fireStartAckIfOwed: (via: 'timer' | 'first-tool') => Promise<void>;
}

export function runStartAck(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: StartAckInputs,
): StartAckOutputs {
  const { agentId, engineStartAckAfterMs } = ctx;
  const { db, counterparty, triggerRow, turnNumber } = input;
  const ENGINE_START_ACK_AFTER_MS = engineStartAckAfterMs;
  // ── F10: wall-clock start-ack timer ──
  // The person who sent a fresh ask hears "on it" at ENGINE_START_ACK_AFTER_MS
  // if no user-visible reply has landed by then. A TIMER, not a loop-boundary
  // check: the first model round can alone take 25s+, so a boundary check
  // cannot fire until moments before the reply (observed: ack 3s before
  // completion, exactly the noise pattern this exists to kill). Armed ONLY
  // when this turn serves a waiting human NOW (triggerRow set, the same
  // "human is waiting" signal the close-out gate trusts): a queued-wakeup /
  // drain / continuation turn has a user counterparty too, and an ack fired
  // there reads as a stray "On it." attached to nothing (observed live).
  // Cancelled in the teardown finally; a fire after the reply is prevented by
  // the DB check (any user-visible assistant text already stamped with this
  // turn_number) plus the shared once-per-turn flag.
  // WORK-GATED (owner report 2026-07-10, slow-local-model screenshot): the ack
  // exists for WORK, not conversation. On a slow model every reply crosses the
  // wall-clock, so a purely time-based ack answered "Hey dude!" with "Starting
  // on this, back with you soon." The gate: the timer only speaks when the turn
  // has STARTED USING TOOLS by the time it fires; a slow chat reply just
  // streams (the working dots cover the wait). Work that begins later than the
  // threshold is covered by the first-tool-call hook at the execution site,
  // which fires this same routine the moment real work starts.
  // PHASE-6 T9b (RULING P6-R3(1)): the handle lives on the turn's bag, not in a
  // driver `let`. It is the ONE mutable local the teardown span both reads and
  // WRITES, and the teardown span is about to become a module — where a by-value
  // parameter would carry the handle in and let the `= null` die at the boundary.
  // `turnCtx.startAckTimer` is a live binding on both sides. Same lifetime: the
  // timer is armed below, after every exit that returns before the main `try`
  // opens, so nothing can arm it and skip the teardown that cancels it.
  // PHASE-6 T7 (RULING P6-R3(1)): the FIRST-TOOL LATCH lives on the bag too, and it
  // is the ONE mutable crossing the `execute` span WRITES. It is written at the first
  // tool dispatch and read HERE, inside the timer callback, at fire time — so by value
  // the timer would read `false` forever and a long working turn would take the
  // "chat-shaped, stay quiet" branch while the person heard nothing. The hazard, and
  // why it completes the F10 family CUT 6 started, are written at the field.
  //   → `turnCtx.anyToolStartedThisTurn`
  // RC-4.4: true while a model call is streaming for this turn, set around the
  // `callModel` await below. PHASE-6 T5 (CUT 5): MIGRATED to the turn's bag under
  // RULING P6-R3(1) — the span writes it and the declaration is the driver's. The
  // comment that stood here claimed the start-ack timer consults it; it does not, and
  // nothing else does either. The measurement, and what is and is not being claimed
  // by moving a flag with no reader, are written at the field.
  // RC-4.2: the turn counterparty is another Dojo agent texting over a human channel
  // (an iMessage safe-sender flagged is_agent). Channel-delivered engine acks (start /
  // completion / A2A-handoff) are gated OFF for such a counterparty: another agent does
  // not need "on it" reassurance, and each ack is a fresh inbound that wakes the peer
  // box, the ack ping-pong (H-5) that produced the duplicate texts to the owner. The
  // human owner's OWN engine acks about her agent's work are unaffected, those go to
  // her dashboard/owner conversation, not to an agent-flagged counterparty.
  const counterpartyIsAgentSender = counterparty.kind === 'user' && !!counterparty.senderIsAgent;
  const startAckArmed = counterparty.kind === 'user' && !!triggerRow && !counterpartyIsAgentSender;
  const startAckArmedAtMs = Date.now();
  // The person has heard something the moment EITHER a user-visible
  // assistant text row landed this turn (the DB check) OR the agent
  // delivered through a channel send TOOL (explicitSendThisTurn). The
  // tool-send case leaves NO assistant text row, so the DB check alone
  // was blind to it and fired a duplicate ack seconds after the model's
  // own send (the observed double-ack, and the stray "On it" after a
  // relay was already sent). `state` is read at fire time, so this sees
  // the flag set during the loop. When the agent truly did nothing on
  // any channel, both are false and the engine still speaks.
  const startAckRepliedNow = (): boolean =>
    Object.values(turnCtx.state!.explicitSendThisTurn).some(Boolean) ||
    !!db.prepare(`
    SELECT 1 FROM messages
    WHERE agent_id = ? AND role = 'assistant' AND turn_number = ?
      AND content NOT LIKE '[{%'
      AND origin_intent IS NULL
      AND length(trim(content)) > 0
    LIMIT 1
  `).get(agentId, turnNumber);
  const fireStartAckIfOwed = async (via: 'timer' | 'first-tool'): Promise<void> => {
    try {
      if (turnCtx.engineStartAckDeliveredThisTurn || turnCtx.startAckSteerRequested || turnCtx.startAckSteerArmedThisTurn || startAckRepliedNow()) return;
      // The captured-narration branch (F10, 2026-07-16) that lived here is
      // GONE (owner production report 2026-07-23: "not a single ack"). It
      // delivered whatever mid-work narration was captured ("Let me look at
      // the structure more closely...") AS the ack, short-circuiting the
      // steer, so the model was never actually asked to address the user.
      // Narration is a working note, not an acknowledgment. The trivial-save
      // contract (captured ANSWER must reach the user) lives at the finalize
      // recovery, not here.
      // Owner ruling 2026-07-22 (engine detects, agent speaks): no canned
      // engine line, no compose call. Request the steer; the loop injects it
      // at the next iteration boundary (loop-synchronous state write, so this
      // async timer can never race the loop) and the MODEL speaks the start
      // line in its own voice. The old in-flight-call wait is gone for the
      // same reason: the request is inert until the checkpoint, which
      // re-checks startAckRepliedNow at a safe boundary.
      turnCtx.startAckSteerRequested = true;
      logger.info('v2 F10: start-ack threshold passed with nothing heard; steer requested so the model says it (engine detects, agent speaks)', {
        agentId, turnNumber, via, thresholdMs: ENGINE_START_ACK_AFTER_MS,
      }, agentId);
    } catch (err) {
      logger.warn('v2 F10: start-ack fire failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };
  if (startAckArmed) {
    turnCtx.startAckTimer = setTimeout(() => {
      if (!turnCtx.anyToolStartedThisTurn) {
        // Chat-shaped so far: the model is composing a reply with no tools.
        // Stay silent (dots cover the wait); if tools DO start later, the
        // first-tool-call hook delivers the ack then. Delivered-flag stays
        // unset on purpose so that hook can still speak.
        logger.info('v2 F10: start-ack threshold passed with no tool activity; staying quiet (chat-shaped turn)', {
          agentId, turnNumber,
        }, agentId);
        return;
      }
      void fireStartAckIfOwed('timer');
    }, ENGINE_START_ACK_AFTER_MS);
  }

  return {
    counterpartyIsAgentSender, startAckArmed, startAckArmedAtMs,
    startAckRepliedNow, fireStartAckIfOwed,
  };
}
