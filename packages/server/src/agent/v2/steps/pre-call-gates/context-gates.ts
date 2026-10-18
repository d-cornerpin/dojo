// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 3 of 3: THE CONTEXT GATE.
//
// The routine condense of rows leaving the live view. Relocated from `agent/v2/loop.ts` (`:3015`–
// `:3164` at `c1ad4d5`); the routine arm rewritten at t140, the gate's ladder deleted at t194.
//
// t194 (v3.4 D1, owner decision 7, 2026-10-17): THE GAUGE MEASURES EXACTLY WHAT THE AGENT SEES.
// STRIP: the four decisions that stood here (<90% noop · 90–96% warn + "memory is getting full"
// toast · 96–99% emergency compact and surrender · ≥99% block and surrender), measured on a private
// model of the assembly that counted summaries up to 70% of the room and the tail before the trim. A
// worker on a 65K window surrendered turns at "99–103%" of a number its model was never sent, and its
// owner's message was then set aside as "poisoned". requirement preserved: "a call never goes out
// bigger than its window" — owned by the assembler's token trim (it always fits the live tail to the
// room it has), the engine's assembly door that folds what the trim took (`out-of-view-fold.ts`) and
// the boundary that refuses an array the window cannot hold (`assembly-validation.ts`). "An over-full
// view still condenses" (OR-COMPACT-1) — owned by the routine check below, on the gauge itself.
//
// The routine condense is fire-and-forget on purpose (v2.5.14): it used to be awaited through a
// summarizer call whose only bound was an SDK default. It runs in the background, one in flight per
// agent, with no clock or chunk cap of its own (round 5, owner ruling 2026-10-13).
//
// t140: THE ROUTINE CONDENSE MEASURES THE MODEL THIS ITERATION WILL DIAL — a fixed model, or an
// auto-routed loop's locked one. With nothing locked the router has not decided yet (it decides in
// the assemble step, after this gate; t212), so the check runs once it names its pick
// (`condenseForTheDialedModel`, from `call-llm/reassemble-for-fit.ts`), never against a stand-in (round 5).
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { checkAndCompact, estimateAssembledTokens, leavingFromView } from '../../../../memory/compaction.js';
import type { LeavingView } from '../../../../memory/tail-horizon.js';
import { getContextWindow } from '../../../model.js';
import { backgroundDrains } from '../../../shared-state.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext } from './index.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { replacePlaceholdersInBackground } from '../../../../memory/uncondensed-placeholder.js';
import { noteAPersonSpoke } from '../../../../memory/summary-writer-health.js';

const logger = createLogger('v2-loop');

/** Round 5: the model each agent's gate last measured the routine check for (absent: left to the call step). */
const routineMeasuredAtGate = new Map<string, string>();
export function routineCheckMeasuredAtGate(agentId: string, modelId: string): boolean {
  return routineMeasuredAtGate.get(agentId) === modelId;
}

/** The context gate. It never ends the turn: a full view is condensed, never surrendered (t194). */
export async function runContextGates(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const { agentId, contextWindow: turnWindow, contextModelId, configuredModelId, isAutoRouted, counterparty } = ctx;
  // Fix round 1 (review I3): every condense below is MEASURED for the dialed model but WRITTEN
  // by the summary writer resolved from the CONFIGURED model — never by a locked, possibly expensive pick.
  const lockedModelId = isAutoRouted ? state.lockedModelId : null;
  const dialModelId = lockedModelId ?? contextModelId;
  const contextWindow = lockedModelId ? getContextWindow(lockedModelId) : turnWindow;

  // t140 round 7: a person's FRESH message (the turn's trigger row) earns this agent's writers a retry.
  if (state.loopCount === 1 && state.lastUserMessageId) noteAPersonSpoke(agentId);
  // t140 round 3: placeholders are replaced first, in the background, when a writer is answering.
  const replacing = replacePlaceholdersInBackground(agentId);
  // Round 5: an auto-routed iteration with nothing locked has no dialed model yet (header).
  if (isAutoRouted && !lockedModelId) {
    routineMeasuredAtGate.delete(agentId);
    return proceed(state);
  }
  routineMeasuredAtGate.set(agentId, dialModelId);
  const fill = await condenseForTheDialedModel({
    agentId, dialedModelId: dialModelId, contextWindow, writerModelId: configuredModelId, counterparty, measureOnly: replacing,
  });
  // D3: the view's fill — what it wants to show over the room it has — for the anti-hoarding advisory.
  return proceed(fill === null ? state : advance(state, { lastContextRatio: fill }));
}

/** THE ROUTINE CHECK for the model a call will dial, on the gauge (the assembler's own dry run): rows
 *  about to leave the view, or summaries the view drops? Then fold and condense exactly those, in the
 *  background. Returns the view's fill (wanted / room), or null when it could not be measured. Never throws. */
export async function condenseForTheDialedModel(args: {
  agentId: string; dialedModelId: string; contextWindow: number; writerModelId: string;
  /** Unused since t194: the gauge measures the system prompt itself. Kept for the call step's caller. */
  systemPromptTokens?: number;
  counterparty?: TurnCounterparty; measureOnly?: boolean;
}): Promise<number | null> {
  const { agentId, dialedModelId, contextWindow, writerModelId } = args;
  try {
    const { view, total } = await estimateAssembledTokens(agentId, contextWindow, dialedModelId,
      { turnContext: args.counterparty ? { latestUserSource: null, counterparty: args.counterparty } : undefined });
    const leaving = leavingFromView(view);
    if (!args.measureOnly && (leaving || view.summaryRawTokens > view.summaryTokens)) {
      condenseLeavingInBackground({ agentId, writerModelId, dialedModelId, contextWindow, leaving });
    }
    return view.budgetTokens > 0 ? total / view.budgetTokens : null;
  } catch (err) {
    logger.warn('v2: the routine condense check could not be measured', {
      agentId, dialedModelId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/**
 * THE ROUTINE CONDENSE, fire-and-forget (v2.5.14): one in flight per agent (`backgroundDrains`),
 * folding exactly `leaving` (header: no clock, no cap). Measured for `dialedModelId`, WRITTEN by the
 * summary writer resolved from `writerModelId` in the background order (fix round 1, review I3;
 * round 5). A PRESSURE fold, ahead of need; rows an assembly already took out of view are folded by
 * the engine's assembly door instead (`out-of-view-fold.ts`). Returns whether one started.
 */
function condenseLeavingInBackground(args: {
  agentId: string; writerModelId: string; dialedModelId: string; contextWindow: number; leaving: LeavingView | null;
}): boolean {
  const { agentId, writerModelId, dialedModelId, contextWindow, leaving } = args;
  if (backgroundDrains.has(agentId)) return false;
  backgroundDrains.add(agentId);
  logger.info('v2: condensing rows leaving the live view (fire-and-forget)', {
    agentId, cause: leaving?.cause ?? 'summaries-dropped', rowsLeaving: leaving?.rowsLeaving ?? 0, throughSeq: leaving?.throughSeq ?? null,
    dialedModelId, contextWindow,
  }, agentId);
  checkAndCompact(agentId, writerModelId, contextWindow, {
    leaving,
    dialedModelId,
    inTheBackground: true,
  })
    .then((result) => {
      logger.info('v2: background condense complete', {
        agentId, leafCreated: result.leafCreated, condensedCreated: result.condensedCreated, cause: leaving?.cause ?? 'summaries-dropped',
      }, agentId);
    })
    .catch((err) => {
      logger.warn('v2: background condense failed or aborted', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    })
    .finally(() => {
      backgroundDrains.delete(agentId);
    });
  return true;
}
