// Where a task came from, rendered for the agent on every tracker read: which conversation, which
// prompt, and when, from the task's own identity columns.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { taskScope, msToText } from '../work/tracker-view.js';
import { stripInboundChannelMarker } from '@dojo/shared';

const logger = createLogger('origin-chain');

export interface TaskOriginChain {
  /** Where the ask came from (channel + counterparty of the origin conversation). */
  from: string | null;
  /** Excerpt of the originating prompt. */
  promptExcerpt: string | null;
  originAt: string | null;
}

export function findTaskOriginChain(taskId: string): TaskOriginChain | null {
  try {
    const db = getDb();
    const task = db.prepare(
      `SELECT w.source_message_id AS source_message_id, w.origin_conv_key AS origin_conv_key,
              w.origin_kind AS origin_kind, ${msToText('w.opened_at')} AS created_at
         FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
    ).get(taskId) as { source_message_id: string | null; origin_conv_key: string | null; origin_kind: string | null; created_at: string } | undefined;
    if (!task) return null;
    if (!task.source_message_id && !task.origin_conv_key) return null;

    let from: string | null = null;
    let promptExcerpt: string | null = null;
    let originAt: string | null = null;
    if (task.source_message_id) {
      const msg = db.prepare(
        `SELECT m.content, datetime(m.created_at/1000,'unixepoch') AS created_at, c.channel, c.counterparty_name, c.counterparty_id
           FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = ?`,
      ).get(task.source_message_id) as { content: string | null; created_at: string; channel: string | null; counterparty_name: string | null; counterparty_id: string | null } | undefined;
      if (msg) {
        originAt = msg.created_at;
        if (msg.channel) {
          const who = msg.counterparty_name ?? msg.counterparty_id ?? 'unknown';
          from = who === 'owner' ? `the owner's ${msg.channel} conversation` : `${who} via ${msg.channel}`;
        }
        if (msg.content) {
          promptExcerpt = stripInboundChannelMarker(msg.content).slice(0, 160) || null;
        }
      }
    }
    if (!from && task.origin_conv_key) from = `conversation ${task.origin_conv_key}`;
    if (!from && task.origin_kind) from = `origin: ${task.origin_kind}`;
    return { from, promptExcerpt, originAt: originAt ?? task.created_at };
  } catch (err) {
    logger.warn('findTaskOriginChain failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** One-line origin rendering for the agent's tracker view. */
export function renderTaskOriginChain(o: TaskOriginChain): string {
  const parts: string[] = [];
  if (o.from) parts.push(`created from ${o.from}`);
  if (o.originAt) parts.push(`at ${o.originAt} UTC`);
  const head = parts.join(' ');
  return o.promptExcerpt ? `${head}, asking: "${o.promptExcerpt}"` : head;
}
