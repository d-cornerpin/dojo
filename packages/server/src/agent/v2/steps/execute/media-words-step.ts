// ════════════════════════════════════════
// THE WORDS STEP — one more model step after a generator starts, so the agent's own words go with the media.
//
// A picture, voice, song or video is made in the background and arrives later with NO caption from the Dojo (owner
// ruling: the engine writes no words for the agent). The agent's words are therefore the only text that goes with it.
// The loop used to end the moment a generator returned, so the tool result's "write that line in this turn" came after
// the agent's last chance to act: the only way to obey was text in the same response as the call, which models rarely
// write. Now a successful generator with no words beside the call grants ONE more model step.
//
// The exit the generator causes stays, and so does its reason (no retry-storm, no second generator, no wandering):
//   • words already beside the call -> they count and are not asked for again, the turn ends as before;
//   • a turn whose text goes nowhere (an agent counterparty: A2A text is suppressed) -> ends as before, no spend;
//   • otherwise the next step runs with every generator refused (`run-one.ts`), and whatever it does the turn ends
//     after it (`index.ts`). The words are the step's ordinary text, so they ride the ordinary reply routing for the
//     turn's origin: the dashboard chat, the person's iMessage thread, or the dashboard alone for a background turn.
// ════════════════════════════════════════

import { stripMoodMarker } from '@dojo/shared';
import type { TurnContext } from '../../../turn-context.js';
import type { AgentTurnState } from '../../state.js';
import { requestExit, type StepOutcome } from '../step-outcome.js';
import { FIRE_AND_FORGET_GEN_TOOLS } from './tool-sets.js';
import type { ExecuteContext } from './index.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

/** Told to the agent when it asks for a second generator in the words step. */
const GENERATOR_REFUSED_IN_WORDS_STEP =
  '[Engine: a generator already started this turn and its file is on its way. No second generator runs now. Write your line in plain text; that line is all that is left to do.]';

/** The tool door's half: in the granted step a generator call is refused, never run. Null for every other call. */
export function wordsStepRefusal(turnCtx: TurnContext, toolName: string): string | null {
  return turnCtx.mediaWordsStepOwed && FIRE_AND_FORGET_GEN_TOOLS.has(toolName) ? GENERATOR_REFUSED_IN_WORDS_STEP : null;
}

/**
 * The turn's end after the response's tools ran, as far as generators are concerned. Returns the exit to take, or null
 * to let the loop run on (the step is granted here, or this response IS the granted step and so is the last).
 * The flag is read BEFORE it can be set: it says whether THIS response is the granted step.
 */
export function endAfterGenerator(state: AgentTurnState, ctx: ExecuteContext, calledGenerator: boolean): StepOutcome | null {
  const { turnCtx, counterparty, result } = ctx;
  const inWordsStep = turnCtx.mediaWordsStepOwed;
  const wordsBesideCall = stripMoodMarker(result.content ?? '').trim().length > 0;
  // An agent counterparty's text is suppressed, so a step there would buy words nobody reads.
  const grant = calledGenerator && !inWordsStep && !wordsBesideCall && counterparty.kind !== 'agent' && !ctx.interAgentTurn;
  if (grant) turnCtx.mediaWordsStepOwed = true;
  if (!(calledGenerator || inWordsStep) || grant) return null;
  logger.info('v2: fire-and-forget generator called, exiting loop (async delivery)', { agentId: ctx.agentId }, ctx.agentId);
  return requestExit(state, 'fire-and-forget-generator-called');
}
