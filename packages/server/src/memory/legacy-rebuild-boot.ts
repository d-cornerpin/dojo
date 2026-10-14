// t144 — THE UPDATE'S OWN START OF THE REBUILD OF OLDER MIXED NOTES, once per boot instead of waiting for
// the first nightly window. SAFE FORM ONLY: just the legacy pass (never the contamination scan), a no-op
// with nothing queued, never alongside another run (the shared guard), detached after a settle delay so
// provider init, channel reconnect and the first owner turns are not contended, and a run that throws is
// logged and swallowed — it holds no state, so a crash cannot repeat at the next boot (no crash loop,
// update-integrity standard). The nightly job stays the backstop.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { rebuildLegacyMixedNotes, type LegacyRebuildStats } from './legacy-notes-rebuild.js';
import { rebuildGuard } from './rebuild-signals.js';

const logger = createLogger('legacy-rebuild-boot');

/** How long after boot the start waits. */
export const BOOT_SETTLE_MS = 120_000;

export async function runLegacyRebuildAtBoot(): Promise<LegacyRebuildStats | null> {
  if (rebuildGuard.running) return null;
  try {
    if (!getDb().prepare("SELECT 1 FROM summaries WHERE rebuild_state = 'legacy_mixed_rebuild' LIMIT 1").get()) return null;
  } catch { return null; }
  rebuildGuard.running = true;
  try {
    return await rebuildLegacyMixedNotes();
  } catch (err) {
    logger.warn('Older mixed notes: the boot-time rebuild failed; the nightly job resumes it', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    rebuildGuard.running = false;
  }
}

/** Called once from boot. Returns at once; the timer is unref'd so it never holds a process open. */
export function scheduleLegacyRebuildAtBoot(): void {
  setTimeout(() => { void runLegacyRebuildAtBoot(); }, BOOT_SETTLE_MS).unref();
}
