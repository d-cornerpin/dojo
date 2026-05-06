// ════════════════════════════════════════
// vault/namespaces.ts — Phase 7 squad shared memory (Part X)
//
// Squad coordination today goes through A2A messages: high-latency, lossy,
// no semantic recall. v2 adds a vault namespace per squad so members can
// write/read shared knowledge directly.
//
// Implementation: leverages the existing `vault_entries` table via a
// `namespace` column (NULL = personal vault, 'squad:<group_id>' = squad).
// Reuses the existing embedding pipeline, semantic-duplicate detection,
// and retrieval, so squad entries get the same quality of recall as
// personal-vault entries.
//
// Public surface:
//   - vaultRememberInNamespace(agentId, namespace, content, tags)
//   - vaultSearchInNamespace(agentId, namespace, query, opts)
//
// Namespace strings are conventionally `squad:<group_id>`. The functions
// don't validate the format — caller (squad_share / squad_recall executors
// in agent/tools.ts) is responsible for resolving the agent's group_id and
// composing the namespace.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { createEntry, listEntries, type VaultEntry } from './store.js';
import { getDb } from '../db/connection.js';

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

/**
 * Write a vault entry into a squad namespace. Same dedup + embedding path
 * as personal `vault_remember`; only difference is the `namespace` field.
 */
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
 * Recall entries from a squad namespace. Combines a literal LIKE filter
 * (cheap, deterministic) with an `ORDER BY created_at DESC` window. The
 * existing semantic-search path is keyed off personal-vault and would need
 * a deeper refactor to scope by namespace cleanly — keyword + recency is
 * sufficient for Phase 7 acceptance ("members can retrieve each other's
 * writes"). If we want semantic recall in v2.1 we add a parallel namespaced
 * `semanticSearch` then.
 */
export function vaultSearchInNamespace(params: {
  namespace: string;
  query?: string;
  limit?: number;
  agentIdFilter?: string; // optional — restrict to writes by a specific squad member
  tag?: string;
}): NamespaceRecallResult[] {
  const limit = params.limit ?? DEFAULT_RECALL_LIMIT;
  // listEntries returns entries scoped to the namespace; we just narrow with
  // search/tag/agent filters and shape the result for the tool consumer.
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
 * Resolve an agent's squad namespace string from its group_id, or null if
 * the agent isn't in a group. Tools call this before share/recall so they
 * can return a clean error to the model when the agent has no squad.
 */
export function resolveAgentNamespace(agentId: string): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT group_id FROM agents WHERE id = ?')
    .get(agentId) as { group_id: string | null } | undefined;
  if (!row?.group_id) return null;
  return `squad:${row.group_id}`;
}
