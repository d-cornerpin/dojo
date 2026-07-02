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
  // C24: the former `unanswered: string[]` field was deleted — it had zero consumers.
  // Its concern (a middle message, e.g. a relay request before a follow-up ping, being
  // dropped without a turn) is now preserved by the PER-MESSAGE pickup-stamp: every
  // unclaimed row stays in the waiting set until IT is itself claimed at pickup
  // (loop.ts ~500), so no sibling is collaterally marked served. No bulk-surfacing needed.
}

export function getWaitingHumanConversations(agentId: string): WaitingConversation[] {
  const db = getDb();
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  // C1: push the candidate-narrowing INTO the WHERE so the LIMIT counts only genuine
  // unanswered-human candidates. The old query took the newest 25 role='user' rows and
  // filtered in JS AFTER the LIMIT — but engine steers, tracker/scheduler notices,
  // completion reports, and A2A inbound are ALL role='user', so 25 of them consumed the
  // window and a human ask older than the newest 25 role='user' rows fell out and was
  // permanently forgotten (inv 2). Narrowing here (unclaimed + not engine + not A2A) means
  // the window holds only real human candidates; ASC + LIMIT 50 then returns every
  // unanswered human ask oldest-first. The per-row deriveOrigin authorization gate below
  // is still the final filter (an authorized-human vs mailbox-notification decision the SQL
  // can't make).
  const rows = db.prepare(
    `SELECT rowid, conv_key, content, source, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_kind, origin_intent, created_at
       FROM messages
      WHERE agent_id = ? AND role = 'user' AND created_at >= ?
        AND conv_key IS NULL
        AND (origin_kind IS NULL OR origin_kind != 'engine')
        AND source_agent_id IS NULL AND a2a_thread_id IS NULL
      ORDER BY created_at ASC, rowid ASC LIMIT 50`,
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
  const agg = new Map<string, { latest: WaitingConversation['latest']; oldest: WaitingConversation['latest']; oldestWaitingRowid: number }>();
  for (const r of rows) {                              // C1: now OLDEST → newest by rowid (ASC)
    if (r.conv_key != null) continue;                  // defensive: WHERE already filters claimed rows
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
    if (!e) { e = { latest: r, oldest: r, oldestWaitingRowid: r.rowid }; agg.set(key, e); }  // C1: first seen (ASC) = OLDEST unanswered
    e.latest = r;                                      // iterating oldest→newest, last write = newest unanswered
  }
  return [...agg.entries()]
    .map(([key, e]) => ({
      key,
      latest: e.latest,
      oldest: e.oldest,
      oldestWaitingRowid: e.oldestWaitingRowid,
    }))
    .sort((a, b) => a.oldestWaitingRowid - b.oldestWaitingRowid);              // FIFO by rowid
}

/**
 * E-A2: the oldest UNPROCESSED engine event (a scheduler/reminder/tracker/healer
 * row, origin_kind='engine', conv_key still NULL) in this session, or null. The
 * loop stamps an engine event's conv_key when it processes it (mirroring the human
 * pickup-stamp), so conv_key NULL = not yet handled. This lets the engine turn be
 * detected even when it isn't the MOST-RECENT inbound (a human message that raced
 * it would otherwise make mostRecentInbound non-engine and the event would be
 * silently starved, its task stuck in_progress forever). The runtime drain also
 * re-triggers while one is pending, so an engine event out-raced by a human still
 * gets its own turn after the human is served.
 */
export function getPendingEngineEvent(agentId: string): { rowid: number; content: string; originIntent: string | null } | null {
  const db = getDb();
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  const row = db.prepare(
    `SELECT rowid, content, origin_intent FROM messages
       WHERE agent_id = ? AND role = 'user' AND origin_kind = 'engine' AND conv_key IS NULL
         AND (origin_intent IS NULL OR origin_intent NOT IN ('thrash_gate', 'hint', 'system'))
         AND created_at >= ?
         AND created_at >= datetime('now', '-1 hour')
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  ).get(agentId, sessionStart) as { rowid: number; content: string; origin_intent: string | null } | undefined;
  // C6: exclude non-deliverable engine intents (thrash-gate steers, hints, system chatter)
  // so they can never drive an engine turn — a deliverable event (scheduler/reminder/
  // tracker/healer/completion) still qualifies. Belt-and-suspenders on top of the conv_key
  // sentinels the steer/notice inserts now carry.
  // C7: a 1-hour floor (on top of the session-start floor) so that after a deploy/restart a
  // burst of historical unstamped engine rows (migration 076 did not backfill conv_key)
  // can't replay as "pending events." Migration 078 backfills the historical rows; this
  // floor is the runtime guard for anything the backfill misses.
  return row ? { rowid: row.rowid, content: row.content, originIntent: row.origin_intent } : null;
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
 * everyone else is keyed by channel + sender (so "a contact via iMessage", "an
 * unknown number via iMessage", and "the owner via dashboard" are all distinct).
 * A2A is keyed by thread. This is what lets a user turn be scoped to exactly
 * the person it's addressing.
 */
export function conversationKey(channel: Channel | null, senderId: string | null, senderName: string | null, threadId?: string | null): string {
  // C-2 (comms-audit): key on the FULL thread id, not an 8-char prefix. Two distinct
  // A2A threads sharing an 8-char prefix would otherwise collapse to one conversation
  // (cross-thread context bleed) — severe for `thread-<hash>`-style ids where the
  // first 8 chars are mostly the common "thread-" prefix.
  if (channel === 'a2a') return `a2a:${(threadId ?? senderId ?? '')}`;
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
export function renderCounterpartyHeader(cp: TurnCounterparty, opts?: { isEngineTurn?: boolean }): string {
  const channel = CHANNEL_LABEL[cp.channel] ?? cp.channel;
  // C-4 (comms-audit): an engine turn synthesizes a user-shaped counterparty, so
  // without this it printed "you are talking to <owner> over dashboard" even though
  // the turn was a scheduler/reminder/system event, not a person. Render an
  // engine-appropriate header instead, and tell the model NOT to spontaneously
  // message the user unless the event is explicitly meant to be delivered (helps the
  // engine-turn spontaneous-owner-text concern too).
  if (opts?.isEngineTurn) {
    return (
      `## What triggered this turn\n` +
      `This turn was triggered by an ENGINE EVENT (a scheduled task, reminder, tracker, or system ` +
      `notice), NOT a person messaging you. Do the work described in your directive. Do NOT address ` +
      `the user or send them a message unless the event is explicitly meant to be delivered to them ` +
      `(a reminder, a digest, a completion report). If there is nothing to tell the user, just do the ` +
      `work, or reply with [no-reply].`
    );
  }
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
  // something to the owner ("I'll ask the owner"), the loop isn't closed until it
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
