// The outbound scope: a caller opens a scope declaring identity (who sends, for whom, on which channel, into which
// conversation); the transport door records the outcome it observed (`recordAtDoor`). An unscoped crossing still
// records, as `PLATFORM_SENDER`. One scope is one row: later crossings update it, and failure wins. The scope rides
// AsyncLocalStorage (as `runWithToolCallId` does) because a per-agent slot is overwritten by a concurrent batch.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channelOfSendTool, PLATFORM_SENDER, type WsEvent } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { turnContext } from '../turn-context.js';
import { recordDelivery, resolvePendingDelivery, dropPendingDelivery, type DeliveryInput } from './deliveries.js';
import { deliveryIdOf, type LedgerOutcome } from './delivery-outcome.js';
export { recordedId, deliveryIdOf } from './delivery-outcome.js';

const logger = createLogger('outbound');

export type DeliveryChannel = DeliveryInput['channel'];
export type DeliveryOutcome = DeliveryInput['outcome'];

/** `deliveries.agent_id` is NOT NULL with no foreign key, and every agent-scoped reader filters by a real agent id, so
 *  rows from `PLATFORM_SENDER` are counted and never masquerade as an agent's own traffic. */
export { PLATFORM_SENDER };

/** What a caller declares before a send. Everything here is identity; nothing is evidence. */
export interface OutboundIntent {
  agentId: string;
  /** The tool or engine lane performing the send (`imessage_send`, `auto-route`, `engine-ack`, ...). */
  tool: string;
  channel: DeliveryChannel;
  recipientId?: string | null;
  recipientDisplay?: string | null;
  provider?: string | null;
  threadRoot?: string | null;
  /** Explicit conversation identity; omitted, `recordDelivery` resolves it from the channel and recipient. */
  conversationId?: string | null;
  messageId?: string | null;
  /** What is being sent, as the person would read it; kept on an outside send's intent row. */
  text?: string | null;
}

/** What a door observed. The door owns the outcome; the rest are fallbacks for a crossing outside any scope. */
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
  /** The receipt the door's executor wrote, for an unscoped crossing (a scope links its own through
   *  `noteReceiptForOutbound`); it is how a ledger send names the message it delivered. */
  receiptId?: string | null;
}

interface OutboundScope {
  intent: OutboundIntent;
  deliveryId: string | null;
  receiptId: string | null;
  failed: boolean;
  /** `deliveryId` is still the INTENT row: no door has said what happened yet. */
  pending: boolean;
  details: string[];
}

/** The channel a send tool delivers on (from the shared `channelOfSendTool` map), or null when it reaches nobody.
 *  `user_` twins run the base tool's executor, so they take its channel. `send_to_agent` and `broadcast_to_group`
 *  return null: the A2A transport writes one row per peer, and a scope would fold a fan-out into one row. */
export function outboundChannelForTool(name: string): DeliveryChannel | null {
  const base = name.startsWith('user_') ? name.slice('user_'.length) : name;
  if (base === 'teams_send_channel_message') return 'teams';
  const ch = channelOfSendTool(base);
  if (ch === null) return null;
  // The delivery union's extra members (dashboard, voice, a2a) have no send tool, so the cast is exact.
  return ch as DeliveryChannel;
}

/** The recipient a send tool named, for `recipient_id`; a missing or reply-shaped argument leaves it null. */
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

/** The words a send tool puts in front of the person, for the intent row. Best-effort, like the recipient. */
export function outboundTextForTool(args: Record<string, unknown> | undefined): string | null {
  for (const k of ['message', 'body', 'text', 'content']) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The whole declaration the tool-dispatch door opens a scope with, or null for a tool that reaches nobody. */
export function outboundIntentForTool(
  agentId: string, name: string, args: Record<string, unknown> | undefined, conversationId: string | null,
): OutboundIntent | null {
  const channel = outboundChannelForTool(name);
  if (channel === null) return null;
  return { agentId, tool: name, channel, recipientId: outboundRecipientForTool(name, args), conversationId, text: outboundTextForTool(args) };
}

const outboundContext = new AsyncLocalStorage<OutboundScope>();

/** An outside channel: a transport the process can die inside after the person already has the words. */
const OUTSIDE_CHANNELS: ReadonlySet<DeliveryChannel> = new Set(['imessage', 'sms', 'email', 'teams', 'phone']);

/** A new scope; on an outside channel its row is written FIRST, as the intent (`pending`, with the text). */
function newScope(intent: OutboundIntent): OutboundScope {
  const scope: OutboundScope = { intent, deliveryId: null, receiptId: null, failed: false, details: [], pending: false };
  if (!OUTSIDE_CHANNELS.has(intent.channel)) return scope;
  scope.deliveryId = deliveryIdOf(recordDelivery({ ...declared(intent), outcome: 'pending', detail: intent.text?.slice(0, 500) ?? null }));
  scope.pending = scope.deliveryId !== null;
  return scope;
}

function declared(i: OutboundIntent): Omit<DeliveryInput, 'outcome'> {
  return {
    agentId: i.agentId, tool: i.tool, channel: i.channel, recipientId: i.recipientId ?? null,
    recipientDisplay: i.recipientDisplay ?? null, provider: i.provider ?? null, threadRoot: i.threadRoot ?? null,
    conversationId: i.conversationId ?? null, messageId: i.messageId ?? null,
  };
}

function mergedDetail(scope: OutboundScope): string | null {
  if (scope.details.length === 0) return null;
  return scope.details.join('; ').slice(0, 500);
}

/** Push the scope's verdict onto its row. Only ever downgrades: a failure makes it `failed`, otherwise the
 *  door's own outcome stands, so settle can never turn a failed send back into a delivered one. */
function settle(scope: OutboundScope): void {
  if (!scope.deliveryId) return;
  // The scope ended with no door crossed: nothing was sent, so the intent row is dropped.
  if (scope.pending) { dropPendingDelivery(scope.deliveryId); scope.deliveryId = null; scope.pending = false; return; }
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

function markFailed(scope: OutboundScope, reason: string): void {
  scope.failed = true;
  if (reason) scope.details.push(reason);
  scope.pending = false;                 // a throw is a verdict: the intent row becomes `failed` below
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
    // The send threw before reaching any transport: still an attempted outbound, recorded as failed so the
    // ledger never holds only the sends that worked.
    scope.deliveryId = deliveryIdOf(recordDelivery({
      ...declared(scope.intent), receiptId: scope.receiptId, outcome: 'failed', detail: mergedDetail(scope),
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

/** Run a send under a declared identity only if none is declared yet, so nested doors fold into one row and a
 *  caller's (or engine lane's) truer identity is never shadowed by a door's generic fallback. */
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

/** A transport door reports what it observed. In a scope the first crossing writes the row and later ones
 *  fold into it; outside one it writes a standalone row, as `PLATFORM_SENDER` unless the door knows the agent. */
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
      receiptId: observed.receiptId ?? null,
      outcome: observed.outcome,
      detail: observed.detail ?? null,
    });
  }

  if (observed.outcome === 'failed') scope.failed = true;
  if (observed.detail) scope.details.push(observed.detail);
  if (scope.pending && scope.deliveryId) {
    // The FIRST crossing of an outside send: the intent becomes what this door observed.
    scope.pending = false;
    const seen = resolvePendingDelivery(scope.deliveryId, {
      outcome: scope.failed ? 'failed' : observed.outcome as Exclude<DeliveryOutcome, 'pending'>, detail: mergedDetail(scope),
      messageId: observed.messageId, recipientId: observed.recipientId, recipientDisplay: observed.recipientDisplay,
      provider: observed.provider, threadRoot: observed.threadRoot, receiptId: scope.receiptId,
    });
    if (seen !== null) return seen;
    scope.deliveryId = null;             // the intent row is gone; write the door's row fresh below
  }

  if (scope.deliveryId) {
    // A later crossing may know more (message row, resolved address): fill blanks, never overwrite a fact.
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
    // One send, one row: this crossing enriched the row the first wrote, so nothing new was recorded.
    return { kind: 'no_change', reason: 'folded-into-open-scope', deliveryId: scope.deliveryId, detail: 'a later crossing of a send already recorded by this scope' };
  }

  const written = recordDelivery({
    agentId: scope.intent.agentId,
    tool: scope.intent.tool,
    // The scope's declared channel stands even when a door crosses on another (a caption riding an attachment).
    channel: scope.intent.channel,
    recipientId: scope.intent.recipientId ?? observed.recipientId ?? null,
    recipientDisplay: scope.intent.recipientDisplay ?? observed.recipientDisplay ?? null,
    provider: scope.intent.provider ?? observed.provider ?? null,
    threadRoot: scope.intent.threadRoot ?? observed.threadRoot ?? null,
    conversationId: scope.intent.conversationId ?? null,
    messageId: scope.intent.messageId ?? observed.messageId ?? null,
    receiptId: scope.receiptId ?? observed.receiptId ?? null,
    outcome: scope.failed ? 'failed' : observed.outcome,
    detail: mergedDetail(scope),
  });
  scope.deliveryId = deliveryIdOf(written);
  return written;
}

/** A `held` outcome has no door to observe it (no transport was reached: the settled-context hold), so it is
 *  recorded directly through this named entry point. */
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

/** Links the receipt `writeToolReceipt` (receipts/store.ts, sole writer of `tool_receipts`) wrote for this
 *  scope's send. Order-independent: a receipt seen before the door crossing is held and lands on the row later. */
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
  const scope = outboundContext.getStore();
  return scope && !scope.pending ? scope.deliveryId : null;   // an intent is not yet a delivery
}

/** True when a send is in flight under a declared identity. Read by the provider-API doors,
 *  which carry both person-reaching sends and ordinary data writes down the same function. */
export function inOutboundScope(): boolean {
  return outboundContext.getStore() !== undefined;
}

// The dashboard door: an owner-lane assistant `chat:message` is the product's most common delivery. It runs
// after the broadcast seam stamps the persisted row and reads only what that seam attached; a chunk, a marker, an
// unpersisted emission or peer traffic is not a delivery (each clause has a negative control in
// __tests__/universal-deliveries.test.ts). Idempotent by message id: a re-emitted bubble is not a second delivery.
export function recordDashboardDelivery(event: WsEvent): string | null {
  try {
    if (event.type !== 'chat:message') return null;
    const msg = event.message;
    if (!msg || msg.role !== 'assistant') return null;
    const agentId = event.agentId;
    if (!agentId) return null;

    // The seam already looked the row up: `row` present means persisted, and it carries the lane.
    const row = event.row;
    if (!row || row.lane !== 'owner') return null;

    const db = getDb();
    const already = db.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND channel = 'dashboard' AND message_id = ?`,
    ).get(agentId, msg.id) as { id: string } | undefined;
    if (already) return already.id;

    // Returns `string | null`: the early returns answer "is this event a delivery at all?", not "was it recorded".
    const deliveryId = deliveryIdOf(recordDelivery({
      agentId,
      tool: 'dashboard',
      channel: 'dashboard',
      recipientId: 'owner',
      messageId: msg.id,
      // The turn's own conversation; outside a turn (a boot notice) the resolver supplies it.
      conversationId: turnContext(agentId)?.root?.conversationId ?? null,
      outcome: 'delivered',
    }));
    return deliveryId;
  } catch (err) {
    logger.warn('dashboard delivery record failed (the bubble itself is unaffected)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
