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
  /** The conversation's NEWEST unanswered message row (kept for logging/context). */
  latest: {
    rowid: number; conv_key: string | null; content: string; source: string | null; source_agent_id: string | null;
    a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
    inbound_meta: string | null; origin_kind: string | null; origin_intent: string | null; created_at: string;
  };
  /** The conversation's OLDEST unanswered message row — this is the turn TRIGGER,
   *  so the agent answers a conversation's pending messages oldest-first and a
   *  later ping can't be answered before the request that preceded it (OPEN-12). */
  oldest: WaitingConversation['latest'];
  oldestWaitingRowid: number;
  /**
   * Contents of EVERY still-unanswered message in this conversation, oldest →
   * newest (OPEN-12). The trigger pick + pickup-stamp uses only `latest`, and
   * stamping the latest's conv_key collaterally marks older unanswered siblings
   * served (the served test is rowid > MAX(stamped rowid)). So a middle message
   * (a relay request) that arrived before a later one (a follow-up ping) would
   * be dropped without ever getting a turn. The loop uses this list to surface
   * ALL pending messages on the one turn that handles the conversation, so none
   * is silently absorbed.
   */
  unanswered: string[];
}

export function getWaitingHumanConversations(agentId: string): WaitingConversation[] {
  const db = getDb();
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  const rows = db.prepare(
    `SELECT rowid, conv_key, content, source, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_kind, origin_intent, created_at
       FROM messages WHERE agent_id = ? AND role = 'user' AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 25`,
  ).all(agentId, sessionStart) as WaitingConversation['latest'][];
  // OPEN-12 root fix — per-message "served", not "a later reply exists".
  // A user message is UNANSWERED iff its OWN conv_key is still NULL, i.e. no turn
  // ever CLAIMED it at pickup (the loop stamps the trigger's conv_key the moment
  // it picks it up). The previous signal marked a message served whenever any
  // reply with a higher rowid existed for its conversation — so a DISTINCT
  // message that arrived mid-turn (a relay request before a follow-up ping) was
  // collaterally served by the unrelated reply and dropped without ever getting a
  // turn. Per-message claim cannot drop a distinct ask: every unclaimed message
  // gets its own turn until it is itself picked up.
  const agg = new Map<string, { latest: WaitingConversation['latest']; oldest: WaitingConversation['latest']; oldestWaitingRowid: number; unanswered: Array<{ rowid: number; content: string }> }>();
  for (const r of rows) {                              // newest → oldest by rowid
    if (r.conv_key != null) continue;                  // already claimed at a pickup — answered/owned
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
    if (!e) { e = { latest: r, oldest: r, oldestWaitingRowid: r.rowid, unanswered: [] }; agg.set(key, e); }  // first seen = newest unanswered
    e.oldest = r;                                      // iterating newest→oldest, last write = oldest unanswered
    e.oldestWaitingRowid = r.rowid;
    e.unanswered.push({ rowid: r.rowid, content: r.content });
  }
  return [...agg.entries()]
    .map(([key, e]) => ({
      key,
      latest: e.latest,
      oldest: e.oldest,
      oldestWaitingRowid: e.oldestWaitingRowid,
      // Collected newest→oldest above; expose oldest→newest for the reader.
      unanswered: e.unanswered.sort((a, b) => a.rowid - b.rowid).map((u) => u.content),
    }))
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
  // OPEN-9 (close-the-loop) — just-in-time, only on non-owner human turns (not
  // the owner, not agents). If a reply to a contact commits the agent to relay
  // something to the owner ("I'll ask David"), the loop isn't closed until it
  // actually does — the engine can't reliably detect the promise, so this is
  // relevant-only guidance, not enforcement. Framed as advice (the model keeps
  // judgment); appears only when the counterparty is a contact, so no SOUL bloat.
  const closeTheLoop =
    cp.relation !== 'owner'
      ? ` Close-the-loop: if your reply promises to follow up with ${getOwnerName()} ` +
        `(e.g. "I'll ask/tell/check with them"), actually do it THIS turn — create a ` +
        `reminder or send ${getOwnerName()} a note — a promise to a contact isn't kept until you act on it.`
      : '';
  return (
    `## Who you are talking to this turn\n` +
    `You are responding to **${cp.name}** (${relationLabel(cp.relation)}) over ${channel}. ` +
    `Your reply goes back to them on ${channel}. Anything in your context marked as memory, an event, ` +
    `or another agent's message is background — it is NOT ${cp.name} talking.` +
    closeTheLoop
  );
}
