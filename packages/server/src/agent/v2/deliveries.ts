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
// itself, so every failure here logs and answers a `failed` Outcome (PHASE-4 T1).
//
// PHASE-4 T2: the row and the CLOSE it causes are ONE unit. See `recordDelivery`.
// ════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { currentTurnNumber, currentTurnRoot } from '../turn-state.js';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { closeAsksForDelivery, noSuchWorkDetail } from '../../work/store.js';
import { withUnit } from '../../db/unit.js';
import type { LedgerOutcome } from './delivery-outcome.js';
export { deliveryIdOf, recordedId, type LedgerOutcome } from './delivery-outcome.js';

const logger = createLogger('deliveries');

export interface DeliveryInput {
  agentId: string;
  /** The tool or engine lane that performed the send (imessage_send,
   *  auto-route, engine-ack, ...). */
  tool: string;
  /** `a2a` is the peer lane: an agent-to-agent hand-back IS something the platform
   *  delivered, and PHASE-2 T4's delegated pieces point at those rows (`work.done` requires a
   *  delivery). It has no human conversation, which is why the resolver below skips it. */
  channel: 'imessage' | 'sms' | 'email' | 'teams' | 'phone' | 'dashboard' | 'voice' | 'a2a' | 'none';
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
  /** `owner_closed` is NOT a send and never claims to be one — see
   *  `recordOwnerCloseReceipt` below for the whole argument. */
  outcome: 'delivered' | 'suppressed' | 'failed' | 'held' | 'owner_closed';
  detail?: string | null;
  /** Explicit conversation identity. Auto-route/ack replies go to the TURN's
   *  own conversation (the turn root carries it exactly); pass it and no
   *  resolution happens. Omit for cross-conversation explicit sends, where
   *  the recipient's conversation resolves from channel + recipient. */
  conversationId?: string | null;
}

/**
 * Record one outbound delivery.
 *
 * PHASE-4 T1: answers `LedgerOutcome`, not `string | null`. Still best-effort by
 * contract — a delivery record must never break the delivery itself — but "the write
 * threw" is now a `failed` outcome the caller has to look at, instead of a null
 * indistinguishable from three other things.
 *
 * PHASE-4 T2 — THE ROW AND THE CLOSE ARE ONE UNIT, and this is the plan's own flagship
 * cluster ("deliver + receipt + work.done atomic"). It was TWO transactions: the INSERT
 * committed on its own, then `closeAsksForDelivery` opened a second one. A failure between
 * them left a `deliveries` row no work row could ever point at, while the ask it answered
 * stayed `claimed` — and since `work.state='done'` REQUIRES `result_delivery_id`
 * (migration `135`'s CHECK plus G7), the whole "done means delivered" law rested on those
 * two writes agreeing. They commit together now, proven by driving the second one into a
 * real ABORT and reading the ledger:
 * `agent/v2/__tests__/delivery-atomicity.test.ts`.
 *
 * The unit does NOT make the close a precondition of the record: a delivery that answers
 * no ask still lands (its own negative control). One unit, not one requirement.
 */
export function recordDelivery(input: DeliveryInput): LedgerOutcome {
  try {
    const db = getDb();
    const id = uuidv4();
    return withUnit((): LedgerOutcome => {
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
      } else if (input.channel === 'none' || input.channel === 'a2a') {
        // The peer lane has no `conversations` row and must not mint one: conversation identity
        // is a HUMAN counterparty fact (party labels, recall scoping, the waiting set all read
        // it), and inventing an a2a conversation would put coordination traffic inside it.
        // `none` is here for the same reason from the other direction: nothing crossed a door,
        // so there is no counterparty to resolve and minting a conversation would invent one.
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

// ════════════════════════════════════════════════════════════════════════════════
// THE OWNER'S OWN CLOSE (PHASE-2 T8c2 item 5 — the policy question T8b2 left open)
// ════════════════════════════════════════════════════════════════════════════════
//
// SHOULD THE OWNER'S EXPLICIT DASHBOARD CLOSE REACH `done` WHEN NO DELIVERY RESOLVES? YES.
// G7 exists to stop the ENGINE and the AGENT asserting completion on their own say-so; the
// owner is neither. He is the person the work was FOR, so the thing G7 is trying to establish
// — that the work reached him — is established by the witness himself. Refusing him is the
// rule misapplied, not enforced.
//
// THE EXEMPTION IS THE OWNER'S ALONE, NOT "ANY AUTHORITY". RULING 1's enum makes `pm` an
// authority too and the PM's close still needs a delivery: the justification is RECIPIENCY,
// not authority. True by construction — the tool path passes `by: callerIsPM ? 'pm' : 'agent'`
// and never `'owner'`, so it cannot reach here.
//
// A ROW, NOT A CHECK AMENDMENT. The alternative (an authority arm on G7 admitting a NULL
// delivery, with the `adjudications` row as the receipt) is coherent and needs
// `CHECK (state <> 'done' OR result_delivery_id IS NOT NULL)` amended — a migration against
// the phase's central constraint, to buy a NULL where an honest row will do.
//
// AND IT IS NOT A FAKE DELIVERY, which is what the ledger's guidance forbids: `channel='none'`,
// `outcome='owner_closed'`, no message, no receipt, no conversation, and NO `root_id` —
// deliberately, per migration `135`'s own reasoning (:230-232) that a sentinel carrying
// `root_id=<task id>` "would have manufactured per-task delivery evidence for the PM's own
// consult path". Safety is ENUMERATED rather than asserted, and the enumeration is a test
// clause that re-derives itself: `__tests__/owner-close-receipt.test.ts`.

/**
 * Record the receipt for an owner's explicit close, and return its id.
 *
 * ONE ROW PER CLOSE rather than one shared sentinel per agent (migration `135`'s legacy
 * shape): a close is a distinct event with its own instant, and pointing every
 * owner-closed row at one shared receipt would lose the only fact the receipt carries.
 *
 * REFUSES (`no-such-work`) if the work row is unknown — the caller then has no delivery to
 * point at and G7 refuses for the same reason, which is the correct answer for an id that
 * does not resolve. It is a refusal rather than a null so the caller can tell it apart from
 * a ledger write that broke.
 */
export function recordOwnerCloseReceipt(workId: string, surface: string): LedgerOutcome {
  const w = getDb().prepare('SELECT agent_id FROM work WHERE id = ?')
    .get(workId) as { agent_id: string } | undefined;
  if (!w) return { kind: 'refused', reason: 'no-such-work', detail: noSuchWorkDetail(workId) };
  return recordDelivery({
    agentId: w.agent_id,
    tool: 'owner-close',
    channel: 'none',
    outcome: 'owner_closed',
    conversationId: null,
    detail: `The owner closed this work himself, from ${surface}. Nothing was delivered by `
      + `this row: it is the receipt for his own act, which is what satisfies work.done's `
      + `delivery requirement here. Every reader of this table filters outcome='delivered'.`,
  });
}
