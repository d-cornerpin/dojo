// ════════════════════════════════════════
// Vault Archive: Pre-compaction raw conversation archival
// Fast, dumb copy -- no LLM calls, no processing
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/store.js';
import { archiveConversation } from './store.js';
import { isSystemServiceAgent, getSystemServiceAgentIds } from '../config/platform.js';
import { summaryPartyTag } from '../memory/party-label.js';
import { interAgentRowToMessage, type InterAgentRow } from '../memory/interagent.js';
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
 * should skip archiving entirely, conversations stay in the live messages
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
    return false; // Best effort, never block archiving on a lookup error
  }
}

/**
 * D1: the archival high-water mark for an agent, the highest message ROWID
 * already copied into vault_conversations. Archival must only ever copy
 * messages NEWER than this so a session reset (or a later compaction) can never
 * re-copy history that is already in the vault. This single signal is what stops
 * the "every reset re-archives all-time history" bloat: before it, each reset
 * wrote another full multi-MB copy of the whole conversation, duplicate blobs
 * that starved the Dreamer (it re-chewed the same history and dedup-dropped it)
 * and grew the DB ~1 GB/day.
 *
 * The high-water is a rowid, not the old MAX(latest_at) whole-second TEXT
 * timestamp (migration 088). messages.created_at is second-granular, so two
 * messages in the same second tied on the old high-water and the strict
 * `created_at > highWater` filter skipped the equal-second boundary row: it was
 * never copied to the vault yet still got compacted, a silent loss. rowid is
 * unique and monotonic, so callers filter `rowid > highWater` with no ties.
 * Returns null when the agent has never been archived (archive everything the
 * first time). Best-effort: on any lookup error return null so archiving still
 * proceeds.
 */
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

/**
 * D-A step-4 follow-up: the STORE-space archival high-water, the highest
 * inter_agent_messages rowid already copied into vault_conversations. The exact
 * twin of getArchiveHighWaterMark, but keyed to the inter-agent store's own
 * (independent) rowid sequence via the migration-100 latest_ia_rowid column.
 *
 * Why a separate high-water: since D-A steps 2+4, peer AND engine-origin A2A rows
 * live in `inter_agent_messages`, whose rowid space is unrelated to `messages`.
 * The messages high-water (latest_rowid) therefore cannot bound store archival, a
 * store row's small rowid sits far below it on any established box and would be
 * excluded forever. MAX() skips NULLs, so a messages-only archive (latest_ia_rowid
 * NULL) is ignored here and a store archive (latest_rowid NULL) is ignored there:
 * the two lanes never cross-contaminate. rowid is unique + monotonic within the
 * store table, so callers filter `rowid > highWater` tie-free (mig 088 rationale).
 * Returns null when the store has never been archived for this agent (archive
 * everything the first time). Best-effort: any lookup error returns null so
 * archiving still proceeds.
 */
export function getStoreArchiveHighWaterMark(agentId: string): number | null {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT MAX(latest_ia_rowid) AS hw FROM vault_conversations WHERE agent_id = ?',
    ).get(agentId) as { hw: number | null } | undefined;
    return row?.hw ?? null;
  } catch {
    return null;
  }
}

/**
 * Archive ALL messages for a terminated/completed agent.
 * Called on agent termination to ensure conversations are preserved for the Dreamer.
 *
 * `force` bypasses the duplicate-archive guard. Used by reset_session: each reset
 * is a distinct conversation boundary, so we always want a new archive even if
 * a previous one is still unprocessed.
 */
export function archiveAgentConversation(agentId: string, force = false): string | null {
  const db = getDb();

  // Skip entirely if this agent (or its group) is on the Dreamer ignore list.
  // The user explicitly opted out of having this agent's conversations
  // remembered. Their chatter just goes away.
  if (isDreamerIgnored(agentId)) {
    logger.debug('Agent on Dreamer ignore list, skipping archive', {}, agentId);
    return null;
  }

  // Skip service agents (Dreamer, Trainer, Healer, PM, Imaginer). Their
  // histories are pure platform plumbing, see the comment on
  // shouldSkipServiceAgent for the recursion-loop rationale.
  if (shouldSkipServiceAgent(agentId)) return null;

  // D-A step-4 follow-up: the STORE arm. Copy this agent's new inter-agent store
  // rows (peer + engine-origin A2A) into vault_conversations on the SAME per-agent
  // reset/terminate boundary as the messages arm below, so the Dreamer sees them.
  // Placed after the two Dreamer-feed guards (both arms share those exclusions) and
  // before the messages arm's !force/existing-unprocessed early return, so the store
  // arm runs regardless of that messages-only optimization. It has its OWN store
  // high-water (idempotent: a call with nothing new archives nothing) and produces a
  // SEPARATE archive blob, so it never disturbs the messages arm or its return value.
  archiveAgentStoreConversation(agentId);

  // Check if this agent already has an unprocessed archive, avoid duplicates
  // (unless force=true, e.g. reset_session)
  if (!force) {
    const existing = db.prepare(
      'SELECT id FROM vault_conversations WHERE agent_id = ? AND is_processed = 0'
    ).get(agentId) as { id: string } | undefined;
    if (existing) {
      logger.debug('Agent already has unprocessed archive, skipping', { agentId }, agentId);
      return existing.id;
    }
  }

  // D1: only archive messages NEWER than what's already in the vault. Before
  // this, reset (force=true) re-copied the ENTIRE all-time history every time,
  // producing duplicate multi-MB blobs. The high-water mark bounds each archive
  // to the genuinely-new tail; a reset with nothing new archives nothing.
  // Migration 088: bound by rowid (unique, tie-free) instead of the old
  // second-granular created_at, which skipped an equal-second boundary row.
  // D-A step-4 follow-up: exclude ids that ALSO live in the inter-agent store
  // (the migration-098 live-edge backfill left double-homed peer-A2A rows in
  // both tables). The store arm archives those; without this exclusion the
  // first post-cutover reset would archive the same id into two blobs. Store
  // wins, the same dedup discipline as every merged loader in memory/store.ts.
  const highWater = getArchiveHighWaterMark(agentId);
  const rows = (highWater != null
    ? db.prepare(
        `SELECT *, rowid FROM messages WHERE agent_id = ? AND rowid > ?
           AND id NOT IN (SELECT id FROM inter_agent_messages WHERE agent_id = ?)
         ORDER BY created_at ASC, rowid ASC`,
      ).all(agentId, highWater, agentId)
    : db.prepare(
        `SELECT *, rowid FROM messages WHERE agent_id = ?
           AND id NOT IN (SELECT id FROM inter_agent_messages WHERE agent_id = ?)
         ORDER BY created_at ASC, rowid ASC`,
      ).all(agentId, agentId)) as Array<Record<string, unknown>>;

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
    rowid: r.rowid as number | undefined,
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
    logger.debug('Agent on Dreamer ignore list, skipping pre-compaction archive', {}, agentId);
    return null;
  }

  // Skip service agents, see shouldSkipServiceAgent for rationale. This is
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
      // Conversation/party attribution (channel-aware redesign): preserve WHO each
      // message is from so the Dreamer can keep whose-request-is-whose when it
      // writes vault memories. Derived now because the raw origin columns are not
      // carried into the archive blob.
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
    // Migration 088: persist the highest archived rowid as the tie-free
    // high-water. Derive from the max over the batch (not positional) so it is
    // correct even if a re-homed engine event left created_at and rowid out of
    // lockstep. Null when the batch carried no rowid (defensive only).
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
    // Archive is best-effort -- don't block compaction if it fails
    logger.error('Failed to archive messages before compaction', {
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    }, agentId);
    return null;
  }
}

/**
 * D-A step-4 follow-up: archive this agent's NEW inter-agent store rows into
 * vault_conversations. The STORE twin of archiveAgentConversation's messages arm:
 * same per-agent reset/terminate boundary, same "everything above the high-water,
 * grouped into ONE per-agent blob" discipline (the exact granularity A2A rows had
 * when they lived in `messages` and rode the single per-agent archive, we do NOT
 * split by a2a_thread_id/conv_key, they ride inside the blob as they always did),
 * and the same two Dreamer-feed guards. The only differences are the source table
 * (inter_agent_messages) and the high-water column (latest_ia_rowid), because the
 * store has its own rowid space.
 *
 * Rows are mapped through interAgentRowToMessage so origin derivation runs exactly
 * as for the merged model tail, giving summaryPartyTag a real "<agent> (agent)"
 * party label per row (the Dreamer needs to know WHICH agent an A2A row is from).
 * attachments are carried across (interAgentRowToMessage does not project them).
 * Returns the archive id, or null when there is nothing new to archive / the agent
 * is Dreamer-ignored or a service agent.
 */
export function archiveAgentStoreConversation(agentId: string): string | null {
  // Same two Dreamer-feed exclusions as the messages arm (defense-in-depth: this is
  // also exported for standalone use). A Dreamer-ignored agent's A2A just goes away;
  // a service agent's A2A is pure plumbing and must never re-enter the Dreamer loop.
  if (isDreamerIgnored(agentId)) {
    logger.debug('Agent on Dreamer ignore list, skipping store archive', {}, agentId);
    return null;
  }
  if (shouldSkipServiceAgent(agentId)) return null;

  const db = getDb();

  // Only archive store rows NEWER than the store high-water (tie-free rowid bound,
  // mig 100). Null high-water = never archived from the store -> archive everything
  // once. Identical shape to the messages arm's high-water SELECT, different table.
  //
  // Migration 104 structural exemption: skip relocated rows (relocated_at IS NOT
  // NULL). Migration 104 moved the agent's LEGACY pre-step-8 own-output from
  // `messages` into this store with fresh (top-of-space) rowids. Those rows are
  // `messages`-origin history the MESSAGES archive arm already owned (they rode
  // per-agent archives for months); the store arm must not re-archive them for a
  // second Dreamer distillation (the storm-archive shape). A high-water bump could
  // not do this without also starving the LEGITIMATE store-native rows (peer A2A +
  // step-8 own-output) that sit BELOW the relocated span and are still pending
  // their first store archive, so the exemption is a per-row marker instead. Only
  // this `SELECT *` arm reads it; every merged model reader uses explicit columns.
  const highWater = getStoreArchiveHighWaterMark(agentId);
  const rows = (highWater != null
    ? db.prepare(
        'SELECT *, rowid FROM inter_agent_messages WHERE agent_id = ? AND rowid > ? AND relocated_at IS NULL ORDER BY created_at ASC, rowid ASC',
      ).all(agentId, highWater)
    : db.prepare(
        'SELECT *, rowid FROM inter_agent_messages WHERE agent_id = ? AND relocated_at IS NULL ORDER BY created_at ASC, rowid ASC',
      ).all(agentId)) as InterAgentRow[];

  if (rows.length === 0) return null;

  const messages: Message[] = rows.map(r => {
    const m = interAgentRowToMessage(r);
    // rowToMessage does not project attachments; carry them so an A2A row that
    // shipped a file is archived whole, exactly like the messages arm does.
    if (r.attachments) {
      try {
        m.attachments = JSON.parse(r.attachments) as Message['attachments'];
      } catch {
        /* leave attachments undefined on malformed JSON, never block the archive */
      }
    }
    return m;
  });

  return archiveStoreMessagesToVault(agentId, messages);
}

/**
 * Serialize + persist a batch of inter-agent store Messages to vault_conversations,
 * the STORE twin of archiveMessagesBeforeCompaction. Byte-for-byte the same blob
 * shape (id/role/content/party/tokenCount/.../attachments), so the Dreamer reads a
 * store archive identically to a messages archive. The ONE difference: the batch's
 * max rowid is persisted as latest_ia_rowid (the store high-water), with latestRowid
 * left NULL, because these rowids are in the store's OWN space and must not touch the
 * messages high-water (getArchiveHighWaterMark). Best-effort: a failure logs and
 * returns null, it never throws into the reset/terminate path.
 */
function archiveStoreMessagesToVault(agentId: string, messages: Message[]): string | null {
  if (messages.length === 0) return null;
  if (isDreamerIgnored(agentId)) return null;
  if (shouldSkipServiceAgent(agentId)) return null;

  try {
    const db = getDb();
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;

    const serialized = messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      // Same per-message party attribution as the messages arm so the Dreamer keeps
      // whose-request-is-whose. For a store row summaryPartyTag resolves the derived
      // agent origin to "<agent> (agent)".
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
    // Store high-water: max over the batch (not positional), tie-free. Null when the
    // batch carried no rowid (defensive only, the SELECT always projects rowid).
    const rowids = messages.map(m => m.rowid).filter((r): r is number => typeof r === 'number');
    const latestIaRowid = rowids.length ? Math.max(...rowids) : null;

    const archiveId = archiveConversation({
      agentId,
      agentName: agent?.name,
      messages: serialized,
      messageCount: messages.length,
      tokenCount: totalTokens,
      earliestAt,
      latestAt,
      latestRowid: null,     // a store archive never advances the messages high-water
      latestIaRowid,         // mig 100 store high-water
    });

    logger.info('Inter-agent store archive complete', {
      archiveId,
      messageCount: messages.length,
      tokenCount: totalTokens,
      timeRange: `${earliestAt} to ${latestAt}`,
    }, agentId);

    return archiveId;
  } catch (err) {
    logger.error('Failed to archive inter-agent store messages', {
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    }, agentId);
    return null;
  }
}
