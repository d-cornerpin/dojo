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
