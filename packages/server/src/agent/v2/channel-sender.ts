// The one sender of queued replies to a person's channel (iMessage, SMS, email, Teams). A conversation's rows go
// oldest first and a waiting row holds the ones behind it. Each try runs in a scope that adopts its row and declares
// the row's own turn; its verdict is written on that row: delivered, due again after a wait, or failed for good.
// The ledger, the transports and their lookups load on use: this module sits under the live-work reader.
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { formatRoutingMarker, withRoutingState, type InboundMeta } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
import { asTurn, type TurnRoot } from '../turn-context.js';
import { announceLiveWork } from '../live-work.js';
import type { FoldedVerdict } from './outbound.js';
import type { RefusalKind } from '../dojo-voice.js';

const logger = createLogger('channel-sender');

/** Where a reply goes. An iMessage with no `to` goes to the owner, looked up when it is sent. `toAgent`: the
 *  recipient is another Dojo's agent. */
export type ReplyAddress = (
  | { channel: 'imessage'; to: string | null }
  | { channel: 'sms'; to: string; from: string | null }
  | { channel: 'email'; to: string | null; messageId: string; service: 'gmail' | 'outlook' | null; account: string | null; fromOwner: boolean }
  | { channel: 'teams'; to: string | null; chatId: string; account: string | null }
) & { toAgent?: true };

/** The waits after each failed try: five tries, the last about 43 minutes after the first. */
const WAITS_MS = [30_000, 120_000, 600_000, 1_800_000];
/** A try the process died inside is due again this long after it began. */
const LEASE_MS = 600_000;
/** A start line goes on its first try within this long of being written, or not at all. */
const START_LINE_FRESH_MS = 60_000;

const midTry = new Set<string>();

/** A verdict with the kind of refusal the sender found before any send, which the owner and the agent are told. */
type Verdict = FoldedVerdict & { refusal?: RefusalKind };

interface QueuedRow {
  id: string; agent_id: string; tool: string; turn_number: number | null; root_kind: string | null; root_id: string | null;
  conversation_id: string | null; attempts: number; next_attempt_at: number; payload_json: string;
}

/** The address of a reply to a request, from its inbound record or the turn's inbound context (same keys). */
export function replyAddressFor(meta: Omit<Partial<InboundMeta>, 'channel'> & { channel: string }): ReplyAddress | null {
  const a = channelAddress(meta);
  return a && meta.senderIsAgent ? { ...a, toAgent: true } : a;
}

function channelAddress(meta: Omit<Partial<InboundMeta>, 'channel'> & { channel: string }): ReplyAddress | null {
  const to = meta.recipientAddress ?? meta.sender ?? null;
  switch (meta.channel) {
    case 'imessage': return { channel: 'imessage', to: meta.sender ?? null };
    case 'sms': {
      const sms = meta.smsFromNumber ?? meta.sender;
      return sms ? { channel: 'sms', to: sms, from: meta.smsToNumber ?? null } : null;
    }
    case 'email': return meta.emailMessageId
      ? { channel: 'email', to, messageId: meta.emailMessageId, service: meta.emailService ?? null, account: meta.emailAccount ?? null, fromOwner: meta.relation === 'owner' }
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
    case 'imessage': {
      // An owner-bound reply names the owner now, so its waiting, sent and stopped marks read alike.
      const who = to ?? (await import('../../services/imessage-bridge.js')).getDefaultSender();
      return `iMessage to ${who ? resolveRecipientDisplay('imessage', who) : 'the owner'}`;
    }
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
    broadcast({
      type: 'chat:message', agentId,
      message: { id, agentId, role: 'system' as const, content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
    });
  } catch (err) {
    // The pill describes a send; it never breaks one.
    logger.warn('routing pill not written', { agentId, label, error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

export function isMidTry(rowId: string): boolean {
  return midTry.has(rowId);
}

export interface WaitingReply { channel: ReplyAddress['channel']; recipient: string | null; createdAt: string }

/** Replies of this agent still waiting to go out, newest first. */
export function pendingReplies(agentId: string): WaitingReply[] {
  try {
    return getDb().prepare(
      `SELECT channel, COALESCE(recipient_display, recipient_id) AS recipient, created_at AS createdAt FROM deliveries
        WHERE agent_id = ? AND outcome = 'pending' AND payload_json IS NOT NULL ORDER BY rowid DESC`,
    ).all(agentId) as WaitingReply[];
  } catch { return []; }
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

/** Tries every reply due at `now`: each conversation's rows in the order written, stopping at its first failure. */
export async function deliverDueReplies(now: number): Promise<void> {
  // A try's lease and wait run from when it starts: `now` plus the time this pass has already spent.
  const passStartedAt = Date.now();
  try {
    const rows = getDb().prepare(
      `SELECT id, agent_id, tool, turn_number, root_kind, root_id, conversation_id, attempts, next_attempt_at, payload_json
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
        const startsAt = now + Date.now() - passStartedAt;
        if (row.next_attempt_at > startsAt || !(await tryOnce(row, startsAt))) return;
      }
    }));
  } catch (err) {
    logger.error('a pass of the reply sender failed', { error: err instanceof Error ? err.message : String(err) });
  }
  (await import('./owed.js')).armOwedClock();
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
    const payload = parsedPayload(row);
    let to: string | null = null;
    let verdict: Verdict;
    // Anything that throws before or around the send is a failed try like any other, so it counts toward the five.
    try {
      if (!payload) throw new Error('the queued reply cannot be read');
      to = payload.address.channel === 'imessage' && payload.address.to === null
        ? (await import('../../services/imessage-bridge.js')).getDefaultSender()
        : payload.address.to;
      verdict = row.tool === 'engine-ack' && now - row.next_attempt_at > START_LINE_FRESH_MS
        ? { delivered: false, final: true, detail: 'a start line goes within a minute or not at all', receiptId: null }
        : await sendAsItsTurn(row, payload, to);
    } catch (err) {
      verdict = { delivered: false, final: false, detail: err instanceof Error ? err.message : String(err), receiptId: null };
    }
    return await recordVerdict(row, payload?.address ?? null, to, verdict, now);
  } finally {
    midTry.delete(row.id);
    announceLiveWork(row.agent_id);
  }
}

interface Payload { text: string; address: ReplyAddress; files?: string[] }

function parsedPayload(row: QueuedRow): Payload | null {
  try { return JSON.parse(row.payload_json) as Payload; } catch { return null; }
}

/** The check and the send, stamped with the row's own turn and request. The words go first, then the files. */
function sendAsItsTurn(row: QueuedRow, payload: Payload, to: string | null): Promise<Verdict> {
  const root: TurnRoot | null = row.root_kind && row.root_id
    ? { kind: row.root_kind as TurnRoot['kind'], id: row.root_id, sourceMessageId: null, conversationId: row.conversation_id }
    : null;
  return asTurn(row.agent_id, { turnNumber: row.turn_number, root, convKey: null }, async (): Promise<Verdict> => {
    const refused = await refusalOf(row.agent_id, payload.address, to);
    if (refused !== null || to === null) return { delivered: false, final: true, detail: refused?.detail ?? null, receiptId: null, refusal: refused?.kind };
    const { withAdoptedOutbound } = await import('./outbound.js');
    const adopted = { id: row.id, agentId: row.agent_id, channel: payload.address.channel };
    const files = payload.files ?? [];
    const words = payload.text || files.length === 0
      ? await withAdoptedOutbound(adopted, () => sendBy(row.agent_id, payload.text, payload.address, to)) : null;
    if (words && (!words.delivered || files.length === 0)) return words;
    const missed = await sendFiles(adopted, to, files);
    const detail = missed.length > 0 ? `not sent: ${missed.join(', ')}` : null;
    // A reply of files alone that sent nothing is a failed try like any other, so it is tried again.
    const anyWent = words !== null || missed.length < files.length;
    // What follows an early answer is not an answer, so no undelivered notice follows it: its files are told here at its last try.
    const lastTry = row.attempts + 1 > WAITS_MS.length;
    if (detail && (anyWent || (lastTry && row.tool === 'download-links'))) await tellOfFilesNotSent(row.agent_id, to, missed);
    return { delivered: anyWent, final: anyWent, detail: [words?.detail, detail].filter(Boolean).join('; ') || null, receiptId: words?.receiptId ?? null };
  });
}

/** Each file in its own try after the words; returns the ones that did not go, with why. A file that does not go
 *  is final for that file: it never holds the row or sends the words again. A missing or too big file is not tried. */
async function sendFiles(adopted: { id: string; agentId: string; channel: ReplyAddress['channel'] }, to: string, files: string[]): Promise<string[]> {
  const { withAdoptedOutbound } = await import('./outbound.js');
  const { sendIMessageWithAttachment, iMessageFileRefusal } = await import('../../services/imessage-bridge.js');
  const missed: string[] = [];
  for (const file of files) {
    let why = iMessageFileRefusal(file);
    if (!why && !(await withAdoptedOutbound(adopted, async () => ({ ok: await sendIMessageWithAttachment(to, file) }))).delivered) {
      why = 'Messages could not send it';
    }
    if (why) missed.push(`${path.basename(file)} (${why})`);
  }
  return missed;
}

/** The words went but some files did not: the agent is woken to tell the person in its own words. */
async function tellOfFilesNotSent(agentId: string, to: string, missed: string[]): Promise<void> {
  const { tellAgentAndWake, requesterReachSentence } = await import('../wake-with-notice.js');
  await tellAgentAndWake({
    agentId, from: 'File delivery',
    brief: `your reply went, but these file(s) did not reach ${to} over iMessage: ${missed.join(', ')}. They are in the dashboard only. `
      + `Tell them so in your own words; do not tell them the files were sent. ${await requesterReachSentence(to)}`,
  });
}

/** The check before any send: the agent holds the channel, iMessage is switched on, the person is approved, an SMS
 *  has a number. Final if not. */
async function refusalOf(agentId: string, a: ReplyAddress, to: string | null): Promise<{ kind: RefusalKind; detail: string } | null> {
  const { engineMayRouteTo, engineRouteRefusalReason } = await import('../access/engine-route.js');
  const agent = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
  if (!agent || agent.status === 'terminated') return { kind: 'agent-ended', detail: 'the agent was ended' };
  if (!engineMayRouteTo(agentId, a.channel)) return { kind: 'no-grant', detail: engineRouteRefusalReason(a.channel) };
  if (a.channel === 'imessage' && !(await import('../../services/imessage-bridge.js')).isIMessageSwitchedOn()) {
    return { kind: 'imessage-off', detail: 'iMessage is switched off in Settings' };
  }
  const { mayAnswer } = await import('./channel-auth.js');
  const approved = to !== null && mayAnswer(a.channel, to, 'agent', a.channel === 'email' ? { emailService: a.service ?? undefined, fromOwner: a.fromOwner } : undefined);
  if (!approved) return { kind: 'not-approved', detail: `${to ?? 'the recipient'} is no longer on the approved list` };
  const noNumber = a.channel === 'sms' && !(a.from ?? (await import('../../twilio/auth.js')).getDefaultFromNumber());
  return noNumber ? { kind: 'no-from-number', detail: 'no number to send the SMS from' } : null;
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
    const res = await sendSms(to, text, a.from ?? getDefaultFromNumber() ?? '');
    if (!res.ok) return { ok: false, final: !!res.status && res.status >= 400 && res.status < 500 && res.status !== 429, detail: res.error };
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

async function recordVerdict(row: QueuedRow, address: ReplyAddress | null, to: string | null, v: Verdict, now: number): Promise<boolean> {
  const attempts = row.attempts + 1;
  // A start line gets one try: after a wait it would arrive late, perhaps after the answer.
  if (!v.delivered && !v.final && row.tool !== 'engine-ack' && attempts <= WAITS_MS.length) {
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
  // Null: the row already ended elsewhere (a restarted sender resent it after the lease); that verdict stands.
  if (written === null) return false;
  if (written.kind === 'failed') {
    // The row stays pending under its lease and is tried again when it ends.
    logger.error('a reply\'s verdict could not be recorded', { deliveryId: row.id, turnNumber: row.turn_number, conversationId: row.conversation_id, error: written.detail }, row.agent_id);
    return false;
  }
  const label = address ? await pillLabel(address, to).catch(() => address.channel) : 'its channel';
  if (v.delivered) {
    await writeRoutingPill(row.agent_id, row.turn_number, label);
    return true;
  }
  logger.error('a reply could not be delivered', { deliveryId: row.id, attempts, reason: v.detail }, row.agent_id);
  const { plainWhy, tellOfUndeliveredReply } = await import('../dojo-voice.js');
  const why = plainWhy(v.refusal, address?.channel);
  await writeRoutingPill(row.agent_id, row.turn_number, withRoutingState(label, 'not delivered', why));
  // Telling the owner and the agent never undoes or blocks the verdict.
  try { tellOfUndeliveredReply(row.id, label, why); } catch (err) {
    logger.warn('an undelivered reply was not told', { deliveryId: row.id, error: err instanceof Error ? err.message : String(err) }, row.agent_id);
  }
  return false;
}
