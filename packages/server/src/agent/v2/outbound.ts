// ════════════════════════════════════════════════════════════════════════════════
// THE OUTBOUND SCOPE (PHASE-2 T5, research 03 §"Structural")
//
// Before this module, `deliveries` had ONE caller — `persistRoutingMarker` in the engine
// loop — and 44 rows of a single tool. Dashboard bubbles (the most common delivery in the
// product), spoken replies, alerts, A2A relays, engine acks and ten named send paths
// recorded nothing at all, and because every record was written by a caller who had already
// decided the send worked (`!isError`), a THROWN send could not produce `outcome='failed'`.
// `work.done` requires a delivery, so on the dashboard path an answered ask rested at
// `claimed` forever.
//
// Research 03's own conclusion: the bridge, the Twilio client and the websocket "write
// nothing themselves — move the record DOWN into the transports". This is that move, and it
// is a split of responsibility rather than a relocation of the same call:
//
//   the CALLER declares IDENTITY   — who is sending, on whose behalf, over which channel,
//                                    into which conversation. It opens a SCOPE.
//   the DOOR records the OUTCOME   — from what it actually observed. `recordAtDoor`.
//
// A caller can no longer claim a delivery that did not happen, because it no longer writes
// the row; and a door can no longer be crossed silently, because an unscoped crossing still
// records (attributed to `PLATFORM_SENDER`, which is honest: nobody's agent sent it).
//
// ONE SCOPE = ONE ROW. A send that crosses a door more than once — the attachment sibling
// that sends the file and then calls `sendIMessage` for the caption, a phone reply spoken as
// several utterances — is ONE thing the person received, so the first crossing writes the
// row and later crossings UPDATE it. Failure wins: a partially failed send is a failed send.
//
// The scope rides `AsyncLocalStorage`, the same primitive and for the same reason as
// `runWithToolCallId` (turn-state.ts): a per-agent slot is overwritten by a concurrent batch,
// while an ALS store travels with the async work that created it.
// ════════════════════════════════════════════════════════════════════════════════
import { AsyncLocalStorage } from 'node:async_hooks';
import { channelOfSendTool, type WsEvent } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { currentTurnRoot, currentTurnNumber } from '../turn-state.js';
import { linkArtifactsToDelivery } from '../pending-attachments.js';
import { recordDelivery, type DeliveryInput } from './deliveries.js';
import { deliveryIdOf, type LedgerOutcome } from './delivery-outcome.js';
export { recordedId, deliveryIdOf } from './delivery-outcome.js';

const logger = createLogger('outbound');

export type DeliveryChannel = DeliveryInput['channel'];
export type DeliveryOutcome = DeliveryInput['outcome'];

/** The sender of a platform outbound that no agent authored: a watchdog-class alert, the
 *  first-run welcome, an approval prompt from the healer. `deliveries.agent_id` is NOT NULL
 *  and carries no foreign key, and every agent-scoped reader filters by a real agent id, so
 *  these rows are counted and never masquerade as an agent's own traffic. */
export const PLATFORM_SENDER = 'platform';

/** What a caller declares before a send. Everything here is identity; nothing is evidence. */
export interface OutboundIntent {
  agentId: string;
  /** The tool or engine lane performing the send (`imessage_send`, `auto-route`,
   *  `engine-ack`, `alert`, ...). */
  tool: string;
  channel: DeliveryChannel;
  recipientId?: string | null;
  recipientDisplay?: string | null;
  provider?: string | null;
  threadRoot?: string | null;
  /** Explicit conversation identity. Omit and `recordDelivery` resolves it from the channel
   *  and recipient exactly as it always has. */
  conversationId?: string | null;
  messageId?: string | null;
}

/** What a door observed. The door owns the outcome; everything else is a fallback used only
 *  when the crossing happens OUTSIDE any scope. */
export interface DoorObservation {
  outcome: DeliveryOutcome;
  channel: DeliveryChannel;
  detail?: string | null;
  /** Door-supplied fallbacks for an unscoped crossing. Ignored when a scope is open. */
  agentId?: string;
  tool?: string;
  recipientId?: string | null;
  recipientDisplay?: string | null;
  provider?: string | null;
  threadRoot?: string | null;
  messageId?: string | null;
}

interface OutboundScope {
  intent: OutboundIntent;
  /** The row this scope owns, once a door has written it. */
  deliveryId: string | null;
  /** A receipt seen inside this scope, held until there is a row to stamp it on. */
  receiptId: string | null;
  /** Any door in this scope reported a failure. */
  failed: boolean;
  details: string[];
}

const outboundContext = new AsyncLocalStorage<OutboundScope>();

function newScope(intent: OutboundIntent): OutboundScope {
  return { intent, deliveryId: null, receiptId: null, failed: false, details: [] };
}

function mergedDetail(scope: OutboundScope): string | null {
  if (scope.details.length === 0) return null;
  return scope.details.join('; ').slice(0, 500);
}

/**
 * Push the scope's accumulated verdict onto the row it owns.
 *
 * Only ever DOWNGRADES: a failure anywhere in the scope makes the row `failed`, and an
 * outcome the door already chose (`held`, `delivered`) is otherwise left exactly as the door
 * recorded it. Settle must never be able to talk a failed send back up into a delivered one.
 */
function settle(scope: OutboundScope): void {
  if (!scope.deliveryId) return;
  try {
    getDb().prepare(
      `UPDATE deliveries
          SET outcome = CASE WHEN ? = 1 THEN 'failed' ELSE outcome END,
              detail = COALESCE(?, detail),
              receipt_id = COALESCE(?, receipt_id),
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(scope.failed ? 1 : 0, mergedDetail(scope), scope.receiptId, scope.deliveryId);
  } catch (err) {
    logger.warn('outbound settle failed (the delivery itself is unaffected)', {
      agentId: scope.intent.agentId, tool: scope.intent.tool,
      error: err instanceof Error ? err.message : String(err),
    }, scope.intent.agentId);
  }
}

/** Mark the scope failed and record why. Used by the throw handlers below. */
function markFailed(scope: OutboundScope, reason: string): void {
  scope.failed = true;
  if (reason) scope.details.push(reason);
  if (scope.deliveryId) {
    try {
      getDb().prepare(
        `UPDATE deliveries SET outcome = 'failed', detail = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(mergedDetail(scope), scope.deliveryId);
    } catch (err) {
      logger.warn('outbound failure stamp failed', {
        agentId: scope.intent.agentId, error: err instanceof Error ? err.message : String(err),
      }, scope.intent.agentId);
    }
  } else {
    // The send threw BEFORE reaching any transport. There is still an outbound the platform
    // attempted and did not complete, and a ledger that only records the sends that worked
    // is the exact dishonesty this task exists to remove.
    scope.deliveryId = deliveryIdOf(recordDelivery({
      agentId: scope.intent.agentId,
      tool: scope.intent.tool,
      channel: scope.intent.channel,
      recipientId: scope.intent.recipientId ?? null,
      recipientDisplay: scope.intent.recipientDisplay ?? null,
      provider: scope.intent.provider ?? null,
      threadRoot: scope.intent.threadRoot ?? null,
      conversationId: scope.intent.conversationId ?? null,
      messageId: scope.intent.messageId ?? null,
      receiptId: scope.receiptId,
      outcome: 'failed',
      detail: mergedDetail(scope),
    }));
  }
}

/** Run a synchronous send under a declared identity. */
export function withOutbound<T>(intent: OutboundIntent, fn: () => T): T {
  const scope = newScope(intent);
  return outboundContext.run(scope, () => {
    try {
      const out = fn();
      settle(scope);
      return out;
    } catch (err) {
      markFailed(scope, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

/**
 * Run a send under a declared identity ONLY if no identity is already declared.
 *
 * The transport doors that call other transport doors (`sendIMessageWithAttachment` sends the
 * file and then calls `sendIMessage` for the caption) need a scope so their own crossings
 * fold into one row — but when the caller ALREADY declared who is sending, that identity is
 * the true one and must not be shadowed by the door's generic fallback. One send, one row,
 * attributed to whoever really sent it.
 */
export function withOutboundIfAbsent<T>(intent: OutboundIntent, fn: () => T): T {
  if (outboundContext.getStore()) return fn();
  return withOutbound(intent, fn);
}

/** Async counterpart of `withOutboundIfAbsent`: the tool-dispatch door declares an identity
 *  only when the engine lane above it (an auto-route reply, a join relay) has not already
 *  declared a truer one. */
export function withOutboundAsyncIfAbsent<T>(intent: OutboundIntent, fn: () => Promise<T>): Promise<T> {
  if (outboundContext.getStore()) return fn();
  return withOutboundAsync(intent, fn);
}

/** Run an asynchronous send under a declared identity. The store travels across every await. */
export function withOutboundAsync<T>(intent: OutboundIntent, fn: () => Promise<T>): Promise<T> {
  const scope = newScope(intent);
  return outboundContext.run(scope, async () => {
    try {
      const out = await fn();
      settle(scope);
      return out;
    } catch (err) {
      markFailed(scope, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

/**
 * A transport door reports what it observed. Returns the row id for this send.
 *
 * Inside a scope: the FIRST crossing writes the row; later crossings fold into it (one send,
 * one row) and a failure anywhere makes the row `failed`.
 * Outside a scope: writes a standalone row from the door's own facts, attributed to
 * `PLATFORM_SENDER` unless the door knows the agent.
 */
export function recordAtDoor(observed: DoorObservation): LedgerOutcome {
  const scope = outboundContext.getStore();
  if (!scope) {
    return recordDelivery({
      agentId: observed.agentId ?? PLATFORM_SENDER,
      tool: observed.tool ?? `${observed.channel}-door`,
      channel: observed.channel,
      recipientId: observed.recipientId ?? null,
      recipientDisplay: observed.recipientDisplay ?? null,
      provider: observed.provider ?? null,
      threadRoot: observed.threadRoot ?? null,
      messageId: observed.messageId ?? null,
      outcome: observed.outcome,
      detail: observed.detail ?? null,
    });
  }

  if (observed.outcome === 'failed') scope.failed = true;
  if (observed.detail) scope.details.push(observed.detail);

  if (scope.deliveryId) {
    // A later crossing of the same send may know MORE than the first did (which message row
    // carried it, which address it actually resolved to). Fill the blanks; never overwrite a
    // fact the first crossing already established.
    if (observed.messageId || observed.recipientId || observed.recipientDisplay) {
      try {
        getDb().prepare(
          `UPDATE deliveries
              SET message_id = COALESCE(message_id, ?),
                  recipient_id = COALESCE(recipient_id, ?),
                  recipient_display = COALESCE(recipient_display, ?),
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(
          observed.messageId ?? null, observed.recipientId ?? null,
          observed.recipientDisplay ?? null, scope.deliveryId,
        );
      } catch { /* enrichment is best-effort; the row and its outcome already stand */ }
    }
    settle(scope);
    // ONE SEND, ONE ROW: this crossing enriched the row the first wrote. Nothing new
    // was recorded and nothing is wrong — the fact `string | null` could not carry.
    return { kind: 'no_change', reason: 'folded-into-open-scope', deliveryId: scope.deliveryId, detail: 'a later crossing of a send already recorded by this scope' };
  }

  const written = recordDelivery({
    agentId: scope.intent.agentId,
    tool: scope.intent.tool,
    // The scope names the channel it declared; a door that crosses on another channel
    // (an iMessage caption riding an attachment send) does not rewrite that identity.
    channel: scope.intent.channel,
    recipientId: scope.intent.recipientId ?? observed.recipientId ?? null,
    recipientDisplay: scope.intent.recipientDisplay ?? observed.recipientDisplay ?? null,
    provider: scope.intent.provider ?? observed.provider ?? null,
    threadRoot: scope.intent.threadRoot ?? observed.threadRoot ?? null,
    conversationId: scope.intent.conversationId ?? null,
    messageId: scope.intent.messageId ?? observed.messageId ?? null,
    receiptId: scope.receiptId,
    outcome: scope.failed ? 'failed' : observed.outcome,
    detail: mergedDetail(scope),
  });
  scope.deliveryId = deliveryIdOf(written);
  return written;
}

/**
 * A `held` outcome has no door to observe it: the whole content of the event is that no
 * transport was reached (the settled-context hold — the 3:32 AM class). It is recorded
 * directly, which is why this is a separate, named entry point rather than a caller
 * pretending to be a door.
 */
export function recordHeld(intent: OutboundIntent, reason: string): LedgerOutcome {
  return recordDelivery({
    agentId: intent.agentId,
    tool: intent.tool,
    channel: intent.channel,
    recipientId: intent.recipientId ?? null,
    recipientDisplay: intent.recipientDisplay ?? null,
    conversationId: intent.conversationId ?? null,
    outcome: 'held',
    detail: reason,
  });
}

/**
 * The engine wrote a receipt for the send this scope is performing. Called by
 * `writeToolReceipt` (receipts/store.ts), the SOLE writer of `tool_receipts`, so the link
 * between a delivery and its provider-issued proof is established by the two writers
 * themselves rather than reconstructed later by a three-column guess.
 *
 * Order-independent: a receipt seen before the door crossing is held on the scope and lands
 * on the row when it is written.
 */
export function noteReceiptForOutbound(receiptId: string): void {
  const scope = outboundContext.getStore();
  if (!scope) return;
  scope.receiptId = receiptId;
  if (!scope.deliveryId) return;
  try {
    getDb().prepare(
      `UPDATE deliveries SET receipt_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(receiptId, scope.deliveryId);
  } catch (err) {
    logger.warn('receipt link failed (non-fatal)', {
      receiptId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The row the current scope owns, or null outside a scope / before the first crossing. */
export function currentOutboundDeliveryId(): string | null {
  return outboundContext.getStore()?.deliveryId ?? null;
}

/** True when a send is in flight under a declared identity. Read by the provider-API doors,
 *  which carry both person-reaching sends and ordinary data writes down the same function. */
export function inOutboundScope(): boolean {
  return outboundContext.getStore() !== undefined;
}

/**
 * The channel a send TOOL delivers on, or null when the tool reaches nobody.
 *
 * This is what lets the engine open a scope at the single tool-dispatch door instead of at
 * each of the ten send paths PINNED §8 lists as unrecorded — `gmail_reply`, `gmail_forward`,
 * `outlook_reply`, `outlook_forward`, `teams_send_message`, `teams_send_channel_message`,
 * `voice_call`, and the four that were already partly covered — and it is derived from the
 * shared `channelOfSendTool` map rather than being a second hand-maintained list.
 *
 * `user_` twins run the BASE tool's executor (the same reasoning `RECEIPT_EXEMPT` records),
 * so they resolve to the base name's channel.
 *
 * `send_to_agent` / `broadcast_to_group` deliberately return null: their rows are written
 * inside the A2A transport, one per PEER, by the call PHASE-2 T4 landed. A scope here would
 * fold a fan-out to five agents into one row, which is a worse answer than no scope.
 */
export function outboundChannelForTool(name: string): DeliveryChannel | null {
  const base = name.startsWith('user_') ? name.slice('user_'.length) : name;
  if (base === 'teams_send_channel_message') return 'teams';
  const ch = channelOfSendTool(base);
  if (ch === null) return null;
  // ChannelKind and the deliveries channel union agree on every send channel; the extra
  // members of the delivery union (dashboard, voice, a2a) have no send tool.
  return ch as DeliveryChannel;
}

/** The recipient a send tool named, for the ledger's `recipient_id`. Best-effort: a missing
 *  or reply-shaped argument simply leaves the column null, exactly as it does today. */
export function outboundRecipientForTool(
  name: string, args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const first = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const base = name.startsWith('user_') ? name.slice('user_'.length) : name;
  if (base.startsWith('teams_')) return first('chat_id', 'channel_id', 'team_id');
  if (base === 'imessage_send') return first('to', 'recipient', 'handle');
  if (base === 'sms_send' || base === 'voice_call') return first('to', 'number', 'recipient');
  return first('to', 'recipient');
}

// ════════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD DOOR
//
// `broadcast()` is the transport for the most common delivery in the product and the one
// research 03 found recording nothing: the assistant bubble. It is also the seam PHASE-1 T9
// stamps (`stampPersistedRow`, carrying the BROADCAST_EQUALS_ROW invariant), so this runs
// AFTER that seam and reads only what it already attached — it adds no lookup of its own and
// changes nothing the seam does.
//
// The predicate is deliberately narrow, and every clause has a negative control in
// __tests__/universal-deliveries.test.ts:
//   · `chat:message` only            — a chunk, a status, a retraction is not a delivery;
//   · role `assistant` only          — a routing marker, a working note, the user's own
//                                      echoed message are not the agent answering;
//   · a PERSISTED row only           — an emission with no row is already reported as an
//                                      orphan by the seam; claiming a delivery for something
//                                      that was never stored is the dishonest half of that
//                                      same defect;
//   · lane `owner` only              — peer traffic on the Threads lane is not owner-facing
//                                      (OR4: agent traffic never masquerades as owner chat).
//
// Idempotent by message id: a re-emitted bubble is not a second delivery.
// ════════════════════════════════════════════════════════════════════════════════
export function recordDashboardDelivery(event: WsEvent): string | null {
  try {
    if (event.type !== 'chat:message') return null;
    const msg = event.message;
    if (!msg || msg.role !== 'assistant') return null;
    const agentId = event.agentId;
    if (!agentId) return null;

    // The seam already looked the row up and stamped what it found; `row` present means
    // persisted, and it carries the lane.
    const row = event.row;
    if (!row || row.lane !== 'owner') return null;

    const db = getDb();
    const already = db.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND channel = 'dashboard' AND message_id = ?`,
    ).get(agentId, msg.id) as { id: string } | undefined;
    if (already) return already.id;

    // ENUMERATED REMAINDER (T1): keeps `string | null` — its three early returns answer
    // "is this ws event a delivery at all?", not "did the ledger record it".
    const deliveryId = deliveryIdOf(recordDelivery({
      agentId,
      tool: 'dashboard',
      channel: 'dashboard',
      recipientId: 'owner',
      messageId: msg.id,
      // The turn's own conversation, exactly as the auto-route sites pass it. Falling back
      // to the resolver keeps a bubble outside a turn (a boot notice) recordable.
      conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
      outcome: 'delivered',
    }));
    // The files, canvas chips and screen chips that rode this bubble now point at the row
    // that carried them (Phase-1 §7 debt: `turn_artifacts.delivery_id`).
    if (deliveryId) linkArtifactsToDelivery(agentId, currentTurnNumber.get(agentId) ?? null, deliveryId);
    return deliveryId;
  } catch (err) {
    logger.warn('dashboard delivery record failed (the bubble itself is unaffected)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
