// One writer for the deliveries table: every outbound send is one row carrying who, where and why.
// The prose "[Reply routed via X]" marker stays as chat transparency; readers key on these rows.
// Best-effort by contract: a record must never break the delivery it records; failures answer `failed`.
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { asTurn, turnStamp, type TurnRoot } from '../turn-context.js';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { noSuchWorkDetail } from '../../work/store.js';
import { asksAnsweredBy, settleAsksForDelivery } from '../../work/ask-settlement.js';
import { afterCommit, withUnit } from '../../db/unit.js';
import { isMidTry, pillLabel, writeRoutingPill, type ReplyAddress } from './channel-sender.js';
import { withRoutingState } from '@dojo/shared';
import { deliveryIdOf, type LedgerOutcome } from './delivery-outcome.js';
export { deliveryIdOf, recordedId, type LedgerOutcome } from './delivery-outcome.js';

const logger = createLogger('deliveries');

export interface DeliveryInput {
  /** The row's id, when the caller named it before the send (an outbound scope). */
  id?: string;
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
  /** `owner_closed` is NOT a send and never claims to be one; `pending` is a queued reply the sender has
   *  not finished (`resolvePendingDelivery` below). */
  outcome: 'delivered' | 'suppressed' | 'failed' | 'held' | 'owner_closed' | 'pending';
  detail?: string | null;
  /** Explicit conversation identity: pass it (the turn's own conversation) and nothing resolves;
   *  omit for cross-conversation sends, where channel + recipient resolve the row. */
  conversationId?: string | null;
  /** A queued reply's words and address, or a relay's request (`joinId`); a `pending` row with one is the sender's. */
  payload?: Record<string, unknown> | null;
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
    const id = input.id ?? uuidv4();
    return withUnit((): LedgerOutcome => {
      const conversationId = conversationFor(input);
      const { turnNumber, root } = turnStamp(input.agentId);
      db.prepare(`
        INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, recipient_display,
                                conversation_id, root_kind, root_id, message_id, receipt_id, outcome, detail, payload_json,
                                next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        id,
        input.agentId,
        turnNumber,
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
        input.payload ? JSON.stringify(input.payload) : null,
        input.payload && input.outcome === 'pending' ? Date.now() : null,
      );
      // The close happens where a delivery becomes a row; `work/ask-settlement.ts` decides it, in the unit.
      settleAsksForDelivery({
        agentId: input.agentId,
        turnNumber,
        deliveryId: id,
        conversationId,
        tool: input.tool,
        outcome: input.outcome,
        joinId: typeof input.payload?.joinId === 'string' ? input.payload.joinId : null,
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

/** A start line ("on it") is tried once and never an answer; what follows an early answer (download links, a later
 *  caption, files) goes like a reply but is never the answer; the cannot-run line is never an answer and never goes
 *  to another Dojo's agent. Each kind is recorded under its own tool. */
const REPLY_TOOL = { reply: 'auto-route', 'start-line': 'engine-ack', 'download-links': 'download-links', 'cannot-run': 'cannot-run' } as const;
export type ReplyKind = keyof typeof REPLY_TOOL;

/** A reply for a person's channel, with the turn and request that wrote it (never the agent's live turn). */
export interface QueuedReply {
  agentId: string;
  turnNumber: number | null;
  root: TurnRoot | null;
  text: string;
  address: ReplyAddress;
  /** What the row is; omitted, the reply. */
  kind?: ReplyKind;
  /** A Dojo line about a delegated request: the helper's `answer` (empty for a notice), the request, the hand-in it reports. */
  relay?: { tool: string; answer: string; joinId: string; reports: string | null };
  /** Paths of files sent after the words; only iMessage carries files. */
  files?: string[];
}

/** The one place a reply is queued for the sender: cleaned, written `pending` and due now, and the sender woken.
 *  Another Dojo's agent gets a helper's answer bare and no Dojo notice: that row is written `held`.
 *  Returns the row, or null when nothing is left to send or the row could not be written. */
export async function queueReply(r: QueuedReply): Promise<{ id: string; held: boolean } | null> {
  // Loaded on use: the credential registry and the sender sit above the ledger in the import graph.
  const { redactHandedCredentials } = await import('../../credentials/secret-fields.js');
  const { armOwedClock } = await import('./owed.js');
  const { announceLiveWork } = await import('../live-work.js');
  const bare = (r.relay !== undefined || r.kind === 'cannot-run') && r.address.toAgent === true;
  const text = redactHandedCredentials(r.agentId, bare ? r.relay?.answer ?? '' : r.text).trim();
  const held = bare && !text;
  const files = r.address.channel === 'imessage' ? r.files ?? [] : [];
  if (!text && !held && files.length === 0) return null;
  const label = await pillLabel(r.address, r.address.to);
  const { relay } = r;
  const id = deliveryIdOf(asTurn(r.agentId, { turnNumber: r.turnNumber, root: r.root, convKey: null }, () => recordDelivery({
    agentId: r.agentId, tool: relay?.tool ?? REPLY_TOOL[r.kind ?? 'reply'], channel: r.address.channel,
    recipientId: r.address.to, conversationId: r.root?.conversationId ?? null, outcome: held ? 'held' : 'pending',
    detail: held ? 'a Dojo notice is never sent to another Dojo\'s agent' : null,
    payload: { text, address: r.address, ...(files.length > 0 ? { files } : {}), ...(relay ? { joinId: relay.joinId, reports: relay.reports } : {}) },
  })));
  if (id === null) return null;
  await writeRoutingPill(r.agentId, r.turnNumber, held ? withRoutingState(label, 'not sent', 'another Dojo\'s agent') : withRoutingState(label, 'sending'));
  if (!held) {
    announceLiveWork(r.agentId);
    armOwedClock();
  }
  return { id, held };
}

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

// The sender's verdict on a queued reply; null when no pending row of that id stands.
export function resolvePendingDelivery(id: string, seen: DoorVerdict): LedgerOutcome | null {
  try {
    const db = getDb();
    return withUnit((): LedgerOutcome | null => {
      const row = db.prepare(
        `SELECT agent_id, turn_number, tool, channel, recipient_id, recipient_display, conversation_id,
                CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.joinId') END AS join_id
           FROM deliveries WHERE id = ? AND outcome = 'pending'`,
      ).get(id) as {
        agent_id: string; turn_number: number | null; tool: string; channel: DeliveryInput['channel'];
        recipient_id: string | null; recipient_display: string | null; conversation_id: string | null; join_id: string | null;
      } | undefined;
      if (!row) return null;
      const recipientId = row.recipient_id ?? seen.recipientId ?? null;
      const recipientDisplay = row.recipient_display ?? seen.recipientDisplay ?? null;
      // A queued row with no conversation takes it from the address the verdict names.
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
        tool: row.tool, outcome: seen.outcome, joinId: row.join_id,
      });
      return { kind: 'applied', value: { deliveryId: id } };
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('resolvePendingDelivery failed (non-fatal; the delivery itself is unaffected)', { id, error: detail });
    return { kind: 'failed', reason: 'ledger-write-failed', detail };
  }
}

/** Stop: each reply of the agent still waiting to go (only those for the asks `roots`, when given), except one
 *  mid-send, ends `suppressed`. Synchronous, so the caller ends the requests in the same transaction; returns those
 *  requests (the asks each reply answered). */
export function suppressQueuedReplies(agentId: string, roots?: string[]): { repliesNotSent: number; askIds: string[] } {
  const rows = getDb().prepare(
    `SELECT id, turn_number, conversation_id, payload_json FROM deliveries WHERE agent_id = @agentId AND outcome = 'pending' AND payload_json IS NOT NULL
       AND (@roots IS NULL OR 'ask:' || root_id IN (SELECT value FROM json_each(@roots)) OR json_extract(payload_json, '$.joinId') IN (SELECT value FROM json_each(@roots)))
     ORDER BY rowid`,
  ).all({ agentId, roots: roots ? JSON.stringify(roots) : null }) as Array<{ id: string; turn_number: number | null; conversation_id: string | null; payload_json: string }>;
  const askIds = new Set<string>();
  let repliesNotSent = 0;
  for (const row of rows) {
    if (isMidTry(row.id) || resolvePendingDelivery(row.id, { outcome: 'suppressed', detail: 'stopped by the owner' })?.kind !== 'applied') continue;
    repliesNotSent++;
    if (row.turn_number !== null && row.conversation_id !== null) {
      for (const id of asksAnsweredBy(agentId, row.turn_number, row.conversation_id)) askIds.add(id);
    }
    let parsed: { address?: ReplyAddress; joinId?: string } = {};
    try { parsed = JSON.parse(row.payload_json) as typeof parsed; } catch { /* unreadable: still dropped, with no mark */ }
    // A relay answers its delegated request.
    if (parsed.joinId) askIds.add(parsed.joinId);
    const { address } = parsed;
    if (!address) continue;
    afterCommit(() => void pillLabel(address, address.to).catch(() => address.channel)
      .then((label) => writeRoutingPill(agentId, row.turn_number, withRoutingState(label, 'not sent', 'stopped by you'))));
  }
  return { repliesNotSent, askIds: [...askIds] };
}
