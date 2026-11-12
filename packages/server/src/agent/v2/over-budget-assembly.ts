// Two cases by measurement: instructions and tools fit (agentFits, the measure the no-fit lock releases on), so
// wait for the condense and park for one wake; or they overflow, so the WINDOW_TOO_SMALL card and the lock.

import { AssemblyValidationError } from '../../memory/assembly-validation.js';
import { compactionBrakeMsLeft, lastForcedPass } from '../../memory/compaction-brakes.js';
import { reportStarvedWindow } from '../../memory/window-starvation-card.js';
import { createLogger } from '../../logger.js';
import { AgentError } from '../errors.js';
import { isEngineAssemblyFault } from './classifiers/provider.js';
import { honestStopWords } from './error-format.js';
import { NO_MODEL_FITS_CODE } from './honest-stop-lock.js';
import { parkAfterForcedPass, parkUntilCompactionLands } from './full-context-wait.js';
import type { AgentTurnState } from './state.js';

const logger = createLogger('v2-over-budget-assembly');

/** The boundary's SIZE refusal in an error's cause chain, or null (a shape refusal carries no `refusedDial`). */
function sizeRefusalOf(err: unknown): AssemblyValidationError | null {
  if (!isEngineAssemblyFault(err)) return null;   // the one cause-chain walk for this type
  let e: unknown = err;
  while (e instanceof Error && !(e instanceof AssemblyValidationError)) e = e.cause;
  return e instanceof AssemblyValidationError && e.refusedDial ? e : null;
}

/** The recovery cascade's step for an over-budget assembly, never an injury (a re-run cannot change it). */
export async function tryOverBudgetAssemblyRecovery(state: AgentTurnState, error: unknown): Promise<boolean> {
  const refusal = sizeRefusalOf(error);
  if (!refusal?.refusedDial) return false;
  const { agentId, turnNumber } = state;
  const { modelId, systemPromptTokens, condensed } = refusal.refusedDial;
  const [{ agentFits, tryHonestStopRecovery }, { dialedPolicy }] = await Promise.all([
    import('./honest-stop.js'), import('./steps/call-llm/reassemble-for-fit.js'),
  ]);

  if (await agentFits(agentId)) {
    const brakedNow = compactionBrakeMsLeft(agentId) !== null;
    if (((await condensed) as { lockBusy?: true } | undefined)?.lockBusy) { parkUntilCompactionLands(agentId, 'recovery-over-budget-assembly'); return true; }
    // The pass recorded whether it was braked; a pass with nothing to fold lands before this step reads the brake.
    const last = lastForcedPass(agentId);
    const brakedBefore = condensed ? (last.braked ?? brakedNow) : brakedNow;
    // The brake is on and this pass did not throw: nothing can shrink the assembly, so report a compaction defect.
    if (compactionBrakeMsLeft(agentId) !== null && !last.threw) {
      (await import('../../memory/compaction-defect.js')).reportCompactionDefect(agentId, 'nothing_left_to_shrink',
        { assembledTokens: refusal.refusedDial.tokenTotal, budgetTokens: refusal.refusedDial.budgetTokens }, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    }
    logger.warn('over-budget assembly: the conversation outgrew the window; condensed, the next turn re-assembles', { agentId, turnNumber, modelId }, agentId);
    // Quiet only after a THROW (the compaction card tells the owner); a genuine stall keeps the existing "stuck" notice.
    parkAfterForcedPass(agentId, 'recovery-over-budget-assembly', brakedBefore, { quiet: last.threw });
    return true;
  }

  logger.warn('over-budget assembly: the instructions and tools alone overflow this agent\'s window', { agentId, turnNumber, modelId }, agentId);
  reportStarvedWindow(agentId, systemPromptTokens, (await dialedPolicy(agentId, modelId)).policy);
  return tryHonestStopRecovery(state, new AgentError(honestStopWords('no_model_fits'), agentId, { code: NO_MODEL_FITS_CODE, cause: refusal }));
}
