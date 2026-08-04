// ════════════════════════════════════════════════════════════════════════════
// A TECHNIQUE REFERENCE → THE DIRECTORY THE PLATFORM RECORDED — a leaf
// (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM 3(1)(a)).
//
// Extracted from `techniques/store.ts` for the same reason
// `services/attachment-resolve.ts` was extracted from `services/transcription.ts`:
// the gate loop has to resolve a technique reference BEFORE it mints the call's
// capability, and it cannot do that by importing the store — that module pulls
// in `node:fs`, the embedding refresher, the websocket broadcast and the
// versioning/dependency writers, none of which belong in every dispatch's
// module graph. `store.ts` re-exports every name that moved, so no consumer
// moved with it.
//
// ── WHY THE RESOLUTION HAS TO BE THE PLATFORM'S OWN READ ──
// The reference an agent passes is not a path and is not even one spelling of a
// name: `resolveTechniqueRef` accepts the slug id, a slugifiable variant, or the
// display name, case-insensitively, and answers with the row's id. The directory
// is then whatever `directory_path` that row records. **No scope template can
// name that directory**, which is why mechanic 5's shape — resolve the argument
// through the reader the handler uses — is the only honest declaration, and why
// this file exists rather than a string pattern in the registry.
//
// ── ONE RESOLUTION POINT ──
// `techniqueDirectory` is the reference → directory mapping, written once, and
// its two steps are the handler's own two steps against the same table. The gate
// loop and the handler therefore ask the same reader the same question and
// cannot disagree about what a call means.
//
// ── THE FAILURE SURFACE STAYS THE HANDLER'S ──
// An unknown reference returns `null` here, the gate loop mints NO grant for it,
// and the handler produces its own message ("Technique X not found. Use
// list_techniques to see what's available…") and returns before it touches the
// disk. A stale reference never becomes a bare refusal.
//
// This module holds NO restricted import: it reads rows, nothing else.
// ════════════════════════════════════════════════════════════════════════════

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

/**
 * THE ONE RESOLUTION POINT the gate loop and the handler share.
 *
 * It is the handler's own two steps — resolve the reference to a row id, read
 * that row's recorded directory — composed once so there is a single answer to
 * "which directory does this call mean?". Anything the reference does not
 * resolve to yields `null` and therefore no grant at all.
 */
export function techniqueDirectory(ref: string): { path: string } | null {
  const resolved = resolveTechniqueRef(ref);
  if (!resolved.ok) return null;
  const technique = getTechnique(resolved.id);
  if (!technique) return null;
  return { path: technique.directoryPath };
}
