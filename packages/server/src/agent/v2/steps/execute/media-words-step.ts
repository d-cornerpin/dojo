// One more model step after a generator starts with no words beside the call, so the agent's words go with
// the media (no engine caption). Never toward an agent (text suppressed); the turn ends after the step.

import { stripMoodMarker } from '@dojo/shared';
import type { TurnContext } from '../../../turn-context.js';
import type { AgentTurnState } from '../../state.js';
import { requestExit, type StepOutcome } from '../step-outcome.js';
import { FIRE_AND_FORGET_GEN_TOOLS } from './tool-sets.js';
import type { ExecuteContext } from './index.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

const GENERATOR_REFUSED_IN_WORDS_STEP =
  '[Engine: a generator already started this turn and its file is on its way. No second generator runs now. Write your line in plain text; that line is all that is left to do.]';

/** The tool door's half: in the granted step a generator call is refused, never run. Null for every other call. */
export function wordsStepRefusal(turnCtx: TurnContext, toolName: string): string | null {
  return turnCtx.mediaWordsStepOwed && FIRE_AND_FORGET_GEN_TOOLS.has(toolName) ? GENERATOR_REFUSED_IN_WORDS_STEP : null;
}

/** The exit after a generator, or null to run on. Reads the words-step flag BEFORE setting it. */
export function endAfterGenerator(state: AgentTurnState, ctx: ExecuteContext, calledGenerator: boolean): StepOutcome | null {
  const { turnCtx, counterparty, result } = ctx;
  const inWordsStep = turnCtx.mediaWordsStepOwed;
  const wordsBesideCall = stripMoodMarker(result.content ?? '').trim().length > 0;
  const grant = calledGenerator && !inWordsStep && !wordsBesideCall && counterparty.kind !== 'agent' && !ctx.interAgentTurn;
  if (grant) turnCtx.mediaWordsStepOwed = true;
  if (!(calledGenerator || inWordsStep) || grant) return null;
  logger.info('v2: fire-and-forget generator called, exiting loop (async delivery)', { agentId: ctx.agentId }, ctx.agentId);
  return requestExit(state, 'fire-and-forget-generator-called');
}
