// OWNER DECISION 33 lives here, apart from the assembler it calls.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getPMAgentId, getTrainerAgentId, getHealerAgentId, getImaginerAgentId } from '../config/platform.js';
import { soulFileForAgent, readSoulFile, writeSoulFile } from './assembler.js';

const logger = createLogger('shipped-souls');

/**
 * OWNER DECISION 33 — DOJO-SUPPLIED SOULS ARE REPLACED ON UPDATE, EVEN IF EDITED.
 *
 * The PM, Trainer, Healer and Imaginer souls are shipped doctrine, not the owner's words. Once
 * per platform version (the stored `shipped_souls_version`), every one that already sits in
 * `~/.dojo/prompts` is overwritten with the shipped template, substituted exactly as at
 * creation (the same `fallback` the first-read seed writes). An absent file is left to that
 * first-read seed. The Dreamer's soul is not file-backed: `vault/maintenance.ts` already
 * rewrites it from its template on every check. THE PRIMARY'S SOUL IS NEVER IN THIS LIST: it is
 * written from the owner's setup answers, and no code path here can reach `SOUL.md`.
 *
 * Returns the file names replaced. An unreadable version stamps and replaces nothing, so a
 * broken manifest cannot make every boot clobber an owner's later edit.
 */
export function refreshShippedSoulsOnce(version: string): string[] {
  if (!/^\d/.test(version)) return [];
  const db = getDb();
  const seen = db.prepare("SELECT value FROM config WHERE key = 'shipped_souls_version'").get() as
    | { value: string } | undefined;
  if (seen?.value === version) return [];
  const replaced: string[] = [];
  for (const id of [getPMAgentId(), getTrainerAgentId(), getHealerAgentId(), getImaginerAgentId()]) {
    const soul = soulFileForAgent(id);
    if (!soul || soul.file === 'SOUL.md' || !soul.fallback) continue;
    // `readSoulFile` seeds an absent file with the shipped version, which is already what is wanted.
    if (readSoulFile(soul) === soul.fallback) continue;
    writeSoulFile(soul, soul.fallback);
    replaced.push(soul.file);
  }
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('shipped_souls_version', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(version);
  if (replaced.length) logger.info('Dojo-supplied souls replaced with the shipped version', { version, files: replaced });
  return replaced;
}


/** The boot hook: refresh once per version; never fatal (the souls on disk keep being read). */
export async function refreshShippedSoulsAtBoot(): Promise<void> {
  try {
    const { getCurrentVersion } = await import('../gateway/routes/update.js');
    refreshShippedSoulsOnce(getCurrentVersion());
  } catch (err) {
    logger.warn('Shipped-soul refresh failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}
