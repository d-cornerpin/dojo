// ════════════════════════════════════════
// Phase 1E — continuation classifier
//
// Per Part VI #13. v1 hard-caps at MAX_TOOL_LOOPS=75 and auto-continues
// in a fresh turn (runtime.ts:1666). v2 makes the decision smarter:
// instead of an arbitrary cap, the engine uses progressClassifier to
// decide whether to continue or stop.
//
//   continuationClassifier returns:
//     'continue' — agent IS progressing, schedule a fresh turn
//     'stop'     — agent is stuck or hit a hard cap, end the run
//
// Hard caps still exist (state.validate enforces 500 max loops) so
// runaway loops can't grind forever. But the SOFT decision (do we
// auto-continue at the typical end-of-turn point?) is now informed
// by real progress signals, not a static count.
// ════════════════════════════════════════

import { progressClassifier, type ProgressInput } from './progress.js';

export interface ContinuationInput {
  /** Loop count this turn. */
  loopCount: number;
  /** Hard cap (matches v1 MAX_TOOL_LOOPS = 75 by default). */
  loopCapSoft: number;
  /** Continuation count for THIS task across turns (matches v1 turnContinuationCounts). */
  continuationCount: number;
  /** Hard continuation cap (matches v1 MAX_TURN_AUTO_CONTINUATIONS = 3). */
  continuationCapHard: number;
  /** Progress signals to feed into progressClassifier. */
  progress: ProgressInput;
}

export type ContinuationDecision =
  | { decision: 'continue'; reason: string }
  | { decision: 'stop'; reason: string };

export function continuationClassifier(input: ContinuationInput): ContinuationDecision {
  // Hard continuation cap — same as v1 (MAX_TURN_AUTO_CONTINUATIONS = 3).
  // After 3 continuations of long-running work, force the agent to stop.
  if (input.continuationCount >= input.continuationCapHard) {
    return {
      decision: 'stop',
      reason: `continuation cap reached (${input.continuationCount} of ${input.continuationCapHard})`,
    };
  }

  // Below the soft loop cap — no need to continue, the loop will keep going.
  if (input.loopCount < input.loopCapSoft) {
    return {
      decision: 'continue',
      reason: `loop count ${input.loopCount} below soft cap ${input.loopCapSoft} — keep going`,
    };
  }

  // Hit the soft cap. Use progress signals to decide.
  const prog = progressClassifier(input.progress);
  if (prog.progressing) {
    return {
      decision: 'continue',
      reason: `hit loop cap ${input.loopCapSoft} but progressing — auto-continue`,
    };
  }
  return {
    decision: 'stop',
    reason: `hit loop cap ${input.loopCapSoft} and ${prog.reason}`,
  };
}

export const CONTINUATION_DEFAULTS = {
  LOOP_CAP_SOFT: 75,                  // matches v1 MAX_TOOL_LOOPS
  CONTINUATION_CAP_HARD: 3,           // matches v1 MAX_TURN_AUTO_CONTINUATIONS
} as const;
