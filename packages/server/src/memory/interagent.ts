// ════════════════════════════════════════
// Inter-agent physical store (D-A). Write path + row mapper.
// ════════════════════════════════════════
//
// Backs migration 098_inter_agent_messages.sql. Owner decision D-A: peer A2A
// inbound traffic lives in its OWN physical table (`inter_agent_messages`), not in
// the primary's `messages` chat table, so no forgetful downstream filter can leak
// it into human chat. This module owns the write into that table and the mapping
// from a raw store row back into the shared `Message` shape.
//
// The columns mirror the A2A-relevant columns of `messages` exactly, so the SAME
// rowToMessage + deriveOrigin projection used for `messages` also applies here and
// the merged model tail (memory/store.ts) comes out byte-identical to the legacy
// single-table tail. That byte-identity is the whole point: it protects the
// correctness floor (the weakest model must act on an ASSIGN identically whether it
// was sourced from `messages` or the store).

import { getDb } from '../db/connection.js';
import { resolveOrCreateConversation } from './conversations.js';
import type { Message } from '@dojo/shared';
import { rowToMessage, type MessageRow } from './store.js';

/**
 * Persist one peer A2A inbound row into the physical inter-agent store.
 *
 * Mirrors the exact column set + values deliverA2AMessage used to write into
 * `messages` (role hardcoded 'user', created_at = datetime('now')). Uses
 * INSERT OR IGNORE and returns the raw `changes` so the caller can keep the FA-C4
 * PERSIST_SKIPPED drop check unchanged: the persisted row is the sole delivery
 * vehicle (runtime.handleMessage re-reads it), so a 0-change insert means the
 * message never landed and must NOT be reported as delivered.
 */
export function insertInterAgentMessage(params: {
  id: string;
  agentId: string;                    // recipient
  content: string;
  sourceAgentId: string | null;
  a2aThreadId: string | null;
  a2aIntent: string | null;
  a2aRequiresResponse: number;        // 0 | 1
  attachments: string | null;        // JSON array string, or null
  originKind: string | null;
  originIntent: string | null;
}): { changes: number } {
  const db = getDb();
  // P5: a peer A2A thread is a conversation like any other; identity keyed on
  // the full thread id. Engine-origin rows (no thread) stay conversation-less.
  const conversationId = params.a2aThreadId
    ? resolveOrCreateConversation(params.agentId, {
        channel: 'a2a', provider: null, counterpartyId: params.sourceAgentId, threadRoot: params.a2aThreadId,
      })
    : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO inter_agent_messages
      (id, agent_id, role, content, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, attachments, origin_kind, origin_intent, conversation_id, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    params.id,
    params.agentId,
    params.content,
    params.sourceAgentId,
    params.a2aThreadId,
    params.a2aIntent,
    params.a2aRequiresResponse,
    params.attachments,
    params.originKind,
    params.originIntent,
    conversationId,
  );
  return { changes: result.changes };
}

/**
 * Persist one ENGINE-ORIGIN notice/event row into the physical inter-agent store
 * (D-A step 4). This is the store home for what the engine-notice writers used to
 * INSERT into `messages`: agent notices (conv_key='engine-notice'), tracker
 * assignments (conv_key NULL), scheduler fires (conv_key NULL), healer-denied
 * notices (conv_key NULL), and the thrash-gate steer (conv_key='engine-steer').
 *
 * Unlike the peer-A2A insert above, an engine row carries a conv_key sentinel
 * and/or a turn_number and NO a2a_* fields, so this takes those columns and leaves
 * the a2a_* columns NULL. origin_kind is hardcoded 'engine' (the whole point: the
 * merged loaders/assembler classify it into the EVENTS lane exactly as the old
 * `messages` row did). The three lifecycle columns (swept_at/delivery_attempts/
 * next_attempt_at, migration 099) are left to their defaults (NULL/0/NULL = never
 * attempted, eligible now), matching a fresh engine row in `messages`.
 *
 * `orIgnore` defaults true (the store idiom + FA-C4 collision-degrades-to-drop
 * rationale). The tracker-assignment writer passes false to PRESERVE its FA-T6
 * reason: with a fresh uuid a constraint collision is impossible, so a plain INSERT
 * only changes behavior for a genuine DB fault, which it lets THROW so the caller's
 * catch reports ok:false honestly instead of a silent skip.
 */
export function insertInterAgentEngineRow(params: {
  id: string;
  agentId: string;                    // recipient
  content: string;
  sourceAgentId: string | null;      // creator/sender, or null for pure-subsystem notices
  originIntent: string | null;
  convKey: string | null;
  turnNumber?: number | null;
  orIgnore?: boolean;
  // P1 lineage spine (migration 112): the WORK this engine row is about, as
  // COLUMNS the serve boundary can read (until now the task/run reference
  // lived only as prose inside content). REQUIRED so every writer states its
  // referent deliberately: pass `work: null` for rows about no specific work
  // (steers, awareness notices, floors); pass real ids for scheduler fires,
  // assignment notices, and anything else a premise check must be able to
  // retire when the referent is spent.
  work: { taskId: string | null; runId: string | null; rootKind: string | null; rootId: string | null } | null;
}): { changes: number } {
  const db = getDb();
  const verb = params.orIgnore === false ? 'INSERT' : 'INSERT OR IGNORE';
  const result = db.prepare(`
    ${verb} INTO inter_agent_messages
      (id, agent_id, role, content, source_agent_id, origin_kind, origin_intent, conv_key, turn_number, task_id, run_id, root_kind, root_id, created_at)
    VALUES (?, ?, 'user', ?, ?, 'engine', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    params.id,
    params.agentId,
    params.content,
    params.sourceAgentId,
    params.originIntent,
    params.convKey,
    params.turnNumber ?? null,
    params.work?.taskId ?? null,
    params.work?.runId ?? null,
    params.work?.rootKind ?? null,
    params.work?.rootId ?? null,
  );
  return { changes: result.changes };
}

/**
 * Persist the agent's OWN inter-agent-turn output (role 'assistant' or 'tool')
 * into the physical inter-agent store (D-A step 8). On a turn the persistence
 * classifier marks inter-agent (the six-way interAgentTurn union in agent/v2/
 * loop.ts), the turn's assistant tool_use rows and its tool_result rows belong
 * in the store, NOT in the primary's `messages` chat table, so a coordination
 * burst can never bury (or leak into) the owner's conversation. This is the WRITE
 * twin of the messages own-output INSERTs; the row id is caller-supplied and
 * STABLE (other tables reference message ids) and the content is byte-identical.
 *
 * The row carries the AUTHOR as agent_id (it is the agent's OWN history, not an
 * inbound message), so source_agent_id / a2a_* / origin_kind stay NULL and the
 * DIRECTION ("own output") is derived from `role` (assistant/tool = own output,
 * user = inbound) rather than a new column. conv_key defaults NULL here and is
 * stamped at turn teardown (see tagInterAgentOwnOutputConvKey), exactly mirroring
 * how the messages own-output rows are tagged. The store deliberately omits the
 * display/accounting columns (token_count/model_id/cost/latency_ms/
 * reasoning_content/source); the merged tail loaders NULL-pad them just as they do
 * for peer-A2A rows, so the model view (role/content/order/attachments/
 * turn_number) comes back byte-identical to the legacy single-table tail
 * (reasoning_content round-trips as the established DeepSeek empty-string fallback,
 * which is correctness-neutral for a completed prior turn). INSERT OR IGNORE keeps
 * the store idiom (a colliding id degrades to a drop, never a duplicate).
 */
export function insertInterAgentOwnOutput(params: {
  id: string;
  agentId: string;                    // the author (its own history)
  role: 'assistant' | 'tool';
  content: string;
  attachments?: string | null;        // JSON array string, or null
  turnNumber: number | null;
}): { changes: number } {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO inter_agent_messages
      (id, agent_id, role, content, attachments, turn_number, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    params.id,
    params.agentId,
    params.role,
    params.content,
    params.attachments ?? null,
    params.turnNumber ?? null,
  );
  return { changes: result.changes };
}

/**
 * Teardown twin of the `messages` conv_key tagging (D-A step 8). The loop tags
 * this turn's own assistant/tool rows with the served conversation's conv_key so
 * one counterparty's work can't bleed into another's turn (content isolation).
 * Since a turn's own output can now live in EITHER table (a mixed human+
 * coordination turn splits its rows by per-phase classification), the tag must
 * reach both homes. This mirrors the messages UPDATE against the store, scoped to
 * this turn's own-output rows only. A no-op (0 rows) on a pure human turn (no
 * store rows for that turn_number). Returns the number of rows tagged.
 */
export function tagInterAgentOwnOutputConvKey(agentId: string, turnNumber: number, convKey: string): number {
  const db = getDb();
  const result = db.prepare(
    `UPDATE inter_agent_messages SET conv_key = ? WHERE agent_id = ? AND turn_number = ? AND role IN ('assistant','tool') AND conv_key IS NULL`,
  ).run(convKey, agentId, turnNumber);
  return result.changes;
}

/** Raw shape read out of `inter_agent_messages` (the table's own columns). */
export interface InterAgentRow {
  id: string;
  agent_id: string;
  role: string;
  content: string;
  source_agent_id: string | null;
  a2a_thread_id: string | null;
  a2a_intent: string | null;
  a2a_requires_response: number | null;
  attachments: string | null;
  origin_kind: string | null;
  origin_intent: string | null;
  conv_key: string | null;
  turn_number: number | null;
  created_at: string;
  rowid?: number;
}

/**
 * Map a raw inter-agent store row into the shared `Message` shape, reusing the
 * SAME rowToMessage projection used for `messages`. The store lacks the non-A2A
 * columns (token_count/model_id/cost/latency_ms/reasoning_content/source/
 * inbound_meta); they are filled as NULL here, which is exactly the value a peer
 * A2A row carries in `messages` today, so origin derivation and downstream
 * partitioning are identical.
 *
 * Provided for the store-only readers that arrive in later steps (the dashboard
 * inter-agent lane route, step 5; any store-scoped reply reads). The merged tail
 * loaders in memory/store.ts project these NULLs inline in SQL and call
 * rowToMessage directly, so they do not need this helper.
 */
export function interAgentRowToMessage(row: InterAgentRow): Message {
  const normalized: MessageRow = {
    id: row.id,
    agent_id: row.agent_id,
    role: row.role,
    content: row.content,
    token_count: null,
    model_id: null,
    cost: null,
    latency_ms: null,
    created_at: row.created_at,
    turn_number: row.turn_number,
    reasoning_content: null,
    source: null,
    source_agent_id: row.source_agent_id,
    a2a_thread_id: row.a2a_thread_id,
    a2a_intent: row.a2a_intent,
    a2a_requires_response: row.a2a_requires_response,
    inbound_meta: null,
    origin_kind: row.origin_kind,
    origin_intent: row.origin_intent,
    conv_key: row.conv_key,
    rowid: row.rowid,
  };
  return rowToMessage(normalized);
}
