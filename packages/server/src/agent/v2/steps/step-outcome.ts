// ════════════════════════════════════════
// PHASE-6 — THE STEP CONTRACT AND THE EXIT-REQUEST CHANNEL
//
// A step is a DIRECTORY under `agent/v2/steps/` (RULING P6-R1) with one entry
// point. Every entry point has the same shape: it takes `(state, ctx)` — the
// turn's state plus everything else its span read from the driver — and returns
// a `StepOutcome`: the state it advanced, and what it wants the driver to do
// next. This file is that contract, and it is deliberately the only thing the
// nine step packages share, so nine tranches cannot grow nine conventions.
//
// ── WHY THE REQUEST IS A RETURN VALUE AND NOT A FIELD ──
// `loop.ts` records the defect this replaces, in its own words, at the main
// loop's head:
//
//     "internal phase transitions during the body (preCallGates → assemble →
//      callLLM → postCallClassify → execute → postExecution) keep overwriting
//      `phase`, so setting `phase: 'done'` mid-body never survives to the next
//      boundary check."
//
// A step that asks to stop by writing `phase` is writing a field the next step
// overwrites. The surviving workaround is `taskClosedWithTextThisTurn` — a
// set-only flag the `while` head reads — and it works for exactly one reason:
// nothing overwrites it. That is a property of that one flag, not of the
// mechanism, and it does not generalise to nine steps.
//
// So the request IS the return value. The driver reads it at the call site,
// where nothing can overwrite it, and honours it immediately.
//
// ── THE THREE RULES EVERY STEP'S CONTRACT TEST ASSERTS ──
//   1. A step that requests exit RETURNS at that point. It never keeps
//      executing after asking to stop. A step that requests exit and then runs
//      its remaining gates is the failure mode this channel exists to remove.
//   2. A step NEVER writes `state.phase`. The driver advances the phase on the
//      transition INTO the step — through `advance`, so `validate()` runs on
//      that transition — and the step's body has no business overwriting it.
//   3. Exit is not sayable without a reason. The `'exit'` arm carries `reason`
//      BY CONSTRUCTION, so "the loop stopped and nothing recorded why" is not a
//      state this type can express.
//
// ── `continue` vs `proceed` ──
// They differ for every step that is not the last statement of the loop body:
// `continue` abandons the rest of the ITERATION, `proceed` runs the steps after
// it. For the tail step they coincide, and the vocabulary still carries both so
// the tranches behind it do not have to invent the distinction later.
// ════════════════════════════════════════

import type { AgentTurnState } from '../state.js';

export type StepDirective = 'proceed' | 'continue' | 'exit';

/**
 * What a step hands back. `state` is always the advanced state — the driver
 * assigns it before honouring the directive, so an exiting step's last
 * transitions are never lost.
 */
export type StepOutcome =
  | { readonly directive: 'proceed'; readonly state: AgentTurnState }
  | { readonly directive: 'continue'; readonly state: AgentTurnState }
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

/** Run the steps after this one in the same iteration. */
export function proceed(state: AgentTurnState): StepOutcome {
  return { directive: 'proceed', state };
}

/** Abandon the rest of THIS iteration; the loop head decides whether to run another. */
export function continueLoop(state: AgentTurnState): StepOutcome {
  return { directive: 'continue', state };
}

/**
 * Ask the driver to leave the loop, and say why. The reason is required: a
 * turn that stopped for a reason nobody recorded is the shape the turn record
 * exists to make impossible.
 */
export function requestExit(state: AgentTurnState, reason: string): StepOutcome {
  return { directive: 'exit', state, reason };
}
