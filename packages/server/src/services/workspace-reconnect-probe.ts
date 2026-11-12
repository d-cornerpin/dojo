// The way back for a benched Google/Microsoft account (connected=0): every ~30 minutes, re-test each benched
// account that still holds a refresh token and un-bench any whose token still works. Terminal accounts stay
// benched without re-alerting; transient ones get another chance next cycle. The network refresh runs only when
// such an account exists, so a healthy box does one small SELECT per provider per cycle.

import { createLogger } from '../logger.js';

const logger = createLogger('reconnect-probe');

const PROBE_INTERVAL_MS = 30 * 60 * 1000;   // re-test benched accounts every ~30 minutes
const FIRST_PROBE_DELAY_MS = 5 * 60 * 1000; // settle after boot before the first sweep

let probeTimer: ReturnType<typeof setInterval> | null = null;
let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Nothing benched with a usable refresh token: no network work.
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

  firstSweepTimer = setTimeout(() => {
    sweep().catch(err => {
      logger.error('Workspace reconnect probe cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, FIRST_PROBE_DELAY_MS);
}

export function stopWorkspaceReconnectProbe(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
    logger.info('Workspace reconnect probe stopped');
  }
  if (firstSweepTimer) {
    clearTimeout(firstSweepTimer);
    firstSweepTimer = null;
  }
}
