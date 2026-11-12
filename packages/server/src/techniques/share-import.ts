// ════════════════════════════════════════
// Technique Import (Share)
// ════════════════════════════════════════
//
// Accepts a .dojo.zip package produced by share-export.ts, validates
// it, writes the contents into a new technique directory in
// `needs_setup` state, and stages the placeholder list for the Trainer to
// walk the user through during the training-mat session.

import path from 'node:path';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { insertMessage } from '../memory/message-store.js';
import { broadcast } from '../gateway/ws.js';
import { TECHNIQUES_DIR, embedTechniqueIntent } from './store.js';
import { extractPackageEntries, undoExtraction, type ExtractedWrite, ensureFolder, makeNewFolder, removeFolder, writeFolderText, readFolderText } from './share-disk.js';

const logger = createLogger('technique-share-import');

const PACKAGE_FORMAT = 'dojo-technique';
const SUPPORTED_VERSION = 1;

export interface ImportedManifest {
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
  ensureFolder(TECHNIQUES_DIR);
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
  if (typeof manifest.technique.name !== 'string') {
    throw new Error('manifest.json technique name must be text; nothing was imported.');
  }

  // ── 2. Pick a free slug & make the target directory ──
  const originalId = String(manifest.technique.id);
  const newId = pickAvailableId(originalId);
  const dirPath = path.resolve(TECHNIQUES_DIR, newId);
  // Refuses a folder that already exists, so a failed import can only ever remove a folder it made itself.
  makeNewFolder(dirPath);
  // From here on, any failure removes the folder THIS import made (and only that one).
  let extractedCount = 0;
  let needsSetup = false;
  let initialState = 'draft';
  const journal: ExtractedWrite[] = [];
  try {

    // ── 3. Extract every entry except manifest.json (we store it separately) ──
    const extracted = extractPackageEntries(zip, dirPath, journal);
    extractedCount = extracted.extractedCount;
    const hasInstructions = extracted.hasInstructions;

    if (!hasInstructions) {
      // Every technique needs TECHNIQUE.md (the catch below undoes the extraction)
      throw new Error('Package is missing TECHNIQUE.md.');
    }

    // ── 4. Persist the import manifest for the Trainer to read during setup ──
    writeFolderText(dirPath, 'IMPORT_MANIFEST.json', JSON.stringify(manifest, null, 2));

    // ── 5. Write metadata.json so the disk layout matches a normal technique ──
    const tags = Array.isArray(manifest.technique.tags) ? manifest.technique.tags : [];
    needsSetup = Array.isArray(manifest.placeholders) && manifest.placeholders.length > 0;
    initialState = needsSetup ? 'needs_setup' : 'draft';

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
    writeFolderText(dirPath, 'metadata.json', JSON.stringify(metadata, null, 2));

    // ── 6. Register: both rows go in together or neither does ──
    const db = getDb();
    const instructions = readFolderText(dirPath, 'TECHNIQUE.md') ?? '';
    db.transaction(() => {
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
    })();
  } catch (err) {
    undoExtraction(journal);   // overwritten files go back byte for byte; files this import newly made are removed
    removeFolder(dirPath);
    throw err;
  }

  // ── Registered. Nothing below can undo the import: a failure here is logged, never thrown. ──
  logger.info('Technique imported', { newId, originalId, extractedCount, needsSetup, placeholders: manifest.placeholders?.length ?? 0 });
  try {
    embedTechniqueIntent(newId); // so recall can find it by what it is for, like one made by hand
  } catch (err) {
    logger.warn('Embedding the imported technique failed (non-fatal)', { newId, error: err instanceof Error ? err.message : String(err) });
  }
  try {
    broadcast({ type: 'technique:created', data: { id: newId, name: manifest.technique.name, state: initialState } });
  } catch (err) {
    logger.warn('Broadcast after import failed (non-fatal)', { newId, error: err instanceof Error ? err.message : String(err) });
  }

  // ── 7. Hand off to the trainer agent ──
  // The trainer is the owner of techniques on this dojo, so importing
  // = dropping a message in the trainer's chat with the staged path,
  // any dependency manifest, and any placeholders that need filling.
  // The trainer's prompt teaches them how to install deps and
  // finalize. Fire-and-forget: a failed handoff doesn't fail the
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
