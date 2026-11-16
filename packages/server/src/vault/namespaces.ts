// Squad shared memory: vault entries in a namespace ('squad:<group_id>'; NULL is the personal vault), reusing the
// `vault_entries` embedding pipeline and duplicate detection. The namespace format is not validated here;
// the squad_share / squad_recall executors (agent/tools/cat/contacts.ts) compose it.

import { createLogger } from '../logger.js';
import { createEntry, listEntries, type VaultEntry } from './store.js';
import { getDb } from '../db/connection.js';
import { isPrimaryAgent } from '../config/platform.js';

const logger = createLogger('vault-namespaces');

const SNIPPET_MAX_CHARS = 200;
const DEFAULT_RECALL_LIMIT = 5;

export interface NamespaceRecallResult {
  id: string;
  agentId: string;
  agentName: string | null;
  snippet: string;
  tags: string[];
  createdAt: string;
  fullLength: number;
}

/** Writes a vault entry into a squad namespace through the same dedup and embedding path as `vault_remember`. */
export async function vaultRememberInNamespace(params: {
  agentId: string;
  agentName?: string;
  namespace: string;
  content: string;
  tags?: string[];
  type?: string;
}): Promise<VaultEntry> {
  const entry = await createEntry({
    agentId: params.agentId,
    agentName: params.agentName,
    type: params.type ?? 'fact',
    content: params.content,
    tags: params.tags ?? [],
    namespace: params.namespace,
    source: 'squad_share',
  });
  logger.info('Squad entry created', {
    id: entry.id,
    namespace: params.namespace,
    agentId: params.agentId,
  });
  return entry;
}

/**
 * Recalls from a squad namespace by literal LIKE filter, newest first (keyword and recency, not semantic):
 * the semantic search path is scoped to the personal vault and cannot scope by namespace.
 */
export function vaultSearchInNamespace(params: {
  namespace: string;
  query?: string;
  limit?: number;
  agentIdFilter?: string; // restrict to writes by a specific squad member
  tag?: string;
}): NamespaceRecallResult[] {
  const limit = params.limit ?? DEFAULT_RECALL_LIMIT;
  const rows = listEntries({
    namespace: params.namespace,
    search: params.query && params.query.trim().length > 0 ? params.query : undefined,
    tag: params.tag,
    agentId: params.agentIdFilter,
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: r.agentName,
    snippet:
      r.content.length > SNIPPET_MAX_CHARS
        ? r.content.slice(0, SNIPPET_MAX_CHARS) + '…'
        : r.content,
    tags: r.tags,
    createdAt: r.createdAt,
    fullLength: r.content.length,
  }));
}

/**
 * The squad namespace an agent reads: its own group's, or a named group it created (any group, for the main
 * agent, whose own group is the System group). Null when there is none it may use.
 */
export function resolveAgentNamespace(agentId: string, groupId?: string): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT group_id FROM agents WHERE id = ?')
    .get(agentId) as { group_id: string | null } | undefined;
  if (!groupId || groupId === row?.group_id) return row?.group_id ? `squad:${row.group_id}` : null;
  const group = db.prepare('SELECT created_by FROM agent_groups WHERE id = ?').get(groupId) as { created_by: string } | undefined;
  return group && (group.created_by === agentId || isPrimaryAgent(agentId)) ? `squad:${groupId}` : null;
}
