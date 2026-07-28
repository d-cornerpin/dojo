import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getMessagesByIds } from './store.js';
import { queueEmbedding } from './embeddings.js';
import { dominantMessageLineage } from './conversations.js';
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

  // P5c: the summary CARRIES the dominant lineage of its chunk (mig 115), so
  // identity survives compression instead of dropping at the boundary.
  const lineage = dominantMessageLineage(messageIds);

  const insertSummary = db.prepare(`
    INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, conversation_id, conv_key, a2a_thread_id, created_at)
    VALUES (?, ?, 0, 'leaf', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // PHASE-1 T7. `summary_messages.message_id` carries a real foreign key to `messages(id)`
  // again (migration 130) now that one table holds every lane — the constraint migration 103
  // had to remove when agent-to-agent rows lived in a second table with their own ids.
  //
  // This SELECT form is what stops the constraint re-opening 103's incident. On 2026-07-06 a
  // chunk naming an id the constraint rejected took the WHOLE leaf summary down with it: the
  // context never shrank and reactive compaction re-fired on every turn. The summarizer's
  // model call still sits BETWEEN reading a chunk and writing it, so a reset_session or the
  // PM prune can delete a named row inside that window. Selecting the id out of `messages`
  // makes an unresolvable id a link not written, rather than a compaction that cannot
  // complete — and OR IGNORE absorbs a chunk that names the same message twice.
  //
  // Nothing is lost by the guard that was not already lost: a link whose message does not
  // exist resolves to nothing in getSummarySourceMessages and counts for nothing in
  // getCompactedMessageIds. The summary's own `descendant_count` is the chunk size and is
  // written above, unaffected.
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO summary_messages (summary_id, message_id)
      SELECT ?, m.id FROM messages m WHERE m.id = ?
  `);

  const txn = db.transaction(() => {
    insertSummary.run(id, agentId, content, tokenCount, earliestAt, latestAt, messageIds.length, lineage.conversationId, lineage.convKey, lineage.a2aThreadId);

    for (const messageId of messageIds) {
      insertLink.run(id, messageId);
    }
  });

  txn();

  // Embed at creation so compressed history is reachable by meaning, not
  // only by recency. (Pre-remediation, summaries were only ever embedded by
  // the manual backfill, so vector search could not see them.)
  queueEmbedding('summary', id, agentId, content);

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

  // P5c: condensed summaries inherit the modal lineage of their parents, same
  // deterministic tie-break as dominantMessageLineage.
  const parentLineage = db.prepare(
    `SELECT conversation_id, conv_key, a2a_thread_id FROM summaries WHERE id IN (${parentPlaceholders})`,
  ).all(...parentIds) as Array<{ conversation_id: string | null; conv_key: string | null; a2a_thread_id: string | null }>;
  const modal = (vals: Array<string | null>): string | null => {
    const tally = new Map<string, number>();
    for (const v of vals) if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
    let best: string | null = null; let bestCount = 0;
    for (const [v, c] of [...tally.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (c > bestCount) { best = v; bestCount = c; }
    }
    return best;
  };
  const lineage = {
    conversationId: modal(parentLineage.map(r => r.conversation_id)),
    convKey: modal(parentLineage.map(r => r.conv_key)),
    a2aThreadId: modal(parentLineage.map(r => r.a2a_thread_id)),
  };

  const insertSummary = db.prepare(`
    INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, conversation_id, conv_key, a2a_thread_id, created_at)
    VALUES (?, ?, ?, 'condensed', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertLink = db.prepare(`
    INSERT INTO summary_parents (summary_id, parent_id) VALUES (?, ?)
  `);

  const txn = db.transaction(() => {
    insertSummary.run(id, agentId, depth, content, tokenCount, earliestAt, latestAt, descendantRow.total, lineage.conversationId, lineage.convKey, lineage.a2aThreadId);

    for (const parentId of parentIds) {
      insertLink.run(id, parentId);
    }
  });

  txn();

  // Same embed-at-creation rule as leaf summaries.
  queueEmbedding('summary', id, agentId, content);

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

  let sql = `SELECT * FROM summaries WHERE ${conditions.join(' AND ')} ORDER BY earliest_at ASC, id ASC`;

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
    ORDER BY s.earliest_at ASC, s.id ASC
  `).all(agentId, depth) as SummaryRow[];

  return rows.map(rowToSummary);
}

export function getSummaryChildren(summaryId: string): Summary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.* FROM summaries s
    INNER JOIN summary_parents sp ON s.id = sp.parent_id
    WHERE sp.summary_id = ?
    ORDER BY s.earliest_at ASC, s.id ASC
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

  // T5: sort by the INSERTION key, not the clock. `created_at` is second-granular TEXT, so
  // a burst of messages inside one second sorted arbitrarily here and the expanded history
  // came back scrambled — and the engine's undelivered-event re-home deliberately pushes a
  // row's clock forward, which put it in the wrong place outright. `rowid` on a Message is
  // `messages.seq`, one keyspace, no ties. Clock order is the fallback for the (defensive)
  // case of a row that reached here without its key.
  allMessages.sort((a, b) => (
    a.rowid != null && b.rowid != null
      ? a.rowid - b.rowid
      : a.createdAt.localeCompare(b.createdAt)
  ));
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
    ORDER BY s.earliest_at ASC, s.id ASC
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
