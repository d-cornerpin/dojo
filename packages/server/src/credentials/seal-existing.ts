// ════════════════════════════════════════════════════════════════════════════
// CONVERTING SECRET COLUMNS THAT ALREADY HOLD PLAINTEXT — ONE OWNER
// (PHASE-5 T10, owner decision D1)
//
// THE REQUIREMENT: after the update that encrypts a secret column, the values
// ALREADY on a box are ciphertext too. A column that is encrypted for new writes
// and plaintext for everything written before it is not encrypted; it is a
// half-migrated store, which is the state this phase refuses to ship.
//
// WHY IT IS CODE AND NOT A NUMBERED MIGRATION. The migration chain is `.sql`,
// executed by SQLite, and SQLite has no AES. The key lives in
// `~/.dojo/secrets.yaml` and is reachable only from TypeScript. This platform
// already carries the shape for exactly this reason — the Workspace account seed
// is a data migration that had to be code, and the secrets-file mode repair
// (T6C) is a self-repair on the first boot after its update. This is the third
// of that family and it is registered beside the first, in `index.ts`.
//
// WHY IT IS ONE FUNCTION AND NOT ONE PER PROVIDER. The first draft was a copy in
// `google/accounts.ts` and a near-identical copy in `microsoft/accounts.ts`, and
// the size-ratchet gate refused the growth — which was the right refusal for the
// wrong-looking reason: two copies of one loop is the duplicate-mechanism disease
// this project exists to remove, and the gate caught it before it landed. The
// loop lives here once; each provider contributes only the two things that
// genuinely differ, its table name and its own update function.
//
// THE WRITE GOES THROUGH THE PROVIDER'S OWN ENCODE POINT. This module never
// writes a token column itself. It hands the recovered plaintext back to
// `updateGoogleAccount` / `updateMicrosoftAccount`, whose encoder seals it —
// so there is still exactly one place per table that knows how a token is
// stored, and adding a third would have been the same disease one level down.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { isSealedText } from './at-rest.js';
import { createLogger } from '../logger.js';

const logger = createLogger('secret-at-rest');

/** The two columns every provider account table stores its OAuth material in. */
type TokenPatch = { accessToken?: string; refreshToken?: string };

interface TokenTable {
  table: 'google_accounts' | 'microsoft_accounts';
  update: (id: string, patch: TokenPatch) => void;
}

/**
 * Seal every plaintext token column in `spec.table`, in place. Idempotent: a
 * column already carrying the envelope is skipped, so after the first boot this
 * costs one SELECT.
 *
 * @returns how many COLUMNS were converted (unit: columns, not rows).
 */
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

/**
 * Seal every Workspace OAuth token still stored in the clear, both providers.
 * Called at boot AFTER the legacy-config seed, so a row the seed has just created
 * from the pre-Path-B keys is sealed in the same boot and never rests plaintext.
 *
 * @returns how many COLUMNS were converted across both tables.
 */
export async function sealWorkspaceTokensAtRest(): Promise<number> {
  // NEVER THROWS, and it owns that rather than leaving it to each caller: this
  // runs on the boot path, and a box whose master key cannot be read must still
  // start and still serve mail from the tokens it already holds. A conversion
  // that cannot happen is a warning to act on, not a dead platform.
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
