// ════════════════════════════════════════
// PHASE-6 T9b — THE `teardown` STEP
//
// The ninth step, and the only one that is not a phase of the LOOP: it is the
// turn's lifetime boundary. Relocated verbatim from `agent/v2/loop.ts`
// (`:9330`–`:9677` at `1cbe8bb` — the function-level `catch` and `finally` of
// `runV2TurnBody`), bounds, wording and log lines unchanged.
//
// ── TWO ARMS, ONE PACKAGE, AND WHY IT IS NOT ONE FUNCTION ──
// A module cannot express `try`/`catch`/`finally` on its caller's behalf, the
// same way it cannot `break` its caller's loop (CUT 1's finding). So the driver
// keeps the language construct and delegates each arm's BODY:
//
//   `runTurnRecovery`  — the `catch` arm. Runs ONLY when the turn threw.
//   `runTurnTeardown`  — the `finally` arm. Runs on EVERY exit path.
//
// The `catch` "rides with" the `finally` in this tranche because they are one
// span of the exit path, not because they are one moment.
//
// ── THE PHASE, AND THE DECISION IT SETTLES (plan §A, owed by this task) ──
// `TurnPhase` gained a ninth member, `'teardown'`, and the driver advances into
// it at the top of the `finally`. The reasons are measured, not asserted:
//
//   * THE UNION ALREADY SPANS BEYOND THE LOOP. `'preflight'` is seeded at
//     `state.ts`'s `initialState` and runs before the main `try` opens, so
//     "the union is only for loop phases" was already false. A ninth-step
//     exception would have been an exception to a rule that does not exist.
//   * NOTHING CAN BE BROKEN BY THE WRITE. `state.phase` has exactly ONE
//     production read — the `while` head's `!== 'done'` — and the loop has
//     already ended by the time this runs. Measured, not assumed.
//   * IT CANNOT THROW FROM A `finally`. `advance` validates, and this
//     transition changes only `phase`, so `validate()` re-checks fields that
//     were valid at their own last write. That matters here and nowhere else:
//     this arm also runs on the throw path, where a new throw would REPLACE
//     the error the turn was already handling.
//   * THE PHASE IS ADVANCED IN THE `finally`, NOT THE `catch`, because the
//     `finally` is the arm whose defining property is "runs on every exit
//     path" — which is the whole reason the member is worth having.
//
// ⚠ WHAT THIS DOES **NOT** CLOSE, said plainly so nobody reads it as closed:
// T13's gate gets read as *"a per-turn transition record exists, and at least
// one decision other than the loop head reads it."* The RECORD half is met and
// is met INSIDE THIS SPAN — `finalizeTurn` writes `turns.exit_reason` +
// `turns.answered`, and the closeout disposition reads them one statement
// later (PHASE-2 T6's "the turn record's first reader"). The `state.phase`
// half is NOT met: nothing but the loop head reads that field, and inventing a
// reader inside a relocation would be a behaviour change this tranche did not
// admit to. Owner: T13, or whichever tranche legitimately needs the read.
//
// ── INPUTS, MEASURED RATHER THAN GUESSED ──
// At `1cbe8bb` the span reads TWENTY declarations from the driver, SEVEN of
// them mutable, and writes exactly ONE: `startAckTimer`. That single crossing
// migrated to the turn's bag first and alone (RULING P6-R3(1), commit
// `1cbe8bb`), so it is a live binding on both sides of this boundary. Nothing
// the span declares is referenced after it (0 escaping declarations — the three
// that look like it, `err`, `claimed` and `t`, are block-scoped names reused
// elsewhere, the `nudgeText` class again).
//
// Two DRIVER CLOSURES arrive as values on the context rather than as imports:
// `reArmIfStrandedNoAnswer` and `stopStatusHeartbeat`. A function value keeps
// the bindings it closed over, so passing it preserves live-read semantics by
// construction — and importing them would have meant either a cycle back into
// the driver or moving a function that this tranche has no mandate to move.
//
// The logger keeps the component name `v2-loop`: it is what the structured
// sink records, and a relocation that renames the field its own operators grep
// by has changed behaviour it did not admit to.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import type { getDb } from '../../../../db/connection.js';
import { activeAbortControllers } from '../../../shared-state.js';
import type { TurnContext } from '../../../turn-context.js';
import { advance, type AgentTurnState, type ChannelInboundContext, type TurnPhase } from '../../state.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { InboundChannel } from '../../inbound-channel.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import { tagTurnOutputs } from './conversation-tagging.js';
import { finalizeTurnRecord } from './finalize-record.js';
import { reclassifyTurnDrafts } from './draft-reclassify.js';
import { flushStrandedAttachments } from './attachment-flush.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances into before calling the `finally` arm. */
export const TEARDOWN_PHASE: TurnPhase = 'teardown';

/**
 * Everything the span read from the driver, written down once now that it is a
 * function boundary instead of a lexical one. Read-only by construction: the
 * one value the span WRITES is `turnCtx.startAckTimer`, which is a property of
 * the turn's bag and therefore live on both sides.
 */
export interface TeardownContext {
  readonly agentId: string;
  /** The turn's bag. Carries the F10 timer handle and the root/servedWork this
   *  block's four stamping reads take. */
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  /** The driver's own handle, resolved once at turn start exactly as before.
   *  Passing it rather than calling `getDb()` here is not plumbing for its own
   *  sake: a `getDb()` inside these arms would sit OUTSIDE the block's
   *  best-effort `try`s, adding a throw site to the one block whose own comments
   *  say three times that "turn teardown must not throw". */
  readonly db: ReturnType<typeof getDb>;
  readonly chosenConvKey: string | null;
  readonly chosenConversationId: string | null;
  readonly lastAssembledAtIso: string | null;
  readonly terminalAnswerRowId: string | null;
  readonly triggerWorkId: string | null;
  readonly toolPhaseEndedBySpinBrake: boolean;
  readonly turnInjectedTechniqueId: string | null;
  readonly counterparty: TurnCounterparty;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly turnStartedAt: string;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  /** Driver closures — see the header. Values, so their own bindings stay live. */
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly stopStatusHeartbeat: (agentId: string) => void;
}

/**
 * THE `catch` ARM. Runs only when the turn threw, before the `finally` arm.
 *
 * It never asks the driver to do anything — a step that runs after the turn has
 * already ended has nothing left to request — so it always `proceed`s, and that
 * is asserted by the contract test on every path.
 */
export async function runTurnRecovery(
  state: AgentTurnState,
  ctx: TeardownContext,
  err: unknown,
): Promise<StepOutcome> {
  const { agentId, turnInjectedTechniqueId, reArmIfStrandedNoAnswer, stopStatusHeartbeat } = ctx;

  // Best-effort cleanup before recovery so heartbeats / abort controllers
  // don't keep firing while the recovery cascade does its DB writes.
  stopStatusHeartbeat(agentId);
  activeAbortControllers.delete(agentId);

  // C2: a throw anywhere AFTER the pickup-stamp (assembleContext, decideTier,
  // enforceModelCapabilities, the grounding INSERT, the assistant/tool persists,
  // all before the model call's own try/catch owns the error) reaches THIS
  // function-level catch with the human trigger still stamped served at pickup, so
  // the ask would be silently stranded and never re-served (inv 2 + 6).
  // recoverFromError does NOT touch conv_key. reArmIfStrandedNoAnswer re-arms the
  // ask so the drain re-serves it, but ONLY under the clean-retry guard (no reply
  // delivered AND no tool executed this turn). That guard is deliberately
  // conservative: it covers the common, dominant case (a transient model/infra
  // failure on the FIRST call, pre-tool sites like assembleContext / decideTier /
  // enforceModelCapabilities), which is the one we live-verified. It intentionally
  // does NOT re-arm the POST-tool throw sites listed above (grounding INSERT,
  // assistant/tool persists): a turn that already executed a tool may have committed
  // a non-idempotent side effect (created a task, wrote a file, sent a message), and
  // re-serving it would DUPLICATE that side effect, the OPEN-12/duplicate-project
  // class the pickup-stamp exists to prevent. So we accept a narrow residual strand
  // (a post-tool non-model throw that delivered no reply) rather than risk a
  // duplicate; those "did work but didn't reply" cases are owned by the
  // note-then-stopped / going-idle nudges. (The symmetric engine-stamp revert is
  // intentionally left to C6/C7's loss-over-loop handling for engine events, a
  // dropped scheduler tick re-fires next cycle; it is not re-armed here.)
  reArmIfStrandedNoAnswer();

  // 5a: a turn that died with a technique injected counts as a failure
  // signal for that technique.
  if (turnInjectedTechniqueId) {
    try {
      const { recordTechniqueOutcome } = await import('../../../../techniques/store.js');
      recordTechniqueOutcome(turnInjectedTechniqueId, agentId, false);
    } catch { /* best effort */ }
  }

  // Phase 6 (2026-05-04), v2 now owns its own recovery cascade.
  // recoverFromError handles all side effects: context-overflow recovery,
  // recoverable provider 4xx (with streak cap + system note), or generic
  // injury (recordError + last_error + healer notification + chat:error).
  //
  // No re-throw, handleMessage's outer catch is now a no-op for v2 errors,
  // and any exception escaping recoverFromError is itself logged but
  // swallowed (the agent is already in a degraded state; throwing further
  // would double-handle).
  try {
    const { recoverFromError } = await import('../../recovery.js');
    await recoverFromError(state, err);
  } catch (recovErr) {
    logger.error('v2 recovery cascade itself threw, swallowing to avoid double-handle', {
      agentId,
      recoveryError: recovErr instanceof Error ? recovErr.message : String(recovErr),
      originalError: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  return proceed(advance(state, { phase: TEARDOWN_PHASE }));
}

/**
 * THE `finally` ARM — the block that runs on EVERY exit path (clean reply,
 * decline, MAX_TOOL_LOOPS, a spinning/thrash break, an early return inside the
 * main try, an exception). That property is the language's, not a list's: the
 * contract test asserts the call site rather than sampling arms.
 */
export async function runTurnTeardown(
  state: AgentTurnState,
  ctx: TeardownContext,
): Promise<StepOutcome> {
  const { turnCtx } = ctx;

  // F10: the wall-clock start-ack timer must never outlive its turn. The DB
  // check inside the callback also guards a race where the timer fired just
  // before this clear, but cancelling here is the primary discipline.
  if (turnCtx.startAckTimer) { clearTimeout(turnCtx.startAckTimer); turnCtx.startAckTimer = null; }

  tagTurnOutputs(ctx);
  await finalizeTurnRecord(state, ctx);
  // SWEEP CORE-2 item 7 — DRAFTS ARE NOT ANSWERS. It runs HERE and the ORDER is the whole
  // mechanism, not a preference: `finalizeTurnRecord` is what stamps `turns.answer_message_id`,
  // so this is the first instant in the turn's life at which the platform knows WHICH bubble
  // answered. Called before it, it would have nothing to read and would have to guess.
  //
  // Best-effort like every other arm of the `finally` (this block's own comments say three
  // times that turn teardown must not throw), but LOUD rather than silent: a failure here
  // leaves the drafting looking like answers on the owner's screen, which is the defect the
  // module exists to remove, and a silence about that is how it would come back unnoticed.
  try {
    reclassifyTurnDrafts({ agentId: ctx.agentId, turnNumber: ctx.turnNumber });
  } catch (err) {
    logger.warn('v2: the turn-end draft re-classification FAILED — this turn\'s drafting will render as answers', {
      agentId: ctx.agentId, turnNumber: ctx.turnNumber,
      error: err instanceof Error ? err.message : String(err),
    }, ctx.agentId);
  }
  await flushStrandedAttachments(ctx);

  return proceed(advance(state, { phase: TEARDOWN_PHASE }));
}
