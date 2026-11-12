// Soft continue/stop at end of turn: progress signals decide, not a static count.
// Hard caps still exist (state.validate enforces 500 max loops) to end runaways.

import { progressClassifier, type ProgressInput } from './progress.js';

export interface ContinuationInput {
  loopCount: number;
  loopCapSoft: number;
  /** Continuation count for THIS task across turns. */
  continuationCount: number;
  continuationCapHard: number;
  progress: ProgressInput;
}

export type ContinuationDecision =
  | { decision: 'continue'; reason: string }
  | { decision: 'stop'; reason: string };

export function continuationClassifier(input: ContinuationInput): ContinuationDecision {
  // Past the hard continuation cap: force stop.
  if (input.continuationCount >= input.continuationCapHard) {
    return {
      decision: 'stop',
      reason: `continuation cap reached (${input.continuationCount} of ${input.continuationCapHard})`,
    };
  }

  if (input.loopCount < input.loopCapSoft) {
    return {
      decision: 'continue',
      reason: `loop count ${input.loopCount} below soft cap ${input.loopCapSoft} — keep going`,
    };
  }

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
  LOOP_CAP_SOFT: 75,                  // loops per turn before progress is consulted
  CONTINUATION_CAP_HARD: 3,           // auto-continuations allowed per task
} as const;
