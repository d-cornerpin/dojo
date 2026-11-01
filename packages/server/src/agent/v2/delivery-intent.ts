// ════════════════════════════════════════════════════════════════════════════════
// THE OUTSIDE SEND'S INTENT (proof-fix-f, coordinator ruling 4)
//
// The door records a send after its transport returns, so a process killed in between left an
// answer the person had received and no row saying so: on restart the ask was answered again.
// An outbound scope on an outside channel (`agent/v2/outbound.ts`) now writes its row
// FIRST, `outcome='pending'`, carrying the text; the door's verdict turns that same row into
// what it observed, through `resolvePendingDelivery`, with the ask close in the same unit as any first write. A
// crash leaves `pending` — "may have been delivered" — and `work/orphaned-claims.ts` hands the
// ask back saying so. Every reader that means "sent" filters `outcome='delivered'`.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { settleAsksForDelivery } from '../../work/ask-settlement.js';
import { withUnit } from '../../db/unit.js';
import { conversationFor, type DeliveryInput } from './deliveries.js';
import type { LedgerOutcome } from './delivery-outcome.js';

const logger = createLogger('delivery-intent');

export interface DoorVerdict {
  outcome: Exclude<DeliveryInput['outcome'], 'pending'>;
  detail?: string | null;
  messageId?: string | null;
  recipientId?: string | null;
  recipientDisplay?: string | null;
  provider?: string | null;
  threadRoot?: string | null;
  receiptId?: string | null;
}

/** The door's verdict on an intent. `null` when no pending row of that id stands (the caller writes a fresh one). */
export function resolvePendingDelivery(id: string, seen: DoorVerdict): LedgerOutcome | null {
  try {
    const db = getDb();
    return withUnit((): LedgerOutcome | null => {
      const row = db.prepare(
        `SELECT agent_id, turn_number, tool, channel, recipient_id, recipient_display, conversation_id
           FROM deliveries WHERE id = ? AND outcome = 'pending'`,
      ).get(id) as {
        agent_id: string; turn_number: number | null; tool: string; channel: DeliveryInput['channel'];
        recipient_id: string | null; recipient_display: string | null; conversation_id: string | null;
      } | undefined;
      if (!row) return null;
      const recipientId = row.recipient_id ?? seen.recipientId ?? null;
      const recipientDisplay = row.recipient_display ?? seen.recipientDisplay ?? null;
      // The intent may not have known the address the door resolved (an owner-bound text); the
      // conversation is resolved now from what the door saw, exactly as a first write would.
      const conversationId = row.conversation_id ?? conversationFor({
        agentId: row.agent_id, tool: row.tool, channel: row.channel, recipientId, recipientDisplay,
        provider: seen.provider ?? null, threadRoot: seen.threadRoot ?? null, outcome: seen.outcome,
      });
      db.prepare(
        `UPDATE deliveries
            SET outcome = ?, detail = ?, message_id = COALESCE(message_id, ?), recipient_id = ?,
                recipient_display = ?, receipt_id = COALESCE(receipt_id, ?), conversation_id = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(seen.outcome, seen.detail ?? null, seen.messageId ?? null, recipientId, recipientDisplay,
        seen.receiptId ?? null, conversationId, id);
      settleAsksForDelivery({
        agentId: row.agent_id, turnNumber: row.turn_number, deliveryId: id, conversationId,
        tool: row.tool, outcome: seen.outcome,
      });
      return { kind: 'applied', value: { deliveryId: id } };
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('resolvePendingDelivery failed (non-fatal; the delivery itself is unaffected)', { id, error: detail });
    return { kind: 'failed', reason: 'ledger-write-failed', detail };
  }
}

/** An intent whose scope ended without reaching any transport: nothing was sent, so no row stands (as before intents). */
export function dropPendingDelivery(id: string): void {
  try {
    getDb().prepare("DELETE FROM deliveries WHERE id = ? AND outcome = 'pending'").run(id);
  } catch (err) {
    logger.warn('an unsent intent row could not be removed; it reads pending', { id, error: err instanceof Error ? err.message : String(err) });
  }
}
