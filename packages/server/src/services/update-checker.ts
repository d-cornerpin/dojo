// Daily, model-free update check: asks GitHub what the dashboard's "Check for updates" button asks and
// caches the answer in the DB. No agent is woken and no update notification is pushed; the agent reads
// the cache on demand via the check_for_update tool.

import { createLogger } from '../logger.js';

const logger = createLogger('update-checker');

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const FIRST_CHECK_DELAY_MS = 60_000;          // settle after boot before the first check

let pollTimer: ReturnType<typeof setInterval> | null = null;
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<void> {
  const { refreshUpdateCache } = await import('../gateway/routes/update.js');
  const entry = await refreshUpdateCache();
  // The running failure count makes a persistently failing check visible in the logs.
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

  firstCheckTimer = setTimeout(() => {
    refresh().catch(err => {
      logger.error('Update check cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, FIRST_CHECK_DELAY_MS);
}

export function stopUpdateChecker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    if (firstCheckTimer) {
      clearTimeout(firstCheckTimer);
      firstCheckTimer = null;
    }
    logger.info('Update checker stopped');
  }
}
