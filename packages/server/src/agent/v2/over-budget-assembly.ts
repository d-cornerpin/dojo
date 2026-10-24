// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 — AN OVER-BUDGET ASSEMBLY CONDENSES OR STOPS WITH THE CARD; IT IS NEVER AN INJURY.
//
// The provider boundary refuses an array over its budget that it cannot repair
// (`memory/assembly-validation.ts`). That refusal is the ENGINE's (`isEngineAssemblyFault`), and before
// this step it matched nothing in the recovery cascade and fell to `recordInjury`: status `error`, the
// Healer's auto-wake re-running the IDENTICAL assembly 5 s apart, three times, then the "stuck" text
// (the dev log, 2026-10-19 16:41). Nothing in that assembly changes between re-runs, so a re-run only
// re-proves the same arithmetic.
//
// What changes it is a condense, and the boundary starts one with every size refusal (it rides the
// error: `refusedDial.condensed`). So:
//   · THE FIRST REFUSAL waits for that condense, then parks the job through the forced-pass door the
//     other recovery compactions use (`parkAfterForcedPass`): ONE wake, whose turn is the ONE
//     re-assembly. Not an injury; the Healer never hears of it.
//   · THE RE-ASSEMBLY STILL OVER (the woken turn's first dial refused again, or a refusal with nothing
//     condensed because the system prompt alone leaves no room): no condense can help — the agent's
//     instructions and tools overflow the window. The owner gets the existing WINDOW_TOO_SMALL card,
//     and the agent rides the platform's existing lock for "none of its models can hold it"
//     (`honest-stop.ts`, `no_model_fits`): status `paused` (never `error`), released when its model,
//     tools or the router change, and no wake of any kind.
//
// The chain's identity is the turn number, the idiom `doomedPrefillCompactionSpent` uses
// (`shared-state.ts`): turn numbers are gapless per agent, so "this refusal is the woken turn's first
// dial" is `condensedAt === turnNumber - 1 && loopCount <= 1`. A refusal later in a turn that already
// dialed (its own tool results grew it) is a fresh chain and condenses again.
// ════════════════════════════════════════════════════════════════════════════════════════

import { AssemblyValidationError } from '../../memory/assembly-validation.js';
import { compactionBrakeMsLeft } from '../../memory/compaction-brakes.js';
import { reportStarvedWindow } from '../../memory/window-starvation-card.js';
import { createLogger } from '../../logger.js';
import { AgentError } from '../errors.js';
import { honestStopWords } from './error-format.js';
import { NO_MODEL_FITS_CODE } from './honest-stop-lock.js';
import { parkAfterForcedPass } from './full-context-wait.js';
import type { AgentTurnState } from './state.js';

const logger = createLogger('v2-over-budget-assembly');

/** agentId -> the turn whose over-budget refusal was condensed (its next turn is the re-assembly). */
const condensedAt = new Map<string, number>();

/** The boundary's SIZE refusal in an error's cause chain, or null (a shape refusal is not one). */
function sizeRefusalOf(err: unknown): AssemblyValidationError | null {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e instanceof AssemblyValidationError && e.refusedDial) return e;
  }
  return null;
}

/** The recovery cascade's step for an over-budget assembly. True when it handled the error. */
export async function tryOverBudgetAssemblyRecovery(state: AgentTurnState, error: unknown): Promise<boolean> {
  const refusal = sizeRefusalOf(error);
  if (!refusal?.refusedDial) return false;
  const { agentId, turnNumber, loopCount } = state;
  const { modelId, systemPromptTokens, condensed } = refusal.refusedDial;
  const reassembly = condensedAt.get(agentId) === turnNumber - 1 && loopCount <= 1;
  condensedAt.delete(agentId);

  if (condensed && !reassembly) {
    const brakedBefore = compactionBrakeMsLeft(agentId) !== null;   // read as the gate reads it: before the pass lands
    await condensed;
    condensedAt.set(agentId, turnNumber);
    logger.warn('over-budget assembly: condensed; the next turn re-assembles once', { agentId, turnNumber, modelId }, agentId);
    parkAfterForcedPass(agentId, 'recovery-over-budget-assembly', brakedBefore);
    return true;
  }

  logger.warn('over-budget assembly: still over after a condense; the window cannot hold this agent', { agentId, turnNumber, modelId }, agentId);
  const [{ dialedPolicy }, { tryHonestStopRecovery }] = await Promise.all([
    import('./steps/call-llm/reassemble-for-fit.js'), import('./honest-stop.js'),
  ]);
  reportStarvedWindow(agentId, systemPromptTokens, (await dialedPolicy(agentId, modelId)).policy);
  return tryHonestStopRecovery(state, new AgentError(honestStopWords('no_model_fits'), agentId, { code: NO_MODEL_FITS_CODE, cause: refusal }));
}

/** Test-only reset; the map is per-process. */
export function __resetOverBudgetAssemblyForTests(): void {
  condensedAt.clear();
}
