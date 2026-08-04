// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 3 of 3: THE CONTEXT GATES.
//
// The pre-call compaction gate and the routine gap-based drain. Relocated verbatim
// from `agent/v2/loop.ts` (`:3015`–`:3164` at `c1ad4d5`).
//
// The four decisions and their thresholds are the contract and they are copied, not
// re-derived: <90% noop · 90–96% warn (every WARN is a v2 architecture bug, so it
// broadcasts) · 96–99% emergency compact and surrender the turn · ≥99% block. The
// numerator is deliberately COMPRESSIBLE-only against a compressible BUDGET (FA-M1),
// so compaction can never no-op-loop on bloat it cannot shrink.
//
// The drain below it is fire-and-forget on purpose (v2.5.14): it used to be awaited
// through a summarizer call whose only bound was an SDK default, so a hung summarizer
// blocked the turn for up to ten minutes with no error and no log line. It now runs
// in the background under its own wall-clock abort, one in flight per agent.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import {
  checkAndCompact, estimateAssembledTokens, getUncompactedGapCount, UNCOMPACTED_GAP_THRESHOLD,
} from '../../../../memory/compaction.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { backgroundDrains, pendingWakeups } from '../../../shared-state.js';
import { compactionGate } from '../../classifiers/compaction.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

/**
 * The context gates. Returns `proceed` when the assembled context still fits, and
 * ends the turn on the two arms that cannot continue into a model call.
 */
export async function runContextGates(
  state: AgentTurnState,
  ctx: PreCallGatesContext,
): Promise<StepOutcome> {
  const {
    agentId, turnNumber, contextWindow, contextModelId, configuredModelId, isAutoRouted,
    assemblerOverheadTokens, broadcast, stashContinuationIfHuman,
  } = ctx;

  // ── Pre-call compaction gate (Part V) ──
  // Check assembled context utilization BEFORE the model call. v2's
  // architecture is "compaction is a debug signal, not routine":
  //   <90%   noop (the common case)
  //   90–96% warn (log + chat:warning broadcast, every WARN is a v2 architecture bug)
  //   96–99% emergency compact (force checkAndCompact + queue wakeup)
  //   ≥99%   block (surrender turn, recovery cascade re-runs)
  const assembledEstimate = await estimateAssembledTokens(agentId, contextWindow, contextModelId);
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
      const effectiveModel = isAutoRouted ? configuredModelId : configuredModelId;
      await checkAndCompact(agentId, effectiveModel, contextWindow, { force: true });
    } catch (compErr) {
      logger.warn('v2: emergency compaction failed', {
        agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
      }, agentId);
    }
    // Queue wakeup so the next iteration assembles fresh post-compaction context
    stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
    pendingWakeups.add(agentId);
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
      await checkAndCompact(agentId, configuredModelId, contextWindow, { force: true });
    } catch { /* best effort */ }
    stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
    pendingWakeups.add(agentId);
    return requestExit(state, 'context-full' satisfies PreCallGatesExitReason);
  }

  // ── v2.5.11, Routine gap-based compaction trigger ──
  // The token gate above only fires at high utilization. Long-running
  // agents whose fresh tail stays bounded never trip it, so messages
  // silently fall outside the fresh tail without ever being summarized.
  // This check fires when too many uncompacted messages have accumulated
  // outside the fresh tail, regardless of token level.
  //
  // v2.5.12, Per-call cap: maxChunksPerRun=1 so a backlog drains
  // incrementally instead of all at once. skipContinuityBrief=true so
  // routine drains don't pay brief cost or spam chat with dividers.
  //
  // v2.5.14, CRITICAL: fire-and-forget. Previously the agent's turn
  // awaited checkAndCompact, which awaited a summarizer LLM call, which
  // had only the OpenAI SDK's 10-minute default timeout. A hung
  // summarizer call would block the turn for up to 10 minutes with no
  // error and no logs. Now: kick off the drain in the background with
  // a 60s wall-clock abort, and the agent's turn proceeds immediately.
  // backgroundDrains flag prevents re-entry while a drain is in-flight
  // for this agent (so slow drains can't pile up; one in-flight max).
  if (gateResult.decision === 'noop') {
    const gapCount = getUncompactedGapCount(agentId, contextWindow);
    if (gapCount > UNCOMPACTED_GAP_THRESHOLD && !backgroundDrains.has(agentId)) {
      backgroundDrains.add(agentId);
      // Catch-up: a normal turn leaves only a few messages uncompacted, so 1
      // chunk/turn keeps up. But a freshly imported/migrated agent (or one
      // whose summarizer was broken for a while) can carry a huge backlog, 
      // at 1 chunk/turn that takes dozens of turns to clear, which reads as
      // "compacting constantly". Scale throughput (and the wall-clock budget)
      // to the backlog so a big gap drains in a few turns, then settles back
      // to 1. Still background + abortable, so turns never block on it.
      const big = gapCount > UNCOMPACTED_GAP_THRESHOLD * 4;
      const maxChunksPerRun = big ? Math.min(10, Math.ceil(gapCount / UNCOMPACTED_GAP_THRESHOLD)) : 1;
      const wallClockTimeoutMs = big ? 180_000 : 60_000;
      const drainAbort = new AbortController();
      const drainTimeout = setTimeout(() => {
        logger.warn('v2: background drain wall-clock timeout, aborting', {
          agentId, wallClockTimeoutMs,
        }, agentId);
        drainAbort.abort();
      }, wallClockTimeoutMs);
      logger.info('v2: kicking off background gap-drain (fire-and-forget)', {
        agentId, gapCount, gapThreshold: UNCOMPACTED_GAP_THRESHOLD,
        maxChunksPerRun, wallClockTimeoutMs, catchUp: big,
      }, agentId);
      checkAndCompact(agentId, configuredModelId, contextWindow, {
        maxChunksPerRun,
        skipContinuityBrief: true,
        abortSignal: drainAbort.signal,
      })
        .then((result) => {
          logger.info('v2: background gap-drain complete', {
            agentId,
            leafCreated: result.leafCreated,
            tokensReclaimed: result.tokensReclaimed,
          }, agentId);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('v2: background gap-drain failed or aborted', {
            agentId, error: msg,
          }, agentId);
        })
        .finally(() => {
          clearTimeout(drainTimeout);
          backgroundDrains.delete(agentId);
        });
    }
  }

  return proceed(state);
}
