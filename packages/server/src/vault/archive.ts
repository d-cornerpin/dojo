// ════════════════════════════════════════
// Vault Archive: Pre-compaction raw conversation archival
// Fast, dumb copy -- no LLM calls, no processing
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/store.js';
import { archiveConversation } from './store.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('vault-archive');

/**
 * Archive ALL messages for a terminated/completed agent.
 * Called on agent termination to ensure conversations are preserved for the Dreamer.
 */
export function archiveAgentConversation(agentId: string): string | null {
  const db = getDb();

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
