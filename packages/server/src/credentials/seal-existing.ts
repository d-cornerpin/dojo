// Seals token columns that already hold plaintext, at boot (SQLite has no AES, so not a .sql migration).
// It never writes a column itself: each provider's update function is the one place that seals.

import { getDb } from '../db/connection.js';
import { isSealedText } from './at-rest.js';
import { createLogger } from '../logger.js';

const logger = createLogger('secret-at-rest');

type TokenPatch = { accessToken?: string; refreshToken?: string };

interface TokenTable {
  table: 'google_accounts' | 'microsoft_accounts';
  update: (id: string, patch: TokenPatch) => void;
}

/** Seal plaintext token columns in place; idempotent. Returns COLUMNS converted, not rows. */
function sealTable(spec: TokenTable): number {
  const rows = getDb()
    .prepare(`SELECT id, access_token, refresh_token FROM ${spec.table}`)
    .all() as Array<{ id: string; access_token: string | null; refresh_token: string | null }>;
  let converted = 0;
  for (const r of rows) {
    const patch: TokenPatch = {};
    if (r.access_token && !isSealedText(r.access_token)) patch.accessToken = r.access_token;
    if (r.refresh_token && !isSealedText(r.refresh_token)) patch.refreshToken = r.refresh_token;
    const n = Object.keys(patch).length;
    if (n === 0) continue;
    spec.update(r.id, patch);
    converted += n;
  }
  return converted;
}

/** Seal both providers' tokens; runs at boot after the legacy seed so new rows never rest plaintext. */
export async function sealWorkspaceTokensAtRest(): Promise<number> {
  // Never throws: boot must still serve mail from existing tokens when the master key is unreadable.
  try {
    const { updateGoogleAccount } = await import('../google/accounts.js');
    const { updateMicrosoftAccount } = await import('../microsoft/accounts.js');
    const converted =
      sealTable({ table: 'google_accounts', update: updateGoogleAccount }) +
      sealTable({ table: 'microsoft_accounts', update: updateMicrosoftAccount });
    if (converted > 0) logger.info('Sealed Workspace account tokens at rest', { columns: converted });
    return converted;
  } catch (err) {
    logger.warn('Workspace token at-rest conversion failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
