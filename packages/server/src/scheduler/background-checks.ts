// ════════════════════════════════════════════════════════════════════════════════════════
// THE BACKGROUND CHECKS THAT RIDE THE SCHEDULER'S CLOCK (t138).
//
// The platform keeps one clock (`scheduler/clock.ts`, 30 s). Two owner-notice checks ride it
// instead of owning timers of their own. Both are KICKED, never awaited by the tick — a slow
// provider API or a module load must never hold the due scan or the re-entrancy guard hostage —
// and the last kick of each is kept so "has it settled" is answerable.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('scheduler-background-checks');

/** The provider-balance check (#8): a balance that was only checked while the Ledger page was
 *  open is the defect it replaces. It decides for itself whether it is due (`BALANCE_CHECK_EVERY_MS`). */
let lastBalanceKick: Promise<void> = Promise.resolve();

/** Settles once the balance module has LOADED (not once its check is done): the other kicks
 *  load their modules after it, never beside it — two concurrent first loads of one module
 *  graph can stall each other. */
let balanceModuleLoaded: Promise<void> = Promise.resolve();

export function kickBalanceCheck(): void {
  const loaded = import('../costs/provider-balance-check.js');
  balanceModuleLoaded = loaded.then(() => undefined, () => undefined);
  lastBalanceKick = loaded
    .then(async (m) => { await m.maybeCheckProviderBalances(); })
    .catch((err) => {
      logger.error('Provider balance check could not start', { error: err instanceof Error ? err.message : String(err) });
    });
}

// r4: while the owner's low-memory card stands, the tick re-measures memory so its recovery
// ends the card (and re-arms the text) without waiting for the next spawn attempt. Nothing is
// measured while memory has not been reported low. r6: the same kick ends budget cards whose
// window has turned over (the budget's incident is its window).
let lastMemoryKick: Promise<void> = Promise.resolve();

export function kickMemoryRecheck(): void {
  lastMemoryKick = balanceModuleLoaded.then(() => import('../services/memory-low-notice.js')).then(async (m) => {
    // t148: an agent parked on a budget's limit is released when the window turned over. First, and in
    // its own guarded step, so a failure ending the cards below never skips it (the lock module catches).
    await (await import('../agent/v2/honest-stop-lock.js')).releaseClearedBudgetStops();
    // r6: a budget whose window turned over has no live incident; its card leaves now.
    (await import('../costs/budget-cards.js')).endTurnedOverBudgetCards();
    if (!m.memoryLowStanding()) return;
    const { getResourceInfo } = await import('../services/resource-monitor.js');
    m.noteCriticalMemory(getResourceInfo().memory.free);
  }).catch((err) => {
    logger.warn('Memory re-check could not run', { error: err instanceof Error ? err.message : String(err) });
  });
}

// t143 r2: the liveness sweep — an agent silent past its window is told to the owner once. On the
// platform's clock, not the PM's: the owner's notice must never depend on the PM being enabled
// (nor on the balance module's import: a rejected import there must not silence it — t143 r3, M4).
let lastLivenessKick: Promise<void> = Promise.resolve();

export function kickLivenessSweep(): void {
  lastLivenessKick = Promise.resolve().then(() => import('../tracker/liveness.js')).then((m) => { m.sweepSilentAgents(); })
    .catch((err) => {
      logger.warn('Liveness sweep could not run', { error: err instanceof Error ? err.message : String(err) });
    });
}

/** Resolves when the most recently kicked checks have finished (or were not due). */
export function backgroundChecksSettled(): Promise<void> {
  return Promise.all([lastBalanceKick, lastMemoryKick, lastLivenessKick]).then(() => undefined);
}
