// Pre-compaction raw conversation archival: a fast, dumb copy with no LLM calls and no processing.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { rowToMessage, type MessageRow } from '../memory/store.js'; import { estimateTokens } from '../memory/budget.js';
import { archiveConversation } from './store.js';
import { isSystemServiceAgent, getSystemServiceAgentIds, getPrimaryAgentId } from '../config/platform.js';
import { summaryPartyTag } from '../memory/party-label.js';
import { clearCompactionBackoff } from '../memory/compaction-brakes.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('vault-archive');

// Service-agent histories are platform mechanics; feeding them back through the Dreamer would be a recursive
// token-burn loop. True means drop the archive silently, as for a dreamer-ignored agent.
function shouldSkipServiceAgent(agentId: string): boolean {
  if (isSystemServiceAgent(agentId)) {
    logger.debug('Skipping archive: service agent (Dreamer/Trainer/Healer/PM/Imaginer)', { agentId });
    return true;
  }
  return false;
}

// Idempotent startup cleanup of unprocessed service-agent archives; `shouldSkipServiceAgent` stops new ones.
// Returns the number deleted.
export function purgeServiceAgentArchives(): number {
  try {
    const db = getDb();
    const ids = getSystemServiceAgentIds();
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const res = db.prepare(
      `DELETE FROM vault_conversations WHERE is_processed = 0 AND agent_id IN (${placeholders})`,
    ).run(...ids);
    if (res.changes > 0) {
      logger.info('Purged unprocessed service-agent archives from backlog', {
        deleted: res.changes,
        agentIds: ids,
      });
    }
    return res.changes;
  } catch (err) {
    logger.warn('purgeServiceAgentArchives failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// True when the agent or its group has dreamer_ignore=1, so its conversations are never archived. Exported so
// compaction.ts can tell an ignored agent (null from the archive, still compacts) from a failed archive.
export function isDreamerIgnored(agentId: string): boolean {
  try {
    // The main agent always dreams: neither its own flag nor its group's is read.
    if (agentId === getPrimaryAgentId()) return false;
    const db = getDb();
    const row = db.prepare(`
      SELECT a.dreamer_ignore AS agent_ignore, g.dreamer_ignore AS group_ignore
      FROM agents a
      LEFT JOIN agent_groups g ON g.id = a.group_id
      WHERE a.id = ?
    `).get(agentId) as { agent_ignore: number | null; group_ignore: number | null } | undefined;
    if (!row) return false;
    return row.agent_ignore === 1 || row.group_ignore === 1;
  } catch {
    return false; // Best effort, never block archiving on a lookup error
  }
}

// The archival high-water mark: the highest message rowid already copied into vault_conversations, or null
// when the agent was never archived. Archival copies only newer messages, so a reset or later compaction
// never re-copies history. It is a rowid, not a timestamp: created_at is second-granular, so equal-second
// rows tied and one was skipped yet still compacted. Any lookup error returns null so archiving proceeds.
export function getArchiveHighWaterMark(agentId: string): number | null {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT MAX(latest_rowid) AS hw FROM vault_conversations WHERE agent_id = ?',
    ).get(agentId) as { hw: number | null } | undefined;
    return row?.hw ?? null;
  } catch {
    return null;
  }
}

// Archives an agent's messages newer than its high-water mark. `force` bypasses the duplicate-archive guard:
// each reset_session is a distinct conversation boundary.
export function archiveAgentConversation(agentId: string, force = false): string | null {
  const db = getDb();

  // A reset deserves a fresh start: every archive/new-session/reset door funnels through here, so clear the
  // compaction backoff ahead of the skips below (an ignored agent gets its room back too).
  clearCompactionBackoff(agentId);

  if (isDreamerIgnored(agentId)) {
    logger.debug('Agent on Dreamer ignore list, skipping archive', {}, agentId);
    return null;
  }

  if (shouldSkipServiceAgent(agentId)) return null;

  if (!force) {
    const existing = db.prepare(
      'SELECT id FROM vault_conversations WHERE agent_id = ? AND is_processed = 0'
    ).get(agentId) as { id: string } | undefined;
    if (existing) {
      logger.debug('Agent already has unprocessed archive, skipping', { agentId }, agentId);
      return existing.id;
    }
  }

  // Archive only messages newer than the vault high-water mark, keyed by `seq` (unique, tie-free). One pass
  // covers every lane the agent owns, agent-to-agent rows (lane='a2a') included, so each is archived
  // exactly once as one per-agent blob.
  const highWater = getArchiveHighWaterMark(agentId);
  const rows = (highWater != null
    ? db.prepare(`SELECT *, datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE agent_id = ? AND seq > ? ORDER BY seq ASC`)
        .all(agentId, highWater)
    : db.prepare(`SELECT *, datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE agent_id = ? ORDER BY seq ASC`)
        .all(agentId)) as Array<Record<string, unknown>>;

  if (rows.length === 0) return null;

  // Mapped through the one row mapper so `rowid` is `seq` and `origin` comes from the stamped lane:
  // `summaryPartyTag` below reads `m.origin` to tell the Dreamer whose request a line was.
  const messages: Message[] = rows.map(r => {
    const m = rowToMessage(r as unknown as MessageRow);
    // rowToMessage does not project attachments; carry them so a row that shipped a file is archived whole.
    if (r.attachments) {
      try {
        m.attachments = JSON.parse(r.attachments as string) as Message['attachments'];
      } catch {
        /* leave attachments undefined on malformed JSON, never block the archive */
      }
    }
    return m;
  });

  return archiveMessagesBeforeCompaction(agentId, messages);
}

export function archiveMessagesBeforeCompaction(
  agentId: string,
  messages: Message[],
): string | null {
  if (messages.length === 0) {
    logger.debug('No messages to archive', {}, agentId);
    return null;
  }

  // An ignored agent's compaction continues, but its raw messages are not copied.
  if (isDreamerIgnored(agentId)) {
    logger.debug('Agent on Dreamer ignore list, skipping pre-compaction archive', {}, agentId);
    return null;
  }

  if (shouldSkipServiceAgent(agentId)) return null;

  try {
    const db = getDb();
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;

    const serialized = messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      // WHO each message is from, so the Dreamer keeps whose-request-is-whose (the raw origin columns are not
      // carried into the archive blob).
      party: summaryPartyTag(m),
      tokenCount: m.tokenCount,
      modelId: m.modelId,
      cost: m.cost,
      latencyMs: m.latencyMs,
      createdAt: m.createdAt,
      attachments: m.attachments ?? null,
    }));

    const totalTokens = messages.reduce(
      (sum, m) => sum + (m.tokenCount ?? estimateTokens(m.content)),
      0,
    );

    const earliestAt = messages[0].createdAt;
    const latestAt = messages[messages.length - 1].createdAt;
    // The highest archived rowid is the high-water; take the max over the batch (not positional) because
    // created_at and rowid can be out of lockstep.
    const rowids = messages.map(m => m.rowid).filter((r): r is number => typeof r === 'number');
    const latestRowid = rowids.length ? Math.max(...rowids) : null;

    const archiveId = archiveConversation({
      agentId,
      agentName: agent?.name,
      messages: serialized,
      messageCount: messages.length,
      tokenCount: totalTokens,
      earliestAt,
      latestAt,
      latestRowid,
    });

    logger.info('Pre-compaction archive complete', {
      archiveId,
      messageCount: messages.length,
      tokenCount: totalTokens,
      timeRange: `${earliestAt} to ${latestAt}`,
    }, agentId);

    return archiveId;
  } catch (err) {
    logger.error('Failed to archive messages before compaction', {
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    }, agentId);
    return null;
  }
}

