import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getMessagesByIds } from './store.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-dag');

// ── Summary Type ──

export interface Summary {
  id: string;
  agentId: string;
  depth: number;
  kind: string;
  content: string;
  tokenCount: number;
  earliestAt: string;
  latestAt: string;
  descendantCount: number;
  createdAt: string;
}

interface SummaryRow {
  id: string;
  agent_id: string;
  depth: number;
  kind: string;
  content: string;
  token_count: number;
  earliest_at: string;
  latest_at: string;
  descendant_count: number;
  created_at: string;
}

function rowToSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    agentId: row.agent_id,
    depth: row.depth,
    kind: row.kind,
    content: row.content,
    tokenCount: row.token_count,
    earliestAt: row.earliest_at,
    latestAt: row.latest_at,
    descendantCount: row.descendant_count,
    createdAt: row.created_at,
  };
}

// ── Create Functions ──

export function createLeafSummary(
  agentId: string,
  content: string,
  tokenCount: number,
  messageIds: string[],
  earliestAt: string,
  latestAt: string,
): Summary {
  const db = getDb();
  const id = `sum_${uuidv4()}`;

  const insertSummary = db.prepare(`
    INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, created_at)
    VALUES (?, ?, 0, 'leaf', ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertLink = db.prepare(`
    INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)
  `);

  const txn = db.transaction(() => {
    insertSummary.run(id, agentId, content, tokenCount, earliestAt, latestAt, messageIds.length);

    for (const messageId of messageIds) {
      insertLink.run(id, messageId);
    }
  });

  txn();

  logger.info('Created leaf summary', {
    summaryId: id,
    messageCount: messageIds.length,
    tokenCount,
  }, agentId);

  return {
    id,
    agentId,
    depth: 0,
    kind: 'leaf',
    content,
    tokenCount,
    earliestAt,
    latestAt,
    descendantCount: messageIds.length,
    createdAt: new Date().toISOString(),
  };
}

export function createCondensedSummary(
  agentId: string,
  content: string,
  tokenCount: number,
  parentIds: string[],
  depth: number,
  earliestAt: string,
  latestAt: string,
): Summary {
  const db = getDb();
  const id = `sum_${uuidv4()}`;

  // Count total descendants from parent summaries
  const parentPlaceholders = parentIds.map(() => '?').join(',');
  const descendantRow = db.prepare(
    `SELECT COALESCE(SUM(descendant_count), 0) as total FROM summaries WHERE id IN (${parentPlaceholders})`,
  ).get(...parentIds) as { total: number };

  const insertSummary = db.prepare(`
    INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, created_at)
    VALUES (?, ?, ?, 'condensed', ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertLink = db.prepare(`
    INSERT INTO summary_parents (summary_id, parent_id) VALUES (?, ?)
  `);

  const txn = db.transaction(() => {
    insertSummary.run(id, agentId, depth, content, tokenCount, earliestAt, latestAt, descendantRow.total);

    for (const parentId of parentIds) {
      insertLink.run(id, parentId);
    }
  });

  txn();

  logger.info('Created condensed summary', {
    summaryId: id,
    depth,
    parentCount: parentIds.length,
    tokenCount,
  }, agentId);

  return {
    id,
    agentId,
    depth,
    kind: 'condensed',
    content,
    tokenCount,
    earliestAt,
    latestAt,
    descendantCount: descendantRow.total,
    createdAt: new Date().toISOString(),
  };
}

// ── Read Functions ──

export function getSummary(id: string): Summary | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow | undefined;
  return row ? rowToSummary(row) : null;
}

export function getSummariesByAgent(
  agentId: string,
  options?: { depth?: number; limit?: number },
): Summary[] {
  const db = getDb();
  const conditions = ['agent_id = ?'];
  const params: unknown[] = [agentId];

  if (options?.depth !== undefined) {
    conditions.push('depth = ?');
    params.push(options.depth);
  }

  let sql = `SELECT * FROM summaries WHERE ${conditions.join(' AND ')} ORDER BY earliest_at ASC`;

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as SummaryRow[];
  return rows.map(rowToSummary);
}

export function getLeafSummariesNotCondensed(agentId: string, depth: number): Summary[] {
  const db = getDb();

  // Get summaries at the given depth that are NOT yet children (parents) of a higher-depth summary
  const rows = db.prepare(`
    SELECT s.* FROM summaries s
    WHERE s.agent_id = ?
      AND s.depth = ?
      AND s.id NOT IN (
        SELECT parent_id FROM summary_parents
      )
    ORDER BY s.earliest_at ASC
  `).all(agentId, depth) as SummaryRow[];

  return rows.map(rowToSummary);
}

export function getSummaryChildren(summaryId: string): Summary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.* FROM summaries s
    INNER JOIN summary_parents sp ON s.id = sp.parent_id
    WHERE sp.summary_id = ?
    ORDER BY s.earliest_at ASC
  `).all(summaryId) as SummaryRow[];

  return rows.map(rowToSummary);
}

export function getSummarySourceMessages(summaryId: string): Message[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT message_id FROM summary_messages WHERE summary_id = ?
  `).all(summaryId) as Array<{ message_id: string }>;

  const ids = rows.map(r => r.message_id);
  return getMessagesByIds(ids);
}

export function getDescendantMessages(summaryId: string): Message[] {
  const summary = getSummary(summaryId);
  if (!summary) return [];

  if (summary.kind === 'leaf') {
    return getSummarySourceMessages(summaryId);
  }

  // For condensed: walk DAG down to leaf summaries, then collect their messages
  const children = getSummaryChildren(summaryId);
  const allMessages: Message[] = [];
  const seenIds = new Set<string>();

  for (const child of children) {
    const descendantMsgs = getDescendantMessages(child.id);
    for (const msg of descendantMsgs) {
      if (!seenIds.has(msg.id)) {
        seenIds.add(msg.id);
        allMessages.push(msg);
      }
    }
  }

  // Sort by created_at ASC
  allMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return allMessages;
}

// ── Update Functions ──

export function updateSummaryContent(id: string, content: string, tokenCount: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE summaries SET content = ?, token_count = ? WHERE id = ?
  `).run(content, tokenCount, id);

  logger.info('Updated summary content', { summaryId: id, tokenCount });
}

export function deleteSummary(id: string): void {
  const db = getDb();

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM summary_messages WHERE summary_id = ?').run(id);
    db.prepare('DELETE FROM summary_parents WHERE summary_id = ? OR parent_id = ?').run(id, id);
    db.prepare('DELETE FROM context_items WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
  });

  txn();

  logger.info('Deleted summary', { summaryId: id });
}

// ── Context Items ──

export function getContextSummaries(agentId: string): Summary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.* FROM summaries s
    INNER JOIN context_items ci ON s.id = ci.item_id
    WHERE ci.agent_id = ? AND ci.item_type = 'summary'
    ORDER BY s.earliest_at ASC
  `).all(agentId) as SummaryRow[];

  return rows.map(rowToSummary);
}

export function replaceContextItems(
  agentId: string,
  items: Array<{ itemType: 'message' | 'summary'; itemId: string }>,
): void {
  const db = getDb();

  const deletePrev = db.prepare('DELETE FROM context_items WHERE agent_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO context_items (agent_id, item_type, item_id, ordinal)
    VALUES (?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    deletePrev.run(agentId);
    for (let i = 0; i < items.length; i++) {
      insertItem.run(agentId, items[i].itemType, items[i].itemId, i);
    }
  });

  txn();

  logger.debug('Replaced context items', {
    agentId,
    itemCount: items.length,
  }, agentId);
}

export function getCompactedMessageIds(agentId: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT sm.message_id FROM summary_messages sm
    INNER JOIN summaries s ON sm.summary_id = s.id
    WHERE s.agent_id = ?
  `).all(agentId) as Array<{ message_id: string }>;

  return new Set(rows.map(r => r.message_id));
}
