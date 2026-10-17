// t196: the stored facts a row label and the wake footer state about a relayed answer. Plain reads, no wording: the
// words (and their neutralising) live in `row-label.ts`. Every read is best-effort: no record, no claim.
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

/** This agent opened `threadId` by delegating a person's ask (a join child under an ask row), in any state. */
export function readDelegatedForAsk(agentId: string, threadId: string): boolean {
  try {
    return !!getDb().prepare(`SELECT 1 FROM work c JOIN work p ON p.id = c.parent_id
                               WHERE c.agent_id = ? AND c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.root_id = ?
                                 AND p.kind = 'ask' LIMIT 1`).get(agentId, threadId);
  } catch { return false; }
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
