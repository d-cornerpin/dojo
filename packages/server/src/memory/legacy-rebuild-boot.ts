// Boot-time start of the legacy pass only (never the contamination scan), delayed so provider init and first
// turns are not contended. A throw is logged and swallowed: the run holds no state; the nightly job resumes it.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { rebuildLegacyMixedNotes, type LegacyRebuildStats } from './legacy-notes-rebuild.js';
import { rebuildGuard } from './rebuild-signals.js';
import { openCatchUps, replacePlaceholdersInBackground } from './out-of-view.js';
import { clearOn } from './writer.js';

const logger = createLogger('legacy-rebuild-boot');

export const BOOT_SETTLE_MS = 120_000;

export async function runLegacyRebuildAtBoot(): Promise<LegacyRebuildStats | null> {
  if (rebuildGuard.running) return null;
  let queued = 0;
  try {
    queued = (getDb().prepare("SELECT COUNT(*) AS n FROM summaries WHERE rebuild_state = 'legacy_mixed_rebuild'").get() as { n: number }).n;
    if (queued === 0) return null;
  } catch { return null; }
  rebuildGuard.running = true;
  logger.info('Older mixed notes: boot rebuild starting', { queued });
  try {
    return await rebuildLegacyMixedNotes();
  } catch (err) {
    logger.warn('Older mixed notes: the boot-time rebuild failed; the nightly job resumes it', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    rebuildGuard.running = false;
  }
}

/** Start the background folder for every agent whose catch-up was open at shutdown. Never throws. */
export function resumeCatchUpsAtBoot(): number {
  let started = 0;
  try {
    for (const agentId of openCatchUps()) if (replacePlaceholdersInBackground(agentId)) started++;
    if (started > 0) logger.info('Boot: open memory catch-ups resumed in the background', { started });
  } catch (err) {
    logger.warn('Boot: open catch-ups could not be resumed; each resumes at its agent\'s next turn end', { error: err instanceof Error ? err.message : String(err) });
  }
  return started;
}

/** Called once from boot: a restart lets every waiting writer be asked again, and after the settle the open
 *  catch-ups resume and the older-notes rebuild runs. Returns at once; the timer never holds a process open. */
export function scheduleLegacyRebuildAtBoot(): void {
  clearOn({ kind: 'boot' });
  setTimeout(() => { resumeCatchUpsAtBoot(); void runLegacyRebuildAtBoot(); }, BOOT_SETTLE_MS).unref();
}
