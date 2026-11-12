// One writer for the deliveries table: every outbound send is one row carrying who, where and why.
// The prose "[Reply routed via X]" marker stays as chat transparency; readers key on these rows.
// Best-effort by contract: a record must never break the delivery it records; failures answer `failed`.
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { turnContext } from '../turn-context.js';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { noSuchWorkDetail } from '../../work/store.js';
import { settleAsksForDelivery } from '../../work/ask-settlement.js';
import { withUnit } from '../../db/unit.js';
import type { LedgerOutcome } from './delivery-outcome.js';
export { deliveryIdOf, recordedId, type LedgerOutcome } from './delivery-outcome.js';

const logger = createLogger('deliveries');

export interface DeliveryInput {
  agentId: string;
  tool: string;
  /** `a2a` is the peer lane: an agent hand-back is a delivery, and delegated pieces point at
   *  these rows (`work.done` requires one). It has no human conversation, so the resolver skips it. */
  channel: 'imessage' | 'sms' | 'email' | 'teams' | 'phone' | 'dashboard' | 'voice' | 'a2a' | 'none';
  recipientId?: string | null;
  recipientDisplay?: string | null;
  /** Provider/thread identity when the channel has one, so this resolves to the inbound producers' row. */
  provider?: string | null;
  threadRoot?: string | null;
  messageId?: string | null;
  receiptId?: string | null;
  /** `owner_closed` is NOT a send and never claims to be one; `pending` is an outside send's
   *  intent, written before its transport runs (`resolvePendingDelivery` below). */
  outcome: 'delivered' | 'suppressed' | 'failed' | 'held' | 'owner_closed' | 'pending';
  detail?: string | null;
  /** Explicit conversation identity: pass it (the turn's own conversation) and nothing resolves;
   *  omit for cross-conversation sends, where channel + recipient resolve the row. */
  conversationId?: string | null;
}

// The recipient's conversation row: the same identity inbound producers stamp, so send and reply share it.
export function conversationFor(input: DeliveryInput): string | null {
  let conversationId: string | null = input.conversationId ?? null;
  if (conversationId !== null) {
  } else if (input.channel === 'dashboard' || input.channel === 'voice') {
    conversationId = resolveOrCreateConversation(input.agentId, {
      channel: input.channel, provider: null, counterpartyId: 'owner', threadRoot: null,
    });
  } else if (input.channel === 'none' || input.channel === 'a2a') {
    // The peer lane has no `conversations` row and must not mint one: conversation identity is a
    // HUMAN counterparty fact. `none` is here from the other direction: nothing crossed a door.
    conversationId = null;
  } else if (input.recipientId) {
    conversationId = resolveOrCreateConversation(input.agentId, {
      channel: input.channel,
      provider: input.provider ?? (input.channel === 'imessage' ? 'imessage' : null),
      counterpartyId: input.recipientId,
      counterpartyName: input.recipientDisplay ?? null,
      threadRoot: input.threadRoot ?? null,
    });
  }
  return conversationId;
}

/** Record one outbound delivery: answers `LedgerOutcome`, not a nullable id; still best-effort.
 *  The row and the ask close it causes are ONE `withUnit` transaction: a split left a `deliveries`
 *  row work could never point at while the ask stayed `claimed`, and `work.state='done'` REQUIRES
 *  `result_delivery_id`. The unit does not make the close a precondition of the record. */
export function recordDelivery(input: DeliveryInput): LedgerOutcome {
  try {
    const db = getDb();
    const id = uuidv4();
    return withUnit((): LedgerOutcome => {
      const conversationId = conversationFor(input);
      const root = turnContext(input.agentId)?.root;
      db.prepare(`
        INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, recipient_display,
                                conversation_id, root_kind, root_id, message_id, receipt_id, outcome, detail, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        id,
        input.agentId,
        turnContext(input.agentId)?.turnNumber ?? null,
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
      // The close happens where a delivery becomes a row; `work/ask-settlement.ts` decides it, in the unit.
      settleAsksForDelivery({
        agentId: input.agentId,
        turnNumber: turnContext(input.agentId)?.turnNumber ?? null,
        deliveryId: id,
        conversationId,
        tool: input.tool,
        outcome: input.outcome,
      });
      return { kind: 'applied', value: { deliveryId: id } };
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('recordDelivery failed (non-fatal; the delivery itself is unaffected)', {
      agentId: input.agentId, tool: input.tool, channel: input.channel, error: detail,
    }, input.agentId);
    return { kind: 'failed', reason: 'ledger-write-failed', detail };
  }
}

// The owner is the recipient the work was for: their close is the witness done-means-delivered wants.
// Refusing it is the rule misapplied. The exemption is the owner's ALONE: what qualifies them is
// recipiency, not authority, and the tool path passes 'pm' or 'agent', never 'owner', by design.
// A row, not a CHECK amendment: channel='none', outcome='owner_closed', no root_id (it would fake
// per-task delivery evidence for the PM consult path); readers filter outcome='delivered'.

/** One row per close rather than one shared sentinel: a close is a distinct event with its own instant.
 *  REFUSES `no-such-work`: a refusal, not a null, so it reads apart from a ledger write that broke. */
export function recordDecisionReceipt(workId: string, decider: string, surface: string): LedgerOutcome {
  const w = getDb().prepare('SELECT agent_id FROM work WHERE id = ?')
    .get(workId) as { agent_id: string } | undefined;
  if (!w) return { kind: 'refused', reason: 'no-such-work', detail: noSuchWorkDetail(workId) };
  return recordDelivery({
    agentId: w.agent_id,
    tool: 'owner-close',
    channel: 'none',
    outcome: 'owner_closed',
    conversationId: null,
    detail: `${decider} decided this work, by ${surface}. Nothing was delivered by `
      + `this row: it is the receipt for the decision, which is what satisfies work.done's `
      + `delivery requirement here. Every reader of this table filters outcome='delivered'.`,
  });
}

// The intent row is written pending before transport; a crash leaves it, orphaned-claims hands the ask back.

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

// The door's verdict on an intent; null when no pending row of that id stands (the caller writes a new one).
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
      // The intent may not have known the resolved address; the conversation resolves from what the door saw.
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

export function dropPendingDelivery(id: string): void {
  try {
    getDb().prepare("DELETE FROM deliveries WHERE id = ? AND outcome = 'pending'").run(id);
  } catch (err) {
    logger.warn('an unsent intent row could not be removed; it reads pending', { id, error: err instanceof Error ? err.message : String(err) });
  }
}
