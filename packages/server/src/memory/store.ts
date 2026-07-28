// ════════════════════════════════════════
// The model-facing readers of `messages`.
// ════════════════════════════════════════
//
// PHASE-1 T5. There is ONE message table and ONE tail query. What stood here before was a
// pair of loaders per window — a plain one and a `*Merged` twin — that UNIONed `messages`
// with `inter_agent_messages`, NULL-padded the columns the second table lacked, dedup'd the
// double-homed ids with an anti-join, and stitched the two rowid spaces back together with
// a synthetic `(created_at, _tag, _rowid)` collation. All of that existed to answer one
// question the schema now answers by itself: which lane is this row on.
//
// STRIP — `mergedTailQuery`, `getRecentMessagesMerged`, `getMessagesOutsideFreshTailMerged`,
// `getMessagesByAgentMerged`, `getMessagesByAgent`.
// Requirement preserved: ONE tail query per window, over every lane the agent owns, in true
// insertion order. `ORDER BY seq` replaces the three-part collation everywhere.
//
// WHY `seq` AND NOT `created_at`. `created_at` is second-granular TEXT, and the engine's own
// undelivered-event re-home (`message-store.rehomeUndeliveredCreatedAt`) deliberately pushes
// a row's clock FORWARD while its insertion key stays put — so a clock-ordered tail reports a
// row that was written first as though it arrived last. `seq` is `INTEGER PRIMARY KEY
// AUTOINCREMENT`, i.e. the table's rowid under a name that means something, and it cannot
// drift. (T10 promotes it to the PK alias role across the tree.)
//
// LANE, NOT TABLE. These loaders are the MODEL's view and deliberately carry every lane the
// agent owns — owner conversation, agent-to-agent coordination, engine events. That is the
// defect this phase exists to close: agent-to-agent history used to sit in a table with no
// FTS index and no summaries, structurally unrecallable. Anything rendered to a PERSON reads
// the fail-closed `chat_messages` view (`lane='owner'`), never these.

import { getDb } from '../db/connection.js';
import type { Message } from '@dojo/shared';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';

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

/** Every loader below projects exactly this list, so `rowToMessage` never has to ask whether
 *  a column happened to be selected. `seq` is projected as itself: it IS the rowid. */
const SELECT_COLS = `seq, id, agent_id, role, content, token_count, model_id, cost,
  latency_ms, created_at, turn_number, reasoning_content, lane, channel, source_agent_id,
  a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_intent, conv_key`;

export interface MessageRow {
  /** The insertion key — `INTEGER PRIMARY KEY AUTOINCREMENT`, the table's rowid. */
  seq: number;
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
  /** The stamped-at-ingest lane (OR4). Origin is PROJECTED from it — never re-parsed. */
  lane: string;
  channel: string | null;
  source_agent_id: string | null;
  a2a_thread_id: string | null;
  a2a_intent: string | null;
  a2a_requires_response: number | null;
  inbound_meta: string | null;
  origin_intent: string | null;
  conv_key: string | null;
}

export function rowToMessage(row: MessageRow): Message {
  // T5: the origin projection reads the STAMPED facts (`lane`, `channel`) instead of the two
  // compat columns migration 127 carries for the writers that had not converted yet.
  // `origin_kind` was only ever `lane='events'` spelled differently, and `source` was
  // `lane='a2a'` plus `channel='voice'` folded into one nullable string (T3-0b §1/§3).
  // Proven equivalent before the change, on every row the live box holds:
  //   origin_kind mismatches 0 · source mismatches 0 · total rows 3211
  // The two columns themselves are T10's to drop; this is the reader half.
  const legacy = legacyOriginInputs(row.lane, row.channel);
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
    // The insertion key. One table, one keyspace: this is always a `messages.seq`, which is
    // what the vault high-water and compaction's archive filter compare against.
    rowid: row.seq,
    // Phase 4 §E (2026-05-04) — surface turn_number so the assembler's
    // stub-and-store pass can age out tool results from old turns.
    turnNumber: row.turn_number,
    // Reasoning content from thinking-mode providers (DeepSeek native,
    // OpenRouter unified reasoning, etc.). Migration 040.
    reasoningContent: row.reasoning_content,
    // ── Attribution ──
    source: legacy.source,
    sourceAgentId: row.source_agent_id,
    a2aThreadId: row.a2a_thread_id,
    a2aIntent: row.a2a_intent,
    a2aRequiresResponse: row.a2a_requires_response,
    inboundMeta: row.inbound_meta,
    convKey: row.conv_key,
    // The single canonical "who is this from" signal, derived from stamped columns.
    origin: deriveOrigin({
      role: row.role as Message['role'],
      content: row.content,
      ...legacy,
      sourceAgentId: row.source_agent_id,
      a2aThreadId: row.a2a_thread_id,
      a2aIntent: row.a2a_intent,
      a2aRequiresResponse: row.a2a_requires_response,
      inboundMeta: row.inbound_meta,
      originIntent: row.origin_intent,
    }),
  };
}

// ── Query Functions ──

/** The newest `count` rows for an agent, oldest-first.
 *
 *  Window semantics are unchanged from the two-table era: bounded below by the agent's
 *  session boundary, and `turnCutoff` (when given) drops user rows that arrived after the
 *  turn started so a turn never answers a message it has not claimed. Both predicates
 *  compare `created_at` as TEXT — deliberately: the whole time column stays TEXT until T6
 *  converts the format and all of its predicates together, in one owned step. */
export function getRecentMessages(agentId: string, count: number, turnCutoff?: string): Message[] {
  const db = getDb();
  const sessionBoundary = getSessionBoundary(agentId);
  const params: Record<string, unknown> = { agentId, count };
  const clauses = ['agent_id = @agentId'];
  if (sessionBoundary) { clauses.push('created_at >= @boundary'); params.boundary = sessionBoundary; }
  if (turnCutoff) { clauses.push("NOT (role = 'user' AND created_at > @cutoff)"); params.cutoff = turnCutoff; }

  // Newest `count` by insertion key, returned oldest-first.
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT ${SELECT_COLS} FROM messages
       WHERE ${clauses.join(' AND ')}
       ORDER BY seq DESC LIMIT @count
    ) ORDER BY seq ASC
  `).all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

/** Everything EXCEPT the newest `freshTailCount` rows, oldest-first.
 *
 *  FA-M3: this partition must stay exactly complementary with `getRecentMessages`, or the
 *  tail-to-summary handoff drops or duplicates messages. Both now order by the same single
 *  key, so complementarity is structural rather than a pair of collations that have to be
 *  kept in step by hand. A `NULL` cutoff (agent has no rows) yields no rows, which is the
 *  right answer for an empty history. */
export function getMessagesOutsideFreshTail(agentId: string, freshTailCount: number): Message[] {
  const db = getDb();
  const sessionBoundary = getSessionBoundary(agentId);
  const params: Record<string, unknown> = { agentId, freshTailCount };
  const clauses = ['agent_id = @agentId'];
  if (sessionBoundary) { clauses.push('created_at >= @boundary'); params.boundary = sessionBoundary; }
  const where = clauses.join(' AND ');

  const rows = db.prepare(`
    SELECT ${SELECT_COLS} FROM messages
     WHERE ${where}
       AND seq < (SELECT MIN(seq) FROM (
             SELECT seq FROM messages WHERE ${where} ORDER BY seq DESC LIMIT @freshTailCount
           ))
     ORDER BY seq ASC
  `).all(params) as MessageRow[];
  return rows.map(rowToMessage);
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

/** Resolve message ids to rows, in insertion order.
 *
 *  This is how a summary's source chunk is rebuilt (`dag.getSummarySourceMessages`), so the
 *  ORDER is the conversation the model is shown. It used to be `(created_at, _tag, _rowid)`
 *  over a UNION of two tables with a JS dedup pass on top, because a chunk could cover rows
 *  from either home; one table means one key and no dedup step. */
export function getMessagesByIds(ids: string[]): Message[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT ${SELECT_COLS} FROM messages WHERE id IN (${placeholders}) ORDER BY seq ASC`,
  ).all(...ids) as MessageRow[];
  return rows.map(rowToMessage);
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
