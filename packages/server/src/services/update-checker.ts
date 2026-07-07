// ════════════════════════════════════════
// services/update-checker.ts — daily, model-free update check.
//
// Once a day the engine asks GitHub the same question the dashboard's "Check
// for updates" button asks, and writes the answer (installed version, latest
// version, release notes) to a DB cache. That's it — no agent is woken, no
// model call is spent.
//
// The agent reads that cache on demand via the check_for_update tool. So
// staying informed about updates is the OWNER's call: they can have their
// agent check on a recurring schedule if they want, or just ask ad hoc — but
// we never push an update notification (or burn a model call) on our own.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('update-checker');

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const FIRST_CHECK_DELAY_MS = 60_000;          // settle after boot before the first check

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  const { refreshUpdateCache } = await import('../gateway/routes/update.js');
  const entry = await refreshUpdateCache();
  // refreshUpdateCache folds this outcome into the consecutive-failure counter
  // (FA-D6); surface the running count here so a persistently-failing check is
  // visible in the logs too, not only via the Healer/owner health signal.
  logger.info('Update cache refreshed', {
    current: entry.currentVersion,
    latest: entry.latestVersion,
    updateAvailable: entry.updateAvailable,
    error: entry.error ?? null,
    consecutiveCheckFailures: entry.consecutiveCheckFailures ?? 0,
    checkPipelineFailing: entry.checkPipelineFailing ?? false,
  });
}

export function startUpdateChecker(): void {
  if (pollTimer) {
    logger.warn('Update checker already running');
    return;
  }
  logger.info('Starting daily update checker', { pollIntervalMs: POLL_INTERVAL_MS });

  pollTimer = setInterval(() => {
    refresh().catch(err => {
      logger.error('Update check cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  setTimeout(() => {
    refresh().catch(() => { /* logged inside */ });
  }, FIRST_CHECK_DELAY_MS);
}

export function stopUpdateChecker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Update checker stopped');
  }
}
