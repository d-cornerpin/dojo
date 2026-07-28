// ════════════════════════════════════════
// Technique Import (Share)
// ════════════════════════════════════════
//
// Accepts a .dojo.zip package produced by share-export.ts, validates
// it, writes the contents into a new technique directory in
// `needs_setup` state, and stages the placeholder list for Yoshi to
// walk the user through during the training-mat session.

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { insertMessage } from '../memory/message-store.js';
import { broadcast } from '../gateway/ws.js';
import { TECHNIQUES_DIR } from './store.js';

const logger = createLogger('technique-share-import');

const PACKAGE_FORMAT = 'dojo-technique';
const SUPPORTED_VERSION = 1;

interface ImportedManifest {
  format: string;
  version: number;
  technique: {
    id: string;
    name: string;
    description: string | null;
    tags: string[];
    version: number;
    author_agent_name: string | null;
  };
  exported_at: string;
  placeholders: Array<{ label: string; hint: string; files: string[] }>;
}

export interface ImportResult {
  techniqueId: string;       // the (possibly de-duped) slug the technique was imported as
  originalId: string;        // the slug from the manifest
  name: string;
  state: string;             // 'needs_setup' if there are placeholders to fill, else 'draft'
  placeholders: Array<{ label: string; hint: string; files: string[] }>;
  needsSetup: boolean;
}

function ensureTechniquesDir(): void {
  if (!fs.existsSync(TECHNIQUES_DIR)) {
    fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
  }
}

function pickAvailableId(desiredId: string): string {
  const db = getDb();
  const exists = (id: string) => db.prepare('SELECT 1 FROM techniques WHERE id = ?').get(id) !== undefined;
  if (!exists(desiredId)) return desiredId;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${desiredId}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find a free id for "${desiredId}" — too many duplicates`);
}

/**
 * Validate, extract, and register an imported technique package.
 * Returns the new technique id + state so the caller can route the
 * dashboard to the training-mat session.
 */
export async function importTechnique(zipBuffer: Buffer): Promise<ImportResult> {
  ensureTechniquesDir();

  // ── 1. Parse the zip ──
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new Error(`Not a valid zip file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error('Not a Dojo technique package: manifest.json missing.');
  }

  let manifest: ImportedManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (manifest.format !== PACKAGE_FORMAT) {
    throw new Error(`Not a Dojo technique package (manifest.format="${manifest.format}", expected "${PACKAGE_FORMAT}").`);
  }
  if (typeof manifest.version !== 'number' || manifest.version > SUPPORTED_VERSION) {
    throw new Error(`Unsupported technique package version ${manifest.version}. This Dojo supports up to version ${SUPPORTED_VERSION}.`);
  }
  if (!manifest.technique?.id || !manifest.technique?.name) {
    throw new Error('manifest.json is missing technique.id or technique.name.');
  }

  // ── 2. Pick a free slug & make the target directory ──
  const originalId = manifest.technique.id;
  const newId = pickAvailableId(originalId);
  const dirPath = path.join(TECHNIQUES_DIR, newId);
  if (fs.existsSync(dirPath)) {
    // Shouldn't happen given pickAvailableId, but stay safe.
    throw new Error(`Target directory ${dirPath} already exists.`);
  }
  fs.mkdirSync(dirPath, { recursive: true });

  // ── 3. Extract every entry except manifest.json (we store it separately) ──
  const entries = zip.getEntries();
  let extractedCount = 0;
  let hasInstructions = false;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryPath = entry.entryName.replace(/^\/+/, '');
    if (!entryPath || entryPath === 'manifest.json') continue;

    // Reject zip-slip — entries that try to escape the technique dir.
    if (entryPath.includes('..') || path.isAbsolute(entryPath)) {
      logger.warn('Rejecting suspicious zip entry', { entryPath });
      continue;
    }

    const dest = path.join(dirPath, entryPath);
    const resolvedDest = path.resolve(dest);
    if (!resolvedDest.startsWith(path.resolve(dirPath) + path.sep) && resolvedDest !== path.resolve(dirPath)) {
      logger.warn('Zip entry escapes target dir, skipping', { entryPath, resolvedDest });
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    extractedCount++;
    if (entryPath === 'TECHNIQUE.md') hasInstructions = true;
  }

  if (!hasInstructions) {
    // Clean up and bail — every technique needs TECHNIQUE.md
    fs.rmSync(dirPath, { recursive: true, force: true });
    throw new Error('Package is missing TECHNIQUE.md.');
  }

  // ── 4. Persist the import manifest for Yoshi to read during setup ──
  const importManifestPath = path.join(dirPath, 'IMPORT_MANIFEST.json');
  fs.writeFileSync(importManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // ── 5. Write metadata.json so the disk layout matches a normal technique ──
  const tags = Array.isArray(manifest.technique.tags) ? manifest.technique.tags : [];
  const needsSetup = Array.isArray(manifest.placeholders) && manifest.placeholders.length > 0;
  const initialState = needsSetup ? 'needs_setup' : 'draft';

  const metadata = {
    id: newId,
    name: manifest.technique.name,
    description: manifest.technique.description,
    state: initialState,
    author_agent_id: null,
    author_agent_name: manifest.technique.author_agent_name,
    tags,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
    version: 1, // start fresh on the importing Dojo
    enabled: true,
    usage_count: 0,
    last_used_at: null,
    build_project_id: null,
    build_squad_id: null,
    imported_from_id: originalId,
    imported_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dirPath, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

  // ── 6. Insert into the techniques table ──
  const db = getDb();
  const instructions = fs.readFileSync(path.join(dirPath, 'TECHNIQUE.md'), 'utf-8');
  db.prepare(`
    INSERT INTO techniques (id, name, description, state, author_agent_id, author_agent_name, tags,
                            directory_path, enabled, version, usage_count, build_project_id, build_squad_id,
                            created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 1, 0, NULL, NULL,
            datetime('now'), datetime('now'), NULL)
  `).run(
    newId,
    manifest.technique.name,
    manifest.technique.description ?? null,
    initialState,
    manifest.technique.author_agent_name ?? null,
    JSON.stringify(tags),
    dirPath,
  );

  // Snapshot v1
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, 1, ?, 'import', ?, '[]', datetime('now'))
  `).run(uuidv4(), newId, instructions, `Imported from ${originalId} (export ${manifest.exported_at})`);

  logger.info('Technique imported', { newId, originalId, extractedCount, needsSetup, placeholders: manifest.placeholders?.length ?? 0 });
  broadcast({ type: 'technique:created', data: { id: newId, name: manifest.technique.name, state: initialState } });

  // ── 7. Hand off to the trainer agent ──
  // The trainer is the owner of techniques on this dojo, so importing
  // = dropping a message in the trainer's chat with the staged path,
  // any dependency manifest, and any placeholders that need filling.
  // The trainer's prompt teaches them how to install deps and
  // finalize. Fire-and-forget — a failed handoff doesn't fail the
  // import (the user can still see the technique sitting in needs_setup
  // and message the trainer manually).
  void notifyTrainerOfImport(newId, manifest.technique.name, dirPath, manifest.placeholders ?? []).catch((err) => {
    logger.warn('Trainer notification after import failed (non-fatal)', {
      newId, error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    techniqueId: newId,
    originalId,
    name: manifest.technique.name,
    state: initialState,
    placeholders: manifest.placeholders ?? [],
    needsSetup,
  };
}

/**
 * Drop a message in the trainer agent's chat describing the freshly-
 * imported technique: its location on disk, dependency manifest, and
 * the placeholders that still need user-supplied values. Trainer's
 * prompt + tool docs cover what to do next (install deps, ask user
 * for secrets, call technique_finalize / publish_technique).
 *
 * Uses the same insert-message + handleMessage pattern other engine→
 * agent handoffs use (PM rename request, scheduler reminder fires).
 */
async function notifyTrainerOfImport(
  techniqueId: string,
  techniqueName: string,
  dirPath: string,
  placeholders: ImportedManifest['placeholders'],
): Promise<void> {
  const [{ getDb }, { v4: uuidv4 }, { getTrainerAgentId, getOwnerName }, { getAgentRuntime }, depsMod] = await Promise.all([
    import('../db/connection.js'),
    import('uuid'),
    import('../config/platform.js'),
    import('../agent/runtime.js'),
    import('./dependencies.js'),
  ]);
  const trainerId = getTrainerAgentId();
  if (!trainerId) return;
  const db = getDb();

  const trainerRow = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(trainerId) as { id: string; status: string } | undefined;
  if (!trainerRow || trainerRow.status === 'terminated') return;

  const manifestData = depsMod.readDependencyManifest(dirPath);
  const depCount =
    manifestData.system_packages.length +
    manifestData.language_packages.length +
    manifestData.repos.length +
    manifestData.models_or_assets.length +
    manifestData.manual_steps.length;
  const placeholderCount = placeholders.length;
  const ownerName = getOwnerName();

  const parts: string[] = [];
  parts.push(`[TECHNIQUE IMPORT] A technique was just imported into this dojo and needs your setup pass.`);
  parts.push('');
  parts.push(`Technique: "${techniqueName}"`);
  parts.push(`ID: ${techniqueId}`);
  parts.push(`Directory: ${dirPath}`);
  parts.push(`Dependency entries declared: ${depCount}`);
  parts.push(`Placeholders awaiting values: ${placeholderCount}`);
  parts.push('');
  parts.push('Your job:');
  parts.push(`1. Read TECHNIQUE.md and dependencies.json (use technique_read action="read_file"). Understand what the technique does and what it needs.`);
  parts.push(`2. For each entry in dependencies.json, install it on this machine — system_packages via brew/apt, language_packages via npm/pip, repos via git clone into install_to, assets via download to destination. Use \`exec\` for each install command; check first whether anything is already installed.`);
  parts.push(`3. For each manual_step, message ${ownerName} and walk them through it. Do NOT skip these.`);
  parts.push(`4. If there are placeholders, ask ${ownerName} for each value (don't guess), then call technique_set_placeholder.`);
  parts.push(`5. Once everything is set up and all placeholders are filled, call technique_finalize (flips state from needs_setup → draft), then publish_technique to make it usable.`);
  parts.push(`6. If any install step fails or you're unsure, message ${ownerName} with the specific problem. Don't push past errors.`);
  parts.push('');
  parts.push(`Report back to ${ownerName} when the technique is ready to use, or if any step needs their input.`);
  const message = parts.join('\n');

  const msgId = uuidv4();
  insertMessage({ id: msgId, agentId: trainerId, role: 'user', content: message });
  broadcast({
    type: 'chat:message',
    agentId: trainerId,
    message: {
      id: msgId, agentId: trainerId, role: 'user' as const,
      content: message,
      tokenCount: null, modelId: null, cost: null, latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  void getAgentRuntime().handleMessage(trainerId, message).catch((err) => {
    logger.warn('Trainer wake after import failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  logger.info('Trainer notified of technique import', {
    techniqueId, trainerId, depCount, placeholderCount,
  });
}

/**
 * Read the import manifest for a technique, if it has one. Returns null
 * for techniques that weren't imported (i.e. were created locally).
 * Used by Yoshi tools to discover placeholder lists and remaining
 * setup work.
 */
export function readImportManifest(directoryPath: string): ImportedManifest | null {
  const manifestPath = path.join(directoryPath, 'IMPORT_MANIFEST.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
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
    if (!fs.existsSync(abs)) continue;
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      if (!content.includes(needle)) continue;
      const parts = content.split(needle);
      const next = parts.join(value);
      fs.writeFileSync(abs, next, 'utf-8');
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
      if (!fs.existsSync(abs)) continue;
      try {
        const content = fs.readFileSync(abs, 'utf-8');
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
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  } catch (err) {
    logger.warn('Failed to remove IMPORT_MANIFEST.json on finalize', { techniqueId, err: err instanceof Error ? err.message : String(err) });
  }

  db.prepare("UPDATE techniques SET state = 'draft', updated_at = datetime('now') WHERE id = ?").run(techniqueId);
  broadcast({ type: 'technique:state_changed', data: { id: techniqueId, name: row.name, oldState: row.state, newState: 'draft' } });

  return { ok: true };
}
