// ── First-class conversations (lanes & lineage P5, 2026-07-21) ──
//
// The ONE writer of conversations rows. Identity = channel + provider +
// counterparty + thread root, resolved-or-created at ingest so every message
// row carries its conversation_id atomically. Best-effort by contract: a
// resolution failure returns null and the producer inserts with a NULL id
// (pre-P5 behavior), never blocks an inbound.
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

/** Dominant (modal) non-null lineage across a set of message ids (lanes & lineage P5c).
 *  Summaries and archives call this so conversation identity survives the compaction
 *  boundary instead of dropping at it. Each field's mode is computed independently: a chunk
 *  can carry one dominant conversation but several conv_keys, and each is separately useful
 *  to recall/audits. Ties break deterministically (count, then lexicographic).
 *  Best-effort by design: any failure returns all-null lineage and never blocks the writer.
 *
 *  T5: ONE query per chunk. This ran the same statement twice, once against each message
 *  store, and summed the tallies — which also meant a double-homed id voted TWICE and could
 *  carry a mode on its own. STRIP; requirement preserved: a summary carries the modal
 *  lineage of the chunk it compressed, counted once per row. */
export function dominantMessageLineage(messageIds: string[]): {
  conversationId: string | null;
  convKey: string | null;
  a2aThreadId: string | null;
} {
  const empty = { conversationId: null, convKey: null, a2aThreadId: null };
  if (messageIds.length === 0) return empty;
  try {
    const db = getDb();
    const tallies: Record<'conversation_id' | 'conv_key' | 'a2a_thread_id', Map<string, number>> = {
      conversation_id: new Map(),
      conv_key: new Map(),
      a2a_thread_id: new Map(),
    };
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT conversation_id, conv_key, a2a_thread_id FROM messages WHERE id IN (${ph})`,
      ).all(...chunk) as Array<{ conversation_id: string | null; conv_key: string | null; a2a_thread_id: string | null }>;
      for (const r of rows) {
        for (const col of ['conversation_id', 'conv_key', 'a2a_thread_id'] as const) {
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
      convKey: mode(tallies.conv_key),
      a2aThreadId: mode(tallies.a2a_thread_id),
    };
  } catch {
    return empty;
  }
}
