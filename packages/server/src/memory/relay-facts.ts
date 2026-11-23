// Relayed-answer facts for row labels and the wake footer: no wording, best-effort (no record, no claim).
import { getDb } from '../db/connection.js';
import { getOwnerName } from '../config/platform.js';
import { ENGINE_JOIN_RELAY_TOOLS } from '../work/ask-settlement.js';

/** The engine's own receipt that it SENT the row `messageId` to the person (a join relay's `deliveries` row). */
export function readRelayReceipt(agentId: string, messageId: string): { channel: string | null; createdAt: string } | null {
  try {
    const tools = [...ENGINE_JOIN_RELAY_TOOLS];
    const d = getDb().prepare("SELECT channel, created_at FROM deliveries WHERE agent_id = ? AND message_id = ? AND outcome = 'delivered'"
      + ' AND tool IN (' + tools.map(() => '?').join(', ') + ') ORDER BY created_at ASC, rowid ASC LIMIT 1')
      .get(agentId, messageId, ...tools) as { channel: string | null; created_at: string } | undefined;
    return d ? { channel: d.channel, createdAt: d.created_at } : null;
  } catch { return null; }
}

/** The newest piece this agent opened on `threadId` by delegating a person's request, in any state, or null. */
export function delegatedPiece(agentId: string, threadId: string): string | null {
  try {
    return (getDb().prepare(`SELECT c.id FROM work c JOIN work p ON p.id = c.parent_id AND p.kind = 'ask'
        WHERE c.agent_id = ? AND c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.root_id = ? ORDER BY c.opened_at DESC LIMIT 1`)
      .get(agentId, threadId) as { id: string } | undefined)?.id ?? null;
  } catch { return null; }
}

/** Who the conversation's person is (the owner by his configured name), raw: the caller neutralises it. */
export function readCounterparty(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  try {
    const c = getDb().prepare('SELECT counterparty_id, counterparty_name FROM conversations WHERE id = ?')
      .get(conversationId) as { counterparty_id: string | null; counterparty_name: string | null } | undefined;
    return c ? (c.counterparty_id === 'owner' ? getOwnerName() : (c.counterparty_name ?? c.counterparty_id ?? 'someone')) : null;
  } catch { return null; }
}
