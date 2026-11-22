// One door: one text, one flag triple (written nowhere else), one ladder; openers differ only in WHEN.
// The steer text is byte-preserved; merging the two opening predicates would invent a third door.

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFiredAtLoop } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import { deliveryLabel } from '../../turn-address.js';
import { personShownALineThisTurn } from '../../person-shown-this-turn.js';

const logger = createLogger('v2-loop');

// Engine detects, agent speaks: the steer hands the mic to the model, whose line becomes the visible ack.
export const START_ACK_STEER_TEXT =
  '[Engine hint: the user has not heard anything from you yet this turn, and their request is being worked as a tracked job. In your next response, open with ONE short line in your own voice letting them know you are on it, then continue the work. Keep it to a single brief sentence; the full answer comes when the work is done.]';

/** The same hint naming who is waiting and where the line lands; the generic text when no person is. */
export function startAckSteerText(turnCtx: TurnContext): string {
  const addr = turnCtx.address;
  if (!addr || addr.kind !== 'person') return START_ACK_STEER_TEXT;
  return `[Engine hint: ${addr.name} has not heard anything from you yet this turn, and their request is being worked as a tracked job. In your next response, open with ONE short line in your own voice letting them know you are on it (it reaches them by ${deliveryLabel(addr.deliveryChannel)}), then continue the work. Keep it to a single brief sentence; the full answer comes when the work is done.]`;
}

export interface StartAckDoorInput {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly turnCtx: TurnContext;
  readonly engineStartAckDeliveredThisTurn: boolean;
}

/** The gate half both openers share: not armed this turn, and the ack not delivered by the model. */
export function startAckDoorOpen(
  turnCtx: TurnContext,
  engineStartAckDeliveredThisTurn: boolean,
): boolean {
  return !turnCtx.startAckSteerArmedThisTurn && !engineStartAckDeliveredThisTurn;
}

/** THE DOOR. No gate here, callers ask `startAckDoorOpen` first. Synchronous: the steer rides this call. */
export function armStartAck(state: AgentTurnState, input: StartAckDoorInput): AgentTurnState {
  const { agentId, turnNumber, turnCtx } = input;
  turnCtx.startAckSteerArmedThisTurn = true;
  turnCtx.startAckSteersInjected = 1;
  turnCtx.startAckSteerInjectedAtLoop = state.loopCount;
  // The row and the queue entry are written from one `content`, so they can never disagree.
  return persistEngineSteer(
    state,
    { agentId, content: startAckSteerText(turnCtx), turnNumber, floor: 'start-ack', atLoop: state.loopCount },
    { broadcast },
  );
}

/** THE LADDER, one `if / else if` that must stay one: the hold of one pass (`runRefusalGates`) presumes the first
 *  steer went out ignored, so it never holds the pass the steer rides. It never asks for an ack the
 *  model already spoke: its own line can close the window, and `startAckRepliedNow` misses a stamped ack. */
export function runStartAckLadder(
  state: AgentTurnState,
  input: StartAckDoorInput & { readonly startAckRepliedNow: () => boolean },
): AgentTurnState {
  const { agentId, turnNumber, turnCtx, engineStartAckDeliveredThisTurn, startAckRepliedNow } = input;
  // "Heard" also counts a working note the person was shown and the delivered start line.
  const shownALine = (): boolean => personShownALineThisTurn(agentId, turnNumber);

  // A requested line is owed only to a person waiting on this turn: the start-line timer is armed only for one.
  if (turnCtx.startAckSteerRequested && turnCtx.startAckTimer !== null && startAckDoorOpen(turnCtx, engineStartAckDeliveredThisTurn)
      && !shownALine() && !startAckRepliedNow()) {
    state = armStartAck(state, input);
    logger.info('v2 start-ack steer injected; the model speaks the start line itself', {
      agentId, turnNumber,
    }, agentId);
  } else if (
    // The ignore is visible: call N answered with nothing delivered; remind on the very next boundary.
    turnCtx.startAckSteersInjected === 1 &&
    !engineStartAckDeliveredThisTurn &&
    // Keyed on the loop the first steer RODE (its fired queue entry); the bag's arming loop is only the fallback.
    state.loopCount > (steerFiredAtLoop(state.steerQueue, 'start-ack') ?? turnCtx.startAckSteerInjectedAtLoop) &&
    !shownALine() &&
    !startAckRepliedNow()
  ) {
    turnCtx.startAckSteersInjected = 2;
    turnCtx.startAckSteerInjectedAtLoop = state.loopCount;
    logger.info('v2 start-ack hold armed (first steer ignored, person still waiting)', {
      agentId, turnNumber,
    }, agentId);
  }

  return state;
}
