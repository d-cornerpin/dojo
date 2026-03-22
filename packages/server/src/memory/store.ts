import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-store');

// ── Token Estimation ──

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Row-to-Message Mapping ──

interface MessageRow {
  id: string;
  agent_id: string;
  role: string;
  content: string;
  token_count: number | null;
  model_id: string | null;
  cost: number | null;
  latency_ms: number | null;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
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
  };
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
  const db = getDb();

  // Get all messages except the last N, ordered by created_at ASC
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE agent_id = ?
      AND id NOT IN (
        SELECT id FROM messages
        WHERE agent_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      )
    ORDER BY created_at ASC, rowid ASC
  `).all(agentId, agentId, freshTailCount) as MessageRow[];

  return rows.map(rowToMessage);
}

export function getMessagesByIds(ids: string[]): Message[] {
  if (ids.length === 0) return [];

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
  ).all(...ids) as MessageRow[];

  return rows.map(rowToMessage);
}

export function getRecentMessages(agentId: string, count: number): Message[] {
  const db = getDb();

  // Get the last N messages, then return in ASC order
  // Use rowid as tiebreaker to preserve insertion order when timestamps match
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT *, rowid as _rowid FROM messages
      WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    ) sub
    ORDER BY created_at ASC, _rowid ASC
  `).all(agentId, count) as MessageRow[];

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

  // Sum known token counts
  const knownRow = db.prepare(
    'SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE agent_id = ? AND token_count IS NOT NULL',
  ).get(agentId) as { total: number };

  // Estimate tokens for messages with null token_count
  const nullRows = db.prepare(
    'SELECT content FROM messages WHERE agent_id = ? AND token_count IS NULL',
  ).all(agentId) as Array<{ content: string }>;

  const estimatedTotal = nullRows.reduce(
    (sum, row) => sum + estimateTokens(row.content),
    0,
  );

  return knownRow.total + estimatedTotal;
}
