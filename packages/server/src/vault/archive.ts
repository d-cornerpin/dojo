// ════════════════════════════════════════
// Vault Archive: Pre-compaction raw conversation archival
// Fast, dumb copy -- no LLM calls, no processing
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/store.js';
import { archiveConversation } from './store.js';
import { isSystemServiceAgent, getSystemServiceAgentIds } from '../config/platform.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('vault-archive');

/**
 * Service agents (Dreamer, Trainer, Healer, PM, Imaginer) have conversation
 * histories that are pure platform mechanics: system prompts, cycle
 * messages, recovery pokes, image-gen requests. None of it is memory-
 * worthy, and feeding it back through the Dreamer is a recursive
 * token-burn loop. Always skip.
 *
 * Returns true if the archive should be silently dropped. Caller must
 * treat the return-null path the same way it does for dreamer-ignored
 * agents.
 */
function shouldSkipServiceAgent(agentId: string): boolean {
  if (isSystemServiceAgent(agentId)) {
    logger.debug('Skipping archive: service agent (Dreamer/Trainer/Healer/PM/Imaginer)', { agentId });
    return true;
  }
  return false;
}

/**
 * Idempotent cleanup that nukes any unprocessed archives belonging to a
 * service agent. Pre-2026-04-30 the Dreamer/PM/Healer/etc. were getting
 * archived alongside everything else. The user repeatedly discarded the
 * backlog only to see fresh archives reappear because each service-agent
 * compaction recreated one. This function purges the residue from the
 * existing DB on server startup; the source-side `shouldSkipServiceAgent`
 * checks above prevent any new ones from being created.
 *
 * Returns the number of archives deleted. Safe to call repeatedly.
 */
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

/**
 * Check whether the Dreamer should ignore this agent. Returns true if the
 * agent itself or its group has dreamer_ignore=1. When true, callers
 * should skip archiving entirely — conversations stay in the live messages
 * table for the agent's lifetime but never enter vault_conversations,
 * so the Dreamer never sees them.
 *
 * Exported so compaction.ts can pre-check and skip the post-archive abort
 * path: archiveMessagesBeforeCompaction returns null both when archive
 * fails AND when the agent is intentionally ignored. Compaction needs to
 * differentiate so it doesn't refuse-to-compact an ignored agent.
 */
export function isDreamerIgnored(agentId: string): boolean {
  try {
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
    return false; // Best effort — never block archiving on a lookup error
  }
}

/**
 * Archive ALL messages for a terminated/completed agent.
 * Called on agent termination to ensure conversations are preserved for the Dreamer.
 */
export function archiveAgentConversation(agentId: string): string | null {
  const db = getDb();

  // Skip entirely if this agent (or its group) is on the Dreamer ignore list.
  // The user explicitly opted out of having this agent's conversations
  // remembered. Their chatter just goes away.
  if (isDreamerIgnored(agentId)) {
    logger.debug('Agent on Dreamer ignore list — skipping archive', {}, agentId);
    return null;
  }

  // Skip service agents (Dreamer, Trainer, Healer, PM, Imaginer). Their
  // histories are pure platform plumbing — see the comment on
  // shouldSkipServiceAgent for the recursion-loop rationale.
  if (shouldSkipServiceAgent(agentId)) return null;

  // Check if this agent already has an unprocessed archive — avoid duplicates
  const existing = db.prepare(
    'SELECT id FROM vault_conversations WHERE agent_id = ? AND is_processed = 0'
  ).get(agentId) as { id: string } | undefined;
  if (existing) {
    logger.debug('Agent already has unprocessed archive, skipping', { agentId }, agentId);
    return existing.id;
  }

  const rows = db.prepare(
    'SELECT * FROM messages WHERE agent_id = ? ORDER BY created_at ASC'
  ).all(agentId) as Array<Record<string, unknown>>;

  if (rows.length === 0) return null;

  // Map raw DB rows to Message interface (created_at → createdAt, etc.)
  const messages: Message[] = rows.map(r => ({
    id: r.id as string,
    agentId: r.agent_id as string,
    role: r.role as Message['role'],
    content: r.content as string,
    tokenCount: r.token_count as number | null ?? null,
    modelId: r.model_id as string | null ?? null,
    cost: r.cost as number | null ?? null,
    latencyMs: r.latency_ms as number | null ?? null,
    createdAt: r.created_at as string,
    attachments: r.attachments ? JSON.parse(r.attachments as string) : undefined,
  }));

  return archiveMessagesBeforeCompaction(agentId, messages);
}

/**
 * Archive raw messages to vault_conversations BEFORE compaction destroys them.
 * This is called from checkAndCompact() before runLeafCompaction().
 */
export function archiveMessagesBeforeCompaction(
  agentId: string,
  messages: Message[],
): string | null {
  if (messages.length === 0) {
    logger.debug('No messages to archive', {}, agentId);
    return null;
  }

  // Skip entirely if this agent (or its group) is on the Dreamer ignore list.
  // Returning null here means the agent's compaction continues, but the raw
  // messages just don't get copied to vault_conversations.
  if (isDreamerIgnored(agentId)) {
    logger.debug('Agent on Dreamer ignore list — skipping pre-compaction archive', {}, agentId);
    return null;
  }

  // Skip service agents — see shouldSkipServiceAgent for rationale. This is
  // the place that was producing the giant Dreamer-self archives the user
  // saw: the Dreamer's compaction was archiving its own conversation
  // (containing its SOUL.md + every old cycle message + every full
  // 3000+ archive enumeration), which then re-entered the Dreamer queue.
  if (shouldSkipServiceAgent(agentId)) return null;

  try {
    // Get agent name for attribution
    const db = getDb();
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;

    // Serialize full message objects
    const serialized = messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
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

    const archiveId = archiveConversation({
      agentId,
      agentName: agent?.name,
      messages: serialized,
      messageCount: messages.length,
      tokenCount: totalTokens,
      earliestAt,
      latestAt,
    });

    logger.info('Pre-compaction archive complete', {
      archiveId,
      messageCount: messages.length,
      tokenCount: totalTokens,
      timeRange: `${earliestAt} to ${latestAt}`,
    }, agentId);

    return archiveId;
  } catch (err) {
    // Archive is best-effort -- don't block compaction if it fails
    logger.error('Failed to archive messages before compaction', {
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    }, agentId);
    return null;
  }
}
