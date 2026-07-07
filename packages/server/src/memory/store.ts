import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { Message } from '@dojo/shared';
import { deriveOrigin } from '@dojo/shared';

const logger = createLogger('memory-store');

// ── Session Boundary ──

function getSessionBoundary(agentId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined;
  return row?.session_started_at ?? null;
}

// ── Token Estimation ──

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Row-to-Message Mapping ──

export interface MessageRow {
  id: string;
  agent_id: string;
  role: string;
  content: string;
  token_count: number | null;
  model_id: string | null;
  cost: number | null;
  latency_ms: number | null;
  created_at: string;
  turn_number: number | null;
  reasoning_content: string | null;
  // Attribution columns (mig 046 source, 027 source_agent_id, 034 a2a_*,
  // 073 inbound_meta). All queries SELECT *, so these are present on the row;
  // the mapper previously dropped them. Surfaced now for the origin projection.
  source: string | null;
  source_agent_id: string | null;
  a2a_thread_id: string | null;
  a2a_intent: string | null;
  a2a_requires_response: number | null;
  inbound_meta: string | null;
  origin_kind: string | null;
  origin_intent: string | null;
  conv_key: string | null;
  // Only projected by queries that add `, rowid` to their SELECT (rowid is not
  // part of `*`). Undefined elsewhere; consumers that need it opt in.
  rowid?: number;
}

export function rowToMessage(row: MessageRow): Message {
  const source = (row.source === 'voice' || row.source === 'a2a') ? row.source : null;
  return {
    id: row.id,
    agentId: row.agent_id,
    role: row.role as Message['role'],
    content: row.content,
    tokenCount: row.token_count,
    modelId: row.model_id,
    cost: row.cost,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    // Present only when the source query projected `, rowid` (see MessageRow).
    rowid: row.rowid,
    // Phase 4 §E (2026-05-04) — surface turn_number so the assembler's
    // stub-and-store pass can age out tool results from old turns.
    turnNumber: row.turn_number,
    // Reasoning content from thinking-mode providers (DeepSeek native,
    // OpenRouter unified reasoning, etc.). Migration 040.
    reasoningContent: row.reasoning_content,
    // ── Attribution (previously dropped here) ──
    source,
    sourceAgentId: row.source_agent_id,
    a2aThreadId: row.a2a_thread_id,
    a2aIntent: row.a2a_intent,
    a2aRequiresResponse: row.a2a_requires_response,
    inboundMeta: row.inbound_meta,
    convKey: row.conv_key,
    // The single canonical "who is this from" signal. Structured columns win;
    // legacy rows fall back to marker parsing via the shim in deriveOrigin.
    origin: deriveOrigin({
      role: row.role as Message['role'],
      content: row.content,
      source: row.source,
      sourceAgentId: row.source_agent_id,
      a2aThreadId: row.a2a_thread_id,
      a2aIntent: row.a2a_intent,
      a2aRequiresResponse: row.a2a_requires_response,
      inboundMeta: row.inbound_meta,
      originKind: row.origin_kind,
      originIntent: row.origin_intent,
    }),
  };
}

// ── Merged tail loaders (D-A inter-agent physical store) ──
//
// Peer A2A inbound rows now live in `inter_agent_messages`, not `messages`. The
// model view is UNCHANGED IN SHAPE but RE-SOURCED: the tail is the UNION of both
// tables, mapped through the same rowToMessage/deriveOrigin, so rows come out
// byte-identical to the legacy single-table tail (correctness-floor guarantee).
//
// Ordering across two tables: rowid is only meaningfully comparable WITHIN a table
// (each table has its own rowid sequence). We therefore sort by
// (created_at, table_tag, rowid); table_tag (0 = messages, 1 = inter_agent) sits
// BETWEEN created_at and rowid. Within one table this collapses to the legacy
// (created_at, rowid) order exactly. When two rows from different tables share a
// created_at (SQLite second precision, so ties are common) there is no cross-table
// ground-truth insertion order anyway; table_tag gives a stable, reproducible tie
// break. messages-first (tag 0) is also the causally-correct interim choice: every
// pre-cutover row lives in `messages` and every post-cutover peer A2A row lives in
// the store, so at a tie the `messages` row is the earlier one. The assembler then
// partitions by origin.kind, so cross-lane ordering at an identical instant does
// not affect what any single turn's model call sees.
//
// Dedup: the live-edge backfill (migration 098) COPIES rows into the store while
// leaving them in `messages`, so the messages arm excludes any id that exists in
// the store. A backfilled row is thus counted once (from the store), never doubled.

/** The projected column list is identical for both arms; the store arm fills the
 *  non-A2A columns as NULL (exactly what a peer A2A row carries in `messages`). */
function mergedTailQuery(opts: { boundary: boolean; cutoff: boolean; exposeRowid: boolean }): string {
  const boundaryClause = opts.boundary ? 'AND created_at >= @boundary' : '';
  const cutoffClause = opts.cutoff ? "AND NOT (role = 'user' AND created_at > @cutoff)" : '';
  const rowidCol = opts.exposeRowid ? ', rowid AS rowid' : '';
  return `
    SELECT id, agent_id, role, content, token_count, model_id, cost, latency_ms,
           created_at, turn_number, reasoning_content, source, source_agent_id,
           a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta,
           origin_kind, origin_intent, conv_key,
           rowid AS _rowid, 0 AS _tag${rowidCol}
    FROM messages
    WHERE agent_id = @agentId ${boundaryClause} ${cutoffClause}
      AND id NOT IN (SELECT id FROM inter_agent_messages WHERE agent_id = @agentId)
    UNION ALL
    SELECT id, agent_id, role, content, NULL AS token_count, NULL AS model_id, NULL AS cost, NULL AS latency_ms,
           created_at, turn_number, NULL AS reasoning_content, NULL AS source, source_agent_id,
           a2a_thread_id, a2a_intent, a2a_requires_response, NULL AS inbound_meta,
           origin_kind, origin_intent, conv_key,
           rowid AS _rowid, 1 AS _tag${rowidCol}
    FROM inter_agent_messages
    WHERE agent_id = @agentId ${boundaryClause} ${cutoffClause}
  `;
}

/** Merged variant of getRecentMessages. Same window semantics; UNIONs the store. */
export function getRecentMessagesMerged(agentId: string, count: number, turnCutoff?: string): Message[] {
  const db = getDb();
  const sessionBoundary = getSessionBoundary(agentId);
  const params: Record<string, unknown> = { agentId, count };
  if (sessionBoundary) params.boundary = sessionBoundary;
  if (turnCutoff) params.cutoff = turnCutoff;

  // Take the newest `count` rows across both tables (DESC by the merged key), then
  // return them oldest-first (ASC by the same key), mirrors getRecentMessages,
  // which does not expose rowid on its rows (aliased to _rowid), so we do the same.
  const sql = `
    SELECT * FROM (
      ${mergedTailQuery({ boundary: !!sessionBoundary, cutoff: !!turnCutoff, exposeRowid: false })}
      ORDER BY created_at DESC, _tag DESC, _rowid DESC
      LIMIT @count
    )
    ORDER BY created_at ASC, _tag ASC, _rowid ASC
  `;
  const rows = db.prepare(sql).all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

/** Merged variant of getMessagesOutsideFreshTail. Same high-water semantics.
 *  Exposes rowid so the archival high-water (vault/archive.ts, compaction) can
 *  filter tie-free. NB: this MESSAGES high-water (vault_conversations.latest_rowid)
 *  is `messages`-scoped; a store row carries its own (independent) rowid here, and
 *  a store row's rowid is far below the messages high-water on any established box,
 *  so the compaction archive path (bounded by the messages high-water) leaves store
 *  rows out of vault_conversations and simply summarizes them (id-based; the raw
 *  store rows persist, no data loss). That Dreamer-coverage gap is now closed by a
 *  PRINCIPLED store-side high-water: migration 100 adds vault_conversations.latest_ia_rowid,
 *  and the session-reset/terminate archive pass gained a store arm
 *  (vault/archive.ts archiveAgentStoreConversation + getStoreArchiveHighWaterMark)
 *  that copies new inter_agent_messages rows into vault_conversations on the same
 *  per-agent boundary as the messages arm. Compaction is deliberately untouched. */
export function getMessagesOutsideFreshTailMerged(agentId: string, freshTailCount: number): Message[] {
  const db = getDb();
  const sessionBoundary = getSessionBoundary(agentId);
  const params: Record<string, unknown> = { agentId, freshTailCount };
  if (sessionBoundary) params.boundary = sessionBoundary;

  // "All rows except the newest N", over the merged set, using the same merged
  // sort key for BOTH the inner cutoff and the outer order so the inside/outside
  // partition stays complementary with getRecentMessagesMerged (FA-M3).
  const inner = mergedTailQuery({ boundary: !!sessionBoundary, cutoff: false, exposeRowid: true });
  const sql = `
    WITH merged AS (${inner})
    SELECT * FROM merged
    WHERE id NOT IN (
      SELECT id FROM merged
      ORDER BY created_at DESC, _tag DESC, _rowid DESC
      LIMIT @freshTailCount
    )
    ORDER BY created_at ASC, _tag ASC, _rowid ASC
  `;
  const rows = db.prepare(sql).all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

/** Merged variant of getMessagesByAgent. Exposed for the step-3/5 read-path switch
 *  (dashboard inter-agent lane, counterparty). Not wired into any reader here. */
export function getMessagesByAgentMerged(
  agentId: string,
  options?: { limit?: number; since?: string; before?: string },
): Message[] {
  const db = getDb();
  const extra: string[] = [];
  const params: Record<string, unknown> = { agentId };
  if (options?.since) { extra.push('AND created_at >= @since'); params.since = options.since; }
  if (options?.before) { extra.push('AND created_at < @before'); params.before = options.before; }
  const filter = extra.join(' ');

  const sql = `
    SELECT id, agent_id, role, content, token_count, model_id, cost, latency_ms,
           created_at, turn_number, reasoning_content, source, source_agent_id,
           a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta,
           origin_kind, origin_intent, conv_key, rowid AS _rowid, 0 AS _tag
    FROM messages
    WHERE agent_id = @agentId ${filter}
      AND id NOT IN (SELECT id FROM inter_agent_messages WHERE agent_id = @agentId)
    UNION ALL
    SELECT id, agent_id, role, content, NULL, NULL, NULL, NULL,
           created_at, turn_number, NULL, NULL, source_agent_id,
           a2a_thread_id, a2a_intent, a2a_requires_response, NULL,
           origin_kind, origin_intent, conv_key, rowid AS _rowid, 1 AS _tag
    FROM inter_agent_messages
    WHERE agent_id = @agentId ${filter}
    ORDER BY created_at ASC, _tag ASC, _rowid ASC
    ${options?.limit ? 'LIMIT @limit' : ''}
  `;
  if (options?.limit) params.limit = options.limit;
  const rows = db.prepare(sql).all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

// ── Query Functions ──

export function getMessagesByAgent(
  agentId: string,
  options?: { limit?: number; since?: string; before?: string },
): Message[] {
  const db = getDb();
  const conditions = ['agent_id = ?'];
  const params: unknown[] = [agentId];

  if (options?.since) {
    conditions.push('created_at >= ?');
    params.push(options.since);
  }
  if (options?.before) {
    conditions.push('created_at < ?');
    params.push(options.before);
  }

  let sql = `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, rowid ASC`;

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessagesOutsideFreshTail(agentId: string, freshTailCount: number): Message[] {
  // D-A step 2: re-sourced to the merged (messages ∪ inter_agent_messages) tail so
  // the inside/outside partition stays complementary with getRecentMessages (which
  // is also merged below). Byte-identical for a pure-messages agent; adds peer A2A
  // store rows for A2A-receiving agents. Kept as a thin delegate so every existing
  // caller (compaction, gap count) moves coherently in one place.
  return getMessagesOutsideFreshTailMerged(agentId, freshTailCount);
}

// Canonical model-aware fresh-tail window size. Larger models keep more raw
// conversation. This is the SINGLE source of truth (FA-M3): the assembler's
// tail-shown count and compaction's inside-tail count MUST be the same number,
// or the tail-to-summary handoff drops or duplicates messages. Both the
// assembler and compaction import this; do not re-inline the table anywhere.
export function getFreshTailCount(contextWindow: number): number {
  if (contextWindow >= 200000) return 80;   // 200k+ (Sonnet, Opus), ~15-20 turns
  if (contextWindow >= 128000) return 64;   // 128k (GPT-4o), ~12-15 turns
  if (contextWindow >= 32000) return 40;    // 32k models, ~8-10 turns
  return 24;                                 // Small models, ~5 turns
}

export function getMessagesByIds(ids: string[]): Message[] {
  if (ids.length === 0) return [];

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  // D-A hotfix (rides migration 103): summary source ids are two-homed. A leaf
  // summary's chunk can cover inter-agent store rows, so resolving its sources
  // (getSummarySourceMessages, the rebuild / sole-copy machinery) must read the
  // MERGED id space or store-homed sources silently vanish from rebuilds. Same
  // shared-column projection as the merged tail loaders (the two tables have
  // different column sets, so the store arm NULL-pads). Ids are globally unique
  // uuids; a double-homed live-edge backfill row could appear twice, keep the
  // messages copy (tag 0 sorts first on a created_at tie).
  const rows = db.prepare(
    `SELECT id, agent_id, role, content, token_count, model_id, cost, latency_ms,
            created_at, turn_number, reasoning_content, source, source_agent_id,
            a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta,
            origin_kind, origin_intent, conv_key, rowid AS _rowid, 0 AS _tag
       FROM messages WHERE id IN (${placeholders})
     UNION ALL
     SELECT id, agent_id, role, content, NULL AS token_count, NULL AS model_id, NULL AS cost, NULL AS latency_ms,
            created_at, turn_number, NULL AS reasoning_content, NULL AS source, source_agent_id,
            a2a_thread_id, a2a_intent, a2a_requires_response, NULL AS inbound_meta,
            origin_kind, origin_intent, conv_key, rowid AS _rowid, 1 AS _tag
       FROM inter_agent_messages WHERE id IN (${placeholders})
     ORDER BY created_at ASC, _tag ASC, _rowid ASC`,
  ).all(...ids, ...ids) as MessageRow[];

  const seen = new Set<string>();
  const deduped = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return deduped.map(rowToMessage);
}

export function getRecentMessages(agentId: string, count: number, turnCutoff?: string): Message[] {
  // D-A step 2: the woken A2A receiver's turn tail (assembler.ts freshTailRaw) is
  // this function. Peer A2A inbound now lands in inter_agent_messages, so a
  // messages-only tail would leave a NEW ASSIGN INVISIBLE to the model. Re-sourced
  // to the merged tail so the store ASSIGN appears in context identically to before
  // (same window, session-boundary and turn-cutoff semantics; rowid not exposed on
  // the returned rows, matching the legacy behavior). Thin delegate so every caller
  // moves in one place.
  return getRecentMessagesMerged(agentId, count, turnCutoff);
}

export function getMessageCountByAgent(agentId: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM messages WHERE agent_id = ?',
  ).get(agentId) as { count: number };
  return row.count;
}

export function getTotalTokensByAgent(agentId: string): number {
  const db = getDb();
  const sessionBoundary = getSessionBoundary(agentId);
  const boundaryClause = sessionBoundary ? 'AND created_at >= ?' : '';
  const boundaryParams = sessionBoundary ? [sessionBoundary] : [];

  // Sum known token counts (current session only)
  const knownRow = db.prepare(
    `SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE agent_id = ? ${boundaryClause} AND token_count IS NOT NULL`,
  ).get(agentId, ...boundaryParams) as { total: number };

  // Estimate tokens for messages with null token_count
  const nullRows = db.prepare(
    `SELECT content FROM messages WHERE agent_id = ? ${boundaryClause} AND token_count IS NULL`,
  ).all(agentId, ...boundaryParams) as Array<{ content: string }>;

  const estimatedTotal = nullRows.reduce(
    (sum, row) => sum + estimateTokens(row.content),
    0,
  );

  return knownRow.total + estimatedTotal;
}
