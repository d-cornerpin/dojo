// A step asks to stop by RETURNING the request at that point: it runs no later gate and never writes
// `state.phase` (later steps overwrite it). `exit` leaves the loop and finalize runs; `abandon` skips it.

import type { AgentTurnState } from '../state.js';

/** The driver assigns `state` before honouring the directive, so an exiting step's transitions survive. */
export type StepOutcome =
  | { readonly directive: 'proceed'; readonly state: AgentTurnState }
  | { readonly directive: 'continue'; readonly state: AgentTurnState }
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string }
  | { readonly directive: 'abandon'; readonly state: AgentTurnState; readonly reason: string };

export function proceed(state: AgentTurnState): StepOutcome {
  return { directive: 'proceed', state };
}

/** `proceed` runs the steps after this one; `continue` skips them and the loop head decides on another. */
export function continueLoop(state: AgentTurnState): StepOutcome {
  return { directive: 'continue', state };
}

export function requestExit(state: AgentTurnState, reason: string): StepOutcome {
  return { directive: 'exit', state, reason };
}

// Only for a stop or preempt mid model call: the driver must return, never break, so only its finally runs.
export function abandonTurn(state: AgentTurnState, reason: string): StepOutcome {
  return { directive: 'abandon', state, reason };
}

/** Preflight makes the state and publishes it live on `turnCtx.state`, so its outcome carries none. */
export type PreflightOutcome<Outputs> =
  | { readonly directive: 'proceed'; readonly outputs: Outputs }
  | { readonly directive: 'abandon'; readonly reason: string };

export function preflightProceed<T>(outputs: T): PreflightOutcome<T> {
  return { directive: 'proceed', outputs };
}

// The driver returns before its main try opens, so neither finalize nor the teardown finally runs.
export function preflightAbandon<T>(reason: string): PreflightOutcome<T> {
  return { directive: 'abandon', reason };
}
