// ════════════════════════════════════════
// Turn Counterparty (attribution redesign, Phase 3)
//
// Every turn is a conversation with exactly ONE counterparty, the entity the
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
import { createLogger } from '../../logger.js';
import { postAgentNotice } from '../agent-notice.js';

const logger = createLogger('counterparty');
// ── Counterparty serialization helper ──
// One source of truth (used by the loop to pick the turn's counterparty, the
// runtime to decide whether to re-trigger and drain, and the dev context-dump)
// for "which human conversations still have an unanswered message," in FIFO
// order. A conversation is WAITING when its latest inbound rowid is past the
// latest reply we've delivered for it. "Reply" = an own message stamped with
// that conversation's conv_key (migration 076), a DB signal, so the waiting set
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
  /** The conversation's OLDEST unanswered message row, this is the turn TRIGGER,
   *  so the agent answers a conversation's pending messages oldest-first and a
   *  later ping can't be answered before the request that preceded it (OPEN-12). */
  oldest: WaitingConversation['latest'];
  oldestWaitingRowid: number;
  // C24: the former `unanswered: string[]` field was deleted, it had zero consumers.
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
  // filtered in JS AFTER the LIMIT, but engine steers, tracker/scheduler notices,
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
        AND swept_at IS NULL
        AND (origin_kind IS NULL OR origin_kind != 'engine')
        AND source_agent_id IS NULL AND a2a_thread_id IS NULL
      ORDER BY created_at ASC, rowid ASC LIMIT 50`,
  ).all(agentId, sessionStart) as WaitingConversation['latest'][];
  // OPEN-12 root fix, per-message "served", not "a later reply exists".
  // A user message is UNANSWERED iff its OWN conv_key is still NULL, i.e. no turn
  // ever CLAIMED it at pickup (the loop stamps the trigger's conv_key the moment
  // it picks it up). The previous signal marked a message served whenever any
  // reply with a higher rowid existed for its conversation, so a DISTINCT
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
    // Lane-3 awareness, the agent surfaces it to the owner, it never counts as a
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
 * D9: quarantine every UNCLAIMED row belonging to one waiting conversation so it
 * is skipped by getWaitingHumanConversations (which filters `swept_at IS NULL`).
 * Used when a conversation's turn repeatedly hard-aborts (poisoned attachment,
 * per-thread provider error, oversized context): rather than letting that
 * poisoned head starve every other waiting conversation behind it, the drain
 * quarantines it and serves the next. Reuses the D11 `swept_at` drain-suppression
 * column, so the row keeps its true conv_key/identity for recall. Returns the
 * number of rows quarantined. Conservative: only rows whose derived key matches
 * `convKey` are touched, so a different conversation is never collaterally hit.
 */
export function quarantineWaitingConversation(agentId: string, convKey: string): number {
  const db = getDb();
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  const rows = db.prepare(
    `SELECT rowid, content, source, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_kind, origin_intent
       FROM messages
      WHERE agent_id = ? AND role = 'user' AND created_at >= ?
        AND conv_key IS NULL
        AND swept_at IS NULL
        AND (origin_kind IS NULL OR origin_kind != 'engine')
        AND source_agent_id IS NULL AND a2a_thread_id IS NULL`,
  ).all(agentId, sessionStart) as Array<WaitingConversation['latest']>;
  const stamp = db.prepare("UPDATE messages SET swept_at = datetime('now') WHERE agent_id = ? AND rowid = ?");
  let n = 0;
  for (const r of rows) {
    const o = deriveOrigin({
      role: 'user', content: r.content, source: r.source, sourceAgentId: r.source_agent_id,
      a2aThreadId: r.a2a_thread_id, a2aIntent: r.a2a_intent, a2aRequiresResponse: r.a2a_requires_response,
      inboundMeta: r.inbound_meta, originKind: r.origin_kind, originIntent: r.origin_intent,
    });
    if (o.kind !== 'user' || !o.authorized) continue;
    if (conversationKey(o.channel, o.senderId, o.senderName, o.threadId) !== convKey) continue;
    stamp.run(agentId, r.rowid);
    n++;
  }
  return n;
}

/**
 * F9 (harness finding, wave 2): narrow batch-claim at turn teardown. Sibling
 * user rows of the SAME conversation that arrived BEFORE the turn's final
 * context assembly were inside the context the reply was generated from (the
 * per-iteration reassembly pulls them into the fresh tail), so the reply
 * answered them too. Claiming them stops the drain from re-serving the same
 * answer (observed: a 1s two-message burst got the identical answer delivered
 * twice). Rows arriving AFTER the final assembly stay NULL and get their own
 * turn, preserving OPEN-12 ("a genuinely newer message is served next").
 */
export function claimAssembledSiblings(agentId: string, convKey: string, assembledAtIso: string): number {
  const db = getDb();
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  const rows = db.prepare(
    `SELECT rowid, content, source, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, origin_kind, origin_intent
       FROM messages
      WHERE agent_id = ? AND role = 'user' AND created_at >= ?
        AND conv_key IS NULL
        AND swept_at IS NULL
        AND datetime(created_at) <= datetime(?)
        AND (origin_kind IS NULL OR origin_kind != 'engine')
        AND source_agent_id IS NULL AND a2a_thread_id IS NULL`,
  ).all(agentId, sessionStart, assembledAtIso) as Array<WaitingConversation['latest']>;
  const stamp = db.prepare('UPDATE messages SET conv_key = ? WHERE agent_id = ? AND rowid = ? AND conv_key IS NULL');
  let n = 0;
  for (const r of rows) {
    const o = deriveOrigin({
      role: 'user', content: r.content, source: r.source, sourceAgentId: r.source_agent_id,
      a2aThreadId: r.a2a_thread_id, a2aIntent: r.a2a_intent, a2aRequiresResponse: r.a2a_requires_response,
      inboundMeta: r.inbound_meta, originKind: r.origin_kind, originIntent: r.origin_intent,
    });
    if (o.kind !== 'user') continue;
    if (conversationKey(o.channel, o.senderId, o.senderName, o.threadId) !== convKey) continue;
    stamp.run(convKey, agentId, r.rowid);
    n++;
  }
  return n;
}

// ── D8: durable delivery lifecycle for engine events (migration 084) ──
// An engine event lives on its own messages row; its lifecycle state lives there
// too: conv_key ('engine' = claimed by a turn), swept_at (disposed), plus
// delivery_attempts and next_attempt_at (this fix). The loop's abort revert bumps
// attempts with backoff on a claimed-then-aborted delivery; eligibility gates on
// attempts and backoff; exhaustion (5 attempts or 6 hours) expires the event
// LOUDLY, exactly once, via the agent-notice path. No silent loss, no infinite
// retry, and nothing older than the 6-hour horizon can ever wake an agent.
export const ENGINE_EVENT_MAX_ATTEMPTS = 5;
export const ENGINE_EVENT_EXPIRY_HOURS = 6;
// Backoff after the Nth failed delivery (minutes). Attempts 1-4 schedule a retry;
// the 5th failure exhausts the event (expired loudly), so its slot is a formality.
const ENGINE_EVENT_BACKOFF_MINUTES = [1, 5, 15, 30, 60];

// Deliverable engine events only: the same intent exclusions as getPendingEngineEvent
// (thrash-gate steers / hints / system chatter never deliver, so they never expire
// "loudly" either; the boot sweep disposes them silently as before).
const DELIVERABLE_ENGINE_EVENT_WHERE =
  `role = 'user' AND origin_kind = 'engine' AND conv_key IS NULL
   AND swept_at IS NULL
   AND (origin_intent IS NULL OR origin_intent NOT IN ('thrash_gate', 'hint', 'system'))`;

/**
 * D8: expire engine events that exhausted their delivery lifecycle, LOUDLY.
 * An event is exhausted after ENGINE_EVENT_MAX_ATTEMPTS failed deliveries or
 * ENGINE_EVENT_EXPIRY_HOURS past creation, whichever comes first. Each expired
 * event is stamped swept_at (the sanctioned D11 disposal signal, identity
 * preserved for recall) and produces EXACTLY ONE deterministic owner-visible
 * notice via the agent-notice path; the swept_at stamp's `changes` count is the
 * once-guard (atomic per row, restart/multi-process safe). Returns the number
 * of events expired. Best-effort: never throws into a caller.
 */
export function expireExhaustedEngineEvents(agentId: string): number {
  let expired = 0;
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT rowid, content FROM messages
        WHERE agent_id = ? AND ${DELIVERABLE_ENGINE_EVENT_WHERE}
          AND (delivery_attempts >= ${ENGINE_EVENT_MAX_ATTEMPTS}
               OR created_at <= datetime('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours'))`,
    ).all(agentId) as Array<{ rowid: number; content: string }>;
    for (const r of rows) {
      const res = db.prepare(
        "UPDATE messages SET swept_at = datetime('now') WHERE agent_id = ? AND rowid = ? AND swept_at IS NULL",
      ).run(agentId, r.rowid);
      if (res.changes === 0) continue; // another process expired it first; its notice already posted
      expired++;
      // Strip the engine [SOURCE: ...] attribution tag so the 100-char gist is the
      // actual reminder text, not the tag.
      const gist = r.content.replace(/^\[SOURCE:[^\]]*\]\s*/, '').slice(0, 100);
      logger.error('engine event expired undelivered (lifecycle exhausted); owner notified', { agentId, rowid: r.rowid, gist }, agentId);
      postAgentNotice({
        toAgentId: agentId,
        fromName: 'Scheduler',
        selfIntro: false,
        intent: 'engine_event_expired',
        brief: `I could not deliver a scheduled reminder: ${gist}`,
      });
    }
  } catch { /* best effort, expiry must never break eligibility checks */ }
  return expired;
}

/**
 * D8: record one failed/aborted delivery of an engine event, called by the loop's
 * engine-claim abort revert AFTER the claim (conv_key='engine') was reverted to
 * NULL. Bumps delivery_attempts and schedules the next attempt per backoff
 * (1m, 5m, 15m, 30m, 60m). When the bump exhausts the lifecycle, the event is
 * expired loudly right here so the owner notice never waits on a later
 * eligibility consult.
 */
export function recordEngineEventDeliveryFailure(agentId: string, rowid: number): void {
  try {
    const db = getDb();
    const cur = db.prepare('SELECT delivery_attempts FROM messages WHERE agent_id = ? AND rowid = ?')
      .get(agentId, rowid) as { delivery_attempts: number | null } | undefined;
    if (!cur) return;
    const attempts = (cur.delivery_attempts ?? 0) + 1;
    const backoffMin = ENGINE_EVENT_BACKOFF_MINUTES[Math.min(attempts, ENGINE_EVENT_BACKOFF_MINUTES.length) - 1];
    db.prepare(
      "UPDATE messages SET delivery_attempts = ?, next_attempt_at = datetime('now', ?) WHERE agent_id = ? AND rowid = ?",
    ).run(attempts, `+${backoffMin} minutes`, agentId, rowid);
    logger.warn('engine event delivery failed; scheduled retry with backoff', { agentId, rowid, attempts, backoffMin }, agentId);
    if (attempts >= ENGINE_EVENT_MAX_ATTEMPTS) expireExhaustedEngineEvents(agentId);
  } catch { /* best effort, failure bookkeeping must never mask the original abort */ }
}

/**
 * D8: the earliest FUTURE retry time (epoch ms) among this agent's engine events
 * that are still inside their delivery lifecycle, or null when none is parked on
 * a backoff. The runtime drain uses it to arm a one-shot in-process retry timer
 * (crash-durable via the boot re-drain, which consults the same eligibility).
 */
export function getNextEngineEventRetryAt(agentId: string): number | null {
  try {
    const db = getDb();
    const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
    const row = db.prepare(
      `SELECT MIN(next_attempt_at) AS t FROM messages
        WHERE agent_id = ? AND ${DELIVERABLE_ENGINE_EVENT_WHERE}
          AND created_at >= ?
          AND created_at >= datetime('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours')
          AND delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}
          AND next_attempt_at > datetime('now')`,
    ).get(agentId, sessionStart) as { t: string | null } | undefined;
    if (!row?.t) return null;
    const ms = Date.parse(row.t.replace(' ', 'T') + 'Z'); // SQLite datetime('now') is UTC
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Session-reset carry-over for FIRED-but-undelivered engine events.
 *
 * Every engine-event eligibility query gates on `created_at >= session_started_at`
 * (getPendingEngineEvent, getNextEngineEventRetryAt, expireExhaustedEngineEvents's
 * consumers). So a reminder / scheduler / tracker / healer row that FIRED, i.e. was
 * queued as an engine row with its conv_key still NULL, moments before a session
 * reset is stranded the instant the boundary is bumped past its created_at: it is
 * unclaimed (never delivered) yet now permanently ineligible, a silent loss of a
 * deliverable the owner is owed.
 *
 * Re-home each such row to the new boundary so it survives the reset and gets its
 * turn in the fresh session. Scope is deliberately narrow so the reset-wipe
 * semantics hold and nothing already-answered is resurfaced:
 *   - only DELIVERABLE_ENGINE_EVENT_WHERE rows (origin_kind='engine', conv_key NULL,
 *     unswept, not a thrash-gate / hint / system steer): an already-claimed event
 *     (conv_key set, i.e. delivered) or ordinary human conversation (origin_kind
 *     != 'engine') is never touched, so a reset still wipes the chat as intended;
 *   - only rows still inside the delivery lifecycle (under max attempts) and inside
 *     the 6-hour horizon, so an already-exhausted event is left to expire loudly,
 *     never revived.
 * created_at is bumped to exactly the new boundary; the `created_at < boundary`
 * guard makes it idempotent (a re-run finds nothing left below the boundary).
 * Best-effort: a reset must never fail on carry-over bookkeeping. Returns the count.
 */
export function rehomeUnclaimedEngineEvents(agentId: string, newBoundary: string): number {
  try {
    const db = getDb();
    const res = db.prepare(
      `UPDATE messages SET created_at = ?
         WHERE agent_id = ? AND ${DELIVERABLE_ENGINE_EVENT_WHERE}
           AND created_at < ?
           AND delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}
           AND created_at >= datetime('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours')`,
    ).run(newBoundary, agentId, newBoundary);
    if (res.changes > 0) {
      logger.info('re-homed fired-but-undelivered engine event(s) across session reset', { agentId, count: res.changes }, agentId);
    }
    return res.changes;
  } catch {
    return 0;
  }
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
  // D8: dispose exhausted/overdue events LOUDLY before answering "what's pending",
  // so every consumer of eligibility (loop pickup, runtime drain, boot owed-check)
  // also drives the once-per-event expiry notice deterministically.
  expireExhaustedEngineEvents(agentId);
  const sessionStart = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
  const row = db.prepare(
    `SELECT rowid, content, origin_intent FROM messages
       WHERE agent_id = ? AND role = 'user' AND origin_kind = 'engine' AND conv_key IS NULL
         AND swept_at IS NULL
         AND (origin_intent IS NULL OR origin_intent NOT IN ('thrash_gate', 'hint', 'system'))
         AND created_at >= ?
         AND created_at >= datetime('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours')
         AND delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}
         AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  ).get(agentId, sessionStart) as { rowid: number; content: string; origin_intent: string | null } | undefined;
  // C6: exclude non-deliverable engine intents (thrash-gate steers, hints, system chatter)
  // so they can never drive an engine turn, a deliverable event (scheduler/reminder/
  // tracker/healer/completion) still qualifies. Belt-and-suspenders on top of the conv_key
  // sentinels the steer/notice inserts now carry.
  // D8: the old hard 1-hour age cliff is replaced by a durable delivery lifecycle
  // (migration 084). An event stays eligible while it is unclaimed (conv_key NULL),
  // unswept, under 5 delivery attempts, and past its retry backoff, so an agent busy
  // with humans for hours no longer silently loses a reminder. The lifecycle is
  // bounded by the 6-hour horizon: past it the event is expired LOUDLY (swept +
  // owner-visible notice) by expireExhaustedEngineEvents above, never delivered.
  // The horizon also keeps the C7 guarantee: after a deploy/restart a burst of
  // historical unstamped engine rows (migration 076 did not backfill conv_key)
  // can't replay as "pending events" (migration 078 backfilled those; this is the
  // runtime guard for anything the backfill missed).
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
  /** A2A thread (for agent turns), null for human turns. */
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
  // (cross-thread context bleed), severe for `thread-<hash>`-style ids where the
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
  // Human turn, derive the sender's origin from the triggering message.
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
    case 'third_party': return 'an unknown / third-party sender, be cautious about what you share';
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
      `You are responding to **${cp.name}**, another agent, over ${channel}` +
      `${cp.threadId ? ` (thread ${cp.threadId})` : ''}. ` +
      `Reply with send_to_agent on this thread. This is NOT your user, do not address the user, ` +
      `and your chat text is not shown to them.`
    );
  }
  // OPEN-9 (close-the-loop), just-in-time, only on non-owner human turns (not
  // the owner, not agents). If a reply to a contact commits the agent to relay
  // something to the owner ("I'll ask the owner"), the loop isn't closed until it
  // actually does, the engine can't reliably detect the promise, so this is
  // relevant-only guidance, not enforcement. Framed as advice (the model keeps
  // judgment); appears only when the counterparty is a contact, so no SOUL bloat.
  const closeTheLoop =
    cp.relation !== 'owner'
      ? ` Close-the-loop: if your reply promises to follow up with ${getOwnerName()} ` +
        `(e.g. "I'll ask/tell/check with them"), actually do it THIS turn, create a ` +
        `reminder or send ${getOwnerName()} a note, a promise to a contact isn't kept until you act on it.`
      : '';
  return (
    `## Who you are talking to this turn\n` +
    `You are responding to **${cp.name}** (${relationLabel(cp.relation)}) over ${channel}. ` +
    `Your reply goes back to them on ${channel}. Anything in your context marked as memory, an event, ` +
    `or another agent's message is background, it is NOT ${cp.name} talking.` +
    closeTheLoop
  );
}
