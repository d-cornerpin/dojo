// The one sender of queued replies to a person's channel (iMessage, SMS, email, Teams). A conversation's rows go
// oldest first and a waiting row holds the ones behind it. Each try runs in a scope that adopts its row and declares
// the row's own turn; its verdict is written on that row: delivered, due again after a wait, or failed for good.
// The ledger, the transports and their lookups load on use: this module sits under the live-work reader.
import { v4 as uuidv4 } from 'uuid';
import { formatRoutingMarker, type InboundMeta } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
import { asTurn, type TurnRoot } from '../turn-context.js';
import { announceLiveWork } from '../live-work.js';
import type { FoldedVerdict } from './outbound.js';

const logger = createLogger('channel-sender');

/** Where a reply goes. An iMessage with no `to` goes to the owner, looked up when it is sent. */
export type ReplyAddress =
  | { channel: 'imessage'; to: string | null }
  | { channel: 'sms'; to: string; from: string | null }
  | { channel: 'email'; to: string | null; messageId: string; service: 'gmail' | 'outlook'; account: string | null }
  | { channel: 'teams'; to: string | null; chatId: string; account: string | null };

/** The waits after each failed try: five tries, the last about 43 minutes after the first. */
const WAITS_MS = [30_000, 120_000, 600_000, 1_800_000];
/** A try the process died inside is due again this long after it began. */
const LEASE_MS = 600_000;
const MAX_TIMER_MS = 2_147_483_647;

const midTry = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

interface QueuedRow {
  id: string; agent_id: string; turn_number: number | null; root_kind: string | null; root_id: string | null;
  conversation_id: string | null; attempts: number; next_attempt_at: number; payload_json: string;
}

/** The address of a reply to a request, from its inbound record or the turn's inbound context (same keys). */
export function replyAddressFor(meta: Partial<InboundMeta> & { channel: string }): ReplyAddress | null {
  const to = meta.recipientAddress ?? meta.sender ?? null;
  switch (meta.channel) {
    case 'imessage': return { channel: 'imessage', to: meta.sender ?? null };
    case 'sms': {
      const sms = meta.smsFromNumber ?? meta.sender;
      return sms ? { channel: 'sms', to: sms, from: meta.smsToNumber ?? null } : null;
    }
    case 'email': return meta.emailMessageId
      ? { channel: 'email', to, messageId: meta.emailMessageId, service: meta.emailService === 'gmail' ? 'gmail' : 'outlook', account: meta.emailAccount ?? null }
      : null;
    // A group chat never gets an engine reply; replies there are the agent's own sends.
    case 'teams': return meta.chatId && meta.chatType !== 'group'
      ? { channel: 'teams', to, chatId: meta.chatId, account: meta.teamsAccount ?? null }
      : null;
    default: return null;
  }
}

export async function pillLabel(a: ReplyAddress, to: string | null): Promise<string> {
  const { resolveRecipientDisplay } = await import('../../contacts/resolve-recipient.js');
  switch (a.channel) {
    case 'imessage': return `iMessage to ${to ? resolveRecipientDisplay('imessage', to) : 'the owner'}`;
    case 'sms': return `SMS to ${resolveRecipientDisplay('sms', a.to)}`;
    case 'email': return `email to ${to ? resolveRecipientDisplay('email', to) : 'the sender'}`;
    case 'teams': return `Teams to chat ${a.chatId.slice(0, 8)}…`;
  }
}

/** The one writer of the dashboard's routing pill, a `[Reply routed via <label>]` system row. Rows are only added. */
export async function writeRoutingPill(agentId: string, turnNumber: number | null, label: string): Promise<void> {
  const id = uuidv4();
  const content = formatRoutingMarker(label);
  try {
    const { insertMessageIfAbsent } = await import('../../memory/message-store.js');
    insertMessageIfAbsent({ id, agentId, role: 'system', content, turnNumber });
  } catch (err) {
    // The pill describes a send; it never breaks one.
    logger.warn('routing pill not written', { agentId, label, error: err instanceof Error ? err.message : String(err) }, agentId);
    return;
  }
  broadcast({
    type: 'chat:message', agentId,
    message: { id, agentId, role: 'system' as const, content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
  });
}

export function isMidTry(rowId: string): boolean {
  return midTry.has(rowId);
}

/** Replies of this agent still waiting to go out. */
export function pendingReplies(agentId: string): number {
  try {
    return (getDb().prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND outcome = 'pending' AND payload_json IS NOT NULL",
    ).get(agentId) as { n: number }).n;
  } catch { return 0; }
}

/** When the next reply can go: the earliest due time of the oldest waiting row of each conversation. */
export function nextReplyDueAt(): number | null {
  return (getDb().prepare(
    `SELECT MIN(d.next_attempt_at) AS due FROM deliveries d
      WHERE d.outcome = 'pending' AND d.payload_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM deliveries o
                         WHERE o.outcome = 'pending' AND o.payload_json IS NOT NULL
                           AND o.conversation_id = d.conversation_id AND o.rowid < d.rowid)`,
  ).get() as { due: number | null }).due;
}

/** The sender's one timer, set to the next due reply. Unref'd: it never holds the process open. */
export function armSenderTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  let due: number | null;
  try { due = nextReplyDueAt(); } catch { return; }
  if (due === null) return;
  timer = setTimeout(() => { timer = null; void deliverDueReplies(Date.now()); }, Math.min(Math.max(0, due - Date.now()), MAX_TIMER_MS));
  timer.unref?.();
}

/** Tries every reply due at `now`: each conversation's rows in the order written, stopping at its first failure. */
export async function deliverDueReplies(now: number): Promise<void> {
  try {
    const rows = getDb().prepare(
      `SELECT id, agent_id, turn_number, root_kind, root_id, conversation_id, attempts, next_attempt_at, payload_json
         FROM deliveries WHERE outcome = 'pending' AND payload_json IS NOT NULL ORDER BY rowid`,
    ).all() as QueuedRow[];
    const queues = new Map<string, QueuedRow[]>();
    for (const row of rows) {
      const key = row.conversation_id ?? row.id;
      queues.set(key, [...(queues.get(key) ?? []), row]);
    }
    await Promise.all([...queues.values()].map(async (queue) => {
      if (queue.some((row) => midTry.has(row.id))) return;
      for (const row of queue) {
        if (row.next_attempt_at > now || !(await tryOnce(row, now))) return;
      }
    }));
  } catch (err) {
    logger.error('a pass of the reply sender failed', { error: err instanceof Error ? err.message : String(err) });
  }
  armSenderTimer();
}

/** One try. The lease is taken first, so a row a crash leaves behind is due again only after it. True if delivered. */
async function tryOnce(row: QueuedRow, now: number): Promise<boolean> {
  const leased = getDb().prepare(
    `UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ?, updated_at = datetime('now')
      WHERE id = ? AND outcome = 'pending' AND next_attempt_at <= ?`,
  ).run(now + LEASE_MS, row.id, now).changes === 1;
  if (!leased) return false;
  midTry.add(row.id);
  try {
    const { text, address } = JSON.parse(row.payload_json) as { text: string; address: ReplyAddress };
    const root: TurnRoot | null = row.root_kind && row.root_id
      ? { kind: row.root_kind as TurnRoot['kind'], id: row.root_id, sourceMessageId: null, conversationId: row.conversation_id }
      : null;
    const to = address.channel === 'imessage' && address.to === null
      ? (await import('../../services/imessage-bridge.js')).getDefaultSender()
      : address.to;
    const verdict = await asTurn(row.agent_id, { turnNumber: row.turn_number, root, convKey: null }, async (): Promise<FoldedVerdict> => {
      const refusal = await refusalOf(row.agent_id, address, to);
      if (refusal !== null) return { delivered: false, final: true, detail: refusal, receiptId: null };
      const { withAdoptedOutbound } = await import('./outbound.js');
      return withAdoptedOutbound({ id: row.id, agentId: row.agent_id, channel: address.channel }, () => sendBy(row.agent_id, text, address, to!));
    });
    return await recordVerdict(row, await pillLabel(address, to), to, verdict, now);
  } finally {
    midTry.delete(row.id);
    announceLiveWork(row.agent_id);
  }
}

/** The check before any send: the agent still holds the channel and the person is still approved. Final if it fails. */
async function refusalOf(agentId: string, a: ReplyAddress, to: string | null): Promise<string | null> {
  const { engineMayRouteTo, engineRouteRefusalReason } = await import('../access/engine-route.js');
  if (!engineMayRouteTo(agentId, a.channel)) return engineRouteRefusalReason(a.channel);
  const { getSafeSenders, findSafeSenderByAddress } = await import('../../services/imessage-bridge.js');
  const { ownerMailboxes } = await import('../../services/owner-mailboxes.js');
  const { isSenderAuthorized } = await import('./channel-auth.js');
  const approved = to !== null && (
    a.channel === 'imessage' ? findSafeSenderByAddress(getSafeSenders(), to) !== null
    : (a.channel === 'email' && ownerMailboxes().some((mb) => mb.address === to.trim().toLowerCase()))
      || isSenderAuthorized(a.channel, to, 'agent', a.channel === 'email' ? { emailService: a.service } : undefined));
  return approved ? null : `${to ?? 'the recipient'} is no longer on the approved list`;
}

async function sendBy(agentId: string, text: string, a: ReplyAddress, to: string): Promise<{ ok: boolean; final?: boolean; detail?: string | null }> {
  const { writeToolReceipt } = await import('../../receipts/store.js');
  if (a.channel === 'imessage') {
    const { sendIMessage, stripSystemTags } = await import('../../services/imessage-bridge.js');
    const body = stripSystemTags(text);
    if (!body) return { ok: false, final: true, detail: 'nothing left to send' };
    const ok = await sendIMessage(to, body);
    // The bridge reports only the program's exit code, and the receipt says so.
    if (ok) writeToolReceipt({ agentId, tool: 'imessage_send', tier: 3, verified: false, basis: 'exit-code', recipient: to, sentText: body, detail: { route: 'auto', textLength: body.length } });
    return { ok };
  }
  if (a.channel === 'sms') {
    const { sendSms } = await import('../../twilio/client.js');
    const { getDefaultFromNumber } = await import('../../twilio/auth.js');
    const from = a.from ?? getDefaultFromNumber();
    if (!from) return { ok: false, final: true, detail: 'no number to send the SMS from' };
    const res = await sendSms(to, text, from);
    if (!res.ok) return { ok: false, detail: res.error };
    const sid = res.data.sid;
    writeToolReceipt({ agentId, tool: 'sms_send', tier: 1, verified: !!sid, basis: sid ? 'provider-id' : 'http-status', providerId: sid ?? null, recipient: to, sentText: text, detail: { route: 'auto', textLength: text.length } });
    return { ok: true };
  }
  const { executeTool } = await import('../tools/index.js');
  const call = a.channel === 'email'
    ? { name: a.service === 'gmail' ? 'gmail_reply' : 'outlook_reply', arguments: { message_id: a.messageId, body: text, ...(a.account ? { account: a.account } : {}) } }
    : { name: 'teams_send_message', arguments: { chat_id: a.chatId, message: text, ...(a.account ? { account: a.account } : {}) } };
  const o = await executeTool(agentId, { id: uuidv4(), ...call });
  if (o.kind === 'applied') return { ok: true };
  // A refusal will not change on its own, except a rate limit.
  return { ok: false, final: o.kind === 'refused' && o.result.errorCode !== 'RATE_LIMITED', detail: o.result.content.slice(0, 300) };
}

async function recordVerdict(row: QueuedRow, label: string, to: string | null, v: FoldedVerdict, now: number): Promise<boolean> {
  const attempts = row.attempts + 1;
  if (!v.delivered && !v.final && attempts <= WAITS_MS.length) {
    getDb().prepare(
      "UPDATE deliveries SET next_attempt_at = ?, detail = ?, updated_at = datetime('now') WHERE id = ? AND outcome = 'pending'",
    ).run(now + WAITS_MS[attempts - 1], v.detail, row.id);
    logger.warn('a reply did not go out; it will be tried again', { deliveryId: row.id, attempts, reason: v.detail }, row.agent_id);
    return false;
  }
  const { resolvePendingDelivery } = await import('./deliveries.js');
  const written = resolvePendingDelivery(row.id, {
    outcome: v.delivered ? 'delivered' : 'failed', detail: v.detail, recipientId: to, receiptId: v.receiptId,
  });
  if (written?.kind === 'failed') {
    // The row stays pending under its lease and is tried again when it ends.
    logger.error('a reply\'s verdict could not be recorded', { deliveryId: row.id, turnNumber: row.turn_number, conversationId: row.conversation_id, error: written.detail }, row.agent_id);
    return false;
  }
  if (v.delivered) {
    await writeRoutingPill(row.agent_id, row.turn_number, label);
    return true;
  }
  logger.error('a reply could not be delivered', { deliveryId: row.id, attempts, reason: v.detail }, row.agent_id);
  await writeRoutingPill(row.agent_id, row.turn_number, `not delivered by ${label}: ${v.detail ?? 'unknown reason'}`);
  return false;
}
