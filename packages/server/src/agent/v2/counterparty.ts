// Every turn has exactly ONE counterparty: resolving it and rendering the "who you are talking
// to" header keeps the model from conflating the user, another agent and an engine event.
import type { TurnAddress } from './turn-address.js';
import { relationWords } from './turn-address.js';
import { deriveOrigin, legacyOriginInputs, type Channel, type Relation, type InboundMeta } from '@dojo/shared';
import { getOwnerName } from '../../config/platform.js';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import {
  createdAtText,
  rehomeUndeliveredCreatedAt,
  sweepByReferent,
  sweepByRowid,
} from '../../memory/message-store.js';
import { conversationIdentityOf, type ConversationIdentity } from '../../memory/conversations.js';
import { ENGINE_RIDER_INTENTS_SQL } from './engine-riders.js';
import { askIdForMessage } from '../../work/store.js';
import { spentRun, spentTask, spentWakeAsk } from './work-lineage.js';
import { postAgentNotice } from '../agent-notice.js';
import { spendServe } from './serve-later.js';

const logger = createLogger('counterparty');
// "Unanswered human conversation" = an open `work(kind='ask')` row: real, so it survives a
// restart; served in one order (the owner, then never served, then oldest); engine events and A2A never open an ask.
export interface WaitingConversation {
  key: string;
  /** Conversation id of the OLDEST unanswered row; NULL until pickup re-resolves it via `identity`. */
  conversationId: string | null;
  /** Unique-key identity from the SAME origin `key` comes from: the pickup stamp cannot disagree. */
  identity: ConversationIdentity;
  /** Which ask the oldest unanswered message keeps open: the pickup CAS addresses THIS, not a rowid. */
  workId: string;
  /** The conversation's NEWEST unanswered message row (kept for logging/context). */
  latest: {
    rowid: number; id: string; conversation_id: string | null; content: string;
    /** Lane+channel stamped at ingest: attribution PROJECTS from these; the compat columns are never read. */
    lane: string; channel: string | null; source_agent_id: string | null;
    a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
    inbound_meta: string | null; origin_intent: string | null; created_at: string;
    /** The row's OWN ask: trigger and siblings are DIFFERENT asks, each claimed and closed alone. */
    work_id: string;
  };
  /** OLDEST unanswered row = the turn TRIGGER: turns answer oldest-first, a later ping cannot go first. */
  oldest: WaitingConversation['latest'];
  oldestWaitingRowid: number;
  /** The smallest due time of the conversation's asks (0: due now); a conversation waits while it is in the future. */
  dueAt: number;
  /** The owner wrote it; the owner is served before anyone else. */
  owner: boolean;
  /** Its oldest ask was picked up by a turn before (handed back); a never-served one goes first. */
  served: boolean;
}

/** ONE projection for every read; `seq AS rowid` must stay: `seq` is the INTEGER PRIMARY KEY. */
const WAITING_COLS = `m.seq AS rowid, m.id, m.conversation_id, m.content, m.lane, m.channel,
  m.source_agent_id, m.a2a_thread_id, m.a2a_intent, m.a2a_requires_response, m.inbound_meta,
  m.origin_intent, ${createdAtText('m.created_at')}, w.id AS work_id`;

/** The candidate narrowing, ONE place for the reads that must agree; the open `ask` join IS the
 *  queue; the lane/A2A guards stay belt-and-braces: a migrated row can carry both. */
const WAITING_HUMAN_CANDIDATE_FROM =
  `work w
     JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id`;

const WAITING_HUMAN_CANDIDATE_WHERE =
  `w.kind = 'ask' AND w.state = 'open'
   AND w.agent_id = @agentId
   AND w.opened_at >= (unixepoch(@sessionStart) * 1000)
   AND m.role = 'user'
   AND m.lane = 'owner'
   AND m.source_agent_id IS NULL AND m.a2a_thread_id IS NULL`;

function originOfCandidate(r: WaitingConversation['latest']) {
  return deriveOrigin({
    role: 'user', content: r.content,
    ...legacyOriginInputs(r.lane, r.channel),
    sourceAgentId: r.source_agent_id,
    a2aThreadId: r.a2a_thread_id, a2aIntent: r.a2a_intent, a2aRequiresResponse: r.a2a_requires_response,
    inboundMeta: r.inbound_meta, originIntent: r.origin_intent,
  });
}

/** The session boundary every eligibility read is scoped to. */
function sessionStartOf(agentId: string): string {
  const db = getDb();
  return (db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? '1970-01-01';
}

/** Conversations whose asks are due now, or with `includeNotDue` also those waiting for a later due time. */
export function getWaitingHumanConversations(agentId: string, opts: { includeNotDue?: boolean } = {}): WaitingConversation[] {
  const db = getDb();
  const sessionStart = sessionStartOf(agentId);
  // Narrow INTO the WHERE before the LIMIT: steers/notices/A2A are all role='user', so post-LIMIT
  // filtering lets them eat the window and an older human ask is forgotten.
  const rows = db.prepare(
    `SELECT ${WAITING_COLS}, COALESCE(w.next_attempt_at, 0) AS due_at,
            EXISTS (SELECT 1 FROM work_events ce WHERE ce.work_id = w.id AND ce.kind = 'claim_turn') AS served
       FROM ${WAITING_HUMAN_CANDIDATE_FROM}
      WHERE ${WAITING_HUMAN_CANDIDATE_WHERE}
      ORDER BY w.opened_at ASC, m.seq ASC LIMIT 50`,
  ).all({ agentId, sessionStart }) as Array<WaitingConversation['latest'] & { due_at: number; served: number }>;
  const now = Date.now();
  // UNANSWERED iff the row's OWN ask is open: a mid-turn arrival must not ride an unrelated reply.
  const agg = new Map<string, { latest: WaitingConversation['latest']; oldest: WaitingConversation['latest']; oldestWaitingRowid: number; workId: string; identity: ConversationIdentity; dueAt: number; owner: boolean; served: boolean }>();
  for (const r of rows) {                              // now OLDEST → newest by rowid (ASC)
    const o = originOfCandidate(r);
    // The one "owes a reply" definition: AUTHORIZED human inbound; the rest is Lane-3 awareness.
    // Trigger pick, the owed items, hasUnansweredUser and isA2ATurn all derive from this skip.
    if (o.kind !== 'user' || !o.authorized) continue;
    const key = conversationKey(o.channel, o.senderId, o.senderName, o.threadId);
    let e = agg.get(key);
    // First seen (ASC) = OLDEST unanswered, and its ask is the one the turn claims.
    if (!e) {
      e = {
        latest: r, oldest: r, oldestWaitingRowid: r.rowid, workId: r.work_id,
        identity: conversationIdentityOf(o.channel, o.senderId, o.senderName, o.threadId), dueAt: r.due_at,
        owner: o.relation === 'owner', served: r.served === 1,
      };
      agg.set(key, e);
    }
    e.latest = r;                                      // iterating oldest→newest, last write = newest unanswered
    e.dueAt = Math.min(e.dueAt, r.due_at);
  }
  return [...agg.entries()]
    .filter(([, e]) => opts.includeNotDue === true || e.dueAt <= now)
    .map(([key, e]) => ({
      key,
      conversationId: e.oldest.conversation_id ?? null,
      identity: e.identity,
      workId: e.workId,
      latest: e.latest,
      oldest: e.oldest,
      oldestWaitingRowid: e.oldestWaitingRowid,
      dueAt: e.dueAt,
      owner: e.owner,
      served: e.served,
    }))
    .sort((a, b) => Number(b.owner) - Number(a.owner) || Number(a.served) - Number(b.served) || a.oldestWaitingRowid - b.oldestWaitingRowid);
}

/** Has a person's message for `agentId` arrived after the row `sinceSeq`, or, given the conversation a turn
 *  serves (null: none), does anyone wait in another one? Compare `seq` order, never whole-second `created_at`. */
export function personArrivedSince(agentId: string, sinceSeq: number, servedKey?: string | null): boolean {
  return getWaitingHumanConversations(agentId).some((c) => c.latest.rowid > sinceSeq || (servedKey !== undefined && c.key !== servedKey));
}

/** The message an ask was opened for, with its conversation key, its ask's state and whether the owner wrote it:
 *  an ask-rooted event and a parked job rank with their request, and a job turn is addressed from it. */
export function askRoot(agentId: string, messageId: string): { row: WaitingConversation['latest']; key: string; owner: boolean; state: string } | null {
  const r = getDb().prepare(`SELECT ${WAITING_COLS}, w.state AS state FROM ${WAITING_HUMAN_CANDIDATE_FROM} WHERE w.id = ? AND w.agent_id = ?`)
    .get(askIdForMessage(messageId), agentId) as (WaitingConversation['latest'] & { state: string }) | undefined;
  if (!r) return null;
  const o = originOfCandidate(r);
  return { row: r, key: conversationKey(o.channel, o.senderId, o.senderName, o.threadId), owner: o.relation === 'owner', state: r.state };
}

/** THE ASSEMBLED-CONTEXT SET: asks in front of the model when this turn replied; later siblings
 *  are absent and get their own turn. Reports only: settlement decides, closes and stamps. */
export function assembledContextAsks(
  agentId: string, convKey: string, assembledAtIso: string,
): Array<{ workId: string; rowid: number }> {
  const db = getDb();
  const sessionStart = sessionStartOf(agentId);
  const rows = db.prepare(
    `SELECT ${WAITING_COLS}
       FROM ${WAITING_HUMAN_CANDIDATE_FROM}
      WHERE ${WAITING_HUMAN_CANDIDATE_WHERE}
        AND m.created_at <= (unixepoch(@assembledAt) * 1000)`,
  ).all({ agentId, sessionStart, assembledAt: assembledAtIso }) as Array<WaitingConversation['latest']>;
  const set: Array<{ workId: string; rowid: number }> = [];
  for (const r of rows) {
    const o = originOfCandidate(r);
    if (o.kind !== 'user') continue;
    if (conversationKey(o.channel, o.senderId, o.senderName, o.threadId) !== convKey) continue;
    set.push({ workId: r.work_id, rowid: r.rowid });
  }
  return set;
}

/** Authorized-human rows of THIS turn's conversation that arrived after the turn start and were
 *  pulled into the answered context, yet may never have been addressed. Reports only. */
export function getOwedMidTurnArrivals(
  agentId: string,
  convKey: string,
  turnStartedAt: string,
  assembledAtIso: string,
  // `id` rides out with the row: quoted prose is otherwise the only trace, and no predicate reads it.
): Array<{ rowid: number; id: string; content: string }> {
  const db = getDb();
  const sessionStart = sessionStartOf(agentId);
  // Same window as `assembledContextAsks`, plus the strict start bound so only mid-turn arrivals qualify.
  const rows = db.prepare(
    `SELECT ${WAITING_COLS}
       FROM ${WAITING_HUMAN_CANDIDATE_FROM}
      WHERE ${WAITING_HUMAN_CANDIDATE_WHERE}
        AND m.created_at > (unixepoch(@turnStartedAt) * 1000)
        AND m.created_at <= (unixepoch(@assembledAt) * 1000)
      ORDER BY m.created_at ASC, m.seq ASC`,
  ).all({ agentId, sessionStart, turnStartedAt, assembledAt: assembledAtIso }) as Array<WaitingConversation['latest']>;
  const owed: Array<{ rowid: number; id: string; content: string }> = [];
  for (const r of rows) {
    const o = originOfCandidate(r);
    // Same authorized-human gate as getWaitingHumanConversations: only an authorized ask is owed a reply.
    if (o.kind !== 'user' || !o.authorized) continue;
    if (conversationKey(o.channel, o.senderId, o.senderName, o.threadId) !== convKey) continue;
    owed.push({ rowid: r.rowid, id: r.id, content: r.content });
  }
  return owed;
}

// An engine event lives on its own messages row with its delivery lifecycle: failed deliveries
// back off; exhaustion (5 attempts or 6 hours) expires it LOUDLY once via the agent-notice path.
export const ENGINE_EVENT_MAX_ATTEMPTS = 5;
export const ENGINE_EVENT_EXPIRY_HOURS = 6;
// Backoff minutes after the Nth failure; the 5th exhausts the event, so its slot is a formality.
export const ENGINE_EVENT_BACKOFF_MINUTES = [1, 5, 15, 30, 60];

// Deliverable engine events only: a RIDER never delivers, so it never expires loudly
// (see `engine-riders.ts`); `served_by_turn IS NULL` is the real serve edge.
const DELIVERABLE_ENGINE_EVENT_WHERE =
  `role = 'user' AND lane = 'events' AND served_by_turn IS NULL
   AND swept_at IS NULL
   AND (origin_intent IS NULL OR origin_intent NOT IN ${ENGINE_RIDER_INTENTS_SQL})`;

// Engine events have ONE home (`messages`, `lane='events'`): every lifecycle mutation hits it.

// "See if it is done" before doing: every queued engine event with a work referent gets its
// premise re-checked against present state; a spent referent retires the event loudly, never with a turn.
function retireOneEngineEvent(
  rowid: number,
  reason: string,
  detail: { taskId?: string | null; runId?: string | null; createdAt?: string | null; referentState?: string | null },
): boolean {
  try {
    const changed = sweepByRowid({ rowid, requireUnclaimed: true });
    if (changed === 0) return false;
    logger.info('serve boundary: retired a spent engine event (premise no longer holds; never served)', {
      reason, rowid, taskId: detail.taskId ?? null, runId: detail.runId ?? null,
      triggerBorn: detail.createdAt ?? null, referentState: detail.referentState ?? null,
    });
    if (detail.taskId) {
      import('../../tracker/task-log.js').then(({ writeTaskLog }) => {
        try {
          writeTaskLog({
            taskId: detail.taskId!,
            fromEntity: 'engine',
            entryKind: 'observation',
            reason: `serve boundary: retired unserved trigger (${reason})`,
            note: `trigger born ${detail.createdAt ?? '?'}; referent ${detail.referentState ?? 'spent'}; retired ${new Date().toISOString()}`,
          });
        } catch { /* audit only */ }
      }).catch(() => { /* audit only */ });
    }
    return true;
  } catch {
    return false;
  }
}

type EventReferent = { run_id: string | null; task_id: string | null; origin_intent: string | null; root_kind: string | null; root_id: string | null };
const spentReferent = (ev: EventReferent): ReturnType<typeof spentRun> =>
  (ev.run_id ? spentRun(ev.run_id) : null) ?? (ev.task_id ? spentTask(ev.task_id) : null) ?? spentWakeAsk(ev);

export function retireSpentEngineEvents(agentId: string): number {
  let retired = 0;
  try {
    const db = getDb();
    const candidates = db.prepare(
      `SELECT seq AS rowid, task_id, run_id, origin_intent, root_kind, root_id, ${createdAtText()} FROM messages
         WHERE agent_id = @agentId AND ${DELIVERABLE_ENGINE_EVENT_WHERE} AND (task_id IS NOT NULL OR run_id IS NOT NULL OR (origin_intent = 'a2a_request' AND root_kind = 'ask'))
       LIMIT 50`,
    ).all({ agentId }) as Array<{ rowid: number; task_id: string | null; run_id: string | null; origin_intent: string | null; root_kind: string | null; root_id: string | null; created_at: string }>;
    for (const ev of candidates) {
      const spent = spentReferent(ev);
      if (spent && retireOneEngineEvent(ev.rowid, spent.reason, {
        taskId: ev.task_id, runId: ev.run_id, createdAt: ev.created_at, referentState: spent.state,
      })) retired++;
    }
  } catch { /* serve boundary is best-effort; eligibility gates still apply */ }
  return retired;
}

/** Keyed trigger retirement at CLOSE time: work retires its drivers the moment it lands
 *  instead of drivers discovering staleness later. Unclaimed rows only; a live turn keeps its trigger. */
export function retireEngineEventsForRun(runId: string, reason = 'run_closed'): number {
  let n = 0;
  try {
    n += sweepByReferent({ referent: 'run_id', id: runId });
    if (n > 0) logger.info('serve boundary: run close retired its unserved trigger(s)', { runId, reason, retired: n });
  } catch { /* best effort */ }
  return n;
}

export function retireEngineEventsForTask(taskId: string, reason = 'task_terminal'): number {
  let n = 0;
  try {
    n += sweepByReferent({ referent: 'task_id', id: taskId });
    if (n > 0) logger.info('serve boundary: task terminal state retired its unserved event(s)', { taskId, reason, retired: n });
  } catch { /* best effort */ }
  return n;
}

/** Expire exhausted engine events LOUDLY: one owner-visible notice per event, guarded by the
 *  `swept_at` stamp's `changes` count, atomic per row and safe across restarts. Never throws. */
export function expireExhaustedEngineEvents(agentId: string): number {
  let expired = 0;
  try {
    const db = getDb();
    // Stamp `swept_at` on the row itself: the once-guard (`swept_at IS NULL` + .changes) stays atomic.
    const exhaustedTail =
      `AND (delivery_attempts >= ${ENGINE_EVENT_MAX_ATTEMPTS}
            OR created_at <= (unixepoch('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours') * 1000))`;
    const rows = db.prepare(
      `SELECT seq AS rowid, content FROM messages
        WHERE agent_id = @agentId AND ${DELIVERABLE_ENGINE_EVENT_WHERE} ${exhaustedTail}`,
    ).all({ agentId }) as Array<{ rowid: number; content: string }>;
    for (const r of rows) {
      const changed = sweepByRowid({ rowid: r.rowid, agentId });
      if (changed === 0) continue; // another process expired it first; its notice already posted
      expired++;
      // Strip the engine `[SOURCE: ...]` tag so the 100-char gist is the reminder text itself.
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

/** Record one failed/aborted delivery: a spent serve, next due at the later of the backoff and a provider's reset
 *  (`retryAt`); if it exhausts the lifecycle the event expires loudly here. */
export function recordEngineEventDeliveryFailure(agentId: string, rowid: number, retryAt: number | null = null): void {
  try {
    if (spendServe(agentId, rowid, ENGINE_EVENT_MAX_ATTEMPTS, { minutes: ENGINE_EVENT_BACKOFF_MINUTES, retryAt })) expireExhaustedEngineEvents(agentId);
  } catch { /* best effort, failure bookkeeping must never mask the original abort */ }
}

/** Earliest FUTURE retry ms among in-lifecycle events, or null; the owed clock (`owed.ts`) wakes the agent then. */
export function getNextEngineEventRetryAt(agentId: string): number | null {
  try {
    const db = getDb();
    const sessionStart = sessionStartOf(agentId);
    const retryGates =
      `AND created_at >= (unixepoch(@sessionStart) * 1000)
       AND created_at >= (unixepoch('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours') * 1000)
       AND delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}
       AND next_attempt_at > (unixepoch('now') * 1000)`;
    const row = db.prepare(
      `SELECT MIN(next_attempt_at) AS t FROM messages
        WHERE agent_id = @agentId AND ${DELIVERABLE_ENGINE_EVENT_WHERE} ${retryGates}`,
    ).get({ agentId, sessionStart }) as { t: number | null } | undefined;
    if (row?.t == null) return null;
    return Number.isFinite(row.t) ? row.t : null;
  } catch {
    return null;
  }
}

// Events fired before a session reset are stranded by the `created_at >= session_started_at` gate;
// re-home them to the new boundary. Idempotent, best-effort. Only unserved, in-lifecycle events move;
// served rows and human chat stay (a reset still wipes it), exhausted ones expire, never revive.
export function rehomeUnclaimedEngineEvents(agentId: string, newBoundary: string): number {
  try {
    const changed = rehomeUndeliveredCreatedAt({
      agentId,
      newBoundary,
      eligibleWhere: DELIVERABLE_ENGINE_EVENT_WHERE,
      maxAttempts: ENGINE_EVENT_MAX_ATTEMPTS,
      expiryHours: ENGINE_EVENT_EXPIRY_HOURS,
    });
    if (changed > 0) {
      logger.info('re-homed fired-but-undelivered engine event(s) across session reset', { agentId, count: changed }, agentId);
    }
    return changed;
  } catch {
    return 0;
  }
}

/** How long a helper's result, or another agent's request once served, stays owed. */
export const TERMINAL_WAKE_WINDOW_MS = 45 * 60_000;

/** Newest never-served terminal-wake A2A row, by unserved-ness, not recency alone; the owed items (`owed.ts`)
 *  read it. */
export function findUnservedTerminalWake(agentId: string): { rowid: number } | null {
  const db = getDb();
  // AGE-BOUNDED on purpose: an unbounded finder frames turns on stale rows, and those turns create
  // REAL new threads, so the storm feeds itself; "unserved" means `served_by_turn IS NULL` only.
  const row = db.prepare(`
    SELECT seq AS rowid FROM messages
     WHERE agent_id = @agentId AND role = 'user'
       AND lane <> 'events'
       AND a2a_thread_id IS NOT NULL
       AND a2a_intent IN ('DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL')
       AND a2a_requires_response = 1
       AND served_by_turn IS NULL AND swept_at IS NULL
       AND created_at >= (unixepoch('now') * 1000 - ${TERMINAL_WAKE_WINDOW_MS})
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get({ agentId }) as { rowid: number } | undefined;
  return row ? { rowid: row.rowid } : null;
}

/** The next deliverable engine event. `pure` writes nothing: instead of expiring and retiring first, it skips an
 *  event whose referent is spent (the clock's read). */
export function getPendingEngineEvent(agentId: string, opts: { pure?: true } = {}): { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null; rootKind: string | null; rootId: string | null } | null {
  const db = getDb();
  if (!opts.pure) {
    // Dispose exhausted/overdue events LOUDLY first, so every eligibility consumer drives the notice.
    expireExhaustedEngineEvents(agentId);
    // Premise re-check BEFORE eligibility, at the single choke point every consumer funnels through.
    retireSpentEngineEvents(agentId);
  }
  const sessionStart = sessionStartOf(agentId);
  // Clock order with the INSERTION key as tiebreak: `created_at` is second-granular, rowid breaks ties.
  const engineGates =
    `AND created_at >= (unixepoch(@sessionStart) * 1000)
     AND created_at >= (unixepoch('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours') * 1000)
     AND delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}
     AND (next_attempt_at IS NULL OR next_attempt_at <= (unixepoch('now') * 1000))`;
  const rows = db.prepare(
    `SELECT seq AS rowid, id, task_id, run_id, content, origin_intent, root_kind, root_id FROM messages
       WHERE agent_id = @agentId AND ${DELIVERABLE_ENGINE_EVENT_WHERE} ${engineGates}
     ORDER BY created_at ASC, rowid ASC LIMIT ${opts.pure ? 50 : 1}`,
  ).all({ agentId, sessionStart }) as Array<EventReferent & { rowid: number; id: string; content: string }>;
  const row = opts.pure ? rows.find((r) => spentReferent(r) === null) : rows[0];
  // The 6-hour horizon bounds the lifecycle: historical unstamped rows must not return as pending.
  return row ? { rowid: row.rowid, id: row.id, taskId: row.task_id, runId: row.run_id, content: row.content, originIntent: row.origin_intent, rootKind: row.root_kind, rootId: row.root_id } : null;
}

export interface TurnCounterparty {
  kind: 'user' | 'agent';
  name: string;
  relation: Relation;
  channel: Channel;
  /** Stable sender id (address/handle) for matching this exact conversation. */
  senderId: string | null;
  /** A2A thread (for agent turns), null for human turns. */
  threadId: string | null;
  /** True when this human-kind counterparty is itself another Dojo agent (inbound_meta `senderIsAgent`).
   *  Engine acks are gated on `!senderIsAgent`: an ack would wake the peer box again. */
  senderIsAgent: boolean;
}

/** One routing pass delivers ONE string to a routed human channel while the dashboard mirrors every
 *  iteration: a persisted-only line reaches nobody, a dashboard-only line reads as a second reply. */
export function isRoutedHumanCounterparty(counterparty: TurnCounterparty): boolean {
  return counterparty.kind === 'user'
    && (counterparty.relation === 'owner' || counterparty.relation === 'known_contact')
    && (counterparty.channel === 'imessage' || counterparty.channel === 'sms'
      || counterparty.channel === 'teams' || counterparty.channel === 'email');
}

/** Routed-human counterparties the ack pusher (`deliverEngineUserAck`) has an arm for, minus phone
 *  (live voice has its own lane). Email is refused, not deferred; a channel joins only when the
 *  pusher gains an arm. */
export function engineAckReachesTheirChannel(counterparty: TurnCounterparty): boolean {
  return isRoutedHumanCounterparty(counterparty)
    && (counterparty.channel === 'imessage' || counterparty.channel === 'sms'
      || counterparty.channel === 'teams');
}

/** Read the structured `senderIsAgent` flag off a trigger row's inbound_meta JSON. Defaults false. */
function readSenderIsAgent(inboundMeta: string | null | undefined): boolean {
  if (!inboundMeta) return false;
  try {
    const meta = JSON.parse(inboundMeta) as InboundMeta;
    return meta?.senderIsAgent === true;
  } catch {
    return false;
  }
}

/** One key identifying ONE conversation, computed identically from a counterparty OR a message
 *  origin; two messages share a conversation iff their keys match. */
export function conversationKey(channel: Channel | null, senderId: string | null, senderName: string | null, threadId?: string | null): string {
  // Key on the FULL thread id: an 8-char prefix collapses distinct `thread-<hash>` ids together.
  if (channel === 'a2a') return `a2a:${(threadId ?? senderId ?? '')}`;
  if (channel === 'dashboard' || channel === 'voice' || channel === null) return 'owner';
  const who = (senderId || senderName || 'unknown').toLowerCase();
  return `${channel}:${who}`;
}

export interface ResolveCounterpartyArgs {
  isA2ATurn: boolean;
  a2aFromName: string | null;
  a2aThreadShort: string | null;
  triggerContent: string | null;
  triggerLane: string | null;
  triggerChannel: string | null;
  triggerInboundMeta: string | null;
  inboundChannel: Channel | null;
}

export function resolveTurnCounterparty(args: ResolveCounterpartyArgs): TurnCounterparty {
  if (args.isA2ATurn) {
    return {
      kind: 'agent',
      name: args.a2aFromName ?? 'another agent',
      relation: 'agent',
      channel: 'a2a',
      senderId: args.a2aFromName ?? null,
      threadId: args.a2aThreadShort,
      // The A2A lane is its own entity; senderIsAgent flags a user-CHANNEL sender, never an A2A turn.
      senderIsAgent: false,
    };
  }
  const origin = deriveOrigin({
    role: 'user',
    content: args.triggerContent,
    ...legacyOriginInputs(args.triggerLane, args.triggerChannel),
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
    // The trigger row's inbound_meta flag says the sender is another Dojo agent; gates acks.
    senderIsAgent: readSenderIsAgent(args.triggerInboundMeta),
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


/** The explicit turn header: appended AFTER the cached system prefix so cache churn stays out of it. */
export function renderCounterpartyHeader(
  cp: TurnCounterparty,
  opts?: { isEngineTurn?: boolean; isNotificationTurn?: boolean; address?: TurnAddress },
): string {
  // Reply channel = the turn ADDRESS's delivery channel: the same value drives real delivery.
  const replyChannelKey: string = opts?.address?.kind === 'person' ? opts.address.deliveryChannel : cp.channel;
  const channel = CHANNEL_LABEL[cp.channel] ?? cp.channel;
  const replyChannel = CHANNEL_LABEL[replyChannelKey] ?? replyChannelKey;
  // A notification-only wake has NO person on the other end: without this variant it fell through
  // to the owner-on-dashboard header, which the awareness lane contradicts. It REPLACES that framing.
  if (opts?.isNotificationTurn) {
    return (
      `## What triggered this turn\n` +
      `This turn was triggered by a mailbox/channel notification, NOT a person messaging ` +
      `you. Do NOT greet or message the user unless the item genuinely matters to them ` +
      `right now; if there is nothing to surface, end with [no-reply].`
    );
  }
  // An engine turn synthesizes a user-shaped counterparty; without this it claimed a person was
  // talking. Render the engine variant; no spontaneous owner texts unless the event is for delivery.
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
  // Close-the-loop advice, non-owner human turns only: a promised follow-up commits to an action
  // the engine cannot detect. Advice only; absent for the owner, so no system-prompt bloat.
  const closeTheLoop =
    cp.relation !== 'owner'
      ? ` Close-the-loop: if your reply promises to follow up with ${getOwnerName()} ` +
        `(e.g. "I'll ask/tell/check with them"), actually do it THIS turn, create a ` +
        `reminder or send ${getOwnerName()} a note. Your written reply goes to ${cp.name}, not ${getOwnerName()}, ` +
        `so reach ${getOwnerName()} with an explicit send that names ${getOwnerName()} as the recipient. ` +
        `A promise to a contact isn't kept until you act on it.`
      : '';
  // Two lines, one per question: who sent this, and who the written reply goes to.
  return (
    `## Who you are talking to this turn\n` +
    `Who sent this: **${cp.name}** (${relationWords(cp.relation)}), over ${channel}.\n` +
    `Your written reply goes to **${cp.name}** (${relationWords(cp.relation)}) by ${replyChannel}. ` +
    `Anything in your context marked as memory, an event, ` +
    `or another agent's message is background, it is NOT ${cp.name} talking.` +
    closeTheLoop
  );
}
