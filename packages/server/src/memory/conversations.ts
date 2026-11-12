// ── First-class conversations ──
//
// The ONE writer of conversations rows. Identity = channel + provider + counterparty + thread root, resolved or
// created at ingest so every message row carries its conversation_id. Best-effort: a failure returns null and the
// producer inserts with a NULL id, never blocking an inbound.
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('conversations');

export interface ConversationIdentity {
  channel: string;
  provider?: string | null;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  threadRoot?: string | null;
}

/**
 * The `conversations` identity of a resolved counterparty: the SAME three inputs `conversationKey()` takes, mapped
 * onto this table's unique key. Lets a turn resolve its conversation at pickup when the producer could not at ingest.
 * `provider` and `threadRoot` are DELIBERATELY NULL: a door knows gmail-vs-outlook and WHICH mail thread, a turn
 * does not, so this is coarser than a producer's identity; if that matters, the fix is at the door.
 */
export function conversationIdentityOf(
  channel: string | null, senderId: string | null, senderName: string | null, threadId?: string | null,
): ConversationIdentity {
  if (channel === 'a2a') {
    return { channel: 'a2a', provider: null, counterpartyId: senderId ?? null, threadRoot: threadId ?? null };
  }
  // `conversationKey()` folds dashboard, voice and a null channel into 'owner'; here the owner's conversation is
  // per-agent and per-channel, and 'dashboard' is the one the owner-side producers resolve.
  if (channel === 'dashboard' || channel === 'voice' || channel === null) {
    return { channel: channel ?? 'dashboard', provider: null, counterpartyId: 'owner', threadRoot: null };
  }
  return {
    channel,
    provider: null,
    counterpartyId: senderId ?? senderName ?? 'unknown',
    counterpartyName: senderName ?? null,
    threadRoot: null,
  };
}

export function resolveOrCreateConversation(agentId: string, ident: ConversationIdentity): string | null {
  try {
    const db = getDb();
    const provider = ident.provider ?? null;
    const cid = (ident.counterpartyId ?? '').trim().toLowerCase() || null;
    const root = ident.threadRoot ?? null;
    const existing = db.prepare(
      `SELECT id FROM conversations
        WHERE agent_id = ? AND channel = ?
          AND provider IS ? AND counterparty_id IS ? AND thread_root IS ?
        LIMIT 1`,
    ).get(agentId, ident.channel, provider, cid, root) as { id: string } | undefined;
    if (existing) {
      db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(existing.id);
      return existing.id;
    }
    const id = uuidv4();
    db.prepare(
      `INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name, thread_root, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, agentId, ident.channel, provider, cid, ident.counterpartyName ?? null, root);
    // A concurrent insert may have won the unique race; read back the truth.
    const row = db.prepare(
      `SELECT id FROM conversations
        WHERE agent_id = ? AND channel = ?
          AND provider IS ? AND counterparty_id IS ? AND thread_root IS ?
        LIMIT 1`,
    ).get(agentId, ident.channel, provider, cid, root) as { id: string } | undefined;
    return row?.id ?? null;
  } catch (err) {
    logger.warn('conversation resolve failed (non-fatal; row proceeds without id)', {
      agentId, channel: ident.channel, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Dominant (modal) non-null lineage across a set of message ids. Summaries and archives call this so conversation
 *  identity survives the compaction boundary. Each field's mode is computed independently, ties break by count
 *  then lexicographic, and each row counts once. Best-effort: any failure returns all-null lineage and never
 *  blocks the writer. */
export function dominantMessageLineage(messageIds: string[]): {
  conversationId: string | null;
  a2aThreadId: string | null;
} {
  const empty = { conversationId: null, a2aThreadId: null };
  if (messageIds.length === 0) return empty;
  try {
    const db = getDb();
    const tallies: Record<'conversation_id' | 'a2a_thread_id', Map<string, number>> = {
      conversation_id: new Map(),
      a2a_thread_id: new Map(),
    };
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT conversation_id, a2a_thread_id FROM messages WHERE id IN (${ph})`,
      ).all(...chunk) as Array<{ conversation_id: string | null; a2a_thread_id: string | null }>;
      for (const r of rows) {
        for (const col of ['conversation_id', 'a2a_thread_id'] as const) {
          const v = r[col];
          if (v) tallies[col].set(v, (tallies[col].get(v) ?? 0) + 1);
        }
      }
    }
    const mode = (m: Map<string, number>): string | null => {
      let best: string | null = null;
      let bestCount = 0;
      for (const [v, c] of [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (c > bestCount) { best = v; bestCount = c; }
      }
      return best;
    };
    return {
      conversationId: mode(tallies.conversation_id),
      a2aThreadId: mode(tallies.a2a_thread_id),
    };
  } catch {
    return empty;
  }
}
