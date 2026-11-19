// Technique store: CRUD and directory management.

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { refreshEmbedding } from '../memory/embeddings.js';
import { writeDiskVersionSnapshot } from './versioning.js';
import {
  type DependencyManifest,
  emptyDependencyManifest,
  readDependencyManifest,
  writeDependencyManifest,
  validateTechniqueFileReferences,
  formatValidationRefusal,
} from './dependencies.js';
// The reference -> row -> directory read lives in its own leaf so the executor's gate loop can run it before
// minting a call's capability, without pulling this module's fs, embeddings and broadcast into every dispatch.
import { getTechnique, rowToTechnique, type TechniqueMetadata } from './technique-dir.js';
import type { ImportedManifest } from './share-import.js';
import { homeDir } from '../home.js';

export { getTechnique, resolveTechniqueRef, techniqueDirectory } from './technique-dir.js';
import { supportingFileTargets } from './technique-folder.js';
export type { TechniqueMetadata } from './technique-dir.js';

const logger = createLogger('technique-store');

// Thrown when TECHNIQUE.md references files that are not inside the technique dir and not declared in
// dependencies.json; tools.ts turns it into a structured refusal for the agent.
export class TechniqueValidationError extends Error {
  constructor(public refusalText: string) {
    super(refusalText);
    this.name = 'TechniqueValidationError';
  }
}

const TECHNIQUES_DIR = path.join(homeDir(), '.dojo', 'techniques');

function ensureTechniquesDir(): void {
  if (!fs.existsSync(TECHNIQUES_DIR)) {
    fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
  }
}


export interface TechniqueDetail extends TechniqueMetadata {
  instructions: string | null; // Current TECHNIQUE.md content
  files: Array<{ path: string; size: number; isDirectory: boolean }>;
}

export interface CreateTechniqueParams {
  name: string; // slug/directory name
  displayName: string;
  description: string;
  instructions: string;
  tags?: string[];
  files?: Array<{ path: string; content: string }>;
  // External dependencies (packages, repos, assets, manual steps). Omitted means an empty manifest, so any
  // external dep TECHNIQUE.md references is flagged missing.
  dependencies?: DependencyManifest;
  // Default true: refuse the save when TECHNIQUE.md references files missing from the support dir and the
  // manifest. The dashboard's create-from-UI route passes false so users can build incrementally (the
  // export-time check still catches it); trainer-tool saves are always true.
  validateReferences?: boolean;
  publish?: boolean;
  authorAgentId?: string;
  authorAgentName?: string;
  buildProjectId?: string;
  buildSquadId?: string;
}


// Embed the technique's intent surface (name + description + tags), not its
// body: recall matches the user's ASK against what the technique is FOR; the
// body is loaded after selection. Techniques are global, so agentId is null.
export function embedTechniqueIntent(id: string): void {
  try {
    const row = getDb().prepare('SELECT name, description, tags FROM techniques WHERE id = ?')
      .get(id) as { name: string; description: string | null; tags: string | null } | undefined;
    if (!row) return;
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags ?? '[]'); } catch { /* malformed tags column */ }
    refreshEmbedding('technique', id, null, `${row.name}\n${row.description ?? ''}\n${tags.join(' ')}`);
  } catch { /* embedding is best-effort */ }
}

export function createTechnique(params: CreateTechniqueParams): TechniqueMetadata {
  ensureTechniquesDir();
  const db = getDb();

  const id = params.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const dirPath = path.join(TECHNIQUES_DIR, id);

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM techniques WHERE id = ?').get(id);
  if (existing) {
    throw new Error(`Technique "${id}" already exists`);
  }

  const fileTargets = supportingFileTargets(dirPath, params.files);
  if (typeof fileTargets === 'string') throw new Error(fileTargets);
  fs.mkdirSync(dirPath, { recursive: true });

  // Write TECHNIQUE.md
  fs.writeFileSync(path.join(dirPath, 'TECHNIQUE.md'), params.instructions, 'utf-8');

  // Write supporting files BEFORE validation runs so the validator can
  // resolve relative references against what will actually be on disk.
  for (const file of params.files ?? []) {
    const filePath = fileTargets.get(file.path)!;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }

  // Always written (even an empty manifest) so downstream readers and the export bundle see one shape.
  const manifest = params.dependencies ?? emptyDependencyManifest();
  writeDependencyManifest(dirPath, manifest);

  // Refuse the create when TECHNIQUE.md references files missing from the support dir and the manifest, and roll
  // back the partial directory so a failed create leaves no trace. Skipped when validateReferences=false
  // (dashboard create-from-UI path; the export-time check still catches it).
  if (params.validateReferences !== false) {
    const validation = validateTechniqueFileReferences(dirPath, params.instructions, manifest);
    if (!validation.ok) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch { /* best effort */ }
      throw new TechniqueValidationError(formatValidationRefusal(validation));
    }
  }

  // Write metadata.json
  const metadata = {
    id,
    name: params.displayName,
    description: params.description,
    state: params.publish ? 'published' : 'draft',
    author_agent_id: params.authorAgentId ?? null,
    author_agent_name: params.authorAgentName ?? null,
    tags: params.tags ?? [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: params.publish ? new Date().toISOString() : null,
    version: 1,
    enabled: true,
    usage_count: 0,
    last_used_at: null,
    build_project_id: params.buildProjectId ?? null,
    build_squad_id: params.buildSquadId ?? null,
  };
  fs.writeFileSync(path.join(dirPath, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

  // (supporting files were written above, before validation)

  // Insert into DB
  const state = params.publish ? 'published' : 'draft';
  db.prepare(`
    INSERT INTO techniques (id, name, description, state, author_agent_id, author_agent_name, tags,
                            directory_path, enabled, version, usage_count, build_project_id, build_squad_id,
                            created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, datetime('now'), datetime('now'), ?)
  `).run(
    id, params.displayName, params.description, state,
    params.authorAgentId ?? null, params.authorAgentName ?? null,
    JSON.stringify(params.tags ?? []), dirPath,
    params.buildProjectId ?? null, params.buildSquadId ?? null,
    params.publish ? new Date().toISOString() : null,
  );

  // Create version 1 snapshot (DB + disk).
  const filesSnapshot = getFilesSnapshot(dirPath);
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, 1, ?, ?, 'Initial version', ?, datetime('now'))
  `).run(uuidv4(), id, params.instructions, params.authorAgentId ?? 'system', JSON.stringify(filesSnapshot));
  writeDiskVersionSnapshot(dirPath, 1, params.instructions, {
    changedBy: params.authorAgentId ?? 'system',
    changeSummary: 'Initial version',
    createdAt,
  });

  logger.info('Technique created', { id, name: params.displayName, state });

  embedTechniqueIntent(id);

  broadcast({ type: 'technique:created', data: { id, name: params.displayName, state } });

  return getTechnique(id)!;
}

export function getTechniqueDetail(id: string): TechniqueDetail | null {
  const technique = getTechnique(id);
  if (!technique) return null;

  let instructions: string | null = null;
  const mdPath = path.join(technique.directoryPath, 'TECHNIQUE.md');
  try {
    if (fs.existsSync(mdPath)) {
      instructions = fs.readFileSync(mdPath, 'utf-8');
    }
  } catch { /* file might not exist yet */ }

  const files = getFileTree(technique.directoryPath);

  return { ...technique, instructions, files };
}

export function listTechniques(filters?: {
  state?: string;
  tag?: string;
  search?: string;
  includeDrafts?: boolean;
  squadId?: string;
}): TechniqueMetadata[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.state) {
    conditions.push('state = ?');
    params.push(filters.state);
  }

  if (filters?.tag) {
    conditions.push("tags LIKE ?");
    params.push(`%"${filters.tag}"%`);
  }

  if (filters?.search) {
    conditions.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }

  if (!filters?.includeDrafts && !filters?.state) {
    // By default, show published + disabled (dashboard can see all)
    // This filter is for the API; agent tools filter further
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM techniques ${where} ORDER BY usage_count DESC, name ASC`).all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToTechnique);
}

export function updateTechnique(id: string, updates: Partial<{
  name: string; // human-readable display name (DB column `name`)
  description: string;
  tags: string[];
  enabled: boolean;
  state: string;
  buildProjectId: string;
  buildSquadId: string;
}>): TechniqueMetadata | null {
  const db = getDb();
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (trimmed.length === 0) {
      throw new Error('Technique name cannot be empty');
    }
    setClauses.push('name = ?');
    params.push(trimmed);
  }
  if (updates.description !== undefined) { setClauses.push('description = ?'); params.push(updates.description); }
  if (updates.tags !== undefined) { setClauses.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }
  if (updates.enabled !== undefined) { setClauses.push('enabled = ?'); params.push(updates.enabled ? 1 : 0); }
  if (updates.state !== undefined) {
    setClauses.push('state = ?');
    params.push(updates.state);
    if (updates.state === 'published') {
      setClauses.push("published_at = datetime('now')");
    }
  }
  if (updates.buildProjectId !== undefined) { setClauses.push('build_project_id = ?'); params.push(updates.buildProjectId); }
  if (updates.buildSquadId !== undefined) { setClauses.push('build_squad_id = ?'); params.push(updates.buildSquadId); }

  params.push(id);
  db.prepare(`UPDATE techniques SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

  // Mirror name/description changes into metadata.json so the file view matches the DB. Versions snapshot only
  // TECHNIQUE.md content, so metadata edits do not bump the version number.
  if (updates.name !== undefined || updates.description !== undefined) {
    try {
      const technique = getTechnique(id);
      if (technique) {
        const metaPath = path.join(technique.directoryPath, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (updates.name !== undefined) meta.name = technique.name;
          if (updates.description !== undefined) meta.description = technique.description;
          meta.updated_at = new Date().toISOString();
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
      }
    } catch (err) {
      logger.warn('Failed to mirror metadata edit to metadata.json', {
        id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (updates.state) {
    const technique = getTechnique(id);
    if (technique) {
      broadcast({ type: 'technique:state_changed', data: { id, name: technique.name, oldState: undefined, newState: updates.state } });
    }
  }
  if (updates.name !== undefined || updates.description !== undefined) {
    const technique = getTechnique(id);
    if (technique) {
      broadcast({ type: 'technique:updated', data: { id, name: technique.name, version: technique.version } });
    }
  }

  if (updates.name !== undefined || updates.description !== undefined || updates.tags !== undefined) {
    embedTechniqueIntent(id);
  }

  return getTechnique(id);
}

export function updateTechniqueInstructions(
  id: string,
  content: string,
  changeSummary: string,
  changedBy?: string,
  options?: { validateReferences?: boolean },
): TechniqueMetadata | null {
  const technique = getTechnique(id);
  if (!technique) return null;

  // Validate file references against the current support dir and manifest BEFORE writing, same rule as create.
  // Skipped when validateReferences=false (dashboard manual-edit path).
  if (options?.validateReferences !== false) {
    const manifest = readDependencyManifest(technique.directoryPath);
    const validation = validateTechniqueFileReferences(technique.directoryPath, content, manifest);
    if (!validation.ok) {
      throw new TechniqueValidationError(formatValidationRefusal(validation));
    }
  }

  // Write new TECHNIQUE.md
  const mdPath = path.join(technique.directoryPath, 'TECHNIQUE.md');
  fs.writeFileSync(mdPath, content, 'utf-8');

  // Increment version
  const newVersion = technique.version + 1;
  const db = getDb();
  db.prepare("UPDATE techniques SET version = ?, updated_at = datetime('now') WHERE id = ?").run(newVersion, id);

  // Create version snapshot (DB + disk so the Trainer can file_read prior versions).
  const filesSnapshot = getFilesSnapshot(technique.directoryPath);
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), id, newVersion, content, changedBy ?? 'system', changeSummary, JSON.stringify(filesSnapshot));
  writeDiskVersionSnapshot(technique.directoryPath, newVersion, content, {
    changedBy: changedBy ?? 'system',
    changeSummary,
    createdAt,
  });

  logger.info('Technique instructions updated', { id, version: newVersion, changedBy });

  broadcast({ type: 'technique:updated', data: { id, name: technique.name, version: newVersion } });

  return getTechnique(id);
}

// Replace the technique's dependency manifest, re-running file-reference validation against the existing
// TECHNIQUE.md so removing a declared dep cannot leave the .md referencing a now-missing path.
export function updateTechniqueDependencies(id: string, manifest: DependencyManifest): TechniqueMetadata | null {
  const technique = getTechnique(id);
  if (!technique) return null;

  const mdPath = path.join(technique.directoryPath, 'TECHNIQUE.md');
  const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf-8') : '';

  const validation = validateTechniqueFileReferences(technique.directoryPath, content, manifest);
  if (!validation.ok) {
    throw new TechniqueValidationError(formatValidationRefusal(validation));
  }

  writeDependencyManifest(technique.directoryPath, manifest);
  const db = getDb();
  db.prepare("UPDATE techniques SET updated_at = datetime('now') WHERE id = ?").run(id);

  logger.info('Technique dependency manifest updated', { id });
  broadcast({ type: 'technique:updated', data: { id, name: technique.name, version: technique.version } });
  return getTechnique(id);
}

/** Read a technique's import manifest, or null if it was created locally (not imported). */
export function readImportManifest(directoryPath: string): ImportedManifest | null {
  const manifestPath = path.join(directoryPath, 'IMPORT_MANIFEST.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Scan the technique's files for remaining {{NEEDS_FROM_USER:LABEL}} markers (gates finalize). */
export function findRemainingPlaceholders(directoryPath: string): string[] {
  const manifest = readImportManifest(directoryPath);
  if (!manifest) return [];
  const remaining = new Set<string>();
  for (const p of manifest.placeholders) {
    for (const relFile of p.files) {
      const abs = path.resolve(directoryPath, relFile);
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

export function publishTechnique(id: string): TechniqueMetadata | null {
  const db = getDb();
  const technique = getTechnique(id);
  if (!technique) return null;
  if (technique.state === 'published') return technique;
  // No agent may read an unfilled {{NEEDS_FROM_USER}} blank as a value.
  if (technique.state === 'needs_setup' || findRemainingPlaceholders(technique.directoryPath).length > 0) {
    throw new TechniqueValidationError('This technique still has blanks to fill in before it can be published.');
  }

  db.prepare("UPDATE techniques SET state = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);

  logger.info('Technique published', { id, name: technique.name });
  embedTechniqueIntent(id);
  broadcast({ type: 'technique:published', data: { id, name: technique.name } });

  return getTechnique(id);
}

export function deleteTechnique(id: string): boolean {
  const technique = getTechnique(id);
  if (!technique) return false;

  const db = getDb();

  // Four tables, one unit: a failure part-way must not leave a deleted technique owning usage rows, versions
  // or an embedding (no FK covers them, so they are separate statements).
  withUnit(() => {
    db.prepare('DELETE FROM technique_usage WHERE technique_id = ?').run(id);
    db.prepare('DELETE FROM technique_versions WHERE technique_id = ?').run(id);
    db.prepare('DELETE FROM techniques WHERE id = ?').run(id);
    db.prepare("DELETE FROM embeddings WHERE source_type = 'technique' AND source_id = ?").run(id);
  });

  // Delete directory
  try {
    fs.rmSync(technique.directoryPath, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Failed to delete technique directory', { id, error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('Technique deleted', { id });
  return true;
}

export function recordTechniqueUsage(techniqueId: string, agentId: string, agentName?: string): void {
  const db = getDb();
  // The usage row and the usage_count that summarises it are one unit, or the counter can disagree with the rows.
  withUnit(() => {
    db.prepare(`
      INSERT INTO technique_usage (id, technique_id, agent_id, agent_name, used_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(uuidv4(), techniqueId, agentId, agentName ?? null);

    db.prepare("UPDATE techniques SET usage_count = usage_count + 1, last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(techniqueId);
  });

  // Emitted after the commit by `broadcast` itself (see gateway/ws.ts).
  broadcast({ type: 'technique:used', data: { id: techniqueId, name: '', agentId, agentName: agentName ?? '' } });
}


function getFileTree(dirPath: string): Array<{ path: string; size: number; isDirectory: boolean }> {
  const results: Array<{ path: string; size: number; isDirectory: boolean }> = [];

  function walk(dir: string, prefix: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name === 'metadata.json') continue; // Don't expose in file tree
        if (entry.isDirectory()) {
          results.push({ path: relPath, size: 0, isDirectory: true });
          walk(path.join(dir, entry.name), relPath);
        } else {
          const stat = fs.statSync(path.join(dir, entry.name));
          results.push({ path: relPath, size: stat.size, isDirectory: false });
        }
      }
    } catch { /* directory might not exist */ }
  }

  walk(dirPath, '');
  return results;
}

function getFilesSnapshot(dirPath: string): Array<{ path: string; size: number }> {
  return getFileTree(dirPath)
    .filter(f => !f.isDirectory)
    .map(f => ({ path: f.path, size: f.size }));
}

export { TECHNIQUES_DIR };
