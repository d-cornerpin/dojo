// The agent-to-agent notification bus: an agent sends another a typed notification, stored
// as a `messages` row scoped by `origin_intent='agent_bus'` to keep it apart from peer traffic.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { insertMessage, AGENT_BUS_INTENT } from '../memory/message-store.js';
import type { AgentMessage } from '@dojo/shared';

const logger = createLogger('agent-bus');

/** Columns the two reads project, in one place so they cannot drift apart. */
const BUS_COLS = `id, agent_id, source_agent_id, a2a_intent, content, inbound_meta,
  served_by_turn, datetime(created_at/1000,'unixepoch') AS created_at`;

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

  // Read back rather than assemble from arguments: the persisted created_at is what the dashboard shows.
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
