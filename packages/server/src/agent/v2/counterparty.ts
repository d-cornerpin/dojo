// ════════════════════════════════════════
// Turn Counterparty (attribution redesign, Phase 3)
//
// Every turn is a conversation with exactly ONE counterparty — the entity the
// agent is responding to. This module resolves that counterparty into a
// structured value and renders the explicit "who you're talking to" header the
// model anchors on, so it can never conflate the user with another agent or an
// engine event.
//
// Phase 3 computes + surfaces the counterparty and the header. Phase 4 uses the
// same counterparty to SCOPE the live conversation (fresh tail) down to it.
// ════════════════════════════════════════
import { deriveOrigin, type Channel, type Relation } from '@dojo/shared';
import { getOwnerName } from '../../config/platform.js';
import { getDb } from '../../db/connection.js';
// ── Counterparty serialization helper ──
// One source of truth (used by the loop to pick the turn's counterparty, the
// runtime to decide whether to re-trigger and drain, and the dev context-dump)
// for "which human conversations still have an unanswered message," in FIFO
// order. A conversation is WAITING when its latest inbound rowid is past the
// latest reply we've delivered for it. "Reply" = an own message stamped with
// that conversation's conv_key (migration 076) — a DB signal, so the waiting set
// survives a server restart (no in-memory served map to lose). Scoped to the
// current session. Engine events and A2A are not human conversations here.
export interface WaitingConversation {
  key: string;
  /** The conversation's LATEST message row (the trigger — answers multi-part together). */
  latest: {
    rowid: number; content: string; source: string | null; source_agent_id: string | null;
    a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
    inbound_meta: string | null; origin_kind: string | null; origin_intent: string | null; created_at: string;
  };
  oldestWaitingRowid: number;
}

export function getWaitingHumanConversations(agentId: string): WaitingConversation[] {
  const db = getDb();
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  const rows = db.prepare(
    `SELECT rowid, content, source, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_kind, origin_intent, created_at
       FROM messages WHERE agent_id = ? AND role = 'user' AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 25`,
  ).all(agentId, sessionStart) as WaitingConversation['latest'][];
  // Durable "served" signal: the latest rowid of an OWN message (assistant/tool)
  // tagged with each conversation's conv_key — i.e. the agent's reply for that
  // conversation. An inbound is answered when a reply for its conversation comes
  // AFTER it (higher rowid). Survives restart (it's read from the DB).
  const replyRows = db.prepare(
    `SELECT conv_key, MAX(rowid) AS maxReply FROM messages
       WHERE agent_id = ? AND conv_key IS NOT NULL AND created_at >= ? GROUP BY conv_key`,
  ).all(agentId, sessionStart) as Array<{ conv_key: string; maxReply: number }>;
  const lastReplyByConv = new Map(replyRows.map((r) => [r.conv_key, r.maxReply]));
  const agg = new Map<string, { latest: WaitingConversation['latest']; oldestWaitingRowid: number | null }>();
  for (const r of rows) {                              // newest → oldest by rowid
    const o = deriveOrigin({
      role: 'user', content: r.content, source: r.source, sourceAgentId: r.source_agent_id,
      a2aThreadId: r.a2a_thread_id, a2aIntent: r.a2a_intent, a2aRequiresResponse: r.a2a_requires_response,
      inboundMeta: r.inbound_meta, originKind: r.origin_kind, originIntent: r.origin_intent,
    });
    // The single "owes a reply" definition (see MESSAGE-ATTRIBUTION-REDESIGN §3):
    // a conversation the agent must answer is AUTHORIZED human inbound. Unauthorized
    // inbound (a mailbox notification about the owner's inbox, an unknown sender) is
    // Lane-3 awareness — the agent surfaces it to the owner, it never counts as a
    // waiting conversation. Skipping it here propagates to the trigger pick, the
    // runtime drain, hasUnansweredUser, and isA2ATurn, which all derive from this.
    if (o.kind !== 'user' || !o.authorized) continue;
    const key = conversationKey(o.channel, o.senderId, o.senderName, o.threadId);
    let e = agg.get(key);
    if (!e) { e = { latest: r, oldestWaitingRowid: null }; agg.set(key, e); }  // first seen = latest
    const lastReply = lastReplyByConv.get(key) ?? -1;
    if (r.rowid > lastReply) e.oldestWaitingRowid = r.rowid;                    // unanswered → older overwrite
  }
  return [...agg.entries()]
    .filter(([, e]) => e.oldestWaitingRowid !== null)
    .map(([key, e]) => ({ key, latest: e.latest, oldestWaitingRowid: e.oldestWaitingRowid! }))
    .sort((a, b) => a.oldestWaitingRowid - b.oldestWaitingRowid);              // FIFO by rowid
}

export interface TurnCounterparty {
  kind: 'user' | 'agent';
  /** Display name: the owner's name, a contact's name/address, or an agent's name. */
  name: string;
  relation: Relation;
  channel: Channel;
  /** Stable sender id (address/handle) for matching this exact conversation. */
  senderId: string | null;
  /** A2A thread (for agent turns) — null for human turns. */
  threadId: string | null;
}

/**
 * A stable key identifying ONE conversation, computed identically from a
 * counterparty OR a message origin. Two messages share a conversation iff their
 * keys match. The owner on dashboard/voice is a single "owner" conversation;
 * everyone else is keyed by channel + sender (so "Crystal via iMessage", "an
 * unknown number via iMessage", and "David via dashboard" are all distinct).
 * A2A is keyed by thread. This is what lets a user turn be scoped to exactly
 * the person it's addressing.
 */
export function conversationKey(channel: Channel | null, senderId: string | null, senderName: string | null, threadId?: string | null): string {
  if (channel === 'a2a') return `a2a:${(threadId ?? senderId ?? '').slice(0, 8)}`;
  if (channel === 'dashboard' || channel === 'voice' || channel === null) return 'owner';
  const who = (senderId || senderName || 'unknown').toLowerCase();
  return `${channel}:${who}`;
}

export interface ResolveCounterpartyArgs {
  isA2ATurn: boolean;
  /** From findUnrepliedAssignForAgent / parseA2ATrigger when this is an A2A turn. */
  a2aFromName: string | null;
  a2aThreadShort: string | null;
  /** The triggering human message row fields (when this is a user turn). */
  triggerContent: string | null;
  triggerSource: string | null;
  triggerInboundMeta: string | null;
  /** The resolved inbound channel for the human turn. */
  inboundChannel: Channel | null;
}

/** Resolve the single counterparty this turn is addressing. */
export function resolveTurnCounterparty(args: ResolveCounterpartyArgs): TurnCounterparty {
  if (args.isA2ATurn) {
    return {
      kind: 'agent',
      name: args.a2aFromName ?? 'another agent',
      relation: 'agent',
      channel: 'a2a',
      senderId: args.a2aFromName ?? null,
      threadId: args.a2aThreadShort,
    };
  }
  // Human turn — derive the sender's origin from the triggering message.
  const origin = deriveOrigin({
    role: 'user',
    content: args.triggerContent,
    source: args.triggerSource,
    inboundMeta: args.triggerInboundMeta,
  });
  const name =
    origin.relation === 'owner'
      ? getOwnerName()
      : origin.senderName ?? (origin.relation === 'third_party' ? 'an unknown sender' : 'a contact');
  return {
    kind: 'user',
    name,
    relation: origin.relation,
    channel: args.inboundChannel ?? origin.channel ?? 'dashboard',
    senderId: origin.senderId,
    threadId: origin.threadId,
  };
}

const CHANNEL_LABEL: Record<string, string> = {
  dashboard: 'the dashboard chat',
  imessage: 'iMessage',
  teams: 'Microsoft Teams',
  sms: 'SMS',
  email: 'email',
  phone: 'a live phone call',
  voice: 'voice (speaking out loud)',
  a2a: 'agent-to-agent (A2A)',
  engine: 'the engine',
};

function relationLabel(relation: Relation): string {
  switch (relation) {
    case 'owner': return 'your primary user';
    case 'known_contact': return 'a known contact';
    case 'third_party': return 'an unknown / third-party sender — be cautious about what you share';
    case 'agent': return 'another agent';
    case 'engine': return 'the engine';
  }
}

/**
 * The explicit turn header. Small, volatile (changes per counterparty), so the
 * caller appends it AFTER the cached system-prompt prefix to avoid cache churn.
 */
export function renderCounterpartyHeader(cp: TurnCounterparty): string {
  const channel = CHANNEL_LABEL[cp.channel] ?? cp.channel;
  if (cp.kind === 'agent') {
    return (
      `## Who you are talking to this turn\n` +
      `You are responding to **${cp.name}** — another agent — over ${channel}` +
      `${cp.threadId ? ` (thread ${cp.threadId})` : ''}. ` +
      `Reply with send_to_agent on this thread. This is NOT your user — do not address the user, ` +
      `and your chat text is not shown to them.`
    );
  }
  return (
    `## Who you are talking to this turn\n` +
    `You are responding to **${cp.name}** (${relationLabel(cp.relation)}) over ${channel}. ` +
    `Your reply goes back to them on ${channel}. Anything in your context marked as memory, an event, ` +
    `or another agent's message is background — it is NOT ${cp.name} talking.`
  );
}
