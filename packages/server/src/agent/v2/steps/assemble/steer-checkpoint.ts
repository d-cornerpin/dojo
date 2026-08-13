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
// ════════════════════════════════════════

import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, markSteerAttempted, nextSteer, steerFiredAtLoop, type SteerEntry } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

// Owner ruling 2026-07-22 (engine detects, agent speaks): the start ack is no
// longer engine-composed. This steer hands the mic to the model instead; the
// capture-site delivery surfaces whatever the model says as the visible ack.
// PHASE-6 T4 (CUT 6): moved here from `loop.ts` with the two sites that bind it —
// this checkpoint and the multi-step scaffold's own arming path, both inside this
// tranche's span. Exported for the second one, and for no other reader.
export const START_ACK_STEER_TEXT =
  '[Engine hint: the user has not heard anything from you yet this turn, and their request is being worked as a tracked job. In your next response, open with ONE short line in your own voice letting them know you are on it, then continue the work. Keep it to a single brief sentence; the full answer comes when the work is done.]';

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
  let state = stateIn;


  // Start-ack steer checkpoint (owner ruling 2026-07-22): the async timer /
  // first-tool hook only REQUEST the steer; the state write happens here,
  // loop-synchronously. Re-checks startAckRepliedNow so a reply that landed
  // in flight quietly disarms it. (T6: the "another nudge occupies the slot, so defer"
  // half died with the flag — the queue retains both steers.)
  //
  // UX-REPAIR T41 (option B) — AND IT NEVER ASKS FOR AN ACK THAT HAS ALREADY BEEN
  // DELIVERED. The owed window now has a second exit: the model's own line, spoken during
  // the wait, can BE the acknowledgment (`post-call-classify/terminal-text.ts`). The
  // request flag that opened the window stays set — it is a record of what the engine
  // observed, not a to-do list — so without this clause the very next boundary would hand
  // the model a steer whose first words are "the user has not heard anything from you yet
  // this turn" moments after they heard exactly that. `startAckRepliedNow` cannot see it:
  // its DB probe requires `origin_intent IS NULL` and the delivered ack is stamped.
  if (turnCtx.startAckSteerRequested && !turnCtx.startAckSteerArmedThisTurn
      && !engineStartAckDeliveredThisTurn && !startAckRepliedNow()) {
    turnCtx.startAckSteerArmedThisTurn = true;
    turnCtx.startAckSteersInjected = 1;
    turnCtx.startAckSteerInjectedAtLoop = state.loopCount;
    state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'start-ack', content: START_ACK_STEER_TEXT, atLoop: state.loopCount }) });
    logger.info('v2 start-ack steer injected; the model speaks the start line itself', {
      agentId, turnNumber,
    }, agentId);
  } else if (
    // One bounded reminder, IGNORE-keyed not time-keyed (2026-07-23, chore
    // battery attempt: the model tool-chained straight past the first
    // steer, and a time-gated reminder only became eligible ~30s later,
    // right when the final answer was landing anyway). The engine can SEE
    // the ignore: the steer rode call N, call N's response is processed,
    // and nothing was delivered. Remind on the very next boundary; after
    // that the terminal reply is the only remaining voice (never spin).
    turnCtx.startAckSteersInjected === 1 &&
    !engineStartAckDeliveredThisTurn &&
    // The loop the first steer rode is read off the QUEUE ENTRY that recorded it
    // (falling back to the local for the pre-assemble arming path at :3489).
    state.loopCount > (steerFiredAtLoop(state.steerQueue, 'start-ack') ?? turnCtx.startAckSteerInjectedAtLoop) &&
    !startAckRepliedNow()
  ) {
    turnCtx.startAckSteersInjected = 2;
    state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, {
      floor: 'start-ack-reminder', atLoop: state.loopCount,
      content: '[Engine hint: reminder, the user has STILL heard nothing from you this turn. Before your next tool call, say one short line to them that you are on it. This is the last reminder.]',
    }) });
    logger.info('v2 start-ack steer reminder injected (first steer ignored, user still waiting)', {
      agentId, turnNumber,
    }, agentId);
  }

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
