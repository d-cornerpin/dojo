// ════════════════════════════════════════
// Phase 1E — progress classifier
//
// Per Part VI #18 and Part XVIII §F. Detects when the agent appears
// to be spinning (lots of turns, no real progress). The engine uses
// this BEFORE breaking — instead of cutting the agent off cold, it
// injects a system note giving the model one chance to confirm
// progress or signal blocked.
//
// Spinning signals (any one is enough; combine for higher confidence):
//   1. Many tool calls with NEW results (turn delta > 500 tokens) but
//      no progress on the original task — fuzzy, hard to detect, skip.
//   2. Many tool calls returning identical or near-identical results.
//   3. Repeated permission denials.
//   4. Repeated empty / no-results from search tools.
//   5. Token delta per turn very small for many consecutive turns.
//
// We measure (3), (4), (5) — they're cheap and accurate. (1) and (2)
// require deeper analysis and are deferred to Phase 4 if they prove
// to matter.
// ════════════════════════════════════════

export interface ProgressInput {
  /** Total tool calls executed across this and recent turns. */
  toolCallsExecutedThisTurn: number;
  /** How many of the last N turns had token delta < SMALL_DELTA_TOKENS. */
  consecutiveSmallDeltas: number;
  /** Current consecutive permission denials. */
  consecutivePermissionDenials: number;
  /** Tool calls that returned "no results" / "not found" in the last batch. */
  consecutiveNoResultTools: number;
  /** Number of times the spinning nudge has already fired this turn (state.spinningNudgeCount). */
  spinningNudgeCount: number;
  /** Loop count this turn. */
  loopCount: number;
}

export type ProgressDecision =
  | { progressing: true; reason: string }
  | { progressing: false; reason: string; signals: string[] };

const SMALL_DELTA_THRESHOLD = 3;             // turns with <500 token delta
const PERMISSION_DENIAL_THRESHOLD = 5;        // matches v1 runtime.ts:1505
const NO_RESULTS_THRESHOLD = 3;
const MAX_SPINNING_NUDGES = 3;                // Part XVIII §F

export function progressClassifier(input: ProgressInput): ProgressDecision {
  const signals: string[] = [];

  // Hard cap: if we've already nudged 3 times and the agent kept going
  // without progress, assume spinning is real and don't block here.
  // The loop-level break is enforced separately.
  if (input.spinningNudgeCount >= MAX_SPINNING_NUDGES) {
    return {
      progressing: false,
      reason: `spinning nudge cap reached (${input.spinningNudgeCount} >= ${MAX_SPINNING_NUDGES}) — engine should break`,
      signals: ['nudge cap'],
    };
  }

  // Signal 1: small deltas across many turns
  if (input.consecutiveSmallDeltas >= SMALL_DELTA_THRESHOLD) {
    signals.push(`${input.consecutiveSmallDeltas} consecutive small-delta turns`);
  }

  // Signal 2: permission denials piling up
  if (input.consecutivePermissionDenials >= PERMISSION_DENIAL_THRESHOLD) {
    signals.push(`${input.consecutivePermissionDenials} consecutive permission denials`);
  }

  // Signal 3: search tools returning nothing repeatedly
  if (input.consecutiveNoResultTools >= NO_RESULTS_THRESHOLD) {
    signals.push(`${input.consecutiveNoResultTools} consecutive no-result tool calls`);
  }

  if (signals.length === 0) {
    return { progressing: true, reason: 'no spinning signals fired' };
  }

  return {
    progressing: false,
    reason: `spinning suspected: ${signals.join(' + ')}`,
    signals,
  };
}

/**
 * Build the nudge text the engine injects when spinning is suspected.
 * Per Part XVIII §F — the model gets ONE chance to confirm progress
 * or signal blocked before the engine breaks unilaterally.
 *
 * FN-8: complete_task is only available to agents that may self-complete
 * (see agentCanSelfComplete in agent/tools.ts), so the caller passes
 * `canSelfComplete` and the wording branches. Naming complete_task to an
 * agent that doesn't have it invites a call the engine guard will refuse.
 */
export function buildSpinningNudge(input: ProgressInput, canSelfComplete: boolean): string {
  const turns = input.loopCount;
  const stuckAdvice = canSelfComplete
    ? `If you're stuck, summarize what's blocking you and call complete_task with ` +
      `status='blocked' and a clear explanation of what you need.]`
    : `If you're stuck, stop and explain what's blocking you in your reply so ` +
      `the user can act. If the work is actually done, mark it done ` +
      `(e.g. work_update(action="status")) and wrap up.]`;
  return (
    `[System: You've been working for ${turns} turn${turns === 1 ? '' : 's'} ` +
    `with little visible progress. ` +
    `If you're still making real progress on the original task, continue normally. ` +
    stuckAdvice
  );
}

/** Constants exported for tests / external introspection. */
export const PROGRESS_THRESHOLDS = {
  SMALL_DELTA_THRESHOLD,
  PERMISSION_DENIAL_THRESHOLD,
  NO_RESULTS_THRESHOLD,
  MAX_SPINNING_NUDGES,
} as const;
