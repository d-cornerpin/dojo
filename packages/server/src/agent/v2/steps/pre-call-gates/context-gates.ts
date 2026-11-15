// The context gate: condenses rows leaving the view, measured for the model this iteration will dial.
// The condense is never awaited: it has no clock or chunk cap, so awaiting it would stall the turn.
// The gate never ends the turn; the window is guarded by the trim, out-of-view.ts, assembly-validation.ts.

import { createLogger } from '../../../../logger.js';
import { checkAndCompact, estimateAssembledTokens, leavingFromView } from '../../../../memory/compaction.js';
import type { LeavingView } from '../../../../memory/tail-horizon.js';
import { agentTurnWindow } from '../../../../router/router-window.js';
import { backgroundDrains } from '../../../shared-state.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext } from './index.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { releaseBackgroundSlot, replacePlaceholdersInBackground } from '../../../../memory/out-of-view.js';
import { clearOn } from '../../../../memory/writer.js';

const logger = createLogger('v2-loop');

/** The model each agent's gate last measured the routine check for (absent: left to the call step). */
const routineMeasuredAtGate = new Map<string, string>();
export function routineCheckMeasuredAtGate(agentId: string, modelId: string): boolean {
  return routineMeasuredAtGate.get(agentId) === modelId;
}

export async function runContextGates(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const { agentId, contextWindow: turnWindow, contextModelId, configuredModelId, isAutoRouted, counterparty } = ctx;
  // Measured for the dialed model, written by the CONFIGURED model's writer (never a locked pick).
  const lockedModelId = isAutoRouted ? state.lockedModelId : null;
  const dialModelId = lockedModelId ?? contextModelId;
  const contextWindow = lockedModelId ? agentTurnWindow(agentId, lockedModelId) : turnWindow;

  if (state.loopCount === 1 && state.lastUserMessageId) clearOn({ kind: 'person-spoke', agentId });
  // Placeholders are replaced first, in the background; while that runs the check only measures.
  const replacing = replacePlaceholdersInBackground(agentId);
  // Nothing locked yet on an auto-routed loop: the call step measures once the router picks.
  if (isAutoRouted && !lockedModelId) {
    routineMeasuredAtGate.delete(agentId);
    return proceed(state);
  }
  routineMeasuredAtGate.set(agentId, dialModelId);
  const fill = await condenseForTheDialedModel({
    agentId, dialedModelId: dialModelId, contextWindow, writerModelId: configuredModelId, counterparty, measureOnly: replacing,
  });
  return proceed(fill === null ? state : advance(state, { lastContextRatio: fill }));
}

/** THE ROUTINE CHECK for the model a call will dial, on the gauge (the assembler's own dry run): rows about to
 *  leave the view? Then fold exactly those, in the background; nothing else starts a run. Returns the view's fill
 *  (wanted / room), or null when it could not be measured. Never throws. */
export async function condenseForTheDialedModel(args: {
  agentId: string; dialedModelId: string; contextWindow: number; writerModelId: string;
  /** Unused: the gauge measures the system prompt itself. Kept for the call step's caller. */
  systemPromptTokens?: number;
  counterparty?: TurnCounterparty; measureOnly?: boolean;
}): Promise<number | null> {
  const { agentId, dialedModelId, contextWindow, writerModelId } = args;
  try {
    const { view, total } = await estimateAssembledTokens(agentId, contextWindow, dialedModelId,
      { turnContext: args.counterparty ? { latestUserSource: null, counterparty: args.counterparty } : undefined });
    const leaving = leavingFromView(view);
    if (!args.measureOnly && leaving) condenseLeavingInBackground({ agentId, writerModelId, dialedModelId, contextWindow, leaving });
    return view.budgetTokens > 0 ? total / view.budgetTokens : null;
  } catch (err) {
    logger.warn('v2: the routine condense check could not be measured', {
      agentId, dialedModelId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/** THE ROUTINE CONDENSE, one in flight per agent: folds exactly `leaving`, written by `writerModelId`'s
 *  writer; rows an assembly already took out of view are `out-of-view.ts`'s. Returns whether one started. */
function condenseLeavingInBackground(args: {
  agentId: string; writerModelId: string; dialedModelId: string; contextWindow: number; leaving: LeavingView;
}): boolean {
  const { agentId, writerModelId, dialedModelId, contextWindow, leaving } = args;
  if (backgroundDrains.has(agentId)) return false;
  backgroundDrains.add(agentId);
  logger.info('v2: condensing rows leaving the live view (fire-and-forget)', {
    agentId, cause: leaving.cause, rowsLeaving: leaving.rowsLeaving, throughSeq: leaving.throughSeq,
    dialedModelId, contextWindow,
  }, agentId);
  checkAndCompact(agentId, writerModelId, contextWindow, {
    leaving,
    dialedModelId,
    inTheBackground: true,
  })
    .then((result) => {
      logger.info('v2: background condense complete', {
        agentId, leafCreated: result.leafCreated, condensedCreated: result.condensedCreated, cause: leaving.cause,
      }, agentId);
    })
    .catch((err) => {
      logger.warn('v2: background condense failed or aborted', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    })
    .finally(() => {
      releaseBackgroundSlot(agentId);   // the slot is handed on to an open catch-up
    });
  return true;
}
