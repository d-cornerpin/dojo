// ════════════════════════════════════════════════════════════════════════════════════════
// THE START-ACK DOOR — one door, one text, one flag triple, one ladder.
// HL4 STEP 2 (2e), merger 1. W26's hand-up, W27's lowest-risk merger.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────────────────
// The same three-flag write existed in TWO copies (`steer-checkpoint.ts` and
// `assemble/multistep-detection.ts`), each followed by its own enqueue of the SAME
// constant, with the reminder rung reading the first steer's queue entry from a third
// place. The census called it the most entangled mechanism in the tree, and the entangling
// was the duplication: the OBSERVABLE behaviour was already single-door, because
// `!startAckSteerArmedThisTurn` makes whichever opener runs second a no-op. This makes the
// code say what the behaviour already was, and nothing else.
//
// ── THE SHAPE, AND WHAT DELIBERATELY STAYED OUTSIDE ──────────────────────────────────────
// Inside: the TEXT, the ARMING (the flag triple plus the enqueue), the shared half of the
// gate, and the reminder rung.
// Outside, at each opener, is the ONE thing that genuinely differs between them — WHEN the
// door is asked:
//   · the CHECKPOINT opener asks on a REQUEST (`turnCtx.startAckSteerRequested`), which the
//     three upstream request sites raise: the wall-clock timer / first-tool hook
//     (`preflight/start-ack.ts`), the agent opening its own project
//     (`execute/tracker-counting.ts`), and the ≥6 scaffold floor (`execute/tracker-floors.ts`).
//     It also re-checks `startAckRepliedNow()`, which is the F10 loop-synchronous
//     re-examination the owner's 2026-07-22 ruling asked for.
//   · the MULTISTEP opener asks on a routed channel (T41-A) or a multistep verdict, and
//     therefore reads the counterparty, which the checkpoint never does.
// A merger that folded those two predicates together would be inventing a third door.
//
// ── WHAT IS PRESERVED, NAMED SO IT CANNOT BE LOST QUIETLY ───────────────────────────────
//   · the steer TEXT, byte-identical (OR2: the engine hands the model the mic and never
//     speaks the ack itself — owner ruling 2026-07-22);
//   · the reminder TEXT, byte-identical, and its hard bound of two;
//   · T41-A's routed-channel opener timing — the arming still happens mid-assembly, so the
//     steer rides THIS first model call;
//   · the loop-synchronous state write, and the flag order within it;
//   · T41-B's delivered-flag disarm (`engineStartAckDeliveredThisTurn`), which exists
//     because `terminal-text.ts` can satisfy the owed window with the model's own line and
//     `startAckRepliedNow` cannot see a stamped ack;
//   · the reminder's gate read off the FIRST steer's own queue entry (`steerFiredAtLoop`),
//     with the turn-bag value as the fallback for the pre-assemble arming path.
// ════════════════════════════════════════════════════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFiredAtLoop } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';

const logger = createLogger('v2-loop');

// Owner ruling 2026-07-22 (engine detects, agent speaks): the start ack is no
// longer engine-composed. This steer hands the mic to the model instead; the
// capture-site delivery surfaces whatever the model says as the visible ack.
export const START_ACK_STEER_TEXT =
  '[Engine hint: the user has not heard anything from you yet this turn, and their request is being worked as a tracked job. In your next response, open with ONE short line in your own voice letting them know you are on it, then continue the work. Keep it to a single brief sentence; the full answer comes when the work is done.]';

// One bounded reminder, IGNORE-keyed not time-keyed (2026-07-23, chore battery attempt:
// the model tool-chained straight past the first steer, and a time-gated reminder only
// became eligible ~30s later, right when the final answer was landing anyway).
const START_ACK_REMINDER_TEXT =
  '[Engine hint: reminder, the user has STILL heard nothing from you this turn. Before your next tool call, say one short line to them that you are on it. This is the last reminder.]';

export interface StartAckDoorInput {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly turnCtx: TurnContext;
  readonly engineStartAckDeliveredThisTurn: boolean;
}

/**
 * The half of the gate BOTH openers share: not already armed this turn, and the ack has
 * not already been delivered by the model's own line (T41-B). Each opener adds its own
 * opening predicate on top — a request, or a routed channel / multistep verdict.
 */
export function startAckDoorOpen(
  turnCtx: TurnContext,
  engineStartAckDeliveredThisTurn: boolean,
): boolean {
  return !turnCtx.startAckSteerArmedThisTurn && !engineStartAckDeliveredThisTurn;
}

/**
 * THE DOOR. The flag triple and the steer, written together, in the only place either is
 * written. Callers have already decided that the door should open.
 *
 * The write is loop-synchronous by construction (this runs inside `assemble`, with the
 * messages array mid-build), which is the property the owner's 2026-07-22 ruling and T41-A
 * both depend on: the steer rides the model call being assembled right now.
 */
export function armStartAck(state: AgentTurnState, input: StartAckDoorInput): AgentTurnState {
  const { agentId, turnNumber, turnCtx } = input;
  turnCtx.startAckSteerArmedThisTurn = true;
  turnCtx.startAckSteersInjected = 1;
  turnCtx.startAckSteerInjectedAtLoop = state.loopCount;
  // HL3: through the RC-19 door — the row and the queue entry from one `content`.
  return persistEngineSteer(
    state,
    { agentId, content: START_ACK_STEER_TEXT, turnNumber, floor: 'start-ack', atLoop: state.loopCount },
    { broadcast },
  );
}

/**
 * THE CHECKPOINT LADDER: the request opener, and rung 2 beneath it.
 *
 * They are one `if / else if` and must stay one: the reminder's whole premise is that the
 * FIRST steer already went out and was ignored, so a shape where both could fire in one
 * pass would hand the model two acks to say.
 *
 * UX-REPAIR T41 (option B) — AND IT NEVER ASKS FOR AN ACK THAT HAS ALREADY BEEN DELIVERED.
 * The owed window has a second exit: the model's own line, spoken during the wait, can BE
 * the acknowledgment (`post-call-classify/terminal-text.ts`). The request flag that opened
 * the window stays set — it is a record of what the engine observed, not a to-do list — so
 * without the delivered check the very next boundary would hand the model a steer whose
 * first words are "the user has not heard anything from you yet this turn" moments after
 * they heard exactly that. `startAckRepliedNow` cannot see it: its DB probe requires
 * `origin_intent IS NULL` and the delivered ack is stamped.
 */
export function runStartAckLadder(
  state: AgentTurnState,
  input: StartAckDoorInput & { readonly startAckRepliedNow: () => boolean },
): AgentTurnState {
  const { agentId, turnNumber, turnCtx, engineStartAckDeliveredThisTurn, startAckRepliedNow } = input;

  if (turnCtx.startAckSteerRequested && startAckDoorOpen(turnCtx, engineStartAckDeliveredThisTurn)
      && !startAckRepliedNow()) {
    state = armStartAck(state, input);
    logger.info('v2 start-ack steer injected; the model speaks the start line itself', {
      agentId, turnNumber,
    }, agentId);
  } else if (
    // The engine can SEE the ignore: the steer rode call N, call N's response is processed,
    // and nothing was delivered. Remind on the very next boundary; after that the terminal
    // reply is the only remaining voice (never spin).
    turnCtx.startAckSteersInjected === 1 &&
    !engineStartAckDeliveredThisTurn &&
    // The loop the first steer rode is read off the QUEUE ENTRY that recorded it (falling
    // back to the turn bag for the pre-assemble arming path).
    state.loopCount > (steerFiredAtLoop(state.steerQueue, 'start-ack') ?? turnCtx.startAckSteerInjectedAtLoop) &&
    !startAckRepliedNow()
  ) {
    turnCtx.startAckSteersInjected = 2;
    state = persistEngineSteer(state, {
      agentId, turnNumber, floor: 'start-ack-reminder', atLoop: state.loopCount,
      content: START_ACK_REMINDER_TEXT,
    }, { broadcast });
    logger.info('v2 start-ack steer reminder injected (first steer ignored, user still waiting)', {
      agentId, turnNumber,
    }, agentId);
  }

  return state;
}
