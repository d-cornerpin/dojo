// ════════════════════════════════════════
// Technique Store — CRUD & Directory Management
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

const logger = createLogger('technique-store');

/**
 * Thrown when TECHNIQUE.md references files that don't resolve inside
 * the technique directory and aren't declared in dependencies.json.
 * Callers (tools, share-export) catch this to return a structured
 * refusal to the agent instead of a generic error.
 */
export class TechniqueValidationError extends Error {
  constructor(public refusalText: string) {
    super(refusalText);
    this.name = 'TechniqueValidationError';
  }
}

const TECHNIQUES_DIR = path.join(os.homedir(), '.dojo', 'techniques');

function ensureTechniquesDir(): void {
  if (!fs.existsSync(TECHNIQUES_DIR)) {
    fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
  }
}

// ── Types ──

export interface TechniqueMetadata {
  id: string;
  name: string;
  description: string | null;
  state: 'draft' | 'review' | 'published' | 'disabled' | 'archived' | 'needs_setup';
  authorAgentId: string | null;
  authorAgentName: string | null;
  tags: string[];
  directoryPath: string;
  enabled: boolean;
  version: number;
  usageCount: number;
  lastUsedAt: string | null;
  buildProjectId: string | null;
  buildSquadId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
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
  /**
   * External dependencies (npm/pip/brew packages, git repos, downloaded
   * assets, manual steps). Omitted = empty manifest. Validation will
   * still run, but it can only catch references to files inside the
   * technique dir; without a manifest, any external dep referenced in
   * TECHNIQUE.md will be flagged as missing.
   */
  dependencies?: DependencyManifest;
  /**
   * If true (default), refuses the save when TECHNIQUE.md references
   * files that don't resolve in the support dir or the dependency
   * manifest. Passed false by the dashboard's create-from-UI route so
   * users can build incrementally (the trainer / export-time check
   * still catches the problem before a broken technique escapes the
   * dojo). Always true for trainer-tool-initiated saves.
   */
  validateReferences?: boolean;
  publish?: boolean;
  authorAgentId?: string;
  authorAgentName?: string;
  buildProjectId?: string;
  buildSquadId?: string;
}

// ── CRUD ──

// Embed the technique's intent surface (name + description + tags), not its
// body: recall matches the user's ASK against what the technique is FOR; the
// body is loaded after selection. Techniques are global, so agentId is null.
function embedTechniqueIntent(id: string): void {
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

  // Create directory structure
  fs.mkdirSync(dirPath, { recursive: true });

  // Write TECHNIQUE.md
  fs.writeFileSync(path.join(dirPath, 'TECHNIQUE.md'), params.instructions, 'utf-8');

  // Write supporting files BEFORE validation runs so the validator can
  // resolve relative references against what will actually be on disk.
  if (params.files) {
    for (const file of params.files) {
      const filePath = path.join(dirPath, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }

  // Write dependencies.json (always — even an empty manifest, so the
  // file exists for downstream readers and the export bundle stays
  // structurally consistent across techniques).
  const manifest = params.dependencies ?? emptyDependencyManifest();
  writeDependencyManifest(dirPath, manifest);

  // ── File-reference validation ──
  // Refuse to create the technique if TECHNIQUE.md references files
  // that aren't in the support dir AND aren't declared in the manifest.
  // Roll back the partial directory so a failed create leaves no trace.
  // Skipped when validateReferences=false (dashboard create-from-UI
  // path — users can build incrementally; the export-time check still
  // catches the problem before sharing).
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

export function getTechnique(id: string): TechniqueMetadata | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM techniques WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTechnique(row);
}

// Resolve a user/agent-supplied technique reference to the canonical slug id.
// Accepts: exact id ("v-e-brew"), the original name agents passed at save time
// ("V-E-Brew" or "V E Brew"), or any case variant. Mirrors the slugification
// in createTechnique so a name → slug → row lookup works without callers
// having to know the slug rules.
//
// Without this, agents who saved a technique as "V-E-Brew" got "Technique not
// found" when they tried to use_technique({name:"V-E-Brew"}) — they had to
// remember to pass the slug "v-e-brew" instead. Friendly error suggests the
// list_techniques tool when nothing matches.
function slugifyTechniqueName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
}

export function resolveTechniqueRef(value: string): { ok: true; id: string } | { ok: false; error: string } {
  if (!value) return { ok: false, error: 'Error: technique name is required.' };
  const db = getDb();
  // 1. Exact id (the slug)
  let row = db.prepare('SELECT id FROM techniques WHERE id = ?').get(value) as { id: string } | undefined;
  if (row) return { ok: true, id: row.id };
  // 2. Slugified input (covers "V-E-Brew" → "v-e-brew" and similar)
  const slug = slugifyTechniqueName(value);
  if (slug !== value) {
    row = db.prepare('SELECT id FROM techniques WHERE id = ?').get(slug) as { id: string } | undefined;
    if (row) return { ok: true, id: row.id };
  }
  // 3. Display name, case-insensitive
  row = db.prepare('SELECT id FROM techniques WHERE name = ? COLLATE NOCASE LIMIT 1').get(value) as { id: string } | undefined;
  if (row) return { ok: true, id: row.id };
  return {
    ok: false,
    error: `Technique "${value}" not found. Use list_techniques to see what's available, or save_technique to create one.`,
  };
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

  // Mirror name/description changes into metadata.json on disk so the
  // file-system view stays consistent with the DB. Versions snapshot only
  // TECHNIQUE.md content, so metadata edits don't bump the version number.
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

  // Validate file references against the current state of the support
  // dir + dependency manifest BEFORE writing — same rule as create.
  // Skipped when validateReferences=false (dashboard manual-edit path —
  // see CreateTechniqueParams.validateReferences for rationale).
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

/**
 * Replace the technique's dependency manifest. Re-runs file-reference
 * validation against the existing TECHNIQUE.md so a manifest edit that
 * REMOVES a declared dep doesn't silently leave the .md referencing a
 * now-missing path.
 */
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

// Remediation Phase 5 (5a): close the loop the dormant `success` column was
// waiting for — the most recent usage row for this (technique, agent) gets
// the turn's outcome. Deliberately coarse (turn completed vs errored): the
// signal only needs to separate "keeps working" from "keeps failing" for
// ranking and retirement.
export function recordTechniqueOutcome(techniqueId: string, agentId: string, success: boolean): void {
  try {
    getDb().prepare(`
      UPDATE technique_usage SET success = ?
      WHERE id = (
        SELECT id FROM technique_usage
        WHERE technique_id = ? AND agent_id = ?
        ORDER BY used_at DESC LIMIT 1
      )
    `).run(success ? 1 : 0, techniqueId, agentId);
  } catch { /* best effort */ }
}

export function publishTechnique(id: string): TechniqueMetadata | null {
  const db = getDb();
  const technique = getTechnique(id);
  if (!technique) return null;
  if (technique.state === 'published') return technique;

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

  // T2: four tables, ONE unit. A failure part-way through used to leave a technique that
  // no longer exists still owning usage rows, versions or an embedding — searchable, and
  // unloadable. (Cascades do not cover it: three of the four are separate statements
  // precisely because there is no FK between them.)
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
  db.prepare(`
    INSERT INTO technique_usage (id, technique_id, agent_id, agent_name, used_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), techniqueId, agentId, agentName ?? null);

  db.prepare("UPDATE techniques SET usage_count = usage_count + 1, last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(techniqueId);

  broadcast({ type: 'technique:used', data: { id: techniqueId, name: '', agentId, agentName: agentName ?? '' } });
}

// ── Helpers ──

function rowToTechnique(row: Record<string, unknown>): TechniqueMetadata {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    state: row.state as TechniqueMetadata['state'],
    authorAgentId: row.author_agent_id as string | null,
    authorAgentName: row.author_agent_name as string | null,
    tags: JSON.parse((row.tags as string) || '[]'),
    directoryPath: row.directory_path as string,
    enabled: Boolean(row.enabled),
    version: row.version as number,
    usageCount: row.usage_count as number,
    lastUsedAt: row.last_used_at as string | null,
    buildProjectId: row.build_project_id as string | null,
    buildSquadId: row.build_squad_id as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    publishedAt: row.published_at as string | null,
  };
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
