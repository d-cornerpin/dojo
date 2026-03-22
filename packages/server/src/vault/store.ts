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
    const duplicate = await findSemanticDuplicate(content, embeddingBuf, 0.92);
    if (duplicate) {
      // New entry is more recent -- check if it's more detailed
      if (content.length > duplicate.content.length) {
        // Supersede old entry
        db.prepare('UPDATE vault_entries SET is_obsolete = 1, superseded_by = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(id, duplicate.id);
        logger.info('Superseding older vault entry', { oldId: duplicate.id, newId: id });
      } else {
        // Old entry is better or same -- skip
        logger.debug('Skipping duplicate vault entry', { existingId: duplicate.id, similarity: 'high' });
        return rowToEntry(db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(duplicate.id) as VaultEntryRow);
      }
    }
  }

  db.prepare(`
    INSERT INTO vault_entries (id, agent_id, agent_name, type, content, context, confidence, is_permanent, tags, is_pinned, source_conversation_id, source, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
    conditions.push('agent_id = ?');
    params.push(options.agentId);
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
}): Promise<Array<VaultEntry & { similarity: number }>> {
  const limit = options?.limit ?? 10;
  const minSim = options?.minSimilarity ?? 0.3;

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch (err) {
    logger.warn('Failed to generate query embedding, falling back to text search', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback to text search
    const entries = listEntries({ search: query, limit });
    return entries.map(e => ({ ...e, similarity: 0.5 }));
  }

  const db = getDb();
  const conditions = ['is_obsolete = 0', 'embedding IS NOT NULL'];
  const params: unknown[] = [];

  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
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

// ── Deduplication Helper ──

async function findSemanticDuplicate(
  content: string,
  embeddingBuf: Buffer,
  threshold: number,
): Promise<VaultEntry | null> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL'
  ).all() as VaultEntryRow[];

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

export function getPinnedEntries(): VaultEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 ORDER BY created_at DESC'
  ).all() as VaultEntryRow[];
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
}): string {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO vault_conversations (id, agent_id, agent_name, messages, message_count, token_count, earliest_at, latest_at, is_processed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(
    id,
    params.agentId,
    params.agentName ?? null,
    JSON.stringify(params.messages),
    params.messageCount,
    params.tokenCount,
    params.earliestAt,
    params.latestAt,
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
