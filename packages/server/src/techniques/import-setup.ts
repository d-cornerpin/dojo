// ════════════════════════════════════════
// Imported-Technique Setup (Share)
// ════════════════════════════════════════
//
// The placeholder surface Yoshi drives after a technique arrives in a shared
// package: read the staged manifest, substitute a value the user supplied, ask
// what is still unfilled, and finalize.
//
// ── WHY IT IS ITS OWN MODULE (PHASE-5 T8 Step 3, RULING P5-R15 part 2) ──
// `share-import.ts` held these four functions beside the package IMPORT, and the
// two surfaces have disjoint callers: the import half is reached only by the
// dashboard upload route, this half only by the technique tool handlers. One
// module with one `node:fs` import made both classifications dishonest. They
// partition perfectly by enclosing function, so this is a relocation and not a
// rewrite; only the manifest TYPE is shared, and it crosses as a type-only
// import — nothing crosses at runtime.
//
// Everything here runs inside a tool dispatch, so it reaches the disk through
// the effect facade on the technique tree the call's own reference resolved to
// (RULING P5-R15 ADDENDUM 3(1)(a)).
// ════════════════════════════════════════

import path from 'node:path';
import * as effectFs from '../agent/effects/fs.js';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import type { ImportedManifest } from './share-import.js';

const logger = createLogger('technique-import-setup');

/**
 * Read the import manifest for a technique, if it has one. Returns null
 * for techniques that weren't imported (i.e. were created locally).
 * Used by Yoshi tools to discover placeholder lists and remaining
 * setup work.
 */
export function readImportManifest(directoryPath: string): ImportedManifest | null {
  const manifestPath = path.join(directoryPath, 'IMPORT_MANIFEST.json');
  if (!effectFs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(effectFs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Apply a placeholder value across every file in the technique that
 * mentions it. Returns the number of substitutions made.
 */
export function applyPlaceholderToTechnique(directoryPath: string, label: string, value: string): number {
  const manifest = readImportManifest(directoryPath);
  if (!manifest) return 0;
  const target = manifest.placeholders.find(p => p.label === label);
  if (!target) return 0;

  const needle = `{{NEEDS_FROM_USER:${label}}}`;
  let total = 0;
  for (const relFile of target.files) {
    const abs = path.join(directoryPath, relFile);
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
 * Scan the technique's files for remaining {{NEEDS_FROM_USER:LABEL}}
 * markers. Used to decide whether finalize is allowed and to surface
 * progress to the user.
 */
export function findRemainingPlaceholders(directoryPath: string): string[] {
  const manifest = readImportManifest(directoryPath);
  if (!manifest) return [];
  const remaining = new Set<string>();
  for (const p of manifest.placeholders) {
    for (const relFile of p.files) {
      const abs = path.join(directoryPath, relFile);
      if (!effectFs.existsSync(abs)) continue;
      try {
        const content = effectFs.readFileSync(abs, 'utf-8');
        if (content.includes(`{{NEEDS_FROM_USER:${p.label}}}`)) {
          remaining.add(p.label);
        }
      } catch {
        /* ignore unreadable file */
      }
    }
  }
  return Array.from(remaining);
}

/**
 * Finalize an imported technique: removes the staged import manifest,
 * flips state from needs_setup → draft, and broadcasts so the dashboard
 * refreshes. Requires that no placeholders remain unfilled.
 */
export function finalizeImportedTechnique(techniqueId: string): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const row = db.prepare('SELECT directory_path, name, state FROM techniques WHERE id = ?').get(techniqueId) as
    { directory_path: string; name: string; state: string } | undefined;
  if (!row) return { ok: false, error: `Technique "${techniqueId}" not found.` };

  const remaining = findRemainingPlaceholders(row.directory_path);
  if (remaining.length > 0) {
    return { ok: false, error: `Cannot finalize: ${remaining.length} placeholder(s) still unfilled — ${remaining.join(', ')}.` };
  }

  // Remove the import manifest (technique is now indistinguishable from a locally-created one)
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
