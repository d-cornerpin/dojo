// A technique reference resolved to the directory the platform recorded: a leaf (reads rows only).
// Split out of `store.ts` (which re-exports it) so the gate loop can resolve a reference before minting
// the call's capability without pulling node:fs and the websocket broadcast into every dispatch.
// An unknown reference returns null (no grant); the handler words the failure itself.

import { getDb } from '../db/connection.js';

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

export function rowToTechnique(row: Record<string, unknown>): TechniqueMetadata {
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

export function getTechnique(id: string): TechniqueMetadata | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM techniques WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTechnique(row);
}

// Resolve a user/agent-supplied technique reference to the canonical slug id: the exact id, a slugified
// variant ("V-E-Brew"), or any case variant. Mirrors the slugification in createTechnique.
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

// The one reference-to-directory mapping the gate loop and the handler share (resolve to a row id, then
// read its recorded directory). Null when the reference resolves to nothing.
export function techniqueDirectory(ref: string): { path: string } | null {
  const resolved = resolveTechniqueRef(ref);
  if (!resolved.ok) return null;
  const technique = getTechnique(resolved.id);
  if (!technique) return null;
  return { path: technique.directoryPath };
}
