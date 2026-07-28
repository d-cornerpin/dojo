// ── PHASE-1 T4 (2026-07-27): the THIRD message store folds in. ─────────────────
//
// `agent_messages` was the platform's third place to keep a message — a notification bus
// (a sub-agent's result to its parent, PM status, scheduler notices). Research 04 row 6:
// REPLACE, fold into the unified `messages`. REKEY; requirement preserved: an agent can
// send another agent a typed notification and the recipient's dashboard can list it, both
// directions. Mapping, each onto a column that already meant this: to_agent -> agent_id
// (the recipient owns the row, as for every inbound A2A row) · from_agent ->
// source_agent_id · message_type -> a2a_intent · metadata -> inbound_meta · lane 'a2a' ·
// role 'user'. `origin_intent='agent_bus'` keeps the bus distinguishable from ordinary
// peer traffic — the job the separate table used to do for free.
//
// Two consequences, deliberate: (1) these rows now reach the recipient's assembled
// history, which they did not (one dashboard route was the only reader) — the direction
// this phase exists for, bounded to three low-frequency producers, and the fail-closed
// view keeps them off the human surface; (2) `readByRecipient` becomes true once a turn
// picks the row up, where the old column was written 0 and updated by nothing.
//
// The old table is NOT dropped here (T10's) and still holds its rows; the Stable Bridge
// addendum carries the mapping for lived-in boxes.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { insertMessage, AGENT_BUS_INTENT } from '../memory/message-store.js';
import type { AgentMessage } from '@dojo/shared';

const logger = createLogger('agent-bus');

/** Columns the two reads project, in one place so they cannot drift apart. */
const BUS_COLS = `id, agent_id, source_agent_id, a2a_intent, content, inbound_meta,
  served_by_turn, created_at`;

interface BusRow {
  id: string; agent_id: string; source_agent_id: string | null; a2a_intent: string | null;
  content: string; inbound_meta: string | null; served_by_turn: number | null; created_at: string;
}

function toAgentMessage(row: BusRow): AgentMessage {
  return {
    id: row.id,
    fromAgent: row.source_agent_id ?? '',
    toAgent: row.agent_id,
    messageType: (row.a2a_intent ?? 'status') as AgentMessage['messageType'],
    content: row.content,
    metadata: JSON.parse(row.inbound_meta ?? '{}') as Record<string, unknown>,
    readByRecipient: row.served_by_turn != null,
    createdAt: row.created_at,
  };
}

// ── Send Message ──

export function sendAgentMessage(
  fromId: string,
  toId: string,
  messageType: string,
  content: string,
  metadata?: Record<string, unknown>,
): string {
  const db = getDb();
  const id = uuidv4();
  const metadataJson = JSON.stringify(metadata ?? {});

  const persisted = insertMessage({
    id,
    agentId: toId,
    role: 'user',
    lane: 'a2a',
    content,
    sourceAgentId: fromId,
    a2aIntent: messageType,
    originIntent: AGENT_BUS_INTENT,
    inboundMeta: metadataJson,
  });

  logger.info('Agent message sent', {
    messageId: id,
    from: fromId,
    to: toId,
    messageType,
    contentLength: content.length,
  }, fromId);

  // Build the event data. Read back rather than assembled from the arguments, exactly
  // as before: the row's persisted created_at is what the dashboard must show.
  const row = db.prepare(`SELECT ${BUS_COLS} FROM messages WHERE id = ?`).get(id) as BusRow;
  const agentMessage: AgentMessage = row
    ? toAgentMessage(row)
    : {
      id, fromAgent: fromId, toAgent: toId,
      messageType: messageType as AgentMessage['messageType'],
      content, metadata: JSON.parse(metadataJson) as Record<string, unknown>,
      readByRecipient: false, createdAt: persisted.createdAt,
    };

  broadcast({
    type: 'agent:message',
    data: agentMessage,
  });

  return id;
}

// ── Get Messages ──

export function getAgentMessages(
  agentId: string,
  options?: { direction?: 'sent' | 'received' | 'both'; limit?: number },
): AgentMessage[] {
  const db = getDb();
  const direction = options?.direction ?? 'both';
  const limit = options?.limit ?? 50;

  // `origin_intent` scopes every arm to the BUS. Without it these reads would start
  // returning ordinary peer A2A conversation, which the old table could not contain.
  const scope = `origin_intent = '${AGENT_BUS_INTENT}'`;
  let where: string;
  let params: unknown[];

  switch (direction) {
    case 'sent':
      where = `${scope} AND source_agent_id = ?`;
      params = [agentId, limit];
      break;
    case 'received':
      where = `${scope} AND agent_id = ?`;
      params = [agentId, limit];
      break;
    case 'both':
    default:
      where = `${scope} AND (source_agent_id = ? OR agent_id = ?)`;
      params = [agentId, agentId, limit];
      break;
  }

  const rows = db.prepare(
    `SELECT ${BUS_COLS} FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params) as BusRow[];

  return rows.map(toAgentMessage);
}

