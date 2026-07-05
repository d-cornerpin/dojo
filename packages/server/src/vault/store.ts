// ════════════════════════════════════════
// Vault Store: CRUD for vault_entries + vault_conversations
// Embedding generation, deduplication, semantic search
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { generateEmbedding } from '../memory/embeddings.js';
import { estimateTokens } from '../memory/store.js';

const logger = createLogger('vault-store');

const MAX_ENTRY_TOKENS = 500;

// W3-4: agent_id used by the dashboard vault API (gateway/routes/vault.ts)
// for owner-authored entries. These form a deliberate OWNER scope: visible to
// every agent's recall (the owner writes facts FOR their agents), while
// agent-authored personal entries stay private per agent. The cross-agent
// privacy scoping must never hide the owner's own hand-written entries.
export const OWNER_VAULT_AGENT_ID = 'manual';

// ── Types ──

export interface VaultEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  type: string;
  content: string;
  context: string | null;
  confidence: number;
  isPermanent: boolean;
  tags: string[];
  isPinned: boolean;
  isObsolete: boolean;
  supersededBy: string | null;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  sourceConversationId: string | null;
  source: string;
  embedding: Buffer | null;
  /**
   * Namespace scope. NULL = personal vault (legacy semantics). 'squad:<group_id>' =
   * shared between members of that squad. Phase 7 / Part X.
   */
  namespace: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultConversation {
  id: string;
  agentId: string;
  agentName: string | null;
  messages: string;
  messageCount: number;
  tokenCount: number;
  earliestAt: string;
  latestAt: string;
  isProcessed: boolean;
  processedAt: string | null;
  createdAt: string;
}

export interface DreamReport {
  id: string;
  archivesProcessed: number;
  memoriesExtracted: number;
  techniquesFound: number;
  duplicatesMerged: number;
  contradictionsResolved: number;
  entriesPruned: number;
  entriesConsolidated: number;
  totalEntries: number;
  pinnedCount: number;
  permanentCount: number;
  reportText: string | null;
  dreamMode: string;
  modelId: string | null;
  durationMs: number | null;
  createdAt: string;
}

// ── Row Mappers ──

interface VaultEntryRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  type: string;
  content: string;
  context: string | null;
  confidence: number;
  is_permanent: number;
  tags: string;
  is_pinned: number;
  is_obsolete: number;
  superseded_by: string | null;
  retrieval_count: number;
  last_retrieved_at: string | null;
  source_conversation_id: string | null;
  source: string;
  embedding: Buffer | null;
  namespace: string | null;
  created_at: string;
  updated_at: string;
}

interface VaultConversationRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  messages: string;
  message_count: number;
  token_count: number;
  earliest_at: string;
  latest_at: string;
  is_processed: number;
  processed_at: string | null;
  created_at: string;
}

interface DreamReportRow {
  id: string;
  archives_processed: number;
  memories_extracted: number;
  techniques_found: number;
  duplicates_merged: number;
  contradictions_resolved: number;
  entries_pruned: number;
  entries_consolidated: number;
  total_entries: number;
  pinned_count: number;
  permanent_count: number;
  report_text: string | null;
  dream_mode: string;
  model_id: string | null;
  duration_ms: number | null;
  created_at: string;
}

function rowToEntry(row: VaultEntryRow): VaultEntry {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags); } catch { /* empty */ }
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    type: row.type,
    content: row.content,
    context: row.context,
    confidence: row.confidence,
    isPermanent: row.is_permanent === 1,
    tags,
    isPinned: row.is_pinned === 1,
    isObsolete: row.is_obsolete === 1,
    supersededBy: row.superseded_by,
    retrievalCount: row.retrieval_count,
    lastRetrievedAt: row.last_retrieved_at,
    sourceConversationId: row.source_conversation_id,
    source: row.source,
    embedding: row.embedding,
    namespace: row.namespace ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToConversation(row: VaultConversationRow): VaultConversation {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    messages: row.messages,
    messageCount: row.message_count,
    tokenCount: row.token_count,
    earliestAt: row.earliest_at,
    latestAt: row.latest_at,
    isProcessed: row.is_processed === 1,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

function rowToReport(row: DreamReportRow): DreamReport {
  return {
    id: row.id,
    archivesProcessed: row.archives_processed,
    memoriesExtracted: row.memories_extracted,
    techniquesFound: row.techniques_found,
    duplicatesMerged: row.duplicates_merged,
    contradictionsResolved: row.contradictions_resolved,
    entriesPruned: row.entries_pruned,
    entriesConsolidated: row.entries_consolidated,
    totalEntries: row.total_entries,
    pinnedCount: row.pinned_count,
    permanentCount: row.permanent_count,
    reportText: row.report_text,
    dreamMode: row.dream_mode,
    modelId: row.model_id,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

// ── Cosine Similarity ──

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Vault Entry CRUD ──

export async function createEntry(params: {
  agentId: string;
  agentName?: string;
  type: string;
  content: string;
  context?: string;
  confidence?: number;
  isPermanent?: boolean;
  tags?: string[];
  isPinned?: boolean;
  sourceConversationId?: string;
  source?: string;
  /**
   * Optional namespace. NULL/undefined = personal vault. 'squad:<group_id>' =
   * shared with squad members (Phase 7).
   */
  namespace?: string | null;
}): Promise<VaultEntry> {
  const db = getDb();
  const id = uuidv4();

  // Enforce 500 token max
  let content = params.content;
  if (estimateTokens(content) > MAX_ENTRY_TOKENS) {
    const maxChars = MAX_ENTRY_TOKENS * 4;
    content = content.slice(0, maxChars) + '\n[Truncated -- consider creating a technique for longer procedures]';
  }

  // Generate embedding
  let embeddingBuf: Buffer | null = null;
  try {
    const embedding = await generateEmbedding(content);
    embeddingBuf = Buffer.from(embedding.buffer);
  } catch (err) {
    logger.warn('Failed to generate embedding for vault entry', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Check for semantic duplicates
  if (embeddingBuf) {
    const duplicate = await findSemanticDuplicate(content, embeddingBuf, 0.92, params.agentId);
    if (duplicate) {
      // Compare the substance (date prefix + whitespace/case normalized away).
      const norm = (s: string) =>
        s.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (norm(content) === norm(duplicate.content)) {
        // Same statement re-saved -- keep the existing entry.
        logger.debug('Skipping duplicate vault entry', { existingId: duplicate.id, similarity: 'high' });
        return rowToEntry(db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(duplicate.id) as VaultEntryRow);
      }
      // 2026-07-03: >= 0.92 similarity with DIFFERENT substance is a
      // correction/update of the same fact, and the NEW statement is the more
      // recent one -- it must win. The old "keep whichever is longer" heuristic
      // silently discarded equal-length corrections (observed live: a
      // membership code correction deduped INTO the stale entry, and the tool
      // reported the OLD content as 'Remembered'; the update was lost unless
      // the agent noticed and manually ran vault_update). Recency is user
      // authority; the superseded entry stays recoverable via superseded_by.
      db.prepare('UPDATE vault_entries SET is_obsolete = 1, superseded_by = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(id, duplicate.id);
      logger.info('Superseding older vault entry', { oldId: duplicate.id, newId: id });
    }
  }

  db.prepare(`
    INSERT INTO vault_entries (id, agent_id, agent_name, type, content, context, confidence, is_permanent, tags, is_pinned, source_conversation_id, source, embedding, namespace, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    params.agentId,
    params.agentName ?? null,
    params.type,
    content,
    params.context ?? null,
    params.confidence ?? 1.0,
    params.isPermanent ? 1 : 0,
    JSON.stringify(params.tags ?? []),
    params.isPinned ? 1 : 0,
    params.sourceConversationId ?? null,
    params.source ?? 'agent',
    embeddingBuf,
    params.namespace ?? null,
  );

  logger.info('Vault entry created', { id, type: params.type, source: params.source ?? 'agent' });
  return rowToEntry(db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(id) as VaultEntryRow);
}

export function getEntry(id: string): VaultEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(id) as VaultEntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function updateEntry(id: string, updates: {
  content?: string;
  tags?: string[];
  isPinned?: boolean;
  isPermanent?: boolean;
  confidence?: number;
}): VaultEntry | null {
  const db = getDb();
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const params: unknown[] = [];

  if (updates.content !== undefined) {
    sets.push('content = ?');
    params.push(updates.content);
  }
  if (updates.tags !== undefined) {
    sets.push('tags = ?');
    params.push(JSON.stringify(updates.tags));
  }
  if (updates.isPinned !== undefined) {
    sets.push('is_pinned = ?');
    params.push(updates.isPinned ? 1 : 0);
  }
  if (updates.isPermanent !== undefined) {
    sets.push('is_permanent = ?');
    params.push(updates.isPermanent ? 1 : 0);
  }
  if (updates.confidence !== undefined) {
    sets.push('confidence = ?');
    params.push(updates.confidence);
  }

  params.push(id);
  db.prepare(`UPDATE vault_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Re-generate embedding if content changed
  if (updates.content !== undefined) {
    generateEmbedding(updates.content).then(emb => {
      db.prepare('UPDATE vault_entries SET embedding = ? WHERE id = ?').run(Buffer.from(emb.buffer), id);
    }).catch(() => { /* best effort */ });
  }

  return getEntry(id);
}

export function markObsolete(id: string, reason?: string): void {
  const db = getDb();
  db.prepare('UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  logger.info('Vault entry marked obsolete', { id, reason });
}

export function deleteEntry(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM vault_entries WHERE id = ?').run(id);
}

export function listEntries(options?: {
  type?: string;
  agentId?: string;
  tag?: string;
  pinned?: boolean;
  permanent?: boolean;
  search?: string;
  limit?: number;
  includeObsolete?: boolean;
  /**
   * Phase 7: filter by namespace. Pass `null` (or omit) to default to
   * personal vault (`namespace IS NULL`). Pass a string like
   * `'squad:<group_id>'` to scope to that namespace. The two scopes never
   * overlap, personal-vault searches never see squad entries and vice versa.
   */
  namespace?: string | null;
  /**
   * W3-4: with agentId set, ALSO include owner-authored entries
   * (agent_id = OWNER_VAULT_AGENT_ID, written via the dashboard vault API).
   * Agent-recall paths pass true: the owner's hand-written facts are meant
   * for their agents; the cross-agent privacy fix must not hide them.
   * Owner-facing dashboard listing keeps strict equality (omit / false).
   */
  includeOwnerScope?: boolean;
}): VaultEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!options?.includeObsolete) {
    conditions.push('is_obsolete = 0');
  }
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.agentId) {
    if (options.includeOwnerScope) {
      conditions.push('(agent_id = ? OR agent_id = ?)');
      params.push(options.agentId, OWNER_VAULT_AGENT_ID);
    } else {
      conditions.push('agent_id = ?');
      params.push(options.agentId);
    }
  }
  if (options?.tag) {
    conditions.push('tags LIKE ?');
    params.push(`%"${options.tag}"%`);
  }
  if (options?.pinned) {
    conditions.push('is_pinned = 1');
  }
  if (options?.permanent) {
    conditions.push('is_permanent = 1');
  }
  if (options?.search) {
    conditions.push('content LIKE ?');
    params.push(`%${options.search}%`);
  }
  // Namespace scoping (Phase 7): default to personal vault, opt into squad
  // namespaces explicitly. Calling listEntries without `namespace` keeps the
  // existing behavior for legacy callers (vault_search, retrieval, etc.).
  if (options && Object.prototype.hasOwnProperty.call(options, 'namespace')) {
    if (options.namespace === null || options.namespace === undefined) {
      conditions.push('namespace IS NULL');
    } else {
      conditions.push('namespace = ?');
      params.push(options.namespace);
    }
  } else {
    conditions.push('namespace IS NULL');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 100;
  params.push(limit);

  const rows = db.prepare(`SELECT * FROM vault_entries ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as VaultEntryRow[];
  return rows.map(rowToEntry);
}

// ── Semantic Search ──

export async function semanticSearch(query: string, options?: {
  limit?: number;
  type?: string;
  minSimilarity?: number;
  // D4: reuse a pre-computed query embedding (assembler auto-recall embeds the
  // per-turn recall query once and shares it across message + vault search).
  queryEmbedding?: Float32Array;
  // AUDIT-FIX: restrict to the personal scope (namespace IS NULL), matching the
  // exact-mode filter in listEntries. Squad-namespace entries are documented as
  // never overlapping personal scope and must not leak into personal recall.
  personalOnly?: boolean;
  // W3-4 (behavioral run bmr59ix4lsg): scope to one agent's vault. The
  // personal vault is per-agent by design (agent_id on every entry; squad
  // namespaces are the deliberate sharing mechanism), but this search ran
  // UNSCOPED, so any agent's vault_search / auto-recall surfaced every other
  // agent's private entries (observed live: a fresh harness peer retrieved
  // the primary agent's project codename and delivered it as its own work).
  // Omit only for owner-level callers (dashboard API), never for agent recall.
  agentId?: string;
}): Promise<Array<VaultEntry & { similarity: number }>> {
  const limit = options?.limit ?? 10;
  const minSim = options?.minSimilarity ?? 0.3;

  let queryEmbedding: Float32Array;
  if (options?.queryEmbedding) {
    queryEmbedding = options.queryEmbedding;
  } else {
    try {
      queryEmbedding = await generateEmbedding(query);
    } catch (err) {
      logger.warn('Failed to generate query embedding, falling back to text search', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback to text search (same agent + owner scoping as the semantic path)
      const entries = listEntries({ search: query, limit, agentId: options?.agentId, includeOwnerScope: true });
      return entries.map(e => ({ ...e, similarity: 0.5 }));
    }
  }

  const db = getDb();
  const conditions = ['is_obsolete = 0', 'embedding IS NOT NULL'];
  const params: unknown[] = [];

  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.personalOnly) {
    conditions.push('namespace IS NULL');
  }
  if (options?.agentId) {
    // Agent recall always includes the owner scope (see OWNER_VAULT_AGENT_ID).
    conditions.push('(agent_id = ? OR agent_id = ?)');
    params.push(options.agentId, OWNER_VAULT_AGENT_ID);
  }

  const where = conditions.join(' AND ');
  const rows = db.prepare(`SELECT * FROM vault_entries WHERE ${where}`).all(...params) as VaultEntryRow[];

  const scored: Array<VaultEntry & { similarity: number }> = [];

  for (const row of rows) {
    if (!row.embedding) continue;
    const emb = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.length / 4,
    );
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= minSim) {
      scored.push({ ...rowToEntry(row), similarity: sim });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// D17: some vault entries carry a NULL embedding (a pre-C12 Ollama 500-and-drop
// at create time, or an embed outage). semanticSearch requires embedding IS NOT
// NULL, so those entries can NEVER match a semantic vault_search, only an exact
// LIKE lookup can find them. Re-embed them once so they become findable. Best
// effort and throttled (LIMIT); anything still failing is retried on the next
// boot pass. Returns how many entries were successfully re-embedded.
export async function reembedNullVaultEntries(limit = 200): Promise<number> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, content FROM vault_entries WHERE embedding IS NULL AND is_obsolete = 0 LIMIT ?',
  ).all(limit) as Array<{ id: string; content: string }>;
  let fixed = 0;
  for (const row of rows) {
    try {
      const emb = await generateEmbedding(row.content);
      db.prepare('UPDATE vault_entries SET embedding = ? WHERE id = ?').run(Buffer.from(emb.buffer), row.id);
      fixed++;
    } catch { /* best effort, retry next boot */ }
  }
  if (fixed > 0) logger.info('Re-embedded NULL-embedding vault entries', { fixed });
  return fixed;
}

// ── Deduplication Helper ──

// W3-4: dedupe/supersede is scoped to the SAME agent's vault. Unscoped, agent
// A saving a near-identical statement could mark agent B's entry obsolete
// (cross-agent data destruction via the 0.92 supersede path).
async function findSemanticDuplicate(
  content: string,
  embeddingBuf: Buffer,
  threshold: number,
  agentId: string,
): Promise<VaultEntry | null> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL AND agent_id = ?'
  ).all(agentId) as VaultEntryRow[];

  const newEmb = new Float32Array(
    embeddingBuf.buffer,
    embeddingBuf.byteOffset,
    embeddingBuf.length / 4,
  );

  for (const row of rows) {
    if (!row.embedding) continue;
    const existing = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.length / 4,
    );
    const sim = cosineSimilarity(newEmb, existing);
    if (sim >= threshold) {
      return rowToEntry(row);
    }
  }

  return null;
}

// ── Retrieval Tracking ──

export function updateRetrievalStats(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    'UPDATE vault_entries SET retrieval_count = retrieval_count + 1, last_retrieved_at = datetime(\'now\') WHERE id = ?'
  );
  for (const id of entryIds) {
    stmt.run(id);
  }
}

// ── Pinned Entries ──

// W3-4: optional agentId scoping, same reason as semanticSearch. Pinned
// entries are injected into EVERY assembled context; unscoped, one agent's
// pins leaked into every other agent's system context. Owner-authored pins
// (OWNER_VAULT_AGENT_ID) stay visible to all agents by design.
export function getPinnedEntries(agentId?: string): VaultEntry[] {
  const db = getDb();
  const rows = (agentId
    ? db.prepare(
        'SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 AND (agent_id = ? OR agent_id = ?) ORDER BY created_at DESC'
      ).all(agentId, OWNER_VAULT_AGENT_ID)
    : db.prepare(
        'SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 ORDER BY created_at DESC'
      ).all()) as VaultEntryRow[];
  return rows.map(rowToEntry);
}

/**
 * Phase 4 §C, Vault entries tagged 'session_context' get auto-injected at
 * session start (in addition to pinned entries). Mirrors Claude Code's
 * CLAUDE.md: stable, small, always-loaded context the agent expects to see
 * at the top of every fresh session.
 *
 * The tag lives in the existing `tags` JSON array on each entry, no schema
 * change. Users can write `vault_remember(content, tags=['session_context'])`
 * to mark something as session-load-on-start.
 */
// W3-4: optional agentId scoping, same reason as getPinnedEntries above,
// session-context entries are injected into assembled contexts and must not
// leak across agents. Owner-authored entries stay visible to all agents.
export function getSessionContextEntries(agentId?: string): VaultEntry[] {
  const db = getDb();
  const agentCond = agentId ? 'AND (agent_id = ? OR agent_id = ?)' : '';
  const params: unknown[] = agentId ? [agentId, OWNER_VAULT_AGENT_ID] : [];
  const rows = db.prepare(
    `SELECT * FROM vault_entries
     WHERE is_obsolete = 0
       AND tags IS NOT NULL
       AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'session_context')
       ${agentCond}
     ORDER BY created_at DESC`
  ).all(...params) as VaultEntryRow[];
  return rows.map(rowToEntry);
}

// ── Conversation Archive CRUD ──

export function archiveConversation(params: {
  agentId: string;
  agentName?: string;
  messages: unknown[];
  messageCount: number;
  tokenCount: number;
  earliestAt: string;
  latestAt: string;
  // Migration 088: the highest message rowid in this archive, the tie-free
  // archival high-water. Optional so older callers still compile; null when the
  // batch carried no rowid.
  latestRowid?: number | null;
}): string {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO vault_conversations (id, agent_id, agent_name, messages, message_count, token_count, earliest_at, latest_at, latest_rowid, is_processed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(
    id,
    params.agentId,
    params.agentName ?? null,
    JSON.stringify(params.messages),
    params.messageCount,
    params.tokenCount,
    params.earliestAt,
    params.latestAt,
    params.latestRowid ?? null,
  );

  logger.info('Conversation archived to vault', {
    id,
    agentId: params.agentId,
    messageCount: params.messageCount,
    tokenCount: params.tokenCount,
  });

  return id;
}

export function getUnprocessedConversations(): VaultConversation[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM vault_conversations WHERE is_processed = 0 ORDER BY created_at ASC'
  ).all() as VaultConversationRow[];
  return rows.map(rowToConversation);
}

export function markConversationProcessed(id: string): void {
  const db = getDb();
  db.prepare('UPDATE vault_conversations SET is_processed = 1, processed_at = datetime(\'now\') WHERE id = ?').run(id);
}

/**
 * Permanently delete a conversation archive without extracting any vault
 * entries. Used by the Dreamer's vault_discard_archives tool to throw away
 * junk batches the user has decided don't need to be remembered.
 * Returns true if a row was deleted, false if no such archive existed.
 */
export function deleteConversation(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM vault_conversations WHERE id = ?').run(id);
  return res.changes > 0;
}

/**
 * Bulk delete unprocessed conversation archives matching the given filter.
 * Surfaces from the dashboard as the "nuke the backlog" button when the
 * Dreamer's queue has gotten out of hand. Only touches is_processed = 0
 * rows so we never accidentally remove archives that have already had
 * their vault entries extracted (that would orphan source-tracking).
 *
 * Filter options:
 *   - agentId: only this agent's archives
 *   - olderThanIso: only archives created before this timestamp
 *   - all: discard every unprocessed archive
 * If no filter is provided, returns 0 (refuses to nuke without intent).
 */
export function bulkDiscardUnprocessedConversations(filter: {
  agentId?: string;
  olderThanIso?: string;
  all?: boolean;
}): number {
  const db = getDb();
  const conds: string[] = ['is_processed = 0'];
  const params: unknown[] = [];

  if (filter.agentId) {
    conds.push('agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter.olderThanIso) {
    conds.push('created_at < ?');
    params.push(filter.olderThanIso);
  }
  // If no narrowing filter is given AND `all` isn't explicitly set, refuse.
  if (!filter.agentId && !filter.olderThanIso && !filter.all) return 0;

  const sql = `DELETE FROM vault_conversations WHERE ${conds.join(' AND ')}`;
  const res = db.prepare(sql).run(...params);
  return res.changes;
}

export function getConversation(id: string): VaultConversation | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM vault_conversations WHERE id = ?').get(id) as VaultConversationRow | undefined;
  return row ? rowToConversation(row) : null;
}

export function listConversations(options?: {
  agentId?: string;
  processed?: boolean;
  limit?: number;
}): VaultConversation[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.agentId) {
    conditions.push('agent_id = ?');
    params.push(options.agentId);
  }
  if (options?.processed !== undefined) {
    conditions.push('is_processed = ?');
    params.push(options.processed ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 50;
  params.push(limit);

  const rows = db.prepare(`SELECT * FROM vault_conversations ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as VaultConversationRow[];
  return rows.map(rowToConversation);
}

// ── Dream Report CRUD ──

export function createDreamReport(params: {
  archivesProcessed: number;
  memoriesExtracted: number;
  techniquesFound: number;
  duplicatesMerged: number;
  contradictionsResolved: number;
  entriesPruned: number;
  entriesConsolidated: number;
  totalEntries: number;
  pinnedCount: number;
  permanentCount: number;
  reportText: string;
  dreamMode: string;
  modelId?: string;
  durationMs?: number;
}): DreamReport {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO dream_reports (id, archives_processed, memories_extracted, techniques_found, duplicates_merged, contradictions_resolved, entries_pruned, entries_consolidated, total_entries, pinned_count, permanent_count, report_text, dream_mode, model_id, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    params.archivesProcessed,
    params.memoriesExtracted,
    params.techniquesFound,
    params.duplicatesMerged,
    params.contradictionsResolved,
    params.entriesPruned,
    params.entriesConsolidated,
    params.totalEntries,
    params.pinnedCount,
    params.permanentCount,
    params.reportText,
    params.dreamMode,
    params.modelId ?? null,
    params.durationMs ?? null,
  );

  return rowToReport(db.prepare('SELECT * FROM dream_reports WHERE id = ?').get(id) as DreamReportRow);
}

export function getDreamReports(limit = 10): DreamReport[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM dream_reports ORDER BY created_at DESC LIMIT ?').all(limit) as DreamReportRow[];
  return rows.map(rowToReport);
}

export function getLatestDreamReport(): DreamReport | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM dream_reports ORDER BY created_at DESC LIMIT 1').get() as DreamReportRow | undefined;
  return row ? rowToReport(row) : null;
}

// ── Stats ──

export function getVaultStats(): {
  totalEntries: number;
  byType: Record<string, number>;
  permanentCount: number;
  pinnedCount: number;
  avgConfidence: number;
  retrievedToday: number;
  unprocessedArchives: number;
  lastDreamAt: string | null;
} {
  const db = getDb();

  const total = (db.prepare('SELECT COUNT(*) as c FROM vault_entries WHERE is_obsolete = 0').get() as { c: number }).c;
  const typeRows = db.prepare(
    'SELECT type, COUNT(*) as c FROM vault_entries WHERE is_obsolete = 0 GROUP BY type'
  ).all() as Array<{ type: string; c: number }>;
  const byType: Record<string, number> = {};
  for (const row of typeRows) byType[row.type] = row.c;

  const permanentCount = (db.prepare('SELECT COUNT(*) as c FROM vault_entries WHERE is_permanent = 1 AND is_obsolete = 0').get() as { c: number }).c;
  const pinnedCount = (db.prepare('SELECT COUNT(*) as c FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0').get() as { c: number }).c;
  const avgRow = db.prepare('SELECT AVG(confidence) as avg FROM vault_entries WHERE is_obsolete = 0').get() as { avg: number | null };
  const avgConfidence = avgRow.avg ?? 1.0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const retrievedToday = (db.prepare(
    'SELECT COUNT(*) as c FROM vault_entries WHERE last_retrieved_at >= ? AND is_obsolete = 0'
  ).get(todayStart.toISOString()) as { c: number }).c;

  const unprocessedArchives = (db.prepare('SELECT COUNT(*) as c FROM vault_conversations WHERE is_processed = 0').get() as { c: number }).c;

  const lastDream = db.prepare('SELECT created_at FROM dream_reports ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined;

  return {
    totalEntries: total,
    byType,
    permanentCount,
    pinnedCount,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    retrievedToday,
    unprocessedArchives,
    lastDreamAt: lastDream?.created_at ?? null,
  };
}
