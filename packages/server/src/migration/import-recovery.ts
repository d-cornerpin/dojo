// Migration import: what happens after a failed import (restart, and telling the owner).

import { createLogger } from '../logger.js';
import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';

const logger = createLogger('migration-import');

/** The one card this module raises. It stands until the owner dismisses it or an import succeeds. */
const CARD_KEY = 'import-failed-not-running';
let standing: string | null = null;

// The "data could not be put back" card must outlive a restart. The database lives in the folder an import
// swaps, so its truth is a marker file beside ~/.dojo (next to the import lock); binding re-raises the card.
interface MarkerFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf-8'): string;
  writeFileSync(p: string, data: string): void;
  rmSync(p: string, o: { force: boolean }): void;
}
let marker: { fs: MarkerFs; file: string } | null = null;
export function bindImportCardMarker(fs: MarkerFs, file: string): void {
  marker = { fs, file };
  const stuck = stuckFromMarker();
  if (stuck) tellOwner(CARD_KEY, stuck.words);
}
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
  standing = words;   // a fact only; it stands until a good import or restart ends it
  tellOwner(CARD_KEY, words);
}

export function clearImportCard(): void {
  dropMarker();
  standing = null;
  ownerConditionCleared(CARD_KEY);
}

/** Does the import card still stand: raised in this process, or its marker beside ~/.dojo? */
export const importCardStands = (): boolean => standing !== null || stuckFromMarker() !== null;
export function importCardDismissed(): void { standing = null; dropMarker(); }

/** Owner-facing sentence when the old data could not be put back (rename and copy both refused). */
export function backupStuckWords(backupPath: string): string {
  return `The import did not finish, and Dojo could not put your previous data back by itself, so it did not start again on the imported data. Your data is safe at ${backupPath}.`;
}

const RESTART_FAILED_WORDS = 'The import did not finish, and Dojo could not start its services again by itself. Your data is safe.';

export function noteBackupStuck(backupPath: string): string {
  const words = backupStuckWords(backupPath);
  try { marker?.fs.writeFileSync(marker.file, JSON.stringify({ words, backupPath })); } catch { /* the live card still goes */ }
  raiseImportCard(words);
  return words;
}

/**
 * After a failed import that had stopped services (and closed the database), restart them so the database
 * re-opens. Runs even if the success-path restart already ran on a swapped-out tree. A failing restart is
 * raised as an owner card and never replaces the original error. Returns the owner's words, else null.
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
