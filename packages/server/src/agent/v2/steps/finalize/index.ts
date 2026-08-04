// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE `finalize` STEP
//
// The eighth step: everything the turn does AFTER the tool loop has ended and BEFORE
// the exit path (`catch`/`finally`, CUT 2's `teardown`). Relocated verbatim from
// `agent/v2/loop.ts` (`:7856`–`:8782` at `0942fd9`, 927 lines), bounds, wording, SQL
// and log lines unchanged.
//
// ── IT CANNOT ASK TO EXIT, AND THAT IS A PROPERTY OF WHERE IT SITS ──
// `finalize` runs after the `while` loop, as the last statement of the turn's main
// `try`. There is no iteration left to continue and no loop left to break, so every
// path returns `proceed` — including the paths whose own work failed, because each of
// this span's five blocks already carries its own best-effort `catch` and a turn that
// has produced its answer must still reach its teardown. The contract test asserts
// that on every arm.
//
// ── EVERY `break` PATH REACHES IT, AND THE OUTCOME IS STAMPED ──
// The tranche note asks for "outcome stamping at the site of the event … assert every
// `break` path stamps". That is asserted as a CENSUS WITH A DENOMINATOR rather than a
// list of arms: every `break` in the driver's `while` body is lexically inside the
// `try` this step ends, so the language — not a convention — guarantees the turn
// reaches here however it stopped. What "stamps" means is the Phase-2 split: the
// truthful-answer key (`noteTerminalAnswer`, whose two sites in this span are the
// recovered reply and the surfaced files) and, one step later in `teardown`,
// `turns.exit_reason` + `turns.answered` derived from records rather than from prose.
//
// ── THE ORDER IS THE CONTRACT ──
//   1. `recoverDeferredReply`      G-SUP-2 — the answer that rode with a tool call.
//   2. `runCompletionAck`          the scaffolded-work detection (see its header).
//   3. `routeTerminalReply`        which channel the reply goes out on, and the send.
//   4. `surfaceStrandedAttachments` the show_to_user safety net — deliberately AFTER
//                                  the router, which is why it sends files itself.
//   5. `scheduleCompletionReport`  the A2A ack-and-ghost follow-up.
//   6. the tail                    heartbeat off, recovery streak cleared, idle,
//                                  healer "recovered", the technique's usage row.
// Steps 1 and 4 can both produce the turn's reply text, and 3 sits between them: a
// reordering would silently change what gets routed and what only reaches the
// dashboard. The contract test pins the order for that reason.
//
// ── INPUTS, MEASURED RATHER THAN GUESSED ──
// At `0942fd9` the span reads FIFTEEN declarations from the driver, TWO of them
// mutable, and writes exactly one — `state`, which the step contract already carries.
// It reached that shape: before this tranche's four carrier commits it read
// TWENTY-ONE with EIGHT mutable, and six of the eight migrated to the turn's bag
// under RULING P6-R3(1). The one that did NOT get a field is `chosenConversationId`,
// because the bag ALREADY publishes that fact as `TurnContext.conversationId` and a
// second field would be two owners of one fact — `route-reply.ts` says so at the read.
//
// Two DRIVER CLOSURES arrive as values on the context: `noteTerminalAnswer` (the ONE
// setter of the truthful-answer key) and `persistRoutingMarker` (the single writer of
// the dashboard's "to X via Y" badge). A function value keeps the bindings it closed
// over, so passing it preserves live-WRITE semantics by construction — CUT 2's
// `reArmIfStrandedNoAnswer` precedent — and importing them would have meant either a
// cycle back into the driver or moving a function this tranche has no mandate to move.
//
// The logger keeps the component name `v2-loop`: it is what the structured sink
// records, and a relocation that renames the field its own operators grep by has
// changed behaviour it did not admit to.
// ════════════════════════════════════════

import type { AgentStatus, WsEvent } from '@dojo/shared';
import type { getDb } from '../../../../db/connection.js';
import { recoveryRunStreak } from '../../../shared-state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { AgentTurnState, TurnPhase } from '../../state.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import { recoverDeferredReply } from './deferred-recovery.js';
import { runCompletionAck } from './completion-ack.js';
import { routeTerminalReply } from './route-reply.js';
import { surfaceStrandedAttachments } from './stranded-attachments.js';
import { scheduleCompletionReport } from './close-the-loop.js';

/** The phase the driver advances into before calling this step. */
export const FINALIZE_PHASE: TurnPhase = 'finalize';

/**
 * Everything the span read from the driver, written down once now that it is a
 * function boundary instead of a lexical one.
 */
export interface FinalizeContext {
  readonly agentId: string;
  /** The turn's bag: this span's six carriers, the root, and the conversation id the
   *  reply-destination resolver scopes its tagging to. */
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  /** The driver's own handle, resolved once at turn start exactly as before. */
  readonly db: ReturnType<typeof getDb>;
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string | null;
  readonly turnStartedAt: string;
  readonly settledContextWakeTurn: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly broadcast: (event: WsEvent) => void;
  /** Driver closures — see the header. Values, so their own bindings stay live. */
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly stopStatusHeartbeat: (agentId: string) => void;
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
}

/**
 * The finalize step. Always `proceed`s — see the header for why that is a property of
 * where it sits rather than a choice.
 */
export async function runFinalize(state: AgentTurnState, ctx: FinalizeContext): Promise<StepOutcome> {
  const { agentId, turnCtx, db, stopStatusHeartbeat, setAgentStatus } = ctx;

  state = recoverDeferredReply(state, ctx);
  const engineCompletionAckThisTurn = runCompletionAck(state, ctx);
  state = await routeTerminalReply(state, ctx, engineCompletionAckThisTurn);
  state = await surfaceStrandedAttachments(state, ctx);
  await scheduleCompletionReport(ctx);

  stopStatusHeartbeat(agentId);

  // Clean turn end, clear the in-loop recovery streak. The agent reached
  // a natural exit without further recovery, so any prior recovery
  // attempts are presumed resolved (matches v1 runtime.ts:1404).
  recoveryRunStreak.delete(agentId);

  // Set agent back to idle (unless terminated)
  const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as
    | { status: string }
    | undefined;
  if (currentAgent && currentAgent.status !== 'terminated') {
    setAgentStatus(agentId, 'idle');
  }

  // Reset the persisted recovery_attempts counter on a successful turn.
  // Pre-2026-05-06 the counter only reset inside reset_session, so 3
  // transient errors spread over weeks would silently accumulate and
  // permanently suppress the Healer for the agent until the user
  // manually intervened. Only fire onAgentRecovered when attempts > 0
  // (there was actually something to recover from) to avoid spamming
  // the "recovered" toast on every healthy turn.
  if (currentAgent && currentAgent.status !== 'terminated') {
    try {
      const attemptsRow = db
        .prepare('SELECT recovery_attempts FROM agents WHERE id = ?')
        .get(agentId) as { recovery_attempts: number | null } | undefined;
      if ((attemptsRow?.recovery_attempts ?? 0) > 0) {
        const { onAgentRecovered } = await import('../../../../healer/injury-recovery.js');
        onAgentRecovered(agentId);
      }
    } catch { /* best effort */ }
  }

  // D14: the per-turn checkTimeouts() call is removed. The 30s interval in
  // index.ts already reaps expired agents; running a full agents-table scan
  // after every single turn was redundant overhead (and, before the sensei
  // fix, an extra path that re-hit the unterminate-able-sensei warn on every
  // turn as well as every 30s).

  // 5a: the injected technique's usage row learns the turn's outcome.
  if (turnCtx.turnInjectedTechniqueId) {
    try {
      const { recordTechniqueOutcome } = await import('../../../../techniques/store.js');
      recordTechniqueOutcome(turnCtx.turnInjectedTechniqueId, agentId, true);
    } catch { /* best effort */ }
  }

  // Compaction is rare in v2 (Part V). For Phase 2 we skip the post-turn
  // call entirely, the pre-call compactionGate (added in Phase 4) will
  // handle it. v1's post-turn compaction call was the failure mode this
  // whole architecture is fixing.

  return proceed(state);
}
