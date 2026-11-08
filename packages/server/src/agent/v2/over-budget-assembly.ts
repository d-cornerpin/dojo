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
// TWO CASES, DECIDED BY A MEASUREMENT, NEVER BY "IT IS STILL OVER" (fix round 1, orchestrator ruling):
//   · THE AGENT'S INSTRUCTIONS AND TOOLS FIT its window (`agentFits`, the very measurement the no-fit
//     lock's release asks, so a park and its release can never disagree): what is over is the
//     conversation — the live tail, or the rows the loop appended this turn. What changes that is a
//     condense, and the boundary starts one with every size refusal (it rides the error:
//     `refusedDial.condensed`). So the step waits for it to land, then parks the job through the
//     existing full-context-wait door (`parkAfterForcedPass`, t211 D7b): ONE wake, whose turn is ONE
//     re-assembly — or, when the compaction brake binds, the wake at the brake's expiry. Fix round 2:
//     every forced pass records its outcome and always has a next step (`memory/compaction-brakes.ts`),
//     so the rounds CONVERGE: a no-progress pass arms the brake (the park waits), a pass with nothing
//     outside the protected part folds its oldest group, a throw is told once through the compaction
//     card. Never the WINDOW_TOO_SMALL card, never an injury, never the "stuck" text.
//   · THE INSTRUCTIONS AND TOOLS TRULY OVERFLOW (system prompt + tool payload + output reserve exceed the
//     assembly budget): no condense can help. The owner gets the existing WINDOW_TOO_SMALL card, and the
//     agent rides the platform's existing lock for "none of its models can hold it" (`honest-stop.ts`,
//     `no_model_fits`): status `paused` (never `error`), released when its model, tools or the router
//     change so that it fits, and no wake of any kind.
// ════════════════════════════════════════════════════════════════════════════════════════

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

/** The recovery cascade's step for an over-budget assembly. True when it handled the error. */
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
    // Resolves whether the pass ran, was skipped or failed (its own catch logs a failure). v3.5 D18 r5: another pass
    // held the lock, so this turn does not wait on it; it parks, and wakes when that pass lands.
    if (((await condensed) as { lockBusy?: true } | undefined)?.lockBusy) { parkUntilCompactionLands(agentId, 'recovery-over-budget-assembly'); return true; }
    // The park tells a braked skip from a pass that ran: the pass itself recorded which (fix round 3); a pass
    // with nothing to fold lands before this step could have read the brake.
    const last = lastForcedPass(agentId);
    const brakedBefore = condensed ? (last.braked ?? brakedNow) : brakedNow;
    // Fix round 3: the pass bought nothing (the brake is on) and did not throw: nothing left can shrink this
    // assembly. Fix round 4: "did not throw" is THIS pass's fact (the flag is per pass), so a throw on an
    // earlier round can never silence the stall. That is a genuine stall: reported once, with the refusal's own numbers, as a compaction defect
    // (`compaction-defect.ts`), and the park below keeps the existing "stuck" notice for it.
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
