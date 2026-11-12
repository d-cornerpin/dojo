// The assemble step's steer checkpoint and queue drain. The async timer and the first-tool hook only
// REQUEST the ack steer; the write happens here, loop-synchronously. Flags live on the turn's bag.

import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import { advance, type AgentTurnState } from '../../state.js';
import { markSteerAttempted, nextSteer, type SteerEntry } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import { runStartAckLadder } from './start-ack-door.js';

export { START_ACK_STEER_TEXT } from './start-ack-door.js';

export interface SteerCheckpointInput {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly engineStartAckDeliveredThisTurn: boolean;
  readonly startAckRepliedNow: () => boolean;
  readonly mctx: AssemblyContext;
  readonly messages: AssembledContext['messages'];
}

export function runSteerCheckpoint(stateIn: AgentTurnState, input: SteerCheckpointInput): { state: AgentTurnState; steerAwaitingConfirm: SteerEntry | null } {
  const { agentId, turnCtx, turnNumber, engineStartAckDeliveredThisTurn, startAckRepliedNow, mctx, messages } = input;

  // The ladder re-checks `startAckRepliedNow`: a reply that landed in flight quietly disarms the ack.
  let state = runStartAckLadder(stateIn, {
    agentId, turnNumber, turnCtx, engineStartAckDeliveredThisTurn, startAckRepliedNow,
  });

  // Drain: ONE entry per iteration, highest precedence first, as a synthetic, never-persisted user message.
  // No tail-shape gate: the assembler appends a user-role line after an assistant tail. Pushed is not
  // delivered: it leaves the queue at the receipt; a refused push counts toward the cap that abandons it.
  let steerAwaitingConfirm: SteerEntry | null = null;
  const steerToDeliver = nextSteer(state.steerQueue);
  if (steerToDeliver) {
    mctx.pendingSteer = steerToDeliver.content;
    if (injectRegistryMessage('msg.pending-nudge', messages, mctx)) {
      steerAwaitingConfirm = steerToDeliver;
    } else {
      state = advance(state, { steerQueue: markSteerAttempted(state.steerQueue, steerToDeliver) });
    }
  }

  return { state, steerAwaitingConfirm };
}
