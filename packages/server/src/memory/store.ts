// Model-facing readers of `messages`: one tail query over every lane the agent owns, in insertion order.
// Order by `seq`, not `created_at` (`message-store.rehomeUndeliveredCreatedAt` moves a row's clock forward).
// Anything shown to a person reads the fail-closed `chat_messages` view instead.

import { getDb } from '../db/connection.js';
import { estimateTokensFromChars } from './budget.js';
import type { Message } from '@dojo/shared';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';
import { sessionBoundaryText } from './session-boundary.js';


// Time columns are epoch-ms INTEGER and SQLite orders INTEGER before TEXT, so a comparison in the old
// TEXT shape silently returns the wrong rows. WRITE with `NOW_MS`, never `datetime('now')`. READ into a
// string with `createdAtText` (the wire type and cached prompt stamp need TEXT). Convert the TEXT side.

/** Epoch-ms for "now", second-granular: the same expression as the `created_at` column DEFAULT. */
export const NOW_MS = "(CAST(strftime('%s','now') AS INTEGER) * 1000)";

/** Project an epoch-ms time column back to the canonical TEXT shape; `col`/`alias` are SQL identifiers
 *  the CALLER supplies from its own literal, never user input. */
export function createdAtText(col = 'created_at', alias = 'created_at'): string {
  return `datetime(${col}/1000,'unixepoch') AS ${alias}`;
}


/** Every loader projects exactly this list, so `rowToMessage` never asks whether a column was selected. */
const SELECT_COLS = `seq, id, agent_id, role, content, token_count, model_id, cost,
  latency_ms, ${createdAtText()}, turn_number, reasoning_content, reasoning_aged_out, lane, channel, source_agent_id,
  a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_intent, conversation_id`;

export interface MessageRow {
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
  reasoning_aged_out: number | null;
  lane: string;
  channel: string | null;
  source_agent_id: string | null;
  a2a_thread_id: string | null;
  a2a_intent: string | null;
  a2a_requires_response: number | null;
  inbound_meta: string | null;
  origin_intent: string | null;
  /** `conversations.id`; NULL means not stamped yet, never no conversation. */
  conversation_id: string | null;
}

export function rowToMessage(row: MessageRow): Message {
  // Origin is projected from the stamped `lane` and `channel`, never re-parsed.
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
    // The insertion key (`messages.seq`): the vault high-water and compaction's archive filter compare it.
    rowid: row.seq,
    turnNumber: row.turn_number,
    reasoningContent: row.reasoning_content,
    reasoningAgedOut: row.reasoning_aged_out === 1,
    source: legacy.source,
    sourceAgentId: row.source_agent_id,
    a2aThreadId: row.a2a_thread_id,
    a2aIntent: row.a2a_intent,
    a2aRequiresResponse: row.a2a_requires_response,
    inboundMeta: row.inbound_meta,
    conversationId: row.conversation_id,
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


/** The newest `count` rows for an agent, oldest-first, above the session boundary; `turnCutoff` drops user
 *  rows that arrived after the turn started. `@boundary` and `@cutoff` are TEXT and converted at the
 *  comparison: unwrapped, `<integer> >= '<datetime>'` is false for every row and the tail comes back empty. */
export function getRecentMessages(agentId: string, count: number, turnCutoff?: string): Message[] {
  const db = getDb();
  const sessionBoundary = sessionBoundaryText(agentId);
  const params: Record<string, unknown> = { agentId, count };
  const clauses = ['agent_id = @agentId'];
  if (sessionBoundary) { clauses.push('created_at >= (unixepoch(@boundary) * 1000)'); params.boundary = sessionBoundary; }
  if (turnCutoff) { clauses.push("NOT (role = 'user' AND created_at > (unixepoch(@cutoff) * 1000))"); params.cutoff = turnCutoff; }

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT ${SELECT_COLS} FROM messages
       WHERE ${clauses.join(' AND ')}
       ORDER BY seq DESC LIMIT @count
    ) ORDER BY seq ASC
  `).all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

/** A conversation row: inbound from agents or a person, or an own row of a conversation turn (partial index 218). */
const CONVERSATION_ROW = "((role = 'user' AND lane IN ('a2a', 'owner')) OR subject_kind IN ('conv', 'a2a_thread'))";

/** The view of an agent whose memory is its board (`memory/pm-view.ts`), oldest-first above the session boundary:
 *  its conversation, front moving in whole blocks (`block` to `2 * block - 1` rows), and the present turn. */
export function boardAgentRows(
  agentId: string, block: number, turnNumber: number | null, triggerId: string | null,
): { tail: Message[]; present: Message[] } {
  const db = getDb();
  const params = { agentId, turn: turnNumber, trigger: triggerId, boundary: sessionBoundaryText(agentId) };
  const where = `agent_id = @agentId AND ${CONVERSATION_ROW}
    AND (@boundary IS NULL OR created_at >= (unixepoch(@boundary) * 1000))
    AND (@turn IS NULL OR turn_number IS NOT @turn)`;
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(params) as { n: number }).n;
  const skip = Math.max(0, Math.floor((n - block) / block) * block);
  const tail = db.prepare(`
    SELECT ${SELECT_COLS} FROM messages
     WHERE ${where}
     ORDER BY seq LIMIT -1 OFFSET @skip
  `).all({ ...params, skip }) as MessageRow[];
  const present = db.prepare(`
    SELECT ${SELECT_COLS} FROM messages WHERE agent_id = @agentId AND turn_number = @turn
    UNION
    SELECT ${SELECT_COLS} FROM messages WHERE id = @trigger AND agent_id = @agentId
     ORDER BY seq
  `).all(params) as MessageRow[];
  const shown = new Set(tail.map((r) => r.id));
  return { tail: tail.map(rowToMessage), present: present.filter((r) => !shown.has(r.id)).map(rowToMessage) };
}

export interface SeqRange { fromSeq?: number; throughSeq?: number }

/** This session's rows in no summary of the agent's, oldest first, older than its newest `floorRows` rows (the window
 *  `getRecentMessages` reads, so the tail-to-summary handoff drops and duplicates nothing) and within `range`. The
 *  session's first seq bounds the walk, so the (agent_id, seq) index never reaches rows before it. */
function unsummarised(agentId: string, floorRows: number, range: SeqRange, cols: string): unknown[] {
  const session = 'agent_id = @agentId AND (@boundary IS NULL OR created_at >= (unixepoch(@boundary) * 1000))';
  return getDb().prepare(`
    SELECT ${cols} FROM messages m
     WHERE ${session}
       AND seq < (SELECT MIN(seq) FROM (SELECT seq FROM messages WHERE ${session} ORDER BY seq DESC LIMIT @floorRows))
       AND seq >= MAX(COALESCE(@from, 0), COALESCE((SELECT MIN(seq) FROM messages
             WHERE agent_id = @agentId AND created_at >= (unixepoch(@boundary) * 1000)), 0))
       AND seq <= COALESCE(@through, 9223372036854775807)
       AND NOT EXISTS (SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id
                        WHERE sm.message_id = m.id AND s.agent_id = @agentId)
     ORDER BY seq ASC
  `).all({ agentId, floorRows, boundary: sessionBoundaryText(agentId), from: range.fromSeq ?? null, through: range.throughSeq ?? null });
}

export function getUnsummarisedRows(agentId: string, floorRows: number, range: SeqRange = {}): Message[] {
  return (unsummarised(agentId, floorRows, range, SELECT_COLS) as MessageRow[]).map(rowToMessage);
}

/** The same rows by count and token cost only: a row's text is read only when it has no stored count. */
export function unsummarisedCost(agentId: string, floorRows: number, range: SeqRange): { rows: number; tokens: number } {
  const rows = unsummarised(agentId, floorRows, range, 'token_count, CASE WHEN token_count IS NULL THEN length(content) END AS chars') as
    Array<{ token_count: number | null; chars: number | null }>;
  return { rows: rows.length, tokens: rows.reduce((t, r) => t + (r.token_count ?? estimateTokensFromChars(r.chars ?? 0)), 0) };
}

// The fresh-tail row floor is `getFreshTailCount` (`memory/budget.ts`); `tail-horizon.ts` `rowsLeavingView`
// says which rows above it are owed a summary.

/** Ids to rows in seq order, as the model saw them (how `dag.getSummarySourceMessages` rebuilds a chunk). */
export function getMessagesByIds(ids: string[]): Message[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT ${SELECT_COLS} FROM messages WHERE id IN (${placeholders}) ORDER BY seq ASC`,
  ).all(...ids) as MessageRow[];
  return rows.map(rowToMessage);
}


