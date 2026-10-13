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
// background under its own wall-clock abort, one in flight per agent.
//
// t140: EVERY ARM MEASURES THE WINDOW OF THE MODEL THIS ITERATION WILL DIAL. On an auto-routed
// turn whose tool loop has locked a model, that is the locked model, not the turn's provisional
// `'__auto__'` window (which is the roomiest routed pick — `agent/model.ts`'s
// `routedContextWindow`). Before the lock, the provisional window is the best fact there is,
// and `reassemble-for-fit` sizes the array down to the real pick before dial.
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

const logger = createLogger('v2-loop');

/**
 * t140: the system prompt each agent's assembler last produced, in tokens. The first gate of a
 * turn runs before that turn's first assembly, so its own measurement is still 0; the system
 * prompt is static per agent (the cache-preservation tenet is what keeps it so), so the last
 * measurement stands in for it rather than letting the view-full check run blind for one call.
 */
const lastSystemPromptTokens = new Map<string, number>();

/**
 * The routine condense's bounds: the most leaf chunks one background run may summarise and its
 * wall-clock abort. A ceiling fold is one step of rows (half the row ceiling), which is a
 * handful of 30K-token chunks at most; ten chunks and three minutes are the old catch-up
 * drain's own bounds, kept rather than re-derived.
 */
const ROUTINE_CONDENSE_MAX_CHUNKS = 10;
const ROUTINE_CONDENSE_WALL_CLOCK_MS = 180_000;

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
  // Still fire-and-forget (v2.5.14), still one in flight per agent, still under a wall clock.
  const measuredSystemTokens = Math.max(0, assemblerOverheadTokens - (assembledEstimate.reserveTokens ?? 0));
  if (assemblerOverheadTokens > 0) lastSystemPromptTokens.set(agentId, measuredSystemTokens);
  const systemPromptTokens = assemblerOverheadTokens > 0 ? measuredSystemTokens : (lastSystemPromptTokens.get(agentId) ?? 0);
  const viewFull = liveViewIsFull(assembledEstimate, systemPromptTokens);
  const leaving = rowsLeavingView(agentId, { freshTailCount: getFreshTailCount(contextWindow) }, { viewFull });
  if (leaving) {
    condenseLeavingInBackground({ agentId, writerModelId: configuredModelId, dialedModelId: dialModelId, contextWindow, leaving });
  }

  return proceed(state);
}

/**
 * THE ROUTINE CONDENSE, fire-and-forget (v2.5.14): one in flight per agent (`backgroundDrains`),
 * under its own wall clock, folding exactly `leaving`. Measured for `dialedModelId`, WRITTEN by the
 * summary writer resolved from `writerModelId` (fix round 1, review I3). Shared by this gate and,
 * since fix round 1 (review M3), by `call-llm/reassemble-for-fit.ts` — a re-fit that sets rows
 * aside for a smaller pick folds them for THAT pick's window. Returns whether a condense started.
 */
export function condenseLeavingInBackground(args: {
  agentId: string; writerModelId: string; dialedModelId: string; contextWindow: number; leaving: LeavingView;
}): boolean {
  const { agentId, writerModelId, dialedModelId, contextWindow, leaving } = args;
  if (backgroundDrains.has(agentId)) return false;
  backgroundDrains.add(agentId);
  const condenseAbort = new AbortController();
  const condenseTimeout = setTimeout(() => {
    logger.warn('v2: background condense wall-clock timeout, aborting', {
      agentId, wallClockTimeoutMs: ROUTINE_CONDENSE_WALL_CLOCK_MS,
    }, agentId);
    condenseAbort.abort();
  }, ROUTINE_CONDENSE_WALL_CLOCK_MS);
  logger.info('v2: condensing rows leaving the live view (fire-and-forget)', {
    agentId, cause: leaving.cause, rowsLeaving: leaving.rowsLeaving, throughSeq: leaving.throughSeq,
    dialedModelId, contextWindow,
  }, agentId);
  checkAndCompact(agentId, writerModelId, contextWindow, {
    leaving,
    dialedModelId,
    maxChunksPerRun: ROUTINE_CONDENSE_MAX_CHUNKS,
    abortSignal: condenseAbort.signal,
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
      clearTimeout(condenseTimeout);
      backgroundDrains.delete(agentId);
    });
  return true;
}
