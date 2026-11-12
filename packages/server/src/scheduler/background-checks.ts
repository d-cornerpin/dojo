// Background checks that ride the scheduler's clock. Each is kicked, never awaited by the tick, so a slow
// provider API or module load cannot hold the due scan or the re-entrancy guard.

import { createLogger } from '../logger.js';

const logger = createLogger('scheduler-background-checks');

let lastBalanceKick: Promise<void> = Promise.resolve();

// Settles when the balance module loads; the memory kick loads after it (concurrent first loads can stall).
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

let lastMemoryKick: Promise<void> = Promise.resolve();

export function kickMemoryRecheck(): void {
  lastMemoryKick = balanceModuleLoaded.then(() => import('../services/memory-low-notice.js')).then(async (m) => {
    // Release budget-parked agents first so a failure in the card sweeps below never skips it.
    await (await import('../agent/v2/honest-stop-lock.js')).releaseClearedBudgetStops();
    (await import('../healer/owner-notice-kinds.js')).sweepOwnerNotices();
    if (!m.memoryLowStanding()) return;
    const { getResourceInfo } = await import('../services/resource-monitor.js');
    m.noteCriticalMemory(getResourceInfo().memory.free);
  }).catch((err) => {
    logger.warn('Memory re-check could not run', { error: err instanceof Error ? err.message : String(err) });
  });
}

// Independent of the PM and the balance import, so neither can silence the owner notice.
let lastLivenessKick: Promise<void> = Promise.resolve();

export function kickLivenessSweep(): void {
  lastLivenessKick = Promise.resolve().then(() => import('../tracker/liveness.js')).then((m) => { m.sweepSilentAgents(); })
    .catch((err) => {
      logger.warn('Liveness sweep could not run', { error: err instanceof Error ? err.message : String(err) });
    });
}

export function backgroundChecksSettled(): Promise<void> {
  return Promise.all([lastBalanceKick, lastMemoryKick, lastLivenessKick]).then(() => undefined);
}
