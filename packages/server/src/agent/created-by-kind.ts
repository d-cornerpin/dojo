// One column stamped at creation says who made a row; disposability is never inferred from a name.
// The kind travels with authorship (child inherits parent), because the engine creates most harness rows.

import { getDb } from '../db/connection.js';

export type CreatedByKind = 'user' | 'agent' | 'harness';

const CREATED_BY_KINDS: readonly CreatedByKind[] = ['user', 'agent', 'harness'];

function parseCreatedByKind(value: unknown): CreatedByKind | null {
  return typeof value === 'string' && (CREATED_BY_KINDS as readonly string[]).includes(value)
    ? (value as CreatedByKind)
    : null;
}

// NULL never means 'user'; a failed read writes the row unstamped; the sweep matches 'harness' positively.
export function createdByKindOfAgent(agentId: string | null | undefined): CreatedByKind | null {
  if (!agentId) return null;
  try {
    const row = getDb()
      .prepare('SELECT created_by_kind FROM agents WHERE id = ?')
      .get(agentId) as { created_by_kind: string | null } | undefined;
    return parseCreatedByKind(row?.created_by_kind ?? null);
  } catch {
    return null;
  }
}

export function inheritedCreatorKind(creatorAgentId: string | null | undefined): CreatedByKind {
  return createdByKindOfAgent(creatorAgentId) ?? 'agent';
}
