// ════════════════════════════════════════
// PHASE-6 T4 (CUT 6) — the `assemble` step's STEER CHECKPOINT AND DRAIN, moved
// byte-faithfully out of `loop.ts`.
//
// Two things, and they are one mechanism's two halves: the F10 start-ack
// checkpoint (owner ruling 2026-07-22 — the async timer and the first-tool hook
// only REQUEST; the state write happens here, loop-synchronously, and re-checks
// whether a reply landed in flight) and the queue drain that puts ONE entry per
// iteration onto the tail (PHASE-4 T3 — highest declared precedence first, the
// rest wait rather than being overwritten).
//
// The four flags this reads and writes live on the TURN'S BAG, not on the driver's
// stack: `startAckSteerRequested` is written from the wall-clock TIMER, which is
// the by-value test's own disqualifier, and the injected count is a bounded cap
// (2) rather than a snapshot. See `turn-context.ts` for the family's reasoning.
//
// ── HL4 STEP 2 (2e), MERGER 1: THE ACK LADDER MOVED OUT, WHOLE ──
// The first half of this file used to BE the ack ladder, in a second copy of a
// three-flag write that `multistep-detection.ts` also carried. Both openers now
// call one module (`start-ack-door.ts`), which owns the text, the arming and the
// reminder rung; this file keeps its own opener's timing — the loop-synchronous
// boundary — and the drain, which is what it was always for. `START_ACK_STEER_TEXT`
// is re-exported here because the door is where it lives now and this is where
// readers have always looked for it.
// ════════════════════════════════════════

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

  // Start-ack steer checkpoint (owner ruling 2026-07-22): the async timer /
  // first-tool hook only REQUEST the steer; the state write happens here,
  // loop-synchronously, and the ladder re-checks `startAckRepliedNow` so a reply
  // that landed in flight quietly disarms it. (T6: the "another nudge occupies the
  // slot, so defer" half died with the flag — the queue retains both steers.)
  let state = runStartAckLadder(stateIn, {
    agentId, turnNumber, turnCtx, engineStartAckDeliveredThisTurn, startAckRepliedNow,
  });

  // Drain the steer queue (synthetic user message, never persisted). NO tail-shape
  // gate: assembler.ts:301 appends a user-role engine line after an assistant
  // tail, so the old assistant-tail test could never be true and every steer
  // written after a tool call went undelivered 2026-07-10 → 2026-07-27 (r22).
  //
  // PHASE-4 T3: ONE entry per iteration, highest declared precedence first; the rest
  // wait rather than being overwritten. PUSHED is not DELIVERED (the array is still
  // mutated below), so the entry leaves the queue at the receipt, not here.
  let steerAwaitingConfirm: SteerEntry | null = null;
  const steerToDeliver = nextSteer(state.steerQueue);
  if (steerToDeliver) {
    mctx.pendingSteer = steerToDeliver.content;
    if (injectRegistryMessage('msg.pending-nudge', messages, mctx)) {
      steerAwaitingConfirm = steerToDeliver;
    } else {
      // Push refused (the dedup net saw identical text in the tail). Count the attempt:
      // three and the entry is ABANDONED, on the record, so it cannot block the queue.
      state = advance(state, { steerQueue: markSteerAttempted(state.steerQueue, steerToDeliver) });
    }
  }

  return { state, steerAwaitingConfirm };
}
