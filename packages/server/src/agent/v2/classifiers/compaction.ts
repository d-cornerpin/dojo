// ════════════════════════════════════════
// Phase 1A — compaction gate classifier
//
// Per Part V of the v2 plan. Compaction is a debug signal, not a
// feature. This gate decides what to do BEFORE each model call:
//
//   <90% utilization → noop (the common case)
//   90–96%           → warn (log loudly + chat:warning broadcast, do NOT compact)
//   96–99%           → compact (emergency only)
//   ≥99%             → block (truly impossible, surrender turn)
//
// Reuses the existing estimateAssembledTokens primitive from
// memory/compaction.ts (which already correctly measures the
// compressible portion: summaries + fresh tail + brief).
//
// IMPORTANT: WARN level fires when v1 would have compacted (75%
// threshold). Each WARN at 90% is an architectural bug to fix —
// the compaction prevention work in Part XVIII should be eliminating
// these. WARN events double as the v2 punch list.
// ════════════════════════════════════════

import { createLogger } from '../../../logger.js';

const logger = createLogger('v2-compaction-gate');

export type CompactionGateDecision = 'noop' | 'warn' | 'compact' | 'block';

export interface CompactionGateResult {
  decision: CompactionGateDecision;
  ratio: number;          // assembledTokens / compressibleBudget
  assembledTokens: number;
  contextWindow: number;
  compressibleBudget: number; // FA-M1: contextWindow minus non-compressible overhead
  reason?: string;        // populated when decision !== 'noop'
}

export const NOOP_THRESHOLD = 0.90;     // <90% → noop
export const WARN_THRESHOLD = 0.90;     // 90–96% → warn (log + toast, do not compact)
export const COMPACT_THRESHOLD = 0.96;  // 96–99% → emergency compact
export const BLOCK_THRESHOLD = 0.99;    // ≥99% → block

/**
 * Decide what the pre-call gate should do given current context utilization.
 *
 * FA-M1: the numerator stays the COMPRESSIBLE subset (summaries + fresh tail +
 * brief) so compaction never no-op-loops on bloat it cannot shrink. The
 * denominator is the COMPRESSIBLE BUDGET, the full window minus the measured
 * non-compressible overhead (system prompt + tool-schema/output reserve) the
 * caller passes in, NOT the full window. Comparing compressible tokens to the
 * full window understated utilization: on a small (e.g. 64K) window a 15-23%
 * system prompt meant the compressible ratio never reached 0.90, so fresh-tail
 * eviction happened with no WARN. `nonCompressibleOverheadTokens` defaults to 0
 * (old full-window behavior) for callers/tests that don't supply it.
 *
 * Pure function — no side effects beyond the logger WARN inside `gateAndLog`
 * helper below. Tests should call this directly and assert on decision/ratio.
 */
export function compactionGate(
  assembledTokens: number,
  contextWindow: number,
  nonCompressibleOverheadTokens = 0,
): CompactionGateResult {
  if (contextWindow <= 0) {
    return {
      decision: 'noop',
      ratio: 0,
      assembledTokens,
      contextWindow,
      compressibleBudget: 0,
      reason: 'invalid contextWindow (<=0); skipping gate',
    };
  }
  const compressibleBudget = Math.max(1, contextWindow - Math.max(0, nonCompressibleOverheadTokens));
  const ratio = assembledTokens / compressibleBudget;
  if (ratio < WARN_THRESHOLD) {
    return { decision: 'noop', ratio, assembledTokens, contextWindow, compressibleBudget };
  }
  if (ratio < COMPACT_THRESHOLD) {
    return {
      decision: 'warn',
      ratio,
      assembledTokens,
      contextWindow,
      compressibleBudget,
      reason:
        `Compressible context at ${(ratio * 100).toFixed(1)}% of its budget (${assembledTokens}/${compressibleBudget}; window ${contextWindow}). ` +
        `This should not happen in normal operation — investigate tool result sizes, scaffolding injection, system prompt cost. ` +
        `See Part XVIII (Compaction Prevention Architecture).`,
    };
  }
  if (ratio < BLOCK_THRESHOLD) {
    return {
      decision: 'compact',
      ratio,
      assembledTokens,
      contextWindow,
      compressibleBudget,
      reason:
        `Emergency compaction at ${(ratio * 100).toFixed(1)}% of the compressible budget. ` +
        `Prevention failed — investigate and fix root cause.`,
    };
  }
  return {
    decision: 'block',
    ratio,
    assembledTokens,
    contextWindow,
    compressibleBudget,
    reason:
      `Compressible context impossibly full at ${(ratio * 100).toFixed(1)}% of budget. ` +
      `Surrendering turn — recovery cascade will queue a wakeup.`,
  };
}

/**
 * Convenience wrapper: call compactionGate, log + emit a chat:warning
 * broadcast for the WARN case (Part V). Caller still gets the decision
 * back to act on. The broadcast itself is fire-and-forget.
 *
 * Side-effecting — only call this from the actual loop path, not from
 * tests. Tests should call compactionGate() directly.
 */
export function gateAndLog(
  agentId: string,
  assembledTokens: number,
  contextWindow: number,
  broadcast: (event: {
    type: 'chat:error';
    agentId: string;
    error: string;
    code: 'CONTEXT_HIGH';
    severity: 'warning';
    retryable: false;
  }) => void,
  nonCompressibleOverheadTokens = 0,
): CompactionGateResult {
  const result = compactionGate(assembledTokens, contextWindow, nonCompressibleOverheadTokens);
  if (result.decision === 'warn') {
    logger.warn(result.reason ?? 'context utilization warning', {
      agentId,
      ratio: result.ratio,
      assembledTokens,
      contextWindow,
    }, agentId);
    try {
      // Phase 4 §C fix (2026-05-04) — was broadcasting type:'chat:warning'
      // (an event the dashboard doesn't listen for, so toasts never fired).
      // Spec calls for severity='warning' on the standard chat:error event;
      // dashboard renders that as the orange toast variant.
      const ratioPct = (result.ratio * 100).toFixed(0);
      broadcast({
        type: 'chat:error',
        agentId,
        error: `Agent's memory is getting full (${ratioPct}%). Working normally for now.`,
        code: 'CONTEXT_HIGH',
        severity: 'warning',
        retryable: false,
      });
    } catch {
      /* broadcast failure is non-fatal */
    }
  } else if (result.decision === 'compact') {
    logger.error(result.reason ?? 'emergency compaction', {
      agentId,
      ratio: result.ratio,
    }, agentId);
  } else if (result.decision === 'block') {
    logger.error(result.reason ?? 'context impossibly full', {
      agentId,
      ratio: result.ratio,
    }, agentId);
  }
  return result;
}
