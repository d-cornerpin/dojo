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
import { deriveOrigin, legacyOriginInputs, type Channel, type Relation, type InboundMeta } from '@dojo/shared';
import { getOwnerName } from '../../config/platform.js';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import {
  createdAtText,
  recordDeliveryAttempt,
  rehomeUndeliveredCreatedAt,
  sweepByReferent,
  sweepByRowid,
} from '../../memory/message-store.js';
import { conversationIdentityOf, type ConversationIdentity } from '../../memory/conversations.js';
import { ENGINE_RIDER_INTENTS_SQL } from './engine-riders.js';
import { transition } from '../../work/store.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../../work/tracker-view.js';
import { occurrenceRunStatus } from '../../work/occurrence-runs.js';
import { postAgentNotice } from '../agent-notice.js';

const logger = createLogger('counterparty');
// ── Counterparty serialization helper ──
// One source of truth (used by the loop to pick the turn's counterparty, the
// runtime to decide whether to re-trigger and drain, and the dev context-dump)
// for "which human conversations still have an unanswered message," in FIFO
// order.
//
// PHASE-2 T3 — THE QUEUE IS A STATE NOW, NOT A NULL.
// A conversation used to be WAITING when its inbound row's `conv_key` was still NULL:
// one column carried the conversation's IDENTITY and the turn's CLAIM at the same time,
// and `conv_key IS NULL` WAS the work queue (07 §structural finding, requirement 2a).
// It is now `work(kind='ask').state = 'open'` — a real state on a real ticket, opened in
// the same transaction as the message (memory/message-store.ts) and moved only by
// `transition()`.
// requirement preserved: the waiting set survives a restart (it is still a DB signal, on a
// stronger row), it is still scoped to the session, it is still oldest-first per ITEM
// rather than "a later reply exists" (P4), and engine events and A2A are still not human
// conversations here — they never open an ask.
export interface WaitingConversation {
  key: string;
  /** PHASE-2 T10I: the conversation as `conversations.id`, off the OLDEST unanswered row.
   *  NULL when no producer resolved one — the turn re-resolves at pickup via `identity`. */
  conversationId: string | null;
  /** This conversation's `conversations` unique-key identity, from the SAME origin `key` is
   *  derived from, so the pickup stamp cannot disagree with the key beside it. */
  identity: ConversationIdentity;
  /** The ticket this conversation's oldest unanswered message opened. The pickup CAS
   *  addresses THIS, not a rowid, and the D-2 race is settled on it. */
  workId: string;
  /** The conversation's NEWEST unanswered message row (kept for logging/context). */
  latest: {
    rowid: number; id: string; conversation_id: string | null; content: string;
    /** The stamped-at-ingest lane and channel (OR4). Attribution is PROJECTED from these
     *  (`legacyOriginInputs`) — the two compat columns are never read here. */
    lane: string; channel: string | null; source_agent_id: string | null;
    a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
    inbound_meta: string | null; origin_intent: string | null; created_at: string;
    /** The row's own ticket. Carried per-row because the trigger and its siblings are
     *  DIFFERENT asks, and each is claimed and closed on its own (P4, per-item). */
    work_id: string;
  };
  /** The conversation's OLDEST unanswered message row, this is the turn TRIGGER,
   *  so the agent answers a conversation's pending messages oldest-first and a
   *  later ping can't be answered before the request that preceded it (OPEN-12). */
  oldest: WaitingConversation['latest'];
  oldestWaitingRowid: number;
  // C24: the former `unanswered: string[]` field was deleted, it had zero consumers.
  // Its concern (a middle message, e.g. a relay request before a follow-up ping, being
  // dropped without a turn) is now preserved by the PER-MESSAGE ticket: every open ask
  // stays in the waiting set until IT is itself claimed at pickup, so no sibling is
  // collaterally marked served. No bulk-surfacing needed.
}

/** Every row shape below is read through this one projection list, so no query can
 *  accidentally omit a column the origin resolver needs.
 *
 *  `seq AS rowid` (T10, migration 133): `seq` is the table's INTEGER PRIMARY KEY now, so a
 *  bare `rowid` here would come back named `seq` and every `r.rowid` in this file — the
 *  waiting set's key, the quarantine's, the teardown claim's — would be `undefined`, with
 *  nothing thrown. This constant is where that would have happened silently: it is
 *  INTERPOLATED into four queries, so the string `rowid` never appears beside a `FROM
 *  messages` and the source walk in memory/__tests__/lane-readers.test.ts could not see it.
 *  The unit suite could: 45 integration tests went red on the promotion's first run because
 *  the turn stopped claiming its trigger. The walk resolves same-file constants now. */
const WAITING_COLS = `m.seq AS rowid, m.id, m.conversation_id, m.content, m.lane, m.channel,
  m.source_agent_id, m.a2a_thread_id, m.a2a_intent, m.a2a_requires_response, m.inbound_meta,
  m.origin_intent, ${createdAtText('m.created_at')}, w.id AS work_id`;

/**
 * T6: the candidate narrowing, in ONE place, for the four reads that must agree on it
 * (the waiting set, the quarantine, the teardown batch-claim and the owed-arrivals probe).
 * They were four copies of the same predicate kept in step by hand.
 *
 * PHASE-2 T3: the claim half of this predicate is GONE. `conv_key IS NULL` (unclaimed) and
 * `swept_at IS NULL` (drain-suppressed) were the two halves of "nobody has taken this on",
 * and both are now one fact on the ticket: `work.state = 'open'`. The join below IS the
 * queue.
 * requirement preserved (the one thing this rekey may not change): WHICH rows the agent
 * believes it owes a reply to. The ticket is opened at ingest behind the SAME structural
 * columns and the SAME `deriveOrigin` authorized-human verdict this predicate applied, so
 * the surviving `lane`/A2A filters below are now belt-and-braces rather than the decision —
 * kept, not deleted, because a pre-D-A a2a row migrated to `lane='owner'` while still
 * holding `a2a_thread_id`, and dropping them would change the answer on a lived-in box.
 *
 * The session bound moves to `work.opened_at`, which is stamped from the message's own
 * `created_at` — the same instant the old predicate compared, on the ticket that carries it.
 */
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

/** The origin of a candidate row, from the STAMPED lane/channel (never the compat columns). */
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

export function getWaitingHumanConversations(agentId: string): WaitingConversation[] {
  const db = getDb();
  const sessionStart = sessionStartOf(agentId);
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
    `SELECT ${WAITING_COLS}
       FROM ${WAITING_HUMAN_CANDIDATE_FROM}
      WHERE ${WAITING_HUMAN_CANDIDATE_WHERE}
      ORDER BY w.opened_at ASC, m.seq ASC LIMIT 50`,
  ).all({ agentId, sessionStart }) as WaitingConversation['latest'][];
  // OPEN-12 root fix, per-message "served", not "a later reply exists".
  // A user message is UNANSWERED iff its OWN TICKET is still `open` — i.e. no turn ever
  // CLAIMED it at pickup. The previous signal marked a message served whenever any reply
  // with a higher rowid existed for its conversation, so a DISTINCT message that arrived
  // mid-turn (a relay request before a follow-up ping) was collaterally served by the
  // unrelated reply and dropped without ever getting a turn. A per-ITEM claim cannot drop a
  // distinct ask: every open ask gets its own turn until it is itself picked up (P4).
  const agg = new Map<string, { latest: WaitingConversation['latest']; oldest: WaitingConversation['latest']; oldestWaitingRowid: number; workId: string; identity: ConversationIdentity }>();
  for (const r of rows) {                              // C1: now OLDEST → newest by rowid (ASC)
    const o = originOfCandidate(r);
    // The single "owes a reply" definition (see MESSAGE-ATTRIBUTION-REDESIGN §3):
    // a conversation the agent must answer is AUTHORIZED human inbound. Unauthorized
    // inbound (a mailbox notification about the owner's inbox, an unknown sender) is
    // Lane-3 awareness, the agent surfaces it to the owner, it never counts as a
    // waiting conversation. Skipping it here propagates to the trigger pick, the
    // runtime drain, hasUnansweredUser, and isA2ATurn, which all derive from this.
    if (o.kind !== 'user' || !o.authorized) continue;
    const key = conversationKey(o.channel, o.senderId, o.senderName, o.threadId);
    let e = agg.get(key);
    // C1: first seen (ASC) = OLDEST unanswered, and its ticket is the one the turn claims.
    if (!e) {
      e = {
        latest: r, oldest: r, oldestWaitingRowid: r.rowid, workId: r.work_id,
        identity: conversationIdentityOf(o.channel, o.senderId, o.senderName, o.threadId),
      };
      agg.set(key, e);
    }
    e.latest = r;                                      // iterating oldest→newest, last write = newest unanswered
  }
  return [...agg.entries()]
    .map(([key, e]) => ({
      key,
      conversationId: e.oldest.conversation_id ?? null,
      identity: e.identity,
      workId: e.workId,
      latest: e.latest,
      oldest: e.oldest,
      oldestWaitingRowid: e.oldestWaitingRowid,
    }))
    .sort((a, b) => a.oldestWaitingRowid - b.oldestWaitingRowid);              // FIFO by rowid
}

/**
 * D9: quarantine every OPEN ask belonging to one waiting conversation so it is skipped by
 * getWaitingHumanConversations. Used when a conversation's turn repeatedly hard-aborts
 * (poisoned attachment, per-thread provider error, oversized context): rather than letting
 * that poisoned head starve every other waiting conversation behind it, the drain
 * quarantines it and serves the next. Returns the number quarantined. Conservative: only
 * rows whose derived key matches `convKey` are touched, so a different conversation is
 * never collaterally hit.
 *
 * PHASE-2 T3: the suppression was a `swept_at` stamp on the message, chosen (D11) because
 * the alternative of the day OVERWROTE `conv_key` and destroyed the row's identity. That
 * trade-off is gone: the obligation and the identity are different rows now, so the ask
 * goes `abandoned` — a real terminal state with a reason and an event — and the message
 * keeps every fact it had. `abandoned` is exactly requirement 2b's "terminal state
 * reachable from three or more causes with a single-transition once-guard": `transition()`
 * refuses the second attempt, which is what `swept_at IS NULL` + `.changes` was doing by
 * hand.
 */
export function quarantineWaitingConversation(agentId: string, convKey: string): number {
  const db = getDb();
  const sessionStart = sessionStartOf(agentId);
  const rows = db.prepare(
    `SELECT ${WAITING_COLS}
       FROM ${WAITING_HUMAN_CANDIDATE_FROM}
      WHERE ${WAITING_HUMAN_CANDIDATE_WHERE}`,
  ).all({ agentId, sessionStart }) as Array<WaitingConversation['latest']>;
  let n = 0;
  for (const r of rows) {
    const o = originOfCandidate(r);
    if (o.kind !== 'user' || !o.authorized) continue;
    if (conversationKey(o.channel, o.senderId, o.senderName, o.threadId) !== convKey) continue;
    // `by: 'agent'` and not `'engine'`: the engine actor must point at an occurrence,
    // delivery or artifact (gate G6, OR2), and a quarantine has none by definition — the
    // whole reason it fires is that nothing happened. This is the agent's own drain giving
    // up on a conversation it cannot serve, and it is recorded as that.
    const res = transition(r.work_id, {
      to: 'abandoned', by: 'agent', actorId: agentId,
      // ⚠ SWEEP CORE-1 CT0 — THE REASON LINE SAID SOMETHING THAT HAD NOT HAPPENED, and a
      // write-off's own explanation is the one place that must not guess. TB3 §8.3 measured
      // the trip: `ask:3bba2728` reached this line after FIVE serving turns (452, 457-461)
      // that each COMPLETED and exited `no_reply_intended`. Nothing aborted. The old text —
      // "this conversation repeatedly aborted its turn" — sent every reader looking for a
      // crash that was never there, and it is the only sentence the owner ever sees about a
      // question that got written off. What is true of BOTH paths (the poisoned attachment
      // this ladder was built for AND the served-into-silence path TB3 found) is that the
      // conversation was served again and again and never produced a reply.
      reason: 'quarantined: this conversation was served again and again and never produced a reply '
        + '(a poisoned message, or turns that finish without answering), and it was starving the '
        + 'queue behind it',
    });
    if (res.kind === 'applied') n++;
  }
  return n;
}

/**
 * THE ASSEMBLED-CONTEXT SET: the asks that were IN FRONT OF THE MODEL when this turn wrote
 * its reply. Sibling user rows of the SAME conversation that arrived BEFORE the turn's final
 * context assembly were inside the context the reply was generated from (the per-iteration
 * reassembly pulls them into the fresh tail), so the reply answered them too. Rows arriving
 * AFTER the final assembly are deliberately absent and get their own turn, preserving OPEN-12
 * ("a genuinely newer message is served next").
 *
 * ── CONVERTED FROM A WRITER TO A READ, SWEEP-A TB1 (`DESIGN-2BUGS/DESIGN.md` §1b, row 2) ──
 * This was `claimAssembledSiblings`, and it moved rows `open -> claimed` at teardown with the
 * reason "answered as a sibling inside this turn's assembled context". Its recorded intent was
 * F9: a 1-second two-message burst got the IDENTICAL answer delivered twice, and the claim
 * stopped the drain re-serving an already-answered sibling. The owner's 2026-08-05 causal
 * correction is why the WRITE had to go: that double answer was itself a symptom of the
 * missing closure fact — the agent did not know it had already answered because the
 * settlement was never recorded — so the claim was a patch over the same seam as the fossil
 * bug, and it converted the double-answer symptom into the stranded-`claimed` symptom (the
 * claim landed AFTER the only closer scoped to that turn had already swept, so nothing could
 * ever close the row again).
 *
 * requirement preserved: no ask is answered twice. Under one settlement authority that is not
 * a mechanism at all — it is the record being correct. The answer's delivery CLOSES every ask
 * it settled, with the receipt on the row and `served_by_turn` stamped as part of the same
 * settlement, so the drain has nothing left to re-serve. This function reports the set; the
 * authority decides and writes. It performs no transition, and the census asserts that.
 */
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

/**
 * F3 (owed mid-turn interrupt): the AUTHORIZED-human user rows of THIS turn's
 * conversation that arrived AFTER the turn started and were pulled into the
 * answered context (so the settlement authority, fed by `assembledContextAsks`,
 * is about to adjudicate them), yet may never have been addressed. A sibling of
 * that read: it scopes to the SAME set (this
 * conversation, conv_key NULL, unswept, not engine, not A2A, created_at <= the
 * turn's final assembly), reusing the identical conversationKey logic, then
 * NARROWS to genuine mid-turn arrivals (created_at > turnStartedAt) so the turn's
 * own trigger (claimed + pre-dates the turn) and any pre-turn burst siblings
 * (already in the FIRST assembly, so answered as the turn's subject) are excluded.
 *
 * The loop re-prompts the model with these ONCE before turn-end, so a quick
 * question that landed mid-task is addressed instead of being silently absorbed
 * and then claimed as answered. This does NOT mutate anything (the existing claim
 * still owns the served-stamping, unchanged); it only reports the owed set,
 * oldest-first. The caller caps how many it quotes.
 */
export function getOwedMidTurnArrivals(
  agentId: string,
  convKey: string,
  turnStartedAt: string,
  assembledAtIso: string,
): Array<{ rowid: number; content: string }> {
  const db = getDb();
  const sessionStart = sessionStartOf(agentId);
  // Same window `assembledContextAsks` uses (<= the final assembly), plus the
  // strict turnStartedAt lower bound so only mid-turn arrivals qualify.
  const rows = db.prepare(
    `SELECT ${WAITING_COLS}
       FROM ${WAITING_HUMAN_CANDIDATE_FROM}
      WHERE ${WAITING_HUMAN_CANDIDATE_WHERE}
        AND m.created_at > (unixepoch(@turnStartedAt) * 1000)
        AND m.created_at <= (unixepoch(@assembledAt) * 1000)
      ORDER BY m.created_at ASC, m.seq ASC`,
  ).all({ agentId, sessionStart, turnStartedAt, assembledAt: assembledAtIso }) as Array<WaitingConversation['latest']>;
  const owed: Array<{ rowid: number; content: string }> = [];
  for (const r of rows) {
    const o = originOfCandidate(r);
    // Same authorized-human gate as getWaitingHumanConversations: only an
    // authorized human's ask is a conversation the agent owes a reply.
    if (o.kind !== 'user' || !o.authorized) continue;
    if (conversationKey(o.channel, o.senderId, o.senderName, o.threadId) !== convKey) continue;
    owed.push({ rowid: r.rowid, content: r.content });
  }
  return owed;
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
export const ENGINE_EVENT_BACKOFF_MINUTES = [1, 5, 15, 30, 60];

// Deliverable engine events only: the same intent exclusions as getPendingEngineEvent
// (a RIDER never delivers, so it never expires "loudly" either; the boot sweep disposes them
// silently as before).
// T6: `origin_kind = 'engine'` became `lane = 'events'` — the same fact, CHECK-constrained
// at the database instead of carried in a nullable free-text column. `origin_intent` stays
// byte-identical: it is the SECOND axis (which subsystem produced this) and `lane` cannot
// absorb its 17+ live values (PHASE-1.md T3-0b §2).
//
// ⚠ PHASE-2 T9 — "UNCLAIMED" IS `served_by_turn IS NULL`, THE REAL SERVE EDGE.
// This predicate read `conv_key IS NULL` and the pickup wrote the sentinel `conv_key='engine'`
// — a fake conversation key written onto the column that carries conversation IDENTITY,
// purely so this WHERE would stop returning the row. It is the same shape T4 deleted for the
// terminal A2A wake, it was the LAST claim job left on `conv_key` (requirement 3l keeps the
// identity half and only that), and T6 named T9 its owner with T10 as backstop because
// `conv_key` drops there. `served_by_turn` already means exactly "a turn took this", is
// already stamped on this very row by the same turn, and has no second meaning to destroy.
//
// ⚠ PHASE-2 T10H — AND THAT RE-POINT LEFT A HOLE THE SENTINEL HAD BEEN COVERING: a three-value
// literal against TEN rider writers, so 21 rider intents could drive turns of their own,
// silently, for four sittings. Finding, measurements and shape argument: `engine-riders.ts`.
const DELIVERABLE_ENGINE_EVENT_WHERE =
  `role = 'user' AND lane = 'events' AND served_by_turn IS NULL
   AND swept_at IS NULL
   AND (origin_intent IS NULL OR origin_intent NOT IN ${ENGINE_RIDER_INTENTS_SQL})`;

// T6 — THE TWO-TABLE DISPATCH IS GONE. D-A step 4 split an engine event's home between
// `messages` and `inter_agent_messages`, so every lifecycle read UNIONed both and tagged
// the source (`_src`) purely so the matching WRITE could address the right table — rowid is
// per-table, and a claim against the wrong one silently misses and re-delivers forever.
// T4 folded every writer into `messages` (`lane='events'`), so there is one home, one rowid
// keyspace, and no tag to carry: `EngineEventSrc` / `engineEventTable` and the six merged
// reads below collapse to single-table statements.
// requirement preserved: every lifecycle mutation reaches the row's ACTUAL home — now true
// by construction rather than by threading a tag through eight call sites.

// ── P2: the serve boundary (lanes & lineage plan, owner invariant 2026-07-20) ──
// "See if it is done" before doing: every queued engine event with a work
// referent (migration 112 columns) gets its PREMISE re-checked against present
// state before it can become a turn. A spent referent retires the event with a
// loud log and a task_log observation, never a model turn. Until this gate,
// eligibility was 100 percent delivery bookkeeping and the model was asked in
// prose to "skip stale triggers silently" (the confession this replaces).
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
      // Best-effort audit-trail entry on the task itself: identity plus time,
      // "trigger born X, referent reached state Y, retired unserved at now".
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

export function retireSpentEngineEvents(agentId: string): number {
  let retired = 0;
  try {
    const db = getDb();
    const candidates = db.prepare(
      `SELECT seq AS rowid, task_id, run_id, ${createdAtText()} FROM messages
         WHERE agent_id = @agentId AND ${DELIVERABLE_ENGINE_EVENT_WHERE} AND (task_id IS NOT NULL OR run_id IS NOT NULL)
       LIMIT 50`,
    ).all({ agentId }) as Array<{ rowid: number; task_id: string | null; run_id: string | null; created_at: string }>;
    for (const ev of candidates) {
      let reason: string | null = null;
      let referentState: string | null = null;
      if (ev.run_id) {
        const runStatus = occurrenceRunStatus(ev.run_id); // T10F: an occurrence id now
        if (!runStatus) { reason = 'run_missing'; referentState = 'run row gone'; }
        else if (runStatus !== 'running') { reason = 'run_closed'; referentState = `run ${runStatus}`; }
      }
      if (!reason && ev.task_id) {
        const task = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('w.state')} AS status, w.is_paused AS is_paused FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(ev.task_id) as { status: string; is_paused: number } | undefined;
        if (!task) { reason = 'task_missing'; referentState = 'task row gone'; }
        else if (task.status === 'complete' || task.status === 'fallen') { reason = 'task_terminal'; referentState = `task ${task.status}`; }
        else if (task.status === 'paused' && task.is_paused === 1) { reason = 'task_paused'; referentState = 'task paused'; }
      }
      if (reason) {
        if (retireOneEngineEvent(ev.rowid, reason, {
          taskId: ev.task_id, runId: ev.run_id, createdAt: ev.created_at, referentState,
        })) retired++;
      }
    }
  } catch { /* serve boundary is best-effort; eligibility gates still apply */ }
  return retired;
}

/**
 * P2: keyed trigger retirement at CLOSE time (the other direction of the serve
 * boundary): work retires its drivers the moment it lands, instead of drivers
 * discovering staleness later. Called from run-close and task-terminal
 * transitions. Unclaimed rows only; a claimed row belongs to a turn already
 * running and the serve boundary never yanks a live turn's trigger.
 */
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
    // One home, one keyspace (T6): stamp swept_at on the row itself, so the once-guard
    // (`swept_at IS NULL` + .changes) stays atomic per row.
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
    recordDeliveryAttempt({ agentId, rowid, attempts, backoffMinutes: backoffMin });
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
    // T6b: `next_attempt_at` IS epoch-ms now, so the answer this function has always
    // returned — a JS millisecond timestamp — is the stored value itself. The old body
    // parsed the TEXT back out (`Date.parse(t.replace(' ','T') + 'Z')`); that string no
    // longer exists, and `.replace` on a number would have thrown here rather than
    // returning a wrong time, which is why this consumer had to move with the column.
    if (row?.t == null) return null;
    return Number.isFinite(row.t) ? row.t : null;
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
 *   - only DELIVERABLE_ENGINE_EVENT_WHERE rows (lane='events', `served_by_turn` NULL,
 *     unswept, not an ENGINE RIDER): an already-claimed event (`served_by_turn` set, i.e.
 *     delivered) or ordinary human conversation (any other lane) is never touched, so a
 *     reset still wipes the chat as intended. (This prose still said `conv_key`.)
 *   - only rows still inside the delivery lifecycle (under max attempts) and inside
 *     the 6-hour horizon, so an already-exhausted event is left to expire loudly,
 *     never revived.
 * created_at is bumped to exactly the new boundary; the `created_at < boundary`
 * guard makes it idempotent (a re-run finds nothing left below the boundary).
 * Best-effort: a reset must never fail on carry-over bookkeeping. Returns the count.
 */
export function rehomeUnclaimedEngineEvents(agentId: string, newBoundary: string): number {
  try {
    // The `created_at < newBoundary` guard keeps the re-home idempotent: a re-run finds
    // nothing left below the boundary.
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

/**
 * E-A2: the oldest UNPROCESSED engine event (a scheduler/reminder/tracker/healer
 * row, lane='events', conv_key still NULL) in this session, or null. The
 * loop stamps an engine event's conv_key when it processes it (mirroring the human
 * pickup-stamp), so conv_key NULL = not yet handled. This lets the engine turn be
 * detected even when it isn't the MOST-RECENT inbound (a human message that raced
 * it would otherwise make mostRecentInbound non-engine and the event would be
 * silently starved, its task stuck in_progress forever). The runtime drain also
 * re-triggers while one is pending, so an engine event out-raced by a human still
 * gets its own turn after the human is served.
 */
/**
 * Newest UNSERVED terminal-wake A2A row (DELIVERABLE/ANSWER/COMPLETE/FAIL,
 * requires_response=1, never claimed by a turn). The
 * turn-start wake detection used to test only the absolute most-recent
 * inbound for wake shape, so a peer question arriving AFTER a deliverable
 * BURIED it: the wake run served the question, the deliverable stayed
 * unserved, and only a slow periodic ever picked it up (observed: a 5m20s
 * gap between a fan-out join completing and the compile turn). Selection by
 * unserved-ness fixes the pick; the runtime's turn-end drain uses the same
 * finder so a leftover wake re-queues immediately instead of waiting.
 */
export function findUnservedTerminalWake(agentId: string): { rowid: number } | null {
  const db = getDb();
  // AGE-BOUNDED (2026-07-23 PRODUCTION STORM, owner box on .20): a lived-in box carries a deep
  // backlog of never-served terminal rows from before served_by_turn stamping existed.
  // Unbounded, this finder dredged them up one per turn, framed turns around messages too old
  // to be in context, the model probed the senders about them, the probes created REAL new
  // threads and replies, and the turn-end drain queued the next stale row: a self-sustaining
  // cross-agent storm. A wake is a wake only while it is FRESH; older rows return to their
  // pre-.20 state (inert, never served), exactly how the box behaved before this finder.
  // PHASE-2 T4: "unserved" is the real serve edge, `served_by_turn`; the claim it replaces was
  // a fake conversation key ('a2a') written onto the identity column (3l).
  const row = db.prepare(`
    SELECT seq AS rowid FROM messages
     WHERE agent_id = @agentId AND role = 'user'
       AND lane <> 'events'
       AND a2a_thread_id IS NOT NULL
       AND a2a_intent IN ('DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL')
       AND a2a_requires_response = 1
       AND served_by_turn IS NULL AND swept_at IS NULL
       AND created_at >= (unixepoch('now', '-45 minutes') * 1000)
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get({ agentId }) as { rowid: number } | undefined;
  return row ? { rowid: row.rowid } : null;
}

export function getPendingEngineEvent(agentId: string): { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null } | null {
  const db = getDb();
  // D8: dispose exhausted/overdue events LOUDLY before answering "what's pending",
  // so every consumer of eligibility (loop pickup, runtime drain, boot owed-check)
  // also drives the once-per-event expiry notice deterministically.
  expireExhaustedEngineEvents(agentId);
  // P2 serve boundary: premise re-check BEFORE eligibility. A trigger whose run
  // closed or whose task went terminal/paused since it was queued retires here,
  // at the one choke point every consumer (drain, retry timer, boot) funnels
  // through, so a spent intention can never become a turn.
  retireSpentEngineEvents(agentId);
  const sessionStart = sessionStartOf(agentId);
  // T6: one home, one keyspace. The pick is oldest-first by the clock with the INSERTION
  // key as the tiebreak — a scheduler tick queues several events inside one clock second
  // and `created_at` is second-granular TEXT, so rowid is what actually orders them.
  const engineGates =
    `AND created_at >= (unixepoch(@sessionStart) * 1000)
     AND created_at >= (unixepoch('now', '-${ENGINE_EVENT_EXPIRY_HOURS} hours') * 1000)
     AND delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}
     AND (next_attempt_at IS NULL OR next_attempt_at <= (unixepoch('now') * 1000))`;
  const row = db.prepare(
    `SELECT seq AS rowid, id, task_id, run_id, content, origin_intent FROM messages
       WHERE agent_id = @agentId AND ${DELIVERABLE_ENGINE_EVENT_WHERE} ${engineGates}
     ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  ).get({ agentId, sessionStart }) as { rowid: number; id: string; task_id: string | null; run_id: string | null; content: string; origin_intent: string | null } | undefined;
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
  return row ? { rowid: row.rowid, id: row.id, taskId: row.task_id, runId: row.run_id, content: row.content, originIntent: row.origin_intent } : null;
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
  /**
   * RC-4.2: this user-kind counterparty is itself another Dojo agent texting over a
   * human channel (an iMessage safe-sender flagged `is_agent`). Read from the trigger
   * row's structured inbound_meta (senderIsAgent). The engine gates channel-delivered
   * start / completion / handoff acks on `!senderIsAgent`: another agent does not need
   * "on it" reassurance, and each such ack is a fresh inbound that wakes the peer box
   * (the ack ping-pong, H-5). Always false on A2A turns (kind='agent', a different
   * lane) and on ordinary human turns.
   */
  senderIsAgent: boolean;
}

/** RC-4.2: read the structured `senderIsAgent` flag off a trigger row's inbound_meta
 *  JSON (stamped by the iMessage bridge). Best-effort, defaults to false. */
function readSenderIsAgent(inboundMeta: string | null | undefined): boolean {
  if (!inboundMeta) return false;
  try {
    const meta = JSON.parse(inboundMeta) as InboundMeta;
    return meta?.senderIsAgent === true;
  } catch {
    return false;
  }
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
  /** T6: the STAMPED lane/channel of the trigger row; attribution is projected from them. */
  triggerLane: string | null;
  triggerChannel: string | null;
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
      // The A2A lane is a separate structural entity; senderIsAgent flags a
      // user-CHANNEL sender that happens to be an agent, which never applies here.
      senderIsAgent: false,
    };
  }
  // Human turn, derive the sender's origin from the triggering message.
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
    // RC-4.2: the sender is another Dojo agent iff the trigger row's inbound_meta
    // stamped senderIsAgent (iMessage bridge). Used to gate channel-delivered acks.
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
export function renderCounterpartyHeader(
  cp: TurnCounterparty,
  opts?: { isEngineTurn?: boolean; isNotificationTurn?: boolean; resolvedDestination?: Channel },
): string {
  // RC-10: the model must never be told "dashboard" on a turn the engine will actually
  // text. When the reply-destination resolver promoted an owner dashboard-default turn
  // to a routed channel (owner-channel affinity, presence-away), render the RESOLVED
  // destination as the reply channel instead of the raw inbound channel.
  const replyChannelKey = opts?.resolvedDestination ?? cp.channel;
  const channel = CHANNEL_LABEL[cp.channel] ?? cp.channel;
  const replyChannel = CHANNEL_LABEL[replyChannelKey] ?? replyChannelKey;
  // RC-5.2: a notification-only wake (no trigger row; the newest inbound is an
  // unauthorized mailbox/channel notice) has no person on the other end. Without this
  // it fell through to the owner-on-dashboard header ("You are responding to <owner>…
  // your reply goes back to them"), which the awareness lane directly contradicts; on
  // the weak model the header won every notification looked like an open channel to the
  // owner. Render a dedicated notification variant that REPLACES that framing.
  if (opts?.isNotificationTurn) {
    return (
      `## What triggered this turn\n` +
      `This turn was triggered by a mailbox/channel notification, NOT a person messaging ` +
      `you. Do NOT greet or message the user unless the item genuinely matters to them ` +
      `right now; if there is nothing to surface, end with [no-reply].`
    );
  }
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
    `Your reply goes back to them on ${replyChannel}. Anything in your context marked as memory, an event, ` +
    `or another agent's message is background, it is NOT ${cp.name} talking.` +
    closeTheLoop
  );
}
