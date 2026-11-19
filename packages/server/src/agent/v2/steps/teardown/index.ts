// Teardown: the bodies of the driver's function-level `catch` (runTurnRecovery) and `finally`
// (runTurnTeardown). Logger component stays `v2-loop`, which operators grep the structured sink by.
import { createLogger } from '../../../../logger.js';
import type { getDb } from '../../../../db/connection.js';
import { abortInFlight } from '../../../shared-state.js';
import { endAgentCommands } from '../../../effects/proc-tree.js';
import { setAgentStatus } from '../../../agent-status.js';
import type { TurnContext } from '../../../turn-context.js';
import { advance, type AgentTurnState, type ChannelInboundContext, type TurnPhase } from '../../state.js';
import { classifyThrownCut, latchEngineCut } from '../../engine-exit.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { InboundChannel } from '../../inbound-channel.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import { finalizeTurnRecord } from './finalize-record.js';
import { reclassifyTurnDrafts } from './draft-reclassify.js';
import { flushStrandedAttachments } from './attachment-flush.js';

const logger = createLogger('v2-loop');

/** The `finally` arm's phase; advancing changes only `phase`, so validation cannot throw here. */
export const TEARDOWN_PHASE: TurnPhase = 'teardown';

/** What the span reads from the driver; read-only except turnCtx.startAckTimer, which lives on the bag. */
export interface TeardownContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  /** Passed in: a getDb() here would add a throw site outside the arms' best-effort trys. */
  readonly db: ReturnType<typeof getDb>;
  readonly chosenConvKey: string | null;
  readonly chosenConversationId: string | null;
  readonly lastAssembledAtIso: string | null;
  readonly terminalAnswerRowId: string | null;
  readonly triggerWorkId: string | null;
  /** The engine event this turn won at pickup (null: none); finalize hands it back by the turn's exit. */
  readonly claimedEngineEvent: { rowid: number; turnNumber: number } | null;
  readonly toolPhaseEndedBySpinBrake: boolean;
  readonly counterparty: TurnCounterparty;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly turnStartedAt: string;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  /** Driver closures, passed as values to keep live bindings and avoid an import cycle into the driver. */
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly stopStatusHeartbeat: (agentId: string) => void;
}

/** THE `catch` ARM: runs only when the turn threw, before the `finally` arm. Always `proceed`s. */
export async function runTurnRecovery(
  state: AgentTurnState,
  ctx: TeardownContext,
  err: unknown,
): Promise<StepOutcome> {
  const {
    agentId, counterparty, isA2ATurn, isEngineTurn,
    reArmIfStrandedNoAnswer, stopStatusHeartbeat,
  } = ctx;

  // Ask the throw what ended the turn BEFORE recoverFromError: recordInjury closes the turn row itself,
  // so a latch applied afterwards would be lost. A throw it cannot place returns null.
  const thrownCut = classifyThrownCut(err, agentId);
  const turnState = thrownCut ? latchEngineCut(state, thrownCut) : state;

  // Abort this turn's in-flight calls before recovery's DB writes; `scope: 'turn'` spares background
  // media jobs (video polls, fired TTS), which outlive the turn on purpose.
  stopStatusHeartbeat(agentId);
  abortInFlight(agentId, 'turn-teardown', { scope: 'turn' });
  endAgentCommands(agentId); // and a command it left running (children wait on the stop, not in that registry)

  // Re-serve a trigger stamped served at pickup only on a clean retry (no reply, no send, no
  // non-idempotent call): re-serving after a side effect would duplicate it.
  reArmIfStrandedNoAnswer();

  try {
    const { recoverFromError } = await import('../../recovery.js');
    // A genuine human conversation; the same predicate finalize-record.ts uses.
    const isUserFacingTurn = counterparty.kind === 'user' && !isA2ATurn && !isEngineTurn;
    await recoverFromError(turnState, err, { isUserFacingTurn });
  } catch (recovErr) {
    logger.error('v2 recovery cascade itself threw, swallowing to avoid double-handle', {
      agentId,
      recoveryError: recovErr instanceof Error ? recovErr.message : String(recovErr),
      originalError: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  return proceed(advance(turnState, { phase: TEARDOWN_PHASE }));
}

/** The turn's one end-of-run `idle` writer; the only other in-turn writers are preflight's two abandon
 *  returns, before the driver's `try`. Writes only over `working`, so any other status stands. */
function settleStatus(ctx: TeardownContext): void {
  try {
    const row = ctx.db.prepare('SELECT status FROM agents WHERE id = ?').get(ctx.agentId) as
      | { status?: string } | undefined;
    if (row?.status !== 'working') return;
    setAgentStatus(ctx.agentId, 'idle');
  } catch (err) {
    logger.warn('v2: turn-end status settle failed; the row may still read working', {
      agentId: ctx.agentId, error: err instanceof Error ? err.message : String(err),
    }, ctx.agentId);
  }
}

/** THE `finally` ARM: runs on every exit path (reply, decline, cap, brake, early return, throw). */
export async function runTurnTeardown(
  state: AgentTurnState,
  ctx: TeardownContext,
): Promise<StepOutcome> {
  const { turnCtx } = ctx;

  if (turnCtx.startAckTimer) { clearTimeout(turnCtx.startAckTimer); turnCtx.startAckTimer = null; }

  settleStatus(ctx);

  await finalizeTurnRecord(state, ctx);
  // Must follow finalizeTurnRecord, which stamps turns.answer_message_id. Best-effort but logged loudly.
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
