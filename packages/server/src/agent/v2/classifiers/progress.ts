// Detects apparent spinning (many turns, no real progress). Before breaking, the
// engine injects one system note: the model gets a chance to confirm progress or
// signal blocked. Measured: denials, no-result searches, small token deltas.

export interface ProgressInput {
  toolCallsExecutedThisTurn: number;
  consecutiveSmallDeltas: number;
  consecutivePermissionDenials: number;
  consecutiveNoResultTools: number;
  /** Times the nudge fired this turn (twin: state.spinningNudgeCount). */
  spinningNudgeCount: number;
  loopCount: number;
}

export type ProgressDecision =
  | { progressing: true; reason: string }
  | { progressing: false; reason: string; signals: string[] };

const SMALL_DELTA_THRESHOLD = 3;             // turns with <500 token delta
const PERMISSION_DENIAL_THRESHOLD = 5;        // consecutive denials that count as spinning
const NO_RESULTS_THRESHOLD = 3;
const MAX_SPINNING_NUDGES = 3;                // nudges are finite; past this the engine breaks

export function progressClassifier(input: ProgressInput): ProgressDecision {
  const signals: string[] = [];

  // Past the nudge cap spinning is real: report not progressing; the loop breaks.
  if (input.spinningNudgeCount >= MAX_SPINNING_NUDGES) {
    return {
      progressing: false,
      reason: `spinning nudge cap reached (${input.spinningNudgeCount} >= ${MAX_SPINNING_NUDGES}) — engine should break`,
      signals: ['nudge cap'],
    };
  }

  if (input.consecutiveSmallDeltas >= SMALL_DELTA_THRESHOLD) {
    signals.push(`${input.consecutiveSmallDeltas} consecutive small-delta turns`);
  }

  if (input.consecutivePermissionDenials >= PERMISSION_DENIAL_THRESHOLD) {
    signals.push(`${input.consecutivePermissionDenials} consecutive permission denials`);
  }

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

// The nudge gives ONE chance before the engine breaks; complete_task is named
// only when the agent may self-complete, never naming a tool the guard refuses.
export function buildSpinningNudge(input: ProgressInput, canSelfComplete: boolean): string {
  const turns = input.loopCount;
  const stuckAdvice = canSelfComplete
    ? `If you're stuck, summarize what's blocking you and call complete_task with ` +
      `status='blocked' and a clear explanation of what you need.]`
    : `If you're stuck, stop and explain what's blocking you in your reply so ` +
      `the user can act. If the work is actually done, record it with ` +
      `its result (e.g. work_update(action="status")).]`;
  return (
    `[System: You've been working for ${turns} turn${turns === 1 ? '' : 's'} ` +
    `with little visible progress. ` +
    `If you're still making real progress on the original task, continue normally. ` +
    stuckAdvice
  );
}

export const PROGRESS_THRESHOLDS = {
  SMALL_DELTA_THRESHOLD,
  PERMISSION_DENIAL_THRESHOLD,
  NO_RESULTS_THRESHOLD,
  MAX_SPINNING_NUDGES,
} as const;
