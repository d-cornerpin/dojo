// ════════════════════════════════════════
// Migration Import — restart after a failed import
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('migration-import');

/**
 * After a failed import that had already stopped services (and closed the database), bring the
 * Dojo back: the caller's restart re-opens the database. Skipped when nothing was stopped (a restart that already ran on a tree since swapped
 * out must run again on the restored one). A failing restart is logged and never replaces the original error, which
 * the caller rethrows.
 */
export async function restartAfterFailedImport(opts: {
  servicesStopped: boolean;
  restartServices: () => Promise<void>;
}): Promise<void> {
  if (!opts.servicesStopped) return;
  try {
    await opts.restartServices();
  } catch (restartErr) {
    logger.error('Failed to restart services after failed import', { error: restartErr instanceof Error ? restartErr.message : String(restartErr) });
  }
}

/** The owner-facing sentence when the old data could not be put back. The path is exact. */
export function backupStuckWords(backupPath: string): string {
  return `The import did not finish and your previous data could not be put back automatically, so Dojo was not restarted. Your data is safe at ${backupPath}. Move it back to .dojo, then restart Dojo from the menu bar.`;
}
