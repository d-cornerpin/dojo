// The outbound scope: a caller opens a scope declaring identity (who sends, for whom, on which channel, into which
// conversation); the transport door records the outcome it observed (`recordAtDoor`). An unscoped crossing still
// records, as `PLATFORM_SENDER`. One scope is one row, written when the send ends; crossings fold in, failure wins. The scope rides
// AsyncLocalStorage (as `runWithToolCallId` does) because a per-agent slot is overwritten by a concurrent batch.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { channelOfSendTool, PLATFORM_SENDER, type WsEvent } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { asTurn, turnStamp, type TurnStamp } from '../turn-context.js';
import { recordDelivery, type DeliveryInput } from './deliveries.js';
import { deliveryIdOf, recordedId, type LedgerOutcome } from './delivery-outcome.js';
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
}

/** What a door observed. The door owns the outcome; the rest are fallbacks for what the scope did not declare. */
export interface DoorObservation {
  outcome: DeliveryOutcome;
  channel: DeliveryChannel;
  detail?: string | null;
  /** Fallbacks: for an unscoped crossing, and for what an open scope did not declare. */
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

const SEEN_KEYS = ['recipientId', 'recipientDisplay', 'provider', 'threadRoot', 'messageId'] as const;

interface OutboundScope {
  intent: OutboundIntent;
  /** The scope's one row: a queued reply's own row, or the row an ordinary send writes when it ends. */
  deliveryId: string;
  /** The first door's outcome; null while no door has been crossed. */
  outcome: DeliveryOutcome | null;
  /** What the doors saw, the first value of each kept. */
  seen: Partial<Record<typeof SEEN_KEYS[number], string | null>>;
  receiptId: string | null;
  failed: boolean;
  details: string[];
  /** The turn the send began in: its row is that turn's, however late the send ends. */
  stamp: TurnStamp;
}

/** The channel a send tool delivers on (the shared `channelOfSendTool`, `user_` twins included), or null when it
 *  reaches nobody. `send_to_agent` and `broadcast_to_group` return null: the A2A transport writes one row per
 *  peer, and a scope would fold a fan-out into one row. */
export function outboundChannelForTool(name: string): DeliveryChannel | null {
  // The delivery union's extra members (dashboard, voice, a2a) have no send tool, so the cast is exact.
  return channelOfSendTool(name) as DeliveryChannel | null;
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

/** The whole declaration the tool-dispatch door opens a scope with, or null for a tool that reaches nobody. */
export function outboundIntentForTool(
  agentId: string, name: string, args: Record<string, unknown> | undefined, conversationId: string | null,
): OutboundIntent | null {
  const channel = outboundChannelForTool(name);
  if (channel === null) return null;
  return { agentId, tool: name, channel, recipientId: outboundRecipientForTool(name, args), conversationId };
}

const outboundContext = new AsyncLocalStorage<OutboundScope>();

const newScope = (intent: OutboundIntent, deliveryId: string): OutboundScope =>
  ({ intent, deliveryId, outcome: null, seen: {}, receiptId: null, failed: false, details: [], stamp: turnStamp(intent.agentId) });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Run a send under a declared identity only if none is declared yet, so nested doors fold into one row and a
 *  caller's (or engine lane's) truer identity is never shadowed by a door's generic fallback. */
export function withOutboundAsyncIfAbsent<T>(intent: OutboundIntent, fn: () => Promise<T>): Promise<T> {
  if (outboundContext.getStore()) return fn();
  return withOutboundAsync(intent, fn);
}

/** Run a send under a declared identity. Its doors fold in; when it ends it writes one row with the verdict:
 *  none when no door was crossed and nothing threw (nothing was sent), `failed` when it threw. */
export async function withOutboundAsync<T>(intent: OutboundIntent, fn: () => Promise<T>): Promise<T> {
  const scope = newScope(intent, randomUUID());
  let out: T;
  try {
    out = await outboundContext.run(scope, fn);
  } catch (err) {
    writeScopeRow(scope, finish(scope, { ok: false, detail: messageOf(err) }));
    throw err;
  }
  if (scope.outcome !== null) writeScopeRow(scope, finish(scope, { ok: true }));
  return out;
}

/** One try's verdict, folded from what the send function said and every door it crossed: failure wins. */
export interface FoldedVerdict {
  delivered: boolean;
  /** The refusal will not change, so the try is not worth repeating. */
  final: boolean;
  detail: string | null;
  receiptId: string | null;
}

function finish(scope: OutboundScope, said: { ok: boolean; final?: boolean; detail?: string | null }): FoldedVerdict {
  if (!said.ok) scope.failed = true;
  if (said.detail) scope.details.push(said.detail);
  const detail = scope.details.length > 0 ? scope.details.join('; ').slice(0, 500) : null;
  return { delivered: !scope.failed, final: !said.ok && said.final === true, detail, receiptId: scope.receiptId };
}

/** An ordinary send's one row: the declared identity first, what the doors saw for the rest. */
function writeScopeRow(scope: OutboundScope, v: FoldedVerdict): void {
  const { intent: i, seen } = scope;
  recordedId(asTurn(i.agentId, scope.stamp, () => recordDelivery({
    id: scope.deliveryId, agentId: i.agentId, tool: i.tool, channel: i.channel,
    recipientId: i.recipientId ?? seen.recipientId ?? null,
    recipientDisplay: i.recipientDisplay ?? seen.recipientDisplay ?? null,
    provider: i.provider ?? seen.provider ?? null,
    threadRoot: i.threadRoot ?? seen.threadRoot ?? null,
    messageId: i.messageId ?? seen.messageId ?? null,
    conversationId: i.conversationId ?? null, receiptId: v.receiptId,
    outcome: v.delivered && scope.outcome !== null ? scope.outcome : 'failed', detail: v.detail,
  })), `${i.tool}: the send's row`, { agentId: i.agentId });
}

/** One try of a queued reply, in a scope that adopts its row: no door writes a row, `finish` gives the one verdict. */
export async function withAdoptedOutbound(
  row: { id: string; agentId: string; channel: DeliveryChannel },
  send: () => Promise<{ ok: boolean; final?: boolean; detail?: string | null }>,
): Promise<FoldedVerdict> {
  const scope = newScope({ agentId: row.agentId, tool: 'auto-route', channel: row.channel }, row.id);
  try {
    return finish(scope, await outboundContext.run(scope, send));
  } catch (err) {
    return finish(scope, { ok: false, detail: messageOf(err) });
  }
}

/** A transport door reports what it observed. Inside a scope the crossing folds into the scope's one row, written
 *  when the send ends; outside one it writes a standalone row, as `PLATFORM_SENDER` unless the door knows the agent. */
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
  scope.outcome ??= observed.outcome;
  for (const k of SEEN_KEYS) scope.seen[k] ??= observed[k] ?? null;
  scope.receiptId ??= observed.receiptId ?? null;
  return { kind: 'no_change', reason: 'folded-into-open-scope', deliveryId: scope.deliveryId, detail: 'a crossing of an open send, recorded when the send ends' };
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
 *  scope's send; it lands on the scope's row with the verdict. */
export function noteReceiptForOutbound(receiptId: string): void {
  const scope = outboundContext.getStore();
  if (scope) scope.receiptId = receiptId;
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
      conversationId: turnStamp(agentId).root?.conversationId ?? null,
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
