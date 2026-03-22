// ════════════════════════════════════════
// Technique Store — CRUD & Directory Management
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('technique-store');

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
  state: 'draft' | 'review' | 'published' | 'disabled' | 'archived';
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
  publish?: boolean;
  authorAgentId?: string;
  authorAgentName?: string;
  buildProjectId?: string;
  buildSquadId?: string;
}

// ── CRUD ──

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

  // Write supporting files
  if (params.files) {
    for (const file of params.files) {
      const filePath = path.join(dirPath, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }

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

  // Create version 1 snapshot
  const filesSnapshot = getFilesSnapshot(dirPath);
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, 1, ?, ?, 'Initial version', ?, datetime('now'))
  `).run(uuidv4(), id, params.instructions, params.authorAgentId ?? 'system', JSON.stringify(filesSnapshot));

  logger.info('Technique created', { id, name: params.displayName, state });

  broadcast({ type: 'technique:created', data: { id, name: params.displayName, state } } as never);

  return getTechnique(id)!;
}

export function getTechnique(id: string): TechniqueMetadata | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM techniques WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTechnique(row);
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

  if (updates.state) {
    const technique = getTechnique(id);
    if (technique) {
      broadcast({ type: 'technique:state_changed', data: { id, name: technique.name, oldState: undefined, newState: updates.state } } as never);
    }
  }

  return getTechnique(id);
}

export function updateTechniqueInstructions(id: string, content: string, changeSummary: string, changedBy?: string): TechniqueMetadata | null {
  const technique = getTechnique(id);
  if (!technique) return null;

  // Write new TECHNIQUE.md
  const mdPath = path.join(technique.directoryPath, 'TECHNIQUE.md');
  fs.writeFileSync(mdPath, content, 'utf-8');

  // Increment version
  const newVersion = technique.version + 1;
  const db = getDb();
  db.prepare("UPDATE techniques SET version = ?, updated_at = datetime('now') WHERE id = ?").run(newVersion, id);

  // Create version snapshot
  const filesSnapshot = getFilesSnapshot(technique.directoryPath);
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), id, newVersion, content, changedBy ?? 'system', changeSummary, JSON.stringify(filesSnapshot));

  logger.info('Technique instructions updated', { id, version: newVersion, changedBy });

  broadcast({ type: 'technique:updated', data: { id, name: technique.name, version: newVersion } } as never);

  return getTechnique(id);
}

export function publishTechnique(id: string): TechniqueMetadata | null {
  const db = getDb();
  const technique = getTechnique(id);
  if (!technique) return null;
  if (technique.state === 'published') return technique;

  db.prepare("UPDATE techniques SET state = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);

  logger.info('Technique published', { id, name: technique.name });
  broadcast({ type: 'technique:published', data: { id, name: technique.name } } as never);

  return getTechnique(id);
}

export function deleteTechnique(id: string): boolean {
  const technique = getTechnique(id);
  if (!technique) return false;

  const db = getDb();

  // Delete DB records (cascading from ON DELETE CASCADE)
  db.prepare('DELETE FROM technique_usage WHERE technique_id = ?').run(id);
  db.prepare('DELETE FROM technique_versions WHERE technique_id = ?').run(id);
  db.prepare('DELETE FROM techniques WHERE id = ?').run(id);

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

  broadcast({ type: 'technique:used', data: { id: techniqueId, name: '', agentId, agentName: agentName ?? '' } } as never);
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
