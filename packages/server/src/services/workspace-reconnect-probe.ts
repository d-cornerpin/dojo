// ════════════════════════════════════════
// services/workspace-reconnect-probe.ts — the way back through the one-way door.
//
// A benched Google/Microsoft account (connected=0) used to have NO automatic
// path back: a single bad token-refresh response benched it and only a manual
// Settings re-auth restored it (live incident 2026-07-08 — a healthy Microsoft
// account was benched at ~5:38 PM after flowing mail hours earlier, and stayed
// dead until a human noticed). The classify-before-bench fix stops MOST false
// benches; this probe closes the loop for the rest: every ~30 minutes it
// re-tests each benched account that still holds a refresh token and un-benches
// any whose refresh token still works. Terminal (genuinely dead) accounts stay
// benched WITHOUT re-alerting; transient ones get another chance next cycle.
//
// Cheap: the per-account network refresh only runs when a benched account with
// a refresh token actually exists. A fully-healthy box does one tiny SELECT per
// provider per cycle and returns.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('reconnect-probe');

const PROBE_INTERVAL_MS = 30 * 60 * 1000;   // re-test benched accounts every ~30 minutes
const FIRST_PROBE_DELAY_MS = 5 * 60 * 1000; // settle after boot before the first sweep

let probeTimer: ReturnType<typeof setInterval> | null = null;

async function sweep(): Promise<void> {
  const [
    { listReconnectableMicrosoftAccounts, attemptMicrosoftReconnect },
    { listReconnectableGoogleAccounts, attemptGoogleReconnect },
  ] = await Promise.all([
    import('../microsoft/auth.js'),
    import('../google/auth.js'),
  ]);

  const benchedMs = listReconnectableMicrosoftAccounts();
  const benchedGoogle = listReconnectableGoogleAccounts();
  // Nothing benched with a usable refresh token — do no network work.
  if (benchedMs.length === 0 && benchedGoogle.length === 0) return;

  let reconnected = 0;
  for (const acc of benchedMs) {
    try {
      if ((await attemptMicrosoftReconnect(acc.id)) === 'reconnected') reconnected++;
    } catch (err) {
      logger.warn('Microsoft reconnect probe step failed', { accountId: acc.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const acc of benchedGoogle) {
    try {
      if ((await attemptGoogleReconnect(acc.id)) === 'reconnected') reconnected++;
    } catch (err) {
      logger.warn('Google reconnect probe step failed', { accountId: acc.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info('Workspace reconnect probe swept benched accounts', {
    microsoftBenched: benchedMs.length,
    googleBenched: benchedGoogle.length,
    reconnected,
  });
}

export function startWorkspaceReconnectProbe(): void {
  if (probeTimer) {
    logger.warn('Workspace reconnect probe already running');
    return;
  }
  logger.info('Starting workspace reconnect probe', { probeIntervalMs: PROBE_INTERVAL_MS });

  probeTimer = setInterval(() => {
    sweep().catch(err => {
      logger.error('Workspace reconnect probe cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, PROBE_INTERVAL_MS);

  setTimeout(() => {
    sweep().catch(() => { /* logged inside */ });
  }, FIRST_PROBE_DELAY_MS);
}

export function stopWorkspaceReconnectProbe(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
    logger.info('Workspace reconnect probe stopped');
  }
}
