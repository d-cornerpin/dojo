import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { getPMAgentId, getTrainerAgentId, getHealerAgentId } from '../config/platform.js';
import { soulFileForAgent, readSoulFile, writeSoulFile } from './assembler.js';

const logger = createLogger('shipped-souls');

/**
 * Replaces the PM, Trainer and Healer souls on disk with the shipped template, once per version.
 * The primary's SOUL.md is never listed; an unreadable version replaces nothing.
 */
export function refreshShippedSoulsOnce(version: string): string[] {
  if (!/^\d/.test(version)) return [];
  const db = getDb();
  const seen = db.prepare("SELECT value FROM config WHERE key = 'shipped_souls_version'").get() as
    | { value: string } | undefined;
  if (seen?.value === version) return [];
  const replaced: string[] = [];
  for (const id of [getPMAgentId(), getTrainerAgentId(), getHealerAgentId()]) {
    const soul = soulFileForAgent(id);
    if (!soul || soul.file === 'SOUL.md' || !soul.fallback) continue;
    // `readSoulFile` seeds an absent file with the shipped version, which is already what is wanted.
    if (readSoulFile(soul) === soul.fallback) continue;
    writeSoulFile(soul, soul.fallback);
    replaced.push(soul.file);
  }
  setConfigValue('shipped_souls_version', version);
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
