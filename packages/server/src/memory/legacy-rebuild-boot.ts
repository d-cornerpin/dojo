// t144 — THE UPDATE'S OWN START OF THE REBUILD OF OLDER MIXED NOTES, once per boot instead of waiting for
// the first nightly window. SAFE FORM ONLY: just the legacy pass (never the contamination scan), a no-op
// with nothing queued, never alongside another run (the shared guard), detached after a settle delay so
// provider init, channel reconnect and the first owner turns are not contended, and a run that throws is
// logged and swallowed — it holds no state, so a crash cannot repeat at the next boot (no crash loop,
// update-integrity standard). The nightly job stays the backstop.
//
// Field fix Y (orchestrator ruling, round 2): the boot's memory start also RESUMES every open catch-up
// (`out-of-view.ts`). Its card promises "this finishes on its own", and an update restarts the server,
// so a catch-up must not wait for the agent's next turn: after the same settle, the background folder is
// started for each agent whose record is open. It yields to live turns as always.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { rebuildLegacyMixedNotes, type LegacyRebuildStats } from './legacy-notes-rebuild.js';
import { rebuildGuard } from './rebuild-signals.js';
import { openCatchUps, replacePlaceholdersInBackground } from './out-of-view.js';

const logger = createLogger('legacy-rebuild-boot');

/** How long after boot the start waits. */
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

/** Field fix Y: start the background folder for every agent whose catch-up was open at shutdown. Never throws. */
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

/** Called once from boot. Returns at once; the timer is unref'd so it never holds a process open. */
export function scheduleLegacyRebuildAtBoot(): void {
  setTimeout(() => { resumeCatchUpsAtBoot(); void runLegacyRebuildAtBoot(); }, BOOT_SETTLE_MS).unref();
}
