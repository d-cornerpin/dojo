// ── PHASE-1 T4 (2026-07-27): the THIRD message store folds in. ─────────────────
//
// `agent_messages` was the platform's third place to keep a message — a notification
// bus between agents (a spawned sub-agent reporting its result to its parent, the PM
// posting status, the scheduler reporting a skipped run). Research 04 row 6's verdict
// is REPLACE, fold into the unified `messages`, and this is it. REKEY; requirement
// preserved: an agent can send another agent a typed notification and the recipient's
// dashboard can list it, in both directions.
//
// The mapping, column by column, and every one of them lands on a column that already
// meant this: to_agent -> agent_id (the recipient owns the row, same as every inbound
// A2A row) · from_agent -> source_agent_id · message_type -> a2a_intent · metadata ->
// inbound_meta · lane 'a2a' · role 'user'. `origin_intent = 'agent_bus'` is what keeps
// the bus distinguishable from ordinary peer traffic, which the old table got for free
// by being a different table.
//
// TWO CONSEQUENCES, both deliberate and neither invented here:
//
//  1. These rows now reach the recipient's assembled history. They did not before —
//     nothing read `agent_messages` except one dashboard route. This is the direction
//     Phase 1 exists for ("agent recall finally covering agent-to-agent history"), and
//     the content is a completion report or a status line addressed to that agent, so
//     it is what the agent should have been seeing. Bounded: three low-frequency
//     producers, 2 rows on the live box in the whole of Phase 0. The fail-closed
//     `chat_messages` view keeps them off the human surface.
//
//  2. `readByRecipient` becomes TRUE once a turn picks the row up. The old column was
//     written 0 and never updated by anything, so the API has always answered "false"
//     — a field carrying no information. `served_by_turn` is the unified store's own
//     answer to the same question and it is a real one.
//
// The old table is NOT dropped here and still holds its rows; T10 drops it with the
// rest of the scaffolding, and the Stable Bridge (T12) carries the lived-in rows.

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

