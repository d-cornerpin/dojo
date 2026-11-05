// ════════════════════════════════════════
// Migration Import — what happens after a failed import (restart, and telling the owner)
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { ownerCardFrame, ownerCardEnded } from '../services/owner-card-frames.js';

const logger = createLogger('migration-import');

/** The one card this module raises. It stands until the owner dismisses it or an import succeeds. */
const CARD_KEY = 'import-failed-not-running';
let standing: string | null = null;

// The "data could not be put back" card must outlive a restart (a restart does not cure it: Dojo
// comes up on the imported tree and the owner's real data waits in the backup). The existing
// owner cards are re-derived from config rows inside the database, but that database lives in the
// very folder an import swaps, so this one keeps a small marker file BESIDE ~/.dojo instead
// (next to the import lock). The route module binds the real fs and the path once at load.
interface MarkerFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf-8'): string;
  writeFileSync(p: string, data: string): void;
  rmSync(p: string, o: { force: boolean }): void;
}
let marker: { fs: MarkerFs; file: string } | null = null;
export function bindImportCardMarker(fs: MarkerFs, file: string): void { marker = { fs, file }; }
const dropMarker = (): void => { try { marker?.fs.rmSync(marker.file, { force: true }); } catch { /* best effort */ } };
function stuckFromMarker(): { words: string; backupPath: string } | null {
  try {
    if (!marker || !marker.fs.existsSync(marker.file)) return null;
    const m = JSON.parse(marker.fs.readFileSync(marker.file, 'utf-8')) as { words?: unknown; backupPath?: unknown };
    if (typeof m.words !== 'string' || typeof m.backupPath !== 'string') return null;
    if (!marker.fs.existsSync(m.backupPath)) { dropMarker(); return null; } // the backup is gone: nothing left to tell
    return { words: m.words, backupPath: m.backupPath };
  } catch { return null; }
}

function raiseImportCard(words: string): void {
  standing = words;
  // Final round: the card states the fact only (owner rule: the Dojo does the work). It stays until a good import or
  // restart ends it, because the Dojo is not running on his data while it stands.
  ownerCardFrame(words, 'error', CARD_KEY, 'action');
}

/** An import (or a restart) succeeded: the card leaves every open dashboard. */
export function clearImportCard(): void {
  dropMarker();
  if (standing === null) return;
  const words = standing;
  standing = null;
  ownerCardEnded(words, CARD_KEY);
}

/** The cards still standing, for `GET /api/config/owner-notices` (a card outlives a closed browser). */
export function importOwnerCards(): Array<{ words: string; severity: 'critical'; cardKey: string; dismiss: () => void }> {
  const stuck = stuckFromMarker();
  const words = standing ?? stuck?.words ?? null;
  return words === null ? [] : [{ words, severity: 'critical', cardKey: CARD_KEY, dismiss: () => { standing = null; dropMarker(); } }];
}

/** The owner-facing sentence when the old data could not be put back (rename and copy both refused). The path is
 *  exact. Final round: a fact, no chore. */
export function backupStuckWords(backupPath: string): string {
  return `The import did not finish, and Dojo could not put your previous data back by itself, so it did not start again on the imported data. Your data is safe at ${backupPath}.`;
}

const RESTART_FAILED_WORDS = 'The import did not finish, and Dojo could not start its services again by itself. Your data is safe.';

/** The data could not be put back: say so on the dashboard. */
export function noteBackupStuck(backupPath: string): string {
  const words = backupStuckWords(backupPath);
  try { marker?.fs.writeFileSync(marker.file, JSON.stringify({ words, backupPath })); } catch { /* the live card still goes */ }
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
