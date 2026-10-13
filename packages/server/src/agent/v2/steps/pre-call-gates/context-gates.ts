// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 3 of 3: THE CONTEXT GATES.
//
// The pre-call compaction gate and the routine condense of rows leaving the live view.
// Relocated from `agent/v2/loop.ts` (`:3015`–`:3164` at `c1ad4d5`); the routine arm rewritten
// at t140 (see the block above it).
//
// The four decisions and their thresholds are the contract and they are copied, not
// re-derived: <90% noop · 90–96% warn (every WARN is a v2 architecture bug, so it
// broadcasts) · 96–99% emergency compact and surrender the turn · ≥99% block. The
// numerator is deliberately COMPRESSIBLE-only against a compressible BUDGET (FA-M1),
// so compaction can never no-op-loop on bloat it cannot shrink.
//
// The routine condense below it is fire-and-forget on purpose (v2.5.14): it used to be
// awaited through a summarizer call whose only bound was an SDK default, so a hung summarizer
// blocked the turn for up to ten minutes with no error and no log line. It runs in the
// background, one in flight per agent, with no clock or chunk cap of its own (round 5, owner ruling
// 2026-10-13): it folds exactly the rows leaving, and ends only on Stop, the turn setting it aside,
// or the writer's own transport patience — a 60 s clock refused a real summary on a user's box.
//
// t140: THE ROUTINE CONDENSE MEASURES THE MODEL THIS ITERATION WILL DIAL — a fixed model, or an
// auto-routed loop's locked one. With nothing locked the router has not decided (it reads the
// assembled array), so the check runs once it names its pick (`condenseForTheDialedModel`, from
// `call-llm/reassemble-for-fit.ts`), never against the building window (round 5).
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import {
  checkAndCompact, estimateAssembledTokens, forcedCompactionOptions, liveViewIsFull,
} from '../../../../memory/compaction.js';
import { rowsLeavingView, type LeavingView } from '../../../../memory/tail-horizon.js';
import { getFreshTailCount } from '../../../../memory/budget.js';
import { getContextWindow } from '../../../model.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { backgroundDrains, queueSelfWake } from '../../../shared-state.js';
import { compactionGate } from '../../classifiers/compaction.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';
import { replacePlaceholdersInBackground, registerBackgroundCompaction, releaseBackgroundCompaction } from '../../../../memory/uncondensed-placeholder.js';

const logger = createLogger('v2-loop');

/**
 * t140: the system prompt each agent's assembler last produced, in tokens. The first gate of a
 * turn runs before that turn's first assembly, so its own measurement is still 0; the system
 * prompt is static per agent (the cache-preservation tenet is what keeps it so), so the last
 * measurement stands in for it rather than letting the view-full check run blind for one call.
 */
const lastSystemPromptTokens = new Map<string, number>();

/** Round 5: the model each agent's gate last measured the routine check for (absent: left to the call step). */
const routineMeasuredAtGate = new Map<string, string>();
export function routineCheckMeasuredAtGate(agentId: string, modelId: string): boolean {
  return routineMeasuredAtGate.get(agentId) === modelId;
}

/**
 * The context gates. Returns `proceed` when the assembled context still fits, and
 * ends the turn on the two arms that cannot continue into a model call.
 */
export async function runContextGates(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, contextWindow: turnWindow, contextModelId, configuredModelId, isAutoRouted,
    assemblerOverheadTokens, broadcast, stashContinuationIfHuman,
  } = ctx;
  // Fix round 1 (review I3): every condense below is MEASURED for the dialed model but WRITTEN
  // by the summary writer resolved from the CONFIGURED model — `'auto'` resolves to the owner's
  // compaction model, else the cheapest text model — never by a locked, possibly expensive pick.
  // The model this iteration will dial, and its window (see the header).
  const lockedModelId = isAutoRouted ? state.lockedModelId : null;
  const dialModelId = lockedModelId ?? contextModelId;
  const contextWindow = lockedModelId ? getContextWindow(lockedModelId) : turnWindow;

  // ── Pre-call compaction gate (Part V) ──
  // Check assembled context utilization BEFORE the model call. v2's
  // architecture is "compaction is a debug signal, not routine":
  //   <90%   noop (the common case)
  //   90–96% warn (log + chat:warning broadcast, every WARN is a v2 architecture bug)
  //   96–99% emergency compact (force checkAndCompact + queue wakeup)
  //   ≥99%   block (surrender turn, recovery cascade re-runs)
  const assembledEstimate = await estimateAssembledTokens(agentId, contextWindow, dialModelId);
  // FA-M1: gate the compressible total against the compressible BUDGET (window
  // minus the non-compressible overhead the assembler produced), not the full
  // window. The numerator stays compressible-only so compaction still never
  // no-op-loops on bloat it cannot shrink.
  const gateResult = compactionGate(assembledEstimate.total, contextWindow, assemblerOverheadTokens);
  // D3: remember this iteration's utilization so the anti-hoarding advisory
  // can nudge on real context pressure instead of raw load-count.
  state = advance(state, { lastContextRatio: gateResult.ratio });
  if (gateResult.decision === 'warn') {
    // The chat:warning toast comes from compaction.ts internal WARN block
    // when checkAndCompact runs, but in WARN-only mode we don't call
    // checkAndCompact. Fire the broadcast directly so dashboard surfaces it.
    logger.warn(gateResult.reason ?? 'context utilization warning', {
      agentId, ratio: gateResult.ratio, assembledTokens: gateResult.assembledTokens,
    }, agentId);
    try {
      // User-facing: plain language. Internal reason goes to logs only.
      const ratioPct = (gateResult.ratio * 100).toFixed(0);
      broadcast({
        type: 'chat:error',
        agentId,
        error: `Agent's memory is getting full (${ratioPct}%). Working normally for now.`,
        code: 'CONTEXT_HIGH',
        severity: 'warning',
        retryable: false,
      });
    } catch { /* best effort */ }
    // Continue the turn, WARN is informational, not a blocker.
  } else if (gateResult.decision === 'compact') {
    logger.error(gateResult.reason ?? 'emergency compaction', {
      agentId, ratio: gateResult.ratio,
    }, agentId);
    try {
      await checkAndCompact(agentId, configuredModelId, contextWindow, { ...forcedCompactionOptions(), dialedModelId: dialModelId });
    } catch (compErr) {
      logger.warn('v2: emergency compaction failed', {
        agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
      }, agentId);
    }
    // Queue wakeup so the next iteration assembles fresh post-compaction context
    stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
    queueSelfWake(agentId, 'context-gate-rebuild');
    return requestExit(state, 'context-emergency-compact' satisfies PreCallGatesExitReason);
  } else if (gateResult.decision === 'block') {
    logger.error(gateResult.reason ?? 'context impossibly full', {
      agentId, ratio: gateResult.ratio,
    }, agentId);
    const blockMsg = (
      `[System: Memory is too full to continue this turn (${(gateResult.ratio * 100).toFixed(0)}%). ` +
      `Pausing, the DOJO will compact memory and resume automatically.]`
    );
    const blockMsgId = uuidv4();
    insertMessageIfAbsent({ id: blockMsgId, agentId, role: 'system', content: blockMsg, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: blockMsgId, agentId, role: 'system' as const,
        content: blockMsg,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    // Force compaction then wakeup so we recover next turn
    try {
      await checkAndCompact(agentId, configuredModelId, contextWindow, { ...forcedCompactionOptions(), dialedModelId: dialModelId });
    } catch { /* best effort */ }
    stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
    queueSelfWake(agentId, 'context-gate-rebuild');
    return requestExit(state, 'context-full' satisfies PreCallGatesExitReason);
  }

  // ── t140: THE ROUTINE ARM CONDENSES ONLY ROWS LEAVING THE LIVE VIEW ──────────────────────
  //
  // OWNER RULING (OR-V333-SET (1), decision #16 re-opened and reversed 2026-10-12): condense
  // only when the working view is getting full for the model actually used, or messages are
  // about to leave view — and then only the messages leaving view, never what the agent is
  // reading.
  //
  // STRIP: what stood here was the v2.5.11 row-gap drain — more than 30 unsummarised rows
  // outside the newest row cap fired a summarise "regardless of token level". After t94 the
  // live view is every row since the boundary, so it folded rows the model was reading word for
  // word, moved the boundary and broke the cache behind the summaries lane; a busy mailbox
  // crossed 30 rows within a few small asks. requirement preserved: "summaries exist before a
  // row leaves the view" — `rowsLeavingView` answers which rows are leaving, with the tail
  // horizon's ceiling as the single owner of that number, and folds them BEFORE the cut.
  //
  // "Full" is measured against the admission budget of the window this iteration will dial
  // (`liveViewIsFull`, off the same dry run as the gate above). The noop AND warn arms both
  // reach here: warn means the view is filling, and the rows leaving it are owed their fold.
  // Still fire-and-forget (v2.5.14), still one in flight per agent.
  const measuredSystemTokens = Math.max(0, assemblerOverheadTokens - (assembledEstimate.reserveTokens ?? 0));
  if (assemblerOverheadTokens > 0) lastSystemPromptTokens.set(agentId, measuredSystemTokens);
  const systemPromptTokens = assemblerOverheadTokens > 0 ? measuredSystemTokens : (lastSystemPromptTokens.get(agentId) ?? 0);
  // t140 round 3: placeholders are replaced first, in the background, when a writer is eligible.
  const replacing = replacePlaceholdersInBackground(agentId);
  // Round 5: an auto-routed iteration with nothing locked has no dialed model yet (header).
  if (isAutoRouted && !lockedModelId) {
    routineMeasuredAtGate.delete(agentId);
  } else {
    routineMeasuredAtGate.set(agentId, dialModelId);
    if (!replacing) {
      await condenseForTheDialedModel({
        agentId, dialedModelId: dialModelId, contextWindow, writerModelId: configuredModelId, systemPromptTokens, estimate: assembledEstimate,
      });
    }
  }

  return proceed(state);
}

/** THE ROUTINE CHECK for the model a call will dial: full for ITS window, or rows about to leave it? Then
 *  fold exactly those, in the background. `estimate`: the gate's own dry run. Never throws. */
export async function condenseForTheDialedModel(args: {
  agentId: string; dialedModelId: string; contextWindow: number; writerModelId: string; systemPromptTokens: number;
  estimate?: Awaited<ReturnType<typeof estimateAssembledTokens>>;
}): Promise<boolean> {
  const { agentId, dialedModelId, contextWindow, writerModelId, systemPromptTokens } = args;
  try {
    const estimate = args.estimate ?? await estimateAssembledTokens(agentId, contextWindow, dialedModelId);
    const viewFull = liveViewIsFull(estimate, systemPromptTokens);
    const leaving = rowsLeavingView(agentId, { freshTailCount: getFreshTailCount(contextWindow) }, { viewFull });
    return leaving ? condenseLeavingInBackground({ agentId, writerModelId, dialedModelId, contextWindow, leaving }) : false;
  } catch (err) {
    logger.warn('v2: the routine condense check could not be measured', {
      agentId, dialedModelId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return false;
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
  agentId: string; writerModelId: string; dialedModelId: string; contextWindow: number; leaving: LeavingView;
}): boolean {
  const { agentId, writerModelId, dialedModelId, contextWindow, leaving } = args;
  if (backgroundDrains.has(agentId)) return false;
  backgroundDrains.add(agentId);
  const condenseAbort = new AbortController();
  registerBackgroundCompaction(agentId, condenseAbort);   // the turn's out-of-view fold may set it aside
  logger.info('v2: condensing rows leaving the live view (fire-and-forget)', {
    agentId, cause: leaving.cause, rowsLeaving: leaving.rowsLeaving, throughSeq: leaving.throughSeq,
    dialedModelId, contextWindow,
  }, agentId);
  checkAndCompact(agentId, writerModelId, contextWindow, {
    leaving,
    dialedModelId,
    abortSignal: condenseAbort.signal,
    inTheBackground: true,
  })
    .then((result) => {
      logger.info('v2: background condense complete', {
        agentId, leafCreated: result.leafCreated, cause: leaving.cause,
      }, agentId);
    })
    .catch((err) => {
      logger.warn('v2: background condense failed or aborted', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    })
    .finally(() => {
      releaseBackgroundCompaction(agentId, condenseAbort);
      backgroundDrains.delete(agentId);
    });
  return true;
}
