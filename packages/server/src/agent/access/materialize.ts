// ════════════════════════════════════════════════════════════════════════════
// MATERIALIZING THE SNAPSHOT (UX-ACCESS A1) — the data migration, in code.
//
// The schema does not move: grants are a key inside the `agents.permissions`
// JSON document, so there is nothing for a `.sql` file to alter. What has to
// happen once, per agent, is that the DERIVED snapshot becomes a DECLARED,
// owner-editable object in the row — owner ruling 3's second half. Until it is
// written there is nothing for the owner to edit; after it is written, an edit
// sticks, because a stored object always beats the derivation.
//
// ── WHY THIS IS PROVABLY A NO-OP ──
// It writes exactly `deriveLegacyGrants(agentId)`, which is the same value
// `getAccessGrants` was already answering with. Before and after the write, every
// door computes from the same object. The parity test drives both states; the
// migration-diff harness drives all 111 rows on the owner's own database.
//
// ── AND WHY IT IS NOT A BOOT REWRITER ──
// It writes an agent's grants ONCE, when the row has none. It never overwrites a
// stored object, so it is the opposite of the four boot reconcilers it replaces
// (`pm-agent.ts`, `trainer-agent.ts`, `healer-agent.ts`, `imaginer-agent.ts`),
// whose whole defect was rewriting the row on every restart and silently
// reverting the owner. A second run of this function writes zero rows.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessGrants } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { deriveLegacyGrants } from './derive.js';
import { forgetAccessGrants, readStoredGrants } from './read.js';

const logger = createLogger('access/materialize');

/**
 * THE ONE WRITE DOOR for an agent's grants (UX-ACCESS A2 promoted this out of
 * `writeGrantsIfAbsent`, which is now its only other caller).
 *
 * It MERGES into the `permissions` document rather than replacing it, because
 * that column carries the `PermissionManifest` too and a grants save that
 * dropped the manifest would re-scope the agent as a side effect — the exact
 * defect A1 found on the owner-side route and closed from the other direction.
 * Every writer goes through here, so there is one place that knows the column is
 * a document and not a field.
 *
 * Returns the text written, or null if the row is gone or its blob does not
 * parse — see `writeGrantsIfAbsent`'s note on why an unparseable blob is left
 * exactly as it is.
 */
export function writeGrants(agentId: string, grants: AccessGrants): string | null {
  const db = getDb();
  const row = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(agentId) as
    { permissions: string | null } | undefined;
  if (!row) return null;

  let doc: Record<string, unknown> = {};
  if (row.permissions && row.permissions !== '{}') {
    try {
      const parsed = JSON.parse(row.permissions) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
    } catch {
      // A manifest that does not parse is already being ignored by
      // `getAgentPermissions` (it logs and falls back to the defaults). Writing
      // grants beside it would make the blob parse again and silently promote
      // whatever else is in there, so this row is left exactly as it is.
      logger.warn('permissions blob does not parse; leaving it untouched', { agentId }, agentId);
      return null;
    }
  }
  doc.grants = grants;
  const text = JSON.stringify(doc);
  db.prepare("UPDATE agents SET permissions = ?, updated_at = datetime('now') WHERE id = ?")
    .run(text, agentId);
  forgetAccessGrants(agentId);
  return text;
}

/** The migration's write: the DERIVED snapshot, and only where none is declared.
 *  Returns the text written, or null if the row already declares grants (never
 *  overwritten — see the header). */
export function writeGrantsIfAbsent(agentId: string): string | null {
  const declared = readStoredGrants(agentId);
  if (declared) return null;
  return writeGrants(agentId, deriveLegacyGrants(agentId));
}

/**
 * Every agent's effective access, declared. Idempotent; returns how many rows
 * were written this pass.
 *
 * Runs at boot, after migrations and before the service-agent ensures, so those
 * ensures see rows that already carry grants and therefore have nothing to
 * reconcile.
 */
export function materializeAccessGrants(): number {
  let written = 0;
  try {
    const ids = getDb().prepare('SELECT id FROM agents').all() as Array<{ id: string }>;
    for (const { id } of ids) {
      if (writeGrantsIfAbsent(id)) written++;
    }
  } catch (err) {
    // Never a reason to refuse a boot: an agent whose grants were not written
    // keeps answering from the derivation, which is its access at HEAD.
    logger.error('access-grant materialization did not complete', {
      error: err instanceof Error ? err.message : String(err), written,
    });
    return written;
  }
  if (written > 0) logger.info('access grants materialized', { agents: written });
  return written;
}
