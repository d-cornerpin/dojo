// ════════════════════════════════════════
// First-class outbound deliveries (lanes & lineage P6b-2, migration 121).
//
// One writer for the deliveries table: every reply the engine auto-routes or
// a send tool pushes onto a channel becomes a row carrying who / where / why
// (turn + root lineage) / how it went. The prose "[Reply routed via X]"
// system marker stays as user-visible chat transparency, but nothing
// load-bearing reads prose anymore; the readers (RECENT OUTBOUND selection,
// cross-conversation visibility, download-link guarantees, grounding
// consults) key on these rows.
//
// Best-effort by contract: a delivery record must never break the delivery
// itself, so every failure here logs and returns null.
// ════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { currentTurnNumber, currentTurnRoot } from '../turn-state.js';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { closeAsksForDelivery } from '../../work/store.js';

const logger = createLogger('deliveries');

export interface DeliveryInput {
  agentId: string;
  /** The tool or engine lane that performed the send (imessage_send,
   *  auto-route, engine-ack, ...). */
  tool: string;
  channel: 'imessage' | 'sms' | 'email' | 'teams' | 'phone' | 'dashboard' | 'voice';
  recipientId?: string | null;
  recipientDisplay?: string | null;
  /** Pass a provider/thread identity when the channel has one (email thread,
   *  Teams chat id) so the conversation resolves to the same row the inbound
   *  producers stamp. */
  provider?: string | null;
  threadRoot?: string | null;
  /** The delivered assistant message row, when one exists. */
  messageId?: string | null;
  receiptId?: string | null;
  outcome: 'delivered' | 'suppressed' | 'failed' | 'held';
  detail?: string | null;
  /** Explicit conversation identity. Auto-route/ack replies go to the TURN's
   *  own conversation (the turn root carries it exactly); pass it and no
   *  resolution happens. Omit for cross-conversation explicit sends, where
   *  the recipient's conversation resolves from channel + recipient. */
  conversationId?: string | null;
}

/** Record one outbound delivery. Returns the row id, or null on any failure
 *  (best-effort; the delivery itself is never blocked). */
export function recordDelivery(input: DeliveryInput): string | null {
  try {
    const db = getDb();
    const id = uuidv4();
    // The RECIPIENT's conversation row: same identity the inbound producers
    // stamp, so a send and the reply it provokes land on one conversation.
    // Dashboard/voice deliveries belong to the owner's per-agent conversation.
    let conversationId: string | null = input.conversationId ?? null;
    if (conversationId !== null) {
      // explicit identity from the caller; nothing to resolve
    } else if (input.channel === 'dashboard' || input.channel === 'voice') {
      conversationId = resolveOrCreateConversation(input.agentId, {
        channel: input.channel, provider: null, counterpartyId: 'owner', threadRoot: null,
      });
    } else if (input.recipientId) {
      conversationId = resolveOrCreateConversation(input.agentId, {
        channel: input.channel,
        provider: input.provider ?? (input.channel === 'imessage' ? 'imessage' : null),
        counterpartyId: input.recipientId,
        counterpartyName: input.recipientDisplay ?? null,
        threadRoot: input.threadRoot ?? null,
      });
    }
    const root = currentTurnRoot.get(input.agentId);
    db.prepare(`
      INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, recipient_display,
                              conversation_id, root_kind, root_id, message_id, receipt_id, outcome, detail, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id,
      input.agentId,
      currentTurnNumber.get(input.agentId) ?? null,
      input.tool,
      input.channel,
      input.recipientId ?? null,
      input.recipientDisplay ?? null,
      conversationId,
      root?.kind ?? null,
      root?.id ?? null,
      input.messageId ?? null,
      input.receiptId ?? null,
      input.outcome,
      input.detail ?? null,
    );
    // PHASE-2 T3: a quick ask is DONE because something was delivered for it — never
    // because a model said so. The close happens here, at the one place a delivery becomes
    // a row, so no send path has to remember to do it and none can claim a close it cannot
    // point at (`work.state='done'` requires `result_delivery_id`, enforced by the DDL AND
    // by `transition()`'s own gate).
    // Narrowed three ways, each a negative control in work/__tests__/ask-lifecycle.test.ts:
    // the send must have succeeded, it must belong to the turn holding the claim, and it
    // must have gone to the ask's OWN conversation.
    closeAsksForDelivery({
      agentId: input.agentId,
      turnNumber: currentTurnNumber.get(input.agentId) ?? null,
      deliveryId: id,
      conversationId,
      tool: input.tool,
      outcome: input.outcome,
    });
    return id;
  } catch (err) {
    logger.warn('recordDelivery failed (non-fatal; the delivery itself is unaffected)', {
      agentId: input.agentId, tool: input.tool, channel: input.channel,
      error: err instanceof Error ? err.message : String(err),
    }, input.agentId);
    return null;
  }
}
