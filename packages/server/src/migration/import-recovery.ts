// ════════════════════════════════════════
// Migration Import — what happens after a failed import (restart, and telling the owner)
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { ownerCardFrame, ownerCardEnded } from '../services/owner-card-frames.js';

const logger = createLogger('migration-import');

/** The one card this module raises. It stands until the owner dismisses it or an import succeeds. */
const CARD_KEY = 'import-failed-not-running';
let standing: string | null = null;

function raiseImportCard(words: string): void {
  standing = words;
  ownerCardFrame(words, 'error', CARD_KEY);
}

/** An import (or a restart) succeeded: the card leaves every open dashboard. */
export function clearImportCard(): void {
  if (standing === null) return;
  const words = standing;
  standing = null;
  ownerCardEnded(words, CARD_KEY);
}

/** The cards still standing, for `GET /api/config/owner-notices` (a card outlives a closed browser). */
export function importOwnerCards(): Array<{ words: string; severity: 'critical'; cardKey: string; dismiss: () => void }> {
  return standing === null ? [] : [{ words: standing, severity: 'critical', cardKey: CARD_KEY, dismiss: () => { standing = null; } }];
}

/** The owner-facing sentence when the old data could not be put back. The path is exact. */
export function backupStuckWords(backupPath: string): string {
  return `The import did not finish and your previous data could not be put back automatically, so Dojo was not restarted. Your data is safe at ${backupPath}. Move it back to .dojo, then restart Dojo from the menu bar.`;
}

const RESTART_FAILED_WORDS = 'The import did not finish and Dojo could not restart itself. Your data is safe. Restart Dojo from the menu bar.';

/** The data could not be put back: say so on the dashboard. */
export function noteBackupStuck(backupPath: string): string {
  const words = backupStuckWords(backupPath);
  raiseImportCard(words);
  return words;
}

/**
 * After a failed import that had already stopped services (and closed the database), bring the
 * Dojo back: the caller's restart re-opens the database. It runs again even if the success-path
 * restart already ran on a tree since swapped out. A failing restart is logged and raised as an
 * owner card; it never replaces the original error, which the caller rethrows. Returns the words
 * the owner was told when the restart failed, else null.
 */
export async function restartAfterFailedImport(opts: {
  servicesStopped: boolean;
  restartServices: () => Promise<void>;
}): Promise<string | null> {
  if (!opts.servicesStopped) return null;
  try {
    await opts.restartServices();
    clearImportCard();
    return null;
  } catch (restartErr) {
    logger.error('Failed to restart services after failed import', { error: restartErr instanceof Error ? restartErr.message : String(restartErr) });
    raiseImportCard(RESTART_FAILED_WORDS);
    return RESTART_FAILED_WORDS;
  }
}
