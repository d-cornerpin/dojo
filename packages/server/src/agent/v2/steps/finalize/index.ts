// After the tool loop, before teardown. Always `proceed`s: each block catches its own failure.
// Order matters: deferred recovery and stranded files both shape the reply, and the router sends
// what they leave. Driver closures arrive as values (importing would cycle).

import type { WsEvent } from '@dojo/shared';
import type { getDb } from '../../../../db/connection.js';
import { recoveryRunStreak, doomedPrefillCompactionSpent } from '../../../shared-state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { AgentTurnState, TurnPhase } from '../../state.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import { recoverDeferredReply } from './deferred-recovery.js';
import { routeTerminalReply } from './route-reply.js';
import { surfaceStrandedAttachments } from './stranded-attachments.js';
import { scheduleCompletionReport } from './close-the-loop.js';

export const FINALIZE_PHASE: TurnPhase = 'finalize';

export interface FinalizeContext {
  readonly agentId: string;
  /** The turn's bag; the channel push records each delivery under its root's conversation id. */
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: ReturnType<typeof getDb>;
  readonly counterparty: TurnCounterparty;
  readonly chosenConvKey: string | null;
  readonly turnStartedAt: string;
  readonly settledContextWakeTurn: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly broadcast: (event: WsEvent) => void;
  /** Driver closures, passed as values so their own bindings stay live. */
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly stopStatusHeartbeat: (agentId: string) => void;
}

export async function runFinalize(state: AgentTurnState, ctx: FinalizeContext): Promise<StepOutcome> {
  const { agentId, db, stopStatusHeartbeat } = ctx;

  state = recoverDeferredReply(state, ctx);
  const said = state.lastAssistantTextForIM ?? '';
  state = await surfaceStrandedAttachments(state, ctx);
  state = await routeTerminalReply(state, ctx, said);
  await scheduleCompletionReport(ctx);

  stopStatusHeartbeat(agentId);

  // A clean end resolves prior recovery; a later doomed request gets its own compaction attempt.
  recoveryRunStreak.delete(agentId);
  doomedPrefillCompactionSpent.delete(agentId);

  // No status write here: teardown's `settleStatus` owns it, so a late stop is never clobbered.
  const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as
    | { status: string }
    | undefined;

  // Reset the recovery counter (else stale errors mute the Healer); only when > 0, to avoid toast spam.
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

  return proceed(state);
}
