// Vault store: CRUD for vault_entries and vault_conversations, embeddings, dedup and semantic search.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { dominantMessageLineage } from '../memory/conversations.js';
import { createLogger, readLogFiles } from '../logger.js';
import { embeddingModelKey } from '../memory/embedding-model.js';
import { generateEmbedding, isEmbeddingBackendUnavailable, warnEmbeddingBackendAbsentOnce } from '../memory/embeddings.js';
import { capEntryContent } from './entry-limit.js';
export { capEntryContent, isOverEntryLimit, ownerEntryTooLongMessage, AGENT_ENTRY_CUT_NOTE } from './entry-limit.js';
import { getHouseholdAgentIds, isPMAgent, isHealerAgent } from '../config/platform.js';
import {
  scanVaultCandidates, fetchVaultRowsByIds, vaultLikeScan, vaultLikeScanSync,
  byBestSimilarity, VAULT_CANDIDATE_ROWS, type VaultLikeScanQuery,
} from './bounded-reads.js';

const logger = createLogger('vault-store');

// agent_id for owner-authored entries (written via the dashboard vault API). They form an OWNER scope
// visible to every agent's recall; per-agent privacy scoping must never hide them.
export const OWNER_VAULT_AGENT_ID = 'manual';

// ── Household recall scope (the single choke point) ──
// Distilled memory is shared across the household: a MEMBER (an id in getHouseholdAgentIds(): the
// primaries and the Dreamer) recalls the full household set plus the owner. A NON-member (spawned worker,
// harness probe) keeps [self, OWNER], so no member's id is in its scope and its id is in no member's.
// OWNER_VAULT_AGENT_ID is always included; writes keep their author id.
export function resolveRecallScope(callerAgentId: string): string[] {
  const ids = new Set<string>([callerAgentId, OWNER_VAULT_AGENT_ID]);
  try {
    const household = getHouseholdAgentIds();
    if (household.includes(callerAgentId)) {
      for (const id of household) ids.add(id);
    } else if (isPMAgent(callerAgentId) || isHealerAgent(callerAgentId)) {
      // The PM audits deliverables made of vault entries and the Healer dereferences vault evidence, so
      // both read the full household scope. Read-only: vault_update / vault_forget stay author-gated at
      // the tool layer, and neither is added to a member's scope.
      for (const id of household) ids.add(id);
    }
  } catch {
    /* config not ready: fall back to [self, OWNER] */
  }
  return [...ids];
}


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
  /**
   * Compact JSON citation of the original source: { "kind": "url" | "file", "ref", "page"?, "section"? }.
   * NULL = none. Metadata only: not embedded, not counted against the vault_remember caps, not used in dedup.
   */
  citation: string | null;
  embedding: Buffer | null;
  /** Namespace scope. NULL = personal vault; 'squad:<group_id>' = shared between that squad's members. */
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
  // Bounded Dreamer retry and poison escalation.
  attempts: number;
  poisoned: boolean;
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
  citation: string | null;
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
  // Older rows predate these columns; the mapper defaults them so NULL never surfaces as NaN.
  attempts: number | null;
  poisoned: number | null;
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
    citation: row.citation ?? null,
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
    attempts: row.attempts ?? 0,
    poisoned: row.poisoned === 1,
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


/** Parsed vault_entries.citation JSON: only `kind` and `ref` are guaranteed; page/section when named. */
export interface VaultCitation {
  kind: 'url' | 'file';
  ref: string;
  page?: number;
  section?: string;
}

/**
 * Renders a stored citation as a compact recall suffix, e.g. [source: report.pdf p.3]; '' when NULL or
 * unparseable. File paths collapse to the last segment (vault_get shows the full path); URLs stay as-is.
 */
export function formatCitationSuffix(citation: string | null | undefined): string {
  if (!citation) return '';
  let c: Partial<VaultCitation>;
  try { c = JSON.parse(citation) as Partial<VaultCitation>; } catch { return ''; }
  if (!c || typeof c.ref !== 'string' || c.ref.length === 0) return '';
  let ref = c.ref;
  if (c.kind === 'file') {
    const seg = ref.split(/[\\/]/).filter(Boolean).pop();
    if (seg) ref = seg;
  }
  let s = ref;
  if (typeof c.page === 'number' && Number.isFinite(c.page)) s += ` p.${c.page}`;
  if (typeof c.section === 'string' && c.section.trim().length > 0) s += ` (${c.section.trim()})`;
  return ` [source: ${s}]`;
}

// Cosine similarity lives in `vault/bounded-reads.ts`, beside the candidate scan that scores with it.


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
  /** Pre-serialized citation JSON from the vault_remember tool layer, stored as-is; NULL = none. */
  citation?: string | null;
  /** NULL/undefined = personal vault; 'squad:<group_id>' = shared with that squad. */
  namespace?: string | null;
  /** The writer says this fact differs from a near-identical older one: keep both, never supersede. */
  distinct?: boolean;
}): Promise<VaultEntry> {
  const db = getDb();
  const id = uuidv4();

  const content = capEntryContent(params.content);

  let embeddingBuf: Buffer | null = null;
  const embeddingModel = embeddingModelKey();   // read first: labels the model that makes this vector
  try {
    const embedding = await generateEmbedding(content);
    embeddingBuf = Buffer.from(embedding.buffer);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (isEmbeddingBackendUnavailable(err)) warnEmbeddingBackendAbsentOnce({ error: m, site: 'vault.createEntry' });
    else logger.warn('Failed to generate embedding for vault entry', { error: m });
  }

  // Near-duplicates (>= 0.92 similarity) are either a re-save or a correction; a correction keeps the pin and
  // the permanent mark of the entry it replaces.
  let corrected: VaultEntry | null = null;
  if (embeddingBuf) {
    const duplicate = await findSemanticDuplicate(content, embeddingBuf, 0.92, params.agentId, params.namespace ?? null);
    if (duplicate) {
      const norm = (s: string) =>
        s.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (norm(content) === norm(duplicate.content)) {
        logger.debug('Skipping duplicate vault entry', { existingId: duplicate.id, similarity: 'high' });
        return rowToEntry(db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(duplicate.id) as VaultEntryRow);
      }
      if (params.distinct) {
        logger.debug('Distinct fact kept beside its near-copy', { existingId: duplicate.id });
      } else {
      // Different substance at >= 0.92 is a correction of the same fact: the newer statement wins, and the
      // superseded entry stays recoverable via superseded_by.
      db.prepare('UPDATE vault_entries SET is_obsolete = 1, superseded_by = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(id, duplicate.id);
      corrected = duplicate;
      logger.info('Superseding older vault entry', { oldId: duplicate.id, newId: id });
      }
    }
  }

  db.prepare(`
    INSERT INTO vault_entries (id, agent_id, agent_name, type, content, context, confidence, is_permanent, tags, is_pinned, source_conversation_id, source, citation, embedding, embedding_model, namespace, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    params.agentId,
    params.agentName ?? null,
    params.type,
    content,
    params.context ?? null,
    params.confidence ?? 1.0,
    params.isPermanent || corrected?.isPermanent ? 1 : 0,
    JSON.stringify(params.tags ?? []),
    params.isPinned || corrected?.isPinned ? 1 : 0,
    params.sourceConversationId ?? null,
    params.source ?? 'agent',
    params.citation ?? null,
    embeddingBuf,
    embeddingBuf ? embeddingModel : null,
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
  if (updates.content !== undefined) updates = { ...updates, content: capEntryContent(updates.content) };

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

  if (updates.content !== undefined) {
    const model = embeddingModelKey();
    generateEmbedding(updates.content).then(emb => {
      db.prepare('UPDATE vault_entries SET embedding = ?, embedding_model = ? WHERE id = ?').run(Buffer.from(emb.buffer), model, id);
    }).catch(() => { /* best effort */ });
  }

  return getEntry(id);
}

const MARKED_OBSOLETE_LOG = 'Vault entry marked obsolete';

export function markObsolete(id: string, reason?: string): void {
  const db = getDb();
  db.prepare('UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  logger.info(MARKED_OBSOLETE_LOG, { id, reason });
}

/** A memory came up (recall rendered it or a search returned it): the fade rules read these two columns. */
export function recordVaultUse(ids: readonly string[]): void {
  if (ids.length === 0) return;
  getDb().prepare(
    `UPDATE vault_entries SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).run(sqlUtcStamp(new Date()), ...ids);
}

// The clean-up's hides since 2026-08-31 were blind to use: they come back once, counted as used once today.
// A correction, a stored vault_forget call, a logged Obsolete mark or a closed commitment stays hidden.
const CLEANUP_RESTORE_KEY = 'vault_cleanup_restore';

export function restoreCleanupHidesOnce(isClosedCommitment: (content: string) => boolean): void {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM config WHERE key = ?').get(CLEANUP_RESTORE_KEY)) return;
  const forgets = db.prepare(`SELECT content FROM messages WHERE content LIKE '%"vault_forget"%'`).all() as Array<{ content: string }>;
  const marks = readLogFiles().flatMap((f) => f.split('\n')).filter((line) => line.includes(MARKED_OBSOLETE_LOG));
  const purposeful = [...forgets.map((r) => r.content), ...marks].join('\n');
  const hidden = db.prepare(
    `SELECT id, content FROM vault_entries WHERE is_obsolete = 1 AND superseded_by IS NULL AND updated_at >= '2026-08-31 00:00:00'`,
  ).all() as Array<{ id: string; content: string }>;
  const ids = hidden.filter((r) => !purposeful.includes(r.id) && !isClosedCommitment(r.content)).map((r) => r.id);
  const back = db.prepare(`UPDATE vault_entries SET is_obsolete = 0, confidence = MAX(confidence, 0.5), updated_at = datetime('now') WHERE id = ?`);
  db.transaction(() => {
    for (const id of ids) back.run(id);
    recordVaultUse(ids);
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
      .run(CLEANUP_RESTORE_KEY, JSON.stringify({ at: sqlUtcStamp(new Date()), restored: ids.length }));
  })();
  if (ids.length > 0) logger.info(`Brought back ${ids.length} memories the clean-up hid`);
}

export function deleteEntry(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM vault_entries WHERE id = ?').run(id);
}

export interface ListEntriesOptions {
  type?: string;
  agentId?: string;
  tag?: string;
  pinned?: boolean;
  permanent?: boolean;
  search?: string;
  limit?: number;
  includeObsolete?: boolean;
  /**
   * Namespace filter. null/omitted = personal vault (`namespace IS NULL`); 'squad:<group_id>' = that
   * namespace. The scopes never overlap.
   */
  namespace?: string | null;
  /**
   * With agentId set, widen to the caller's recall scope (`resolveRecallScope`: the owner scope, plus the
   * household for members, the PM and the Healer). Agent recall passes true; the dashboard omits it.
   */
  includeOwnerScope?: boolean;
}

/** The listing's WHERE, split into SCOPE (always bounded) and MATCH (the LIKE, scanned separately). */
function buildListQuery(options?: ListEntriesOptions): VaultLikeScanQuery & { search: boolean } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const match: string[] = [];
  const matchParams: unknown[] = [];

  if (!options?.includeObsolete) {
    conditions.push('is_obsolete = 0');
  }
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.agentId) {
    if (options.includeOwnerScope) {
      // Household recall scope; resolveRecallScope already appends OWNER.
      const scope = resolveRecallScope(options.agentId);
      conditions.push(`agent_id IN (${scope.map(() => '?').join(', ')})`);
      params.push(...scope);
    } else {
      // Strict single-agent equality (owner-facing dashboard listing): no recall expansion.
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
    match.push('content LIKE ?');
    matchParams.push(`%${options.search}%`);
  }
  // Default to the personal vault; squad namespaces are opt-in.
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

  return {
    scope: conditions, scopeParams: params, match, matchParams,
    limit: options?.limit ?? 100, search: match.length > 0,
  };
}

/** The unfiltered listing: bounded by its own LIMIT, because no LIKE stands between it and its rows. */
function listUnmatched(q: VaultLikeScanQuery): VaultEntryRow[] {
  const db = getDb();
  const where = q.scope.length > 0 ? `WHERE ${q.scope.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM vault_entries ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...q.scopeParams, q.limit) as VaultEntryRow[];
}

export function listEntries(options?: ListEntriesOptions): VaultEntry[] {
  const q = buildListQuery(options);
  // Only the search arm has a leading-wildcard LIKE; the unmatched arm's LIMIT bounds the answer, but its
  // `ORDER BY created_at DESC` still scans the scope (vault_entries has no created_at index).
  const rows = q.search ? vaultLikeScanSync<VaultEntryRow>(q) : listUnmatched(q);
  return rows.map(rowToEntry);
}

/**
 * `listEntries`, through the reader pool, for vault_search exact mode, the recall lane's embed-outage
 * fallback (`memory/recall-lane.ts`) and `semanticSearch`'s embed-outage fallback.
 */
export async function listEntriesBounded(
  options?: ListEntriesOptions,
  signal?: AbortSignal,
): Promise<VaultEntry[]> {
  const q = buildListQuery(options);
  const rows = q.search ? await vaultLikeScan<VaultEntryRow>(q, signal) : listUnmatched(q);
  return rows.map(rowToEntry);
}


// ── Semantic Search ──

/**
 * The last semantic search's window, for `vault/tools.ts` to tell the agent about. `semanticSearch` returns
 * a bare array, so the window rides here: set on every semantic search and read right after by the same
 * caller. Not a cache and no user content: overwritten by the next search.
 */
let lastSemanticWindow: { truncated: boolean; oldestRidConsidered: number; cap: number } = {
  truncated: false, oldestRidConsidered: 0, cap: 0,
};

/** What the last `semanticSearch` on this process looked at. See `lastSemanticWindow`. */
export function lastSemanticSearchWindow(): { truncated: boolean; oldestRidConsidered: number; cap: number } {
  return lastSemanticWindow;
}

export async function semanticSearch(query: string, options?: {
  limit?: number;
  type?: string;
  minSimilarity?: number;
  // Reuse a pre-computed query embedding (auto-recall embeds the per-turn query once and shares it).
  queryEmbedding?: Float32Array;
  // Restrict to the personal scope (namespace IS NULL), matching exact mode; squad entries must not leak in.
  personalOnly?: boolean;
  // Scope to one agent's vault (plus owner and household, see resolveRecallScope). Omit only for owner-level
  // callers such as the dashboard API, never for agent recall.
  agentId?: string;
  // Aborting discards the in-flight candidate scan, which runs on the reader pool.
  signal?: AbortSignal;
}): Promise<Array<VaultEntry & { similarity: number }>> {
  const limit = options?.limit ?? 10;
  const minSim = options?.minSimilarity ?? 0.3;

  let queryEmbedding: Float32Array;
  if (options?.queryEmbedding) {
    queryEmbedding = options.queryEmbedding;
  } else {
    try {
      queryEmbedding = await generateEmbedding(query, { agentId: options?.agentId });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (isEmbeddingBackendUnavailable(err)) warnEmbeddingBackendAbsentOnce({ error: m, site: 'vault.semanticSearch' });
      else logger.warn('Failed to generate query embedding, falling back to text search', { error: m });
      // Fallback to text search (same recall scope as the semantic path), through the pooled door: this runs
      // on every vault_search while the embedding backend is down, so it must not scan on the serving thread.
      const entries = await listEntriesBounded(
        { search: query, limit, agentId: options?.agentId, includeOwnerScope: true },
        options?.signal,
      );
      // No candidate window ran here, so do not leave the previous search's one standing.
      lastSemanticWindow = { truncated: false, oldestRidConsidered: 0, cap: 0 };
      return entries.map(e => ({ ...e, similarity: 0.5 }));
    }
  }

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
    // Household recall scope; the embed-fail fallback above applies the same scope.
    const scope = resolveRecallScope(options.agentId);
    conditions.push(`agent_id IN (${scope.map(() => '?').join(', ')})`);
    params.push(...scope);
  }

  // The candidate scan is bounded and off-thread (`bounded-reads.ts`); only the winners' bodies are fetched.
  const scan = await scanVaultCandidates({
    label: 'vault_semantic',
    queryEmbedding, conditions, params,
    agentId: options?.agentId, signal: options?.signal,
    // The window is this scope's, not the table's: otherwise a table whose newest rowids belong to other
    // agents pushes the recency window above this caller's rows and the search finds nothing.
    scopeAgentIds: options?.agentId ? resolveRecallScope(options.agentId) : undefined,
  });

  lastSemanticWindow = {
    truncated: scan.truncated,
    oldestRidConsidered: scan.oldestRidConsidered,
    cap: VAULT_CANDIDATE_ROWS,
  };

  // Ties break to the older entry (see `byBestSimilarity`), independent of the scan's direction.
  const winners = scan.scored
    .filter((c) => c.similarity >= minSim)
    .sort(byBestSimilarity)
    .slice(0, limit);
  if (winners.length === 0) return [];

  const rows = await fetchVaultRowsByIds<VaultEntryRow>({
    label: 'vault_semantic', ids: winners.map((w) => w.id), signal: options?.signal,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const scored: Array<VaultEntry & { similarity: number }> = [];
  for (const w of winners) {
    const row = byId.get(w.id);
    // An entry deleted between the candidate pass and the body fetch is simply not a result.
    if (!row) continue;
    scored.push({ ...rowToEntry(row), similarity: w.similarity });
  }
  return scored;
}


// Dedupe and supersede are scoped to the SAME agent's vault, so one agent saving a near-identical
// statement can never mark another agent's entry obsolete.
async function findSemanticDuplicate(
  content: string,
  embeddingBuf: Buffer,
  threshold: number,
  agentId: string,
  namespace: string | null,
): Promise<VaultEntry | null> {
  const newEmb = new Float32Array(
    embeddingBuf.buffer,
    embeddingBuf.byteOffset,
    embeddingBuf.length / 4,
  );

  // A personal entry and a squad share are different memory spaces: each dedupes only within its own.
  const conditions = ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'];
  const dedupParams: unknown[] = [agentId];
  if (namespace === null) {
    conditions.push('namespace IS NULL');
  } else {
    conditions.push('namespace = ?');
    dedupParams.push(namespace);
  }
  const scan = await scanVaultCandidates({
    label: 'vault_dedup',
    queryEmbedding: newEmb,
    conditions,
    params: dedupParams,
    agentId,
    // The window is the author's own: a global window above their newest row would make the duplicate
    // check see nothing and let duplicates accumulate.
    scopeAgentIds: [agentId],
  });

  // The smallest rowid among the hits (the OLDEST entry over the threshold) is the one the caller
  // SUPERSEDES, whichever direction the bounded walk arrives in.
  const hit = scan.scored
    .filter((c) => c.similarity >= threshold)
    .sort((a, b) => a.rid - b.rid)[0];
  if (!hit) return null;

  const rows = await fetchVaultRowsByIds<VaultEntryRow>({ label: 'vault_dedup', ids: [hit.id] });
  return rows[0] ? rowToEntry(rows[0]) : null;
}

// Pre-save near-duplicate band check for the vault_remember TOOL path: reports the best hit in the
// low..high band (same topic, different words) so executeVaultRemember can bounce before saving and
// steer the model to vault_update. Self-scoped because the entry must be one the caller can update
// (cross-agent edits are author-gated). Returns null on an upper-band hit (the supersede path in
// createEntry handles that) and on an embed outage (fail open, never block a save).
export async function findNearDuplicateEntry(
  content: string,
  agentId: string,
  low = 0.78,
  high = 0.92,
): Promise<(VaultEntry & { similarity: number }) | null> {
  let newEmb: Float32Array;
  try {
    newEmb = await generateEmbedding(content);
  } catch {
    return null; // embed outage: fail open, do not block the save
  }

  const scan = await scanVaultCandidates({
    label: 'vault_nearband',
    queryEmbedding: newEmb,
    conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'],
    params: [agentId],
    agentId,
    scopeAgentIds: [agentId],
  });

  // An upper-band hit anywhere returns null; the band's best is picked by `byBestSimilarity`, so a tie goes
  // to the oldest entry.
  if (scan.scored.some((c) => c.similarity >= high)) return null; // supersede-class dup, defer to createEntry
  const best = scan.scored.filter((c) => c.similarity >= low).sort(byBestSimilarity)[0];
  if (!best) return null;

  const rows = await fetchVaultRowsByIds<VaultEntryRow>({ label: 'vault_nearband', ids: [best.id] });
  return rows[0] ? { ...rowToEntry(rows[0]), similarity: best.similarity } : null;
}

// Scoped by agent (plus owner and household) because pinned entries are injected into every assembled
// context and must not leak across agents.
export function getPinnedEntries(agentId?: string): VaultEntry[] {
  const db = getDb();
  let rows: VaultEntryRow[];
  if (agentId) {
    // Household recall scope (see resolveRecallScope).
    const scope = resolveRecallScope(agentId);
    const inList = scope.map(() => '?').join(', ');
    rows = db.prepare(
      `SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 AND agent_id IN (${inList}) ORDER BY created_at DESC`
    ).all(...scope) as VaultEntryRow[];
  } else {
    rows = db.prepare(
      'SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 ORDER BY created_at DESC'
    ).all() as VaultEntryRow[];
  }
  return rows.map(rowToEntry);
}

/**
 * Entries tagged 'session_context' are auto-injected at session start, in addition to pinned ones:
 * stable, small, always-loaded context. Scoped by agent (plus owner and household) like getPinnedEntries.
 */
export function getSessionContextEntries(agentId?: string): VaultEntry[] {
  const db = getDb();
  // Household recall scope (see resolveRecallScope).
  const scope = agentId ? resolveRecallScope(agentId) : [];
  const agentCond = agentId ? `AND agent_id IN (${scope.map(() => '?').join(', ')})` : '';
  const params: unknown[] = scope;
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


export function archiveConversation(params: {
  agentId: string;
  agentName?: string;
  messages: unknown[];
  messageCount: number;
  tokenCount: number;
  earliestAt: string;
  latestAt: string;
  // The highest message `seq` in this archive, the one archival high-water: compared only against
  // `messages.seq`, since a number from another keyspace would silently skip real history. Null when
  // the batch carried no key.
  latestRowid?: number | null;
}): string {
  const db = getDb();
  const id = uuidv4();

  const archiveIds = (params.messages as Array<{ id?: unknown }>)
    .map(m => (typeof m?.id === 'string' ? m.id : null))
    .filter((v): v is string => v !== null);
  const lineage = dominantMessageLineage(archiveIds);

  db.prepare(`
    INSERT INTO vault_conversations (id, agent_id, agent_name, messages, message_count, token_count, earliest_at, latest_at, latest_rowid, conversation_id, is_processed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
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
    lineage.conversationId,
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
  // Poisoned archives (the Dreamer failed to distill them after the bounded retry) are excluded from the
  // work queue; the DREAM_POISONED Healer diagnostic surfaces them instead.
  // This loads every archive's FULL messages JSON synchronously: callers needing only counts, ids or
  // sizes must use getUnprocessedConversationMeta / getUnprocessedConversationCount, and load content
  // per row via getUnprocessedConversationById.
  const rows = db.prepare(
    'SELECT * FROM vault_conversations WHERE is_processed = 0 AND poisoned = 0 ORDER BY created_at ASC'
  ).all() as VaultConversationRow[];
  return rows.map(rowToConversation);
}

/** Metadata-only view of the unprocessed queue (no messages blob); same filter and order as above. */
export interface VaultConversationMeta {
  id: string;
  agentId: string;
  agentName: string | null;
  messageCount: number;
  tokenCount: number;
  createdAt: string;
}

export function getUnprocessedConversationMeta(): VaultConversationMeta[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, agent_id, agent_name, message_count, token_count, created_at
     FROM vault_conversations WHERE is_processed = 0 AND poisoned = 0 ORDER BY created_at ASC`
  ).all() as Array<{ id: string; agent_id: string; agent_name: string | null; message_count: number; token_count: number; created_at: string }>;
  return rows.map((r) => ({
    id: r.id, agentId: r.agent_id, agentName: r.agent_name,
    messageCount: r.message_count, tokenCount: r.token_count, createdAt: r.created_at,
  }));
}

export function getUnprocessedConversationCount(): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM vault_conversations WHERE is_processed = 0 AND poisoned = 0'
  ).get() as { n: number };
  return row.n;
}

/** Full single-row load (blob included); null if the row is gone or no longer unprocessed. */
export function getUnprocessedConversationById(id: string): VaultConversation | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM vault_conversations WHERE id = ? AND is_processed = 0 AND poisoned = 0'
  ).get(id) as VaultConversationRow | undefined;
  return row ? rowToConversation(row) : null;
}


// Bumps the per-archive attempt counter after a Dreamer batch ended without distilling it, so a failing
// archive escalates instead of retrying forever. Touches only rows still awaiting processing; returns
// the new count so the caller can decide whether to poison.
export function incrementArchiveAttempt(id: string): number {
  const db = getDb();
  db.prepare(
    'UPDATE vault_conversations SET attempts = attempts + 1 WHERE id = ? AND is_processed = 0 AND poisoned = 0'
  ).run(id);
  const row = db.prepare('SELECT attempts FROM vault_conversations WHERE id = ?').get(id) as
    | { attempts: number } | undefined;
  return row?.attempts ?? 0;
}

// Marks an archive poisoned after it crossed the attempt cap. Deliberately does NOT set is_processed = 1:
// it was never distilled. poisoned = 1 excludes it from the work queue, backlog count and DREAM_STALE
// signal, and lights DREAM_POISONED. Guarded on is_processed = 0 so a racing 'complete' pass wins.
export function markArchivePoisoned(id: string, reason: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE vault_conversations SET poisoned = 1, poisoned_at = datetime('now'), poison_reason = ? WHERE id = ? AND is_processed = 0"
  ).run(reason, id);
}

// Summary for the DREAM_POISONED Healer diagnostic: parked count plus the latest reason and time.
export function getPoisonedArchiveStats(): { count: number; latestReason: string | null; latestAt: string | null } {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM vault_conversations WHERE poisoned = 1').get() as { c: number }).c;
  const latest = db.prepare(
    'SELECT poison_reason, poisoned_at FROM vault_conversations WHERE poisoned = 1 ORDER BY poisoned_at DESC LIMIT 1'
  ).get() as { poison_reason: string | null; poisoned_at: string | null } | undefined;
  return { count, latestReason: latest?.poison_reason ?? null, latestAt: latest?.poisoned_at ?? null };
}

// Backs the unfiled-archive recall bridge (`vault/retrieval.ts`): the newest archives the Dreamer has not
// filed yet, as only the columns the bridge needs. Only the caller's own archives (agent_id = ?), not the
// household recall scope; is_processed = 0 ends the bridge once the Dreamer files the archive.
export function getUnfiledArchivesForAgent(
  agentId: string,
  limit = 3,
): Array<{ id: string; messages: string; latestAt: string }> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, messages, latest_at FROM vault_conversations WHERE agent_id = ? AND is_processed = 0 ORDER BY created_at DESC LIMIT ?',
  ).all(agentId, limit) as Array<{ id: string; messages: string; latest_at: string }>;
  return rows.map(r => ({ id: r.id, messages: r.messages, latestAt: r.latest_at }));
}

export function markConversationProcessed(id: string): void {
  const db = getDb();
  db.prepare('UPDATE vault_conversations SET is_processed = 1, processed_at = datetime(\'now\') WHERE id = ?').run(id);
}

/**
 * Permanently deletes a conversation archive without extracting entries (the Dreamer's
 * vault_discard_archives tool). Returns true if a row was deleted.
 */
export function deleteConversation(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM vault_conversations WHERE id = ?').run(id);
  return res.changes > 0;
}

/**
 * Bulk-deletes unprocessed archives (the dashboard's backlog discard). Only is_processed = 0 rows, so
 * archives with extracted entries are never orphaned. Filters: agentId, olderThanIso, or `all`;
 * with none, returns 0 (refuses to delete without intent).
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


// Renders a Date as the UTC text datetime('now') writes: 'YYYY-MM-DD HH:MM:SS'.
export function sqlUtcStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

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
  ).get(sqlUtcStamp(todayStart)) as { c: number }).c;

  // Poisoned archives were tried and parked, not waiting: excluded so DREAM_BACKLOG stays honest.
  const unprocessedArchives = (db.prepare('SELECT COUNT(*) as c FROM vault_conversations WHERE is_processed = 0 AND poisoned = 0').get() as { c: number }).c;

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
