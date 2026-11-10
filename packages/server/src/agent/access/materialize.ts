// The migration in code: each agent's derived snapshot becomes a stored key inside the
// `permissions` document, written once and never overwriting a stored object.

import type { AccessGrants } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { deriveLegacyGrants } from './derive.js';
import { forgetAccessGrants, readStoredGrants } from './read.js';

const logger = createLogger('access/materialize');

/** THE one write door: MERGES into the `permissions` document, never replaces it, because that
 *  column also carries the manifest and a dropped manifest would re-scope the agent. */
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
      // A blob that does not parse is left exactly as it is: writing grants would make it parse again.
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

/** Writes the derived snapshot only where none is declared; null when the row already has one. */
export function writeGrantsIfAbsent(agentId: string): string | null {
  const declared = readStoredGrants(agentId);
  if (declared) return null;
  return writeGrants(agentId, deriveLegacyGrants(agentId));
}

/** Idempotent; returns rows written. Runs at boot after migrations, before the service-agent ensures. */
export function materializeAccessGrants(): number {
  let written = 0;
  try {
    const ids = getDb().prepare('SELECT id FROM agents').all() as Array<{ id: string }>;
    for (const { id } of ids) {
      if (writeGrantsIfAbsent(id)) written++;
    }
  } catch (err) {
    // Never a reason to refuse a boot: unwritten agents keep answering from the derivation.
    logger.error('access-grant materialization did not complete', {
      error: err instanceof Error ? err.message : String(err), written,
    });
    return written;
  }
  if (written > 0) logger.info('access grants materialized', { agents: written });
  return written;
}
