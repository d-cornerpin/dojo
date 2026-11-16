// The placeholder surface the Trainer drives after a technique arrives in a shared package: substitute a
// user-supplied value and finalize. Reading the manifest and the unfilled blanks lives in store.ts.
// Kept apart from `share-import.ts` (reached only by the dashboard upload route; this half only by the
// technique tool handlers); only the manifest type crosses, as a type-only import.
// Runs in a tool dispatch: the effect facade allows disk only in the call's resolved technique folder.

import path from 'node:path';
import * as effectFs from '../agent/effects/fs.js';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { readImportManifest, findRemainingPlaceholders } from './store.js';

const logger = createLogger('technique-import-setup');

/** Apply a placeholder value across every file that mentions it; returns the substitution count. */
export function applyPlaceholderToTechnique(directoryPath: string, label: string, value: string): number {
  const manifest = readImportManifest(directoryPath);
  if (!manifest) return 0;
  const target = manifest.placeholders.find(p => p.label === label);
  if (!target) return 0;

  const needle = `{{NEEDS_FROM_USER:${label}}}`;
  let total = 0;
  for (const relFile of target.files) {
    const abs = path.resolve(directoryPath, relFile);
    if (!effectFs.existsSync(abs)) continue;
    try {
      const content = effectFs.readFileSync(abs, 'utf-8');
      if (!content.includes(needle)) continue;
      const parts = content.split(needle);
      const next = parts.join(value);
      effectFs.writeFileSync(abs, next, 'utf-8');
      total += parts.length - 1;
    } catch (err) {
      logger.warn('Failed to apply placeholder to file', { abs, label, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return total;
}

/**
 * Finalize an imported technique: removes the staged manifest, flips state needs_setup to draft and
 * broadcasts. Refused while any placeholder is unfilled.
 */
export function finalizeImportedTechnique(techniqueId: string): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const row = db.prepare('SELECT directory_path, name, state FROM techniques WHERE id = ?').get(techniqueId) as
    { directory_path: string; name: string; state: string } | undefined;
  if (!row) return { ok: false, error: `Technique "${techniqueId}" not found.` };
  if (row.state !== 'needs_setup') return { ok: false, error: `"${row.name}" is not in setup, so there is nothing to finalize.` };

  const remaining = findRemainingPlaceholders(row.directory_path);
  if (remaining.length > 0) {
    return { ok: false, error: `Cannot finalize: ${remaining.length} placeholder(s) still unfilled — ${remaining.join(', ')}.` };
  }

  // The technique is now indistinguishable from a locally created one.
  const manifestPath = path.join(row.directory_path, 'IMPORT_MANIFEST.json');
  try {
    if (effectFs.existsSync(manifestPath)) effectFs.unlinkSync(manifestPath);
  } catch (err) {
    logger.warn('Failed to remove IMPORT_MANIFEST.json on finalize', { techniqueId, err: err instanceof Error ? err.message : String(err) });
  }

  db.prepare("UPDATE techniques SET state = 'draft', updated_at = datetime('now') WHERE id = ?").run(techniqueId);
  broadcast({ type: 'technique:state_changed', data: { id: techniqueId, name: row.name, oldState: row.state, newState: 'draft' } });

  return { ok: true };
}
