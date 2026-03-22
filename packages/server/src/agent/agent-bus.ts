import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import type { AgentMessage } from '@dojo/shared';

const logger = createLogger('agent-bus');

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

  db.prepare(`
    INSERT INTO agent_messages (id, from_agent, to_agent, message_type, content, metadata, read_by_recipient, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(id, fromId, toId, messageType, content, metadataJson);

  logger.info('Agent message sent', {
    messageId: id,
    from: fromId,
    to: toId,
    messageType,
    contentLength: content.length,
  }, fromId);

  // Build the event data
  const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as {
    id: string;
    from_agent: string;
    to_agent: string;
    message_type: string;
    content: string;
    metadata: string;
    read_by_recipient: number;
    created_at: string;
  };

  const agentMessage: AgentMessage = {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    messageType: row.message_type as AgentMessage['messageType'],
    content: row.content,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    readByRecipient: row.read_by_recipient === 1,
    createdAt: row.created_at,
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

  let sql: string;
  let params: unknown[];

  switch (direction) {
    case 'sent':
      sql = `SELECT * FROM agent_messages WHERE from_agent = ? ORDER BY created_at DESC LIMIT ?`;
      params = [agentId, limit];
      break;
    case 'received':
      sql = `SELECT * FROM agent_messages WHERE to_agent = ? ORDER BY created_at DESC LIMIT ?`;
      params = [agentId, limit];
      break;
    case 'both':
    default:
      sql = `SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC LIMIT ?`;
      params = [agentId, agentId, limit];
      break;
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
    message_type: string;
    content: string;
    metadata: string;
    read_by_recipient: number;
    created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    messageType: row.message_type as AgentMessage['messageType'],
    content: row.content,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    readByRecipient: row.read_by_recipient === 1,
    createdAt: row.created_at,
  }));
}

// ── Mark Read ──

export function markMessageRead(messageId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE agent_messages SET read_by_recipient = 1 WHERE id = ?
  `).run(messageId);

  logger.debug('Agent message marked as read', { messageId });
}

// ── Unread Count ──

export function getUnreadCount(agentId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM agent_messages
    WHERE to_agent = ? AND read_by_recipient = 0
  `).get(agentId) as { count: number };

  return row.count;
}
