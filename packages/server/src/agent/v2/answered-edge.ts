// ════════════════════════════════════════════════════════════════════════════════
// THE ANSWERED EDGE — the ONE place this tree answers "has the person heard from us".
// PHASE-2 T6 (research 07-FULL requirement rows 1a, 1b, 1c, 1e, 1g, 2b, 2d).
//
// WHAT THIS REPLACES, named so the removal can be checked rather than trusted. Seven
// mechanisms each carried their own definition, and research 07 §1 records what each one
// got wrong when they disagreed:
//
//   * a PROSE CLASSIFIER (`CLOSEOUT_WHOLE_RE`, a 20-phrase regex) decided whether the
//     model's last line "was a closeout" and suppressed it — prose as authority, the exact
//     shape the deliverable-claim floor was removed for TWICE (research 21, caution 2);
//   * `state.surfacedReplyThisTurn` / `deferredDeliveredByAck`, turn-local booleans that a
//     process death erases;
//   * a scan of `legacy_tasks.status='complete'` joined by hand, per row, to
//     `messages.answer_message_id`;
//   * `hasUnansweredUser`, an ARRAY the loop had to build (with a per-row origin
//     re-derivation) just to ask "is anything outstanding";
//   * `conv_key IS NULL` and `swept_at IS NULL`, two columns on the message doing the
//     obligation's job (PHASE-2 T3 took the first half, this file finishes the reading
//     side);
//   * `terminalAnswerRowId`, a loop-local variable set at four persist sites;
//   * and the turn record's OWN `exit_reason` / `answered` / `answer_message_id`, which
//     `finalizeTurn` has always written and which NOTHING read (research 21, R-0 — "the
//     one-line proof of the whole thesis").
//
// The edge itself is `work.result_delivery_id`: work is answered because something was
// DELIVERED, and the delivery is a row written by the transport door that performed the
// send (PHASE-2 T5). `messages.answer_message_id` (migration 113) stays as the second half
// of the same edge — requirement 2d says one edge must serve BOTH the answer-receipt read
// and the closeout-owe read — and it is the dated fallback for rows written before the
// ticket existed, exactly the way T5 dated its own pre-ledger fallbacks.
//
// EVERY FUNCTION HERE IS A READER, with two exceptions at the bottom (the pause and its
// reopen), and those two are marked, argued and named to their converting task.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import type { TurnExitReason } from './turn-record.js';
import { writeTaskLog } from '../../tracker/task-log.js';
import { askIdForMessage, type WorkState } from '../../work/store.js';
// T19 (D2): the DECLARED set of bubbles the platform has already ruled not-an-answer. One
// owner, three readers (this file, `work/occurrences.ts`, `work/ask-remediation.ts`).
import { NON_ANSWERING_DISPLAY_KINDS } from '../../work/ask-settlement.js';
import { taskScope, tsToMs, type TrackerStatus } from '../../work/tracker-view.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { recordedInstant } from '../../memory/message-stamp.js';
// TYPE ONLY, and deliberately: the withdrawal predicate below names report STATES, so the
// compiler must see the same closed set `report/store.ts` declares. No value crosses this
// import, so the report store's doors — the only writers of that column — stay one-way.
import type { ReportStatus } from '../../report/store.js';

const logger = createLogger('answered-edge');

/** Deliveries that are not an ANSWER to anybody, and counting one would mark a question
 *  answered before anybody looked at it.
 *
 *  ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02). The marker read "the engine saying
 *  'on it' … T4 removes the lane". T4 removed the ENGINE'S PROSE from it, not the lane: the
 *  one surviving caller delivers the MODEL'S own opening line early (`loop.ts:4582`,
 *  `startLine`), which §T0-PINS E names as the shape OR2 wants. The exclusion stands on its
 *  own footing now — a START-ACK IS NOT AN ANSWER, whoever wrote it. Kept in step with
 *  `work/ask-settlement.ts`'s `NON_ANSWERING_DELIVERY_TOOLS` by the conformance test beside it. */
const NON_ANSWERING_TOOLS = ["'engine-ack'"];

// ════════════════════════════════════════════════════════════════════════════════
// 2d — the answer-receipt read AND the closeout-owe read, from one place.
// ════════════════════════════════════════════════════════════════════════════════

export interface AnswerReceipt {
  /** Has the person had an answer to this ask? */
  answered: boolean;
  /** The delivery that proves it, when the spine holds one. */
  deliveryId: string | null;
  /** The answering message row (migration 113), when one was stamped. */
  answerMessageId: string | null;
  /** True when this ask has no ticket at all — a row written before PHASE-2 T3. */
  legacyRow: boolean;
}

const NO_RECEIPT: AnswerReceipt = {
  answered: false, deliveryId: null, answerMessageId: null, legacyRow: false,
};

/**
 * Requirement 2d, both directions at once.
 *
 * `answered === true`  -> the ANSWER-RECEIPT read: the person has it, do not re-announce.
 * `answered === false` -> the CLOSEOUT-OWE read: this ask still owes an answer.
 *
 * The two records are unioned deliberately rather than ranked. The ticket's
 * `result_delivery_id` is the strong form and is what every new row gets; the mig-113 stamp
 * covers rows written before the ticket existed AND any send path whose delivery record is
 * still missing. The union stands on the T8c measurement below — nineteen rows a person WAS
 * answered on — and on nothing else.
 *
 * ⚠ WHAT THIS PARAGRAPH USED TO SAY, AND WHO OVERRULED IT. It read: *"Erring toward 'answered'
 * here can only ever SUPPRESS a second announcement; erring the other way re-tells a person
 * something they already have, which is the defect this machinery exists to prevent (owner
 * transcript 2026-07-23)."* The GOVERNING priority is owner ruling **2026-08-05**, thirteen days
 * later (`DESIGN-2BUGS/DESIGN.md:46`): *"the user asks the agent to do something and it does it.
 * Period."* — when evidence of an answer is absent OR AMBIGUOUS the system errs toward SERVING
 * THE ASK AGAIN, and the no-double-answer protection survives strictly SUBORDINATE to it ("it is
 * politeness, and it may never cost the owner an answer"). `work/ask-settlement.ts:28-36` records
 * that reversal by name for its own header; this file was not swept with it, and the round-2 red
 * is what that cost. So the 2026-07-23 direction is not authority for suppressing anything: its
 * *"can only ever suppress"* premise is false the moment the earlier work has been WITHDRAWN,
 * which is what `answerStillStands` (below) checks for every read that lists or quotes a settled
 * ask. This function's own union is unchanged — its direction rests on the measurement, not on
 * the overruled precedent.
 */
export function answerReceiptForAsk(messageId: string | null | undefined): AnswerReceipt {
  if (!messageId) return NO_RECEIPT;
  const db = getDb();
  const row = db.prepare(
    `SELECT w.state AS state, w.result_delivery_id AS delivery_id, m.answer_message_id AS answer_message_id,
            (w.id IS NULL) AS no_ticket, (m.id IS NULL) AS no_message
       FROM (SELECT ? AS mid) q
       LEFT JOIN work w ON w.id = ?
       LEFT JOIN messages m ON m.id = q.mid`,
  ).get(messageId, askIdForMessage(messageId)) as
    | { state: string | null; delivery_id: string | null; answer_message_id: string | null;
        no_ticket: number; no_message: number }
    | undefined;
  if (!row || (row.no_ticket === 1 && row.no_message === 1)) return NO_RECEIPT;
  // ── PHASE-2 T8c item 2 — THE STAMP ARM WAS BOOKED TO GO PURE-LEGACY HERE, AND THE
  // MEASUREMENT REFUSED IT. T6 concern 5 predicted that once tasks lived on the spine the
  // mig-113 stamp would be a pure legacy fallback and could be dated out. Re-derived at this
  // HEAD, READONLY, on this box:
  //
  //   stamped messages with NO ask ticket at all (genuinely legacy, pre-T3)   -> 586
  //   stamped messages WITH a ticket that is not done-with-delivery           ->  19
  //   ...and every one of those 19 is state='abandoned', not 'open'
  //
  // So the 19 are not legacy rows and not a bug in the ticket: they are asks a person WAS
  // answered on and that T6's unservable-ask reaper later abandoned. Ranking the ticket above
  // the stamp would flip all nineteen from "answered" to "not answered", and the consequence
  // of THAT error is re-telling somebody something they already have — the direction T6
  // deliberately chose against. The union therefore stands, and it stands on a measurement
  // rather than on inertia.
  //
  // RETIREMENT CONDITION, as a command rather than a feeling (T10 owns it): the stamp arm may
  // be dropped when this returns 0 —
  //   SELECT count(*) FROM messages m JOIN work w ON w.root_id = m.id AND w.kind='ask'
  //    WHERE m.answer_message_id IS NOT NULL
  //      AND NOT (w.state='done' AND w.result_delivery_id IS NOT NULL);
  // What IS ranked, and always was: `deliveryId` comes from the ticket or not at all, so a
  // caller that needs a receipt it can point at never gets one the stamp cannot back.
  const byTicket = row.state === 'done' && row.delivery_id !== null;
  const byStamp = row.answer_message_id !== null;
  return {
    answered: byTicket || byStamp,
    deliveryId: byTicket ? row.delivery_id : null,
    answerMessageId: row.answer_message_id,
    legacyRow: row.no_ticket === 1,
  };
}

/** The closeout-owe read, phrased the way its callers ask it. */
export function owesAnswer(messageId: string | null | undefined): boolean {
  return !answerReceiptForAsk(messageId).answered;
}

/**
 * THE PRE-SPINE FALLBACK for the same question, for work with no birthing ask to key on:
 * "since this instant, has the person had a substantive, MODEL-AUTHORED reply?"
 *
 * Excluded, and each exclusion is a fact the row carries rather than a guess about its text:
 * the a2a lane (not the person), tool_use/tool_result JSON blobs (`[{`), every engine-stamped
 * row (`origin_intent IS NOT NULL` — this is how a promoted start-ack is refused, exactly as
 * T2's stamp was written to be read), and anything under 40 trimmed characters.
 *
 * UX-REPAIR T15 — ONE COPY, AND A BOUNDARY THAT IS ms ON BOTH SIDES. This clause list used to
 * exist twice, in `finalize/completion-ack.ts` and `execute/result-notes.ts`, each with its own
 * `created_at >= (unixepoch(?) * 1000)` round-trip over a column that is ALREADY epoch ms.
 * The round-trip is the defect's family: `unixepoch()` of an ms NUMBER is NULL, and an INTEGER
 * ms column bounded by a TEXT datetime matches nothing in SQLite — which is precisely how the
 * completion probe's scaffold selector sat dormant for its whole life. So the parameter here is
 * ms, the column is ms, and there is no conversion anywhere on the path. Two copies of one
 * question could answer it differently; one cannot.
 */
export function substantiveReplySince(agentId: string, sinceMs: number): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM messages
      WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?
        AND lane <> 'a2a'
        AND content NOT LIKE '[{%'
        AND origin_intent IS NULL
        AND length(trim(content)) > 40
      LIMIT 1`,
  ).get(agentId, sinceMs);
}

// ════════════════════════════════════════════════════════════════════════════════
// DOES THIS ANSWER STILL STAND? — ONE PREDICATE, APPLIED BY EVERY READ BELOW THAT
// LISTS OR QUOTES A SETTLED ASK (DOJO-REPORT round-2 red).
//
// THE DEFECT, and it is a MISSING EDGE. The reads below answer "has the person heard from us"
// off `messages.answer_message_id` alone, and nothing on that path ever looks at the ARTEFACT
// the answer announced. `dojo_report` is the one user-facing door in this tree that writes no
// `deliveries` row — 0 rows in the whole dev database, ever — so the stamp and the preview card
// it claimed have NO EDGE between them and nothing can notice when the card is withdrawn.
// Cancel the card, re-ask in an ordinary paraphrase, and the model is handed "do NOT re-execute
// this work" plus a verbatim quote of its own *"sitting on your dashboard as a preview card"*.
// The reproduction is not repeated here: `__tests__/a-withdrawn-report-is-not-an-answer.test.ts`
// carries both arms, door by door, in its header.
//
// THE LAW THIS SERVES — owner ruling 2026-08-05, the governing priority: when evidence of an
// answer is absent OR AMBIGUOUS the system errs toward SERVING THE ASK AGAIN, and the
// no-double-answer protection is subordinate to it. See `answerReceiptForAsk` above for what
// that ruling overruled in this file. The priority's one declared limit ("it does not extend to
// answering twice", `overhaul-plans/UX-REPAIR.md:355`) does not reach this case: the row was
// withdrawn, so re-filing produces ONE card, not two.
//
// WHAT IT IS KEYED ON: ROWS, NEVER WORDS. The trigger is not "the answer mentions a report" —
// a prose classifier here is the exact shape the deliverable-claim floor was removed for TWICE
// (see this file's header), and there is still no regex in this file and no text read. It is a
// row-to-row join the engine already records: the `tool_use` rows inside the stamp's own window →
// their `report_id` → `dojo_reports.status`. No migration, no new column, no new writer.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * The report states in which the artefact — or its delivery — STILL STANDS, so the answer that
 * announced it is still true and is listed and quoted exactly as before.
 *
 * Reasoned per state rather than as a list, because the direction of each is the whole ruling:
 *   * `awaiting_approval` — the preview card is on the owner's dashboard. The claim is true;
 *   * `approved`          — decided, waiting on the transport. Still standing;
 *   * `posted`            — delivered, by `markPosted` OR by `markExported` (the export door
 *                           writes `status='posted'` with `export_path`, so "exported" is this
 *                           state and needs no entry of its own);
 *   * `cancelled`         — WITHDRAWN. Nothing is on the dashboard; the claim is false;
 *   * `drafting`          — the claim was PREMATURE. This is round 1's false-filed shape: a
 *                           brief attached, nobody ever asked, and the agent announcing a card
 *                           that was never submitted. Void.
 * Anything this release does not recognise falls outside the set and is therefore treated as
 * withdrawn — the same safe direction `report/store.ts`'s rule 4 takes for an unknown status.
 */
const STANDING_REPORT_STATUSES: readonly ReportStatus[] = ['awaiting_approval', 'approved', 'posted'];

/** The one tool whose recorded calls this predicate reads, by the name on the call row. */
const REPORT_TOOL_NAME = 'dojo_report';

/**
 * THE CHEAP GATE, and it is also the blast-radius statement: an agent with NO non-standing report
 * row cannot have a withdrawn-report answer, so every read below returns exactly what it returned
 * before this task and pays one tiny-table read to prove it. `drafting` is non-standing, so an
 * in-flight or abandoned draft arms the gate as well — deliberate (a `drafting` row IS round 1's
 * false-filed shape), and the reason this is not phrased as "never withdrew a report".
 *
 * COST, measured readonly on the owner's box: the plan is `SCAN dojo_reports` — there is no index
 * on `agent_id`, only `(status, created_at)`, `signature` and the PK — at **0.010 ms over 14 rows**.
 * Left as a scan deliberately: the index-using form is `status IN (<the non-standing values>)`, and
 * a closed IN-list cannot express "anything this release does not recognise", which is the safe
 * direction `report/store.ts`'s rule 4 takes and the one row of the per-status table nothing else
 * holds. It grows with every report ever filed; when that table stops being tiny, index `agent_id`.
 *
 * A database with no `dojo_reports` table (a hand-built test fixture) has no reports at all,
 * which is the same answer — this is not a swallowed failure, it is the truth on that box.
 */
function agentHasWithdrawnReport(agentId: string): boolean {
  const marks = STANDING_REPORT_STATUSES.map(() => '?').join(', ');
  try {
    return getDb().prepare(
      `SELECT 1 AS ok FROM dojo_reports
        WHERE agent_id = ? AND status NOT IN (${marks}) LIMIT 1`,
    ).get(agentId, ...STANDING_REPORT_STATUSES) !== undefined;
  } catch {
    return false;
  }
}

// ── THE TWO ARMS, AS TWO STATEMENTS, AND THE REASON IS 207× ──────────────────────────────
// They were ONE statement carrying `(m.turn_number = ? OR (m.seq >= ? AND m.seq <= ?))`, and an OR
// across two different indexes gets NEITHER. Measured readonly on BehaviorBot — 38,872 messages,
// and it is the release ritual's own agent: the plan was `SEARCH m USING INDEX
// idx_messages_agent_id (agent_id=?)`, i.e. every message row of the agent with `json_each` over
// each `[{%` one, at 18.7 ms — and `recentlyAnsweredAsks(limit=3)` runs on EVERY model call,
// uncached, so 52.4 ms per call, growing with the agent's lifetime. Split, each arm gets the index
// its plan names: turn arm `ix_msg_turn (agent_id=? AND turn_number=?)` 0.023 ms; span arm
// `idx_messages_agent_id (agent_id=? AND rowid>? AND rowid<?)` — `seq` IS the rowid — 0.022 ms.
// The whole read goes 52.4 ms -> 0.253 ms. Identical answer: each arm is its own `DISTINCT` and the
// union is taken below, which is all the predicate ever asked of the set.
//
// WRITTEN OUT TWICE ON PURPOSE. A shared fragment with `${…}` in it would make both statements
// unpreparable as written, and the SQL gate prepares every literal statement in this tree against
// the migrated schema — that check is worth more than the eleven duplicated lines.
//
// `content LIKE '[{%'` is the same structural prefilter `substantiveReplySince` above already uses
// to tell a tool_use envelope from prose — it reads the JSON frame, never the words — and the
// `CASE WHEN json_valid` guard is what makes `json_each` unable to throw on a prose row whatever
// the planner decides to evaluate first.
const REPORT_STATUSES_IN_TURN = `SELECT DISTINCT (SELECT status FROM dojo_reports
                         WHERE id = json_extract(j.value, '$.input.report_id')
                           AND agent_id = m.agent_id) AS status
         FROM messages m,
              json_each(CASE WHEN json_valid(m.content) THEN m.content ELSE '[]' END) j
        WHERE m.agent_id = ? AND m.turn_number = ?
          AND m.role = 'assistant' AND m.content LIKE '[{%'
          AND json_extract(j.value, '$.name') = ?
          AND json_extract(j.value, '$.input.report_id') IS NOT NULL`;
const REPORT_STATUSES_IN_SPAN = `SELECT DISTINCT (SELECT status FROM dojo_reports
                         WHERE id = json_extract(j.value, '$.input.report_id')
                           AND agent_id = m.agent_id) AS status
         FROM messages m,
              json_each(CASE WHEN json_valid(m.content) THEN m.content ELSE '[]' END) j
        WHERE m.agent_id = ? AND m.seq >= ? AND m.seq <= ?
          AND m.role = 'assistant' AND m.content LIKE '[{%'
          AND json_extract(j.value, '$.name') = ?
          AND json_extract(j.value, '$.input.report_id') IS NOT NULL`;

/**
 * Does the answer this stamp points at STILL STAND — i.e. may it be listed and quoted as
 * something the person already has?
 *
 * `false` ONLY when `dojo_report` rows are bound inside the window below and every one of them has
 * left the standing set. A stamp with no report call in its window, one whose report is still on
 * the card, and one that re-filed after a cancel (a withdrawn row AND a standing row — measured,
 * Arm A) all still stand: this refuses one shape, an answer whose only artefacts are gone.
 *
 * ── WHAT THE WINDOW IS, AND WHAT IT IS NOT ──
 * It is RAW CONTAINMENT, and calling it "the answering episode" (as this comment did) overstates
 * it: rows whose `turn_number` equals the stamp's turn, plus rows whose `seq` falls between the ask
 * and its answer. Agent-scoped — NOT conversation-scoped, while the reads it filters are. Both arms
 * are needed and each was measured against the two real shapes: Arm B records the `dojo_report`
 * calls on turn 1 (seq 83301/83303/83305) while the stamp points at turn 2's reply (seq 83314),
 * because the engine's "you have not spoken yet this turn" hint opens a new turn — the SPAN arm
 * catches that; the kit-driven agent (BehaviorBot, six asks, `served_by_turn == answer.turn_number`)
 * writes its call rows AFTER the answer row inside one turn — the TURN arm catches that, and it is
 * why the window deliberately reaches past the answer.
 *
 * FOUR OVER-VOID SHAPES ARE MEASURED AND ACCEPTED, stated because the previous wording ("it can
 * reach neither before the ask nor past the answer") was false in both halves: (a) two asks batched
 * into ONE turn void together, because `setAnswerMessageId` stamps every row with that
 * `served_by_turn`; (b) the span arm does the same for anything answered between the pair; (c) a
 * report call in ANOTHER conversation inside the seq span voids a dashboard ask; (d) the turn arm
 * also reaches call rows written BEFORE the ask.
 *
 * THE DIRECTION IS THE RULING'S, AND THE COLLATERAL IS MEASURED, NOT ASSUMED. Over the live body:
 * 8 of 4,240 answered asks on gate-armed agents are voided and ALL EIGHT are genuine report asks —
 * zero collateral; the enabling fan-out is 89 of 4,511 stamped asks (~2%) and it additionally needs
 * that batch to hold report work that later dies; spans are short (mean 6.0 rows, max 81, none over
 * 100). An over-void costs one unrelated ask its anti-repetition — the owner may hear an answer
 * twice, which 2026-08-05 chooses in those words — while the under-void direction IS the round-2
 * red. Narrowing it to a true ask-binding wants the `dojo_reports.ask_id` column the investigation
 * named; until then this is the honest description of what it does.
 *
 * ⚠ THE ANSWER ROW IS RESOLVED HERE, BEHIND THE GATE, AND NOT BY THE CALLERS. Its two columns could
 * have ridden along on each read's own query — and one of those reads is the one
 * `conversation-identity-is-the-fk.test.ts` pins BY ITS SQL TEXT (`AND conversation_id = ?`), which
 * a self-join has to alias away. A clause that then passes on a DIFFERENT read's unqualified copy of
 * that string is the silent re-pointing the guard-corpus census exists to stop, so the reads keep
 * their SQL and the span is resolved once, here, only when the gate is open.
 */
export function answerStillStands(
  agentId: string, askSeq: number, answerMessageId: string | null | undefined,
): boolean {
  if (!agentHasWithdrawnReport(agentId)) return true;
  if (!answerMessageId) return true;
  let statuses: Array<string | null>;
  try {
    const db = getDb();
    const ans = db.prepare(
      'SELECT seq, turn_number AS turn FROM messages WHERE id = ? AND agent_id = ?',
    ).get(answerMessageId, agentId) as { seq: number; turn: number | null } | undefined;
    // A stamp whose answer row is gone (a cleared history) has no window to check, and it
    // counted as answered before this task — it still does.
    if (!ans) return true;
    const arm = (sql: string, params: unknown[]): Array<string | null> =>
      (db.prepare(sql).all(...params as never[]) as Array<{ status: string | null }>)
        .map((r) => r.status);
    statuses = ans.turn === null ? [] : arm(REPORT_STATUSES_IN_TURN, [agentId, ans.turn, REPORT_TOOL_NAME]);
    statuses = statuses.concat(arm(REPORT_STATUSES_IN_SPAN, [agentId, askSeq, ans.seq, REPORT_TOOL_NAME]));
  } catch (err) {
    // ⚠ FAIL OPEN — ARGUED, NOT CONVENIENT, AND SAID OUT LOUD. A throw here is the INSTRUMENT
    // failing, not ambiguity about whether the person was answered, and the 2026-08-05 priority
    // governs the second question rather than the first. Failing CLOSED would void EVERY answered
    // ask on the agent — all three reads filter through this — so one malformed row would re-open
    // the owner's 2026-08-09 repeat-yourself incident across the board; failing open loses only
    // the withdrawal check, which is precisely the pre-fix behaviour. So it stays `true` and it
    // SHOUTS, because a silent revert to the behaviour this task exists to remove is how the defect
    // comes back. Pinned by "the instrument failing is LOUD, and it fails OPEN" — deleting this log
    // or flipping the direction is RED there.
    logger.error(
      'answered-edge: the withdrawn-report check could not run, so this answer stamp STANDS '
      + '(pre-fix behaviour) — until this is fixed a cancelled report card can be asserted as live',
      { askSeq, answerMessageId, error: err instanceof Error ? err.message : String(err) },
      agentId,
    );
    return true;
  }
  // A call whose id resolves to NO row binds nothing — there is no artefact to contradict the
  // claim, so the stamp is left alone. Only a row that EXISTS and has left the standing set is
  // a withdrawal, and one standing row anywhere in the window is enough to keep the answer.
  const bound = statuses.filter((s): s is string => s !== null);
  if (bound.length === 0) return true;
  return bound.some((s) => (STANDING_REPORT_STATUSES as readonly string[]).includes(s));
}

/**
 * The agent's OWN recorded answer in this conversation, most recent first.
 *
 * The engine hands this back to the model to restate when a question it already answered is
 * ghosted a second time (OR2: the engine never speaks as the agent, so it quotes the
 * agent's own words rather than re-serving them itself). It is the answered edge walked in
 * the other direction — from the ask to the reply — and it lives here so the edge has one
 * home rather than a hand-written two-table join inside the loop.
 *
 * ⚠ THE FIFTH CARRIER OF THE ROUND-2 RED, and the predicate above is why it is now safe. Its
 * one consumer is the ghosted-ask ladder's second rung (`steps/post-call-classify/no-reply.ts`,
 * *"you already answered this in this conversation. Your recorded answer: … Do not re-do the
 * work and do not stay silent."*), which quotes this string under the same authority framing as
 * the two prompt-assembly reads. A withdrawn-report answer returns `null` here and the rung
 * simply does not fire — it does not reach further back for an OLDER answer, because this read
 * is scoped to the newest settled ask and quoting a different one would put a claim in front of
 * the model that was never on offer.
 */
export function recordedAnswerInConversation(agentId: string, conversationId: string): string | null {
  const r = getDb().prepare(
    `SELECT m2.content AS answer, m1.seq AS ask_seq, m2.id AS ans_id
       FROM messages m1 JOIN messages m2 ON m2.id = m1.answer_message_id
      WHERE m1.agent_id = ? AND m1.role = 'user' AND m1.conversation_id = ?
        AND m1.answer_message_id IS NOT NULL AND m2.role = 'assistant'
      ORDER BY m1.created_at DESC LIMIT 1`,
  ).get(agentId, conversationId) as
    | { answer: string; ask_seq: number; ans_id: string }
    | undefined;
  if (!r) return null;
  if (!answerStillStands(agentId, r.ask_seq, r.ans_id)) return null;
  return r.answer;
}

// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 4 — THE PROMPT-ASSEMBLY READS OF THE SAME EDGE.
//
// Two blocks put "what you already answered" in front of the model, and until this task both
// of them hand-wrote their own join against `messages.answer_message_id` at the injection
// site — the exact shape this file's header says the edge exists to stop. They live here now.
//
// ⚠ WHAT MOVING THEM FOUND, and it is the mechanism behind the owner's 2026-08-09 incident:
// the `engine.recently-answered` block was DEAD. `messages.created_at` became an epoch-ms
// INTEGER at migration 131; the block passed that integer to `relativeTimeAgo`, which took a
// SQLite datetime STRING and called `.replace` on it. Every render threw
// `sqliteUtc.replace is not a function` on its FIRST row, straight into a
// `catch { /* best effort */ }`. Measured on the owner's own body: 3,181 answered-stamped
// rows, and the block builds for none of them. The engine's only standing instruction not to
// re-execute finished work has not reached a model since 131 landed. The type is handled ONCE
// here now, so a second caller cannot re-acquire the same bug.
// ════════════════════════════════════════════════════════════════════════════════

/** How many settled asks the engine names. RC's own choice, carried: "the last few asks of
 *  THIS conversation that already have answers ... Bounded: 3 lines". The recall lane reads
 *  the same number so the two blocks cannot name different sets of the same thing. */
export const RECENTLY_ANSWERED_LIMIT = 3;

/** One ask this agent has already answered in a conversation, newest first. */
export interface AnsweredAsk {
  askId: string;
  askContent: string;
  /** Epoch ms — `messages.created_at` since migration 131. */
  askAt: number;
}

/**
 * The last `limit` asks of ONE conversation that carry an answer stamp.
 *
 * This is `engine.recently-answered`'s read. It is deliberately conversation-scoped and
 * deliberately recency-ordered: it is a ledger of this thread's settled questions, not a
 * search. What it CANNOT do — reach across a session or conversation boundary, or say what
 * the answer actually was — is the recall lane's half (`memory/recall-lane.ts`).
 *
 * ⚠ AND IT DROPS AN ANSWER WHOSE ARTEFACT IS GONE (`answerStillStands`). This read feeds BOTH
 * failing carriers of the round-2 red — the `engine.recently-answered` block itself
 * (`steps/call-llm/pre-call-injections.ts`) and the recall lane's dedup set
 * (`memory/recall-lane.ts`) — which is exactly why the predicate belongs here and not at
 * either injection site.
 *
 * THE LIST SHORTENS; IT DOES NOT REACH FURTHER BACK. A voided row is filtered out of the rows
 * this query already returned and nothing older is pulled up to replace it. Refilling would put
 * a fourth, older ask in front of the model that it was not going to see AND drop that ask's
 * pair out of the recall lane (which dedups against this set) — two behaviour changes on asks
 * that have nothing to do with the withdrawn report. Shortening changes neither.
 */
export function recentlyAnsweredAsks(
  agentId: string, conversationId: string, limit: number,
): AnsweredAsk[] {
  const rows = getDb().prepare(
    `SELECT id, content, created_at, seq, answer_message_id FROM messages
      WHERE agent_id = ? AND conversation_id = ? AND role = 'user'
        AND answer_message_id IS NOT NULL
      ORDER BY created_at DESC LIMIT ?`,
  ).all(agentId, conversationId, limit) as Array<{
    id: string; content: string; created_at: number; seq: number; answer_message_id: string;
  }>;
  return rows
    .filter((r) => answerStillStands(agentId, r.seq, r.answer_message_id))
    .map((r) => ({ askId: r.id, askContent: r.content, askAt: r.created_at }));
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T69b — THE RECENTLY-ANSWERED BLOCK, A PURE FUNCTION OF ITS ROWS.
//
// It was an inline `.map()` in `steps/call-llm/pre-call-injections.ts` — the same shape, and
// the same consequence, as the hand-written JOIN this file's header names as the disease. Two
// things come with the move, and neither is cosmetic:
//
//  1. THE CLOCK LEAVES IT. It rendered `relativeTimeAgo(a.askAt)`, off `Date.now()`, so a
//     byte-identical set of settled asks emitted different bytes at every bucket boundary —
//     "just now" → "1 minute ago" → … — and this block sits AHEAD of the whole per-ask half
//     of the tail, so each tick re-billed everything behind it. It states the RECORDED
//     INSTANT now, in the one stamp format the fresh tail above it already uses and
//     `msg.current-time` below it already explains ("subtract from the current time").
//     Measured on the dev box at `2557747`, three consecutive quiet turns: this block was the
//     FIRST divergence in the tail on every one of them.
//
//  2. IT IS TESTABLE. "identical rows ⇒ identical bytes" cannot be asserted about a `.map()`
//     that only exists inside a 240-line async injection function holding an `AgentTurnState`.
//
// The excerpt slice, the frame and the wording are carried verbatim; only the time term moved.
// ════════════════════════════════════════════════════════════════════════════════════════

/** How much of the ask is quoted. Carried verbatim from the deleted inline render. */
const ANSWERED_EXCERPT_CHARS = 90;

export const RECENTLY_ANSWERED_HEAD =
  'RECENTLY ANSWERED in this conversation (engine record; do NOT re-execute this work. If '
  + "asked about it again, a brief restatement of the answer's content is fine, or point at "
  + 'the earlier answer; never silence, and never re-run the work itself):';

export function renderRecentlyAnsweredBlock(asks: readonly AnsweredAsk[]): string | null {
  if (asks.length === 0) return null;
  const lines = asks.map((a) => {
    const excerpt = a.askContent.replace(/^\[[^\]]*\]\s*/g, '').trim().slice(0, ANSWERED_EXCERPT_CHARS);
    return `- answered ${recordedInstant(a.askAt)}: "${excerpt}"`;
  });
  return `${RECENTLY_ANSWERED_HEAD}\n${lines.join('\n')}`;
}

/** An ask and the reply that answered it, as one fact. */
export interface AnsweredPair {
  askId: string;
  askContent: string;
  askAt: number;
  answerId: string;
  answerContent: string;
  answerAt: number;
}

/**
 * Resolve any of the given message ids to the ANSWERED PAIR it belongs to — the ask half or
 * the answer half, whichever won the search.
 *
 * The recall lane hits raw rows by meaning, and a hit on an old question is worth very little
 * on its own: it tells the model it was asked something, not what it concluded. This walks
 * the same edge `recordedAnswerInConversation` walks, in both directions and for a SET, so
 * the lane can carry the conclusion beside the question.
 *
 * Scope is NOT widened: `agent_id` binds both halves, so one agent's recall can never surface
 * another's answer. The returned map holds ONE object per pair, reachable under BOTH ids —
 * which is what lets a caller dedup a pair whose two halves both hit.
 *
 * ⚠ AND A PAIR WHOSE ARTEFACT IS GONE IS NOT RETURNED (`answerStillStands`). This is the read
 * that carries the VERBATIM ANSWER — the *"Written up and sitting on your dashboard as a
 * preview card"* quote the round-2 red served for a `cancelled` row — so the predicate is
 * applied here for the same reason it is applied to `recentlyAnsweredAsks`: one question, one
 * owner, and every downstream carrier inherits the answer rather than re-deriving it.
 */
export function answeredPairsForMessages(
  agentId: string, messageIds: readonly string[],
): Map<string, AnsweredPair> {
  const out = new Map<string, AnsweredPair>();
  if (messageIds.length === 0) return out;
  const marks = messageIds.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT ask.id AS ask_id, ask.content AS ask_content, ask.created_at AS ask_at,
            ans.id AS ans_id, ans.content AS ans_content, ans.created_at AS ans_at,
            ask.seq AS ask_seq
       FROM messages ask JOIN messages ans ON ans.id = ask.answer_message_id
      WHERE ask.agent_id = ? AND ans.agent_id = ?
        AND ask.role = 'user' AND ans.role = 'assistant'
        AND (ask.id IN (${marks}) OR ans.id IN (${marks}))`,
  ).all(agentId, agentId, ...messageIds, ...messageIds) as Array<{
    ask_id: string; ask_content: string; ask_at: number;
    ans_id: string; ans_content: string; ans_at: number; ask_seq: number;
  }>;
  for (const r of rows) {
    if (!answerStillStands(agentId, r.ask_seq, r.ans_id)) continue;
    const pair: AnsweredPair = {
      askId: r.ask_id, askContent: r.ask_content, askAt: r.ask_at,
      answerId: r.ans_id, answerContent: r.ans_content, answerAt: r.ans_at,
    };
    out.set(r.ask_id, pair);
    out.set(r.ans_id, pair);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════
// 1a — "did THIS turn already put the result in front of the person": a RECEIPT.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Requirement 1a. The old question was "does this text look like a closeout"; the honest
 * question is "is there a delivery on the ledger for this turn". PHASE-2 T5 made deliveries
 * universal at the five transport doors, so this is now answerable for every channel
 * including the dashboard bubble, which recorded nothing at all before that task.
 *
 * `conversationId` narrows to the person this turn is addressing: an email sent to a third
 * party while working on the owner's question is not the owner's answer. Pass `null` only
 * when the caller genuinely means "any person".
 *
 * ⚠ UX-REPAIR ROUND 4 T19 (D2) — AND THE HONEST QUESTION NEEDED ONE MORE CLAUSE TO BE HONEST.
 * The paragraph above was true about the LEDGER and false about the PERSON, because the
 * dashboard door records a receipt for EVERY assistant row including the tool-call chips.
 * Measured on the owner's box, 2026-08-10 13:45Z: a fired reminder produced FOUR `deliveries`
 * rows on one turn, all `outcome='delivered'`, `channel='dashboard'` — and all four pointed at
 * `display_kind='tool-turn'` message rows. Nothing the owner could read was among them. This
 * function returned TRUE, which suppressed the reminder-silence ghost (`handoff-floors.ts`),
 * the one arm whose whole job was to tell him the reminder never arrived.
 *
 * The narrowing is not new and is not invented here: `NON_ANSWERING_DISPLAY_KINDS` is the
 * declared set `work/ask-settlement.ts` already uses for exactly this reason — *"a bubble the
 * PLATFORM ITSELF has already declared not to be the answer … without this entry an ask could
 * be closed on a receipt pointing at a row the platform has on record as drafting"* — and
 * `work/occurrences.ts`'s `runDeliverableEvidence` reads it too. Three readers of one question
 * now read one set. IMPORTED, never retyped.
 *
 * A receipt with NO message row behind it (the channel doors write those) is untouched: the
 * clause is a `NOT EXISTS`, exactly as the deliverable authority writes it.
 */
export function turnDeliveredToPerson(
  agentId: string, turnNumber: number | null | undefined, conversationId?: string | null,
): boolean {
  if (turnNumber == null) return false;
  const db = getDb();
  const scoped = conversationId != null;
  const chipKinds = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  const hit = db.prepare(
    `SELECT 1 AS ok FROM deliveries d
      WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered'
        AND d.channel <> 'a2a'
        AND d.tool NOT IN (${NON_ANSWERING_TOOLS.join(', ')})
        AND NOT EXISTS (SELECT 1 FROM messages m
                         WHERE m.id = d.message_id AND m.display_kind IN (${chipKinds}))
        ${scoped ? 'AND d.conversation_id = ?' : 'AND d.conversation_id IS NOT NULL'}
      LIMIT 1`,
  ).get(...(scoped ? [agentId, turnNumber, conversationId] : [agentId, turnNumber])) as
    { ok: number } | undefined;
  return hit !== undefined;
}

/**
 * Requirement 1g — the DELIVERY the truthful-answer key points at.
 *
 * `terminalAnswerRowId` is `result_delivery_id` in embryo (research 07 §1): a loop-local
 * pointer to the message row that WAS the answer, set at four genuine user-facing persists
 * and nowhere else. What it never had was the receipt — the row proving the message left
 * the building. This resolves it from the same ledger every other reader here uses, so the
 * outcome ladder, the ticket stamps and the owe-filter are all looking at one fact.
 *
 * Newest first: a turn that delivered twice (a reply plus a stranded-file surface) is
 * proven by its latest send, which is the one the answer row belongs to.
 */
export function terminalDeliveryForTurn(
  agentId: string, turnNumber: number | null | undefined, conversationId?: string | null,
): string | null {
  if (turnNumber == null) return null;
  const scoped = conversationId != null;
  const r = getDb().prepare(
    `SELECT id FROM deliveries
      WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered'
        AND channel <> 'a2a'
        AND tool NOT IN (${NON_ANSWERING_TOOLS.join(', ')})
        ${scoped ? 'AND conversation_id = ?' : 'AND conversation_id IS NOT NULL'}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(...(scoped ? [agentId, turnNumber, conversationId] : [agentId, turnNumber])) as
    { id: string } | undefined;
  return r?.id ?? null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 1b — "did work close WITHOUT a delivery": a JOIN.
// ════════════════════════════════════════════════════════════════════════════════

export interface ClosedWithoutDelivery {
  workId: string;
  kind: string;
  title: string | null;
  rootId: string;
  state: string;
  conversationId: string | null;
}

/**
 * Requirement 1b. Work that reached a terminal state inside the window with nothing
 * delivered for it. `done` cannot appear here — the DDL's own CHECK forbids `done` without
 * `result_delivery_id`, which is the point: the only way to close silently is to close
 * `failed` or `abandoned`, and that is a fact the engine should say out loud rather than a
 * pattern it should detect in prose.
 */
export function closedWithoutDelivery(
  agentId: string, sinceMs: number, limit = 5,
): ClosedWithoutDelivery[] {
  return getDb().prepare(
    `SELECT id AS workId, kind, title, root_id AS rootId, state, conversation_id AS conversationId
       FROM work
      WHERE agent_id = ? AND state IN ('done','failed','abandoned')
        AND closed_at >= ? AND result_delivery_id IS NULL
      ORDER BY closed_at ASC LIMIT ?`,
  ).all(agentId, sinceMs, limit) as ClosedWithoutDelivery[];
}

// ════════════════════════════════════════════════════════════════════════════════
// 1c — turn end enumerates still-claimed work, WITH the identity to escalate.
// ════════════════════════════════════════════════════════════════════════════════

export interface ClaimedWork {
  workId: string;
  kind: string;
  title: string | null;
  conversationId: string | null;
  claimedByTurn: number | null;
  rootId: string;
}

/**
 * Requirement 1c. The escalation used to enumerate `legacy_tasks.status='in_progress'` and
 * then hunt for who to tell; a claim is a state on the spine now and it carries the
 * conversation it belongs to, so the identity comes back with the row.
 */
export function stillClaimedWork(
  agentId: string, opts?: { turnNumber?: number | null; limit?: number },
): ClaimedWork[] {
  const db = getDb();
  const turnNumber = opts?.turnNumber ?? null;
  const limit = opts?.limit ?? 10;
  const params: unknown[] = [agentId];
  let clause = '';
  if (turnNumber != null) { clause = 'AND claimed_by_turn = ?'; params.push(turnNumber); }
  params.push(limit);
  return db.prepare(
    `SELECT id AS workId, kind, title, conversation_id AS conversationId,
            claimed_by_turn AS claimedByTurn, root_id AS rootId
       FROM work
      WHERE agent_id = ? AND state = 'claimed' ${clause}
      ORDER BY opened_at ASC LIMIT ?`,
  ).all(...params) as ClaimedWork[];
}

// ════════════════════════════════════════════════════════════════════════════════
// 1e — "settled" is ONE query.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Requirement 1e: "any work open for a human counterparty right now?"
 *
 * The consumers are the proactive-send budget and the settled-context channel hold. Both
 * used `!hasUnansweredUser`, which required BUILDING the waiting set — fifty rows, a
 * per-row origin re-derivation and a Map — to learn a single boolean.
 *
 * SCOPE, stated because it is a decision and not an accident: `kind='ask'`. An open TASK is
 * work the agent owes ITSELF; an open ASK is a person waiting on a reply, which is what
 * "settled" has always meant here and what the proactive budget is calibrated against.
 * Widening it to every open row would silence the settled-context hint on any box carrying
 * an open backlog, which is a behaviour change nobody asked for.
 *
 * The join to `messages` is the identity half and it is load-bearing: an ask whose root row
 * is gone (a cleared history, a terminated agent) can never be served, and counting it would
 * leave the agent permanently un-settled. It is the same join the waiting set makes, so the
 * two cannot drift apart.
 */
export function hasOpenHumanWork(agentId: string): boolean {
  const hit = getDb().prepare(
    `SELECT 1 AS ok
       FROM work w JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
      WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'open' AND w.requester = 'owner'
      LIMIT 1`,
  ).get(agentId) as { ok: number } | undefined;
  return hit !== undefined;
}

// ════════════════════════════════════════════════════════════════════════════════
// The turn-outcome reader (PHASE-2 T2 adjudication #3 — the orphan-gate debt on
// `turns.exit_reason`). R-0's finding was that `finalizeTurn` writes the true outcome and
// nothing reads it. This is the reader, and the disposition below is its consumer.
// ════════════════════════════════════════════════════════════════════════════════

export interface TurnOutcome {
  exitReason: TurnExitReason | null;
  answered: boolean;
  answerMessageId: string | null;
  effectfulCalls: number;
  ended: boolean;
  convKey: string | null;
  subjectId: string | null;
}

export function turnOutcome(agentId: string, turnNumber: number | null | undefined): TurnOutcome | null {
  if (turnNumber == null) return null;
  const r = getDb().prepare(
    `SELECT exit_reason, answered, answer_message_id, effectful_calls, ended_at, conv_key, subject_id
       FROM turns WHERE agent_id = ? AND turn_number = ?`,
  ).get(agentId, turnNumber) as
    | { exit_reason: string | null; answered: number; answer_message_id: string | null;
        effectful_calls: number; ended_at: string | null; conv_key: string | null; subject_id: string | null }
    | undefined;
  if (!r) return null;
  return {
    exitReason: (r.exit_reason as TurnExitReason | null) ?? null,
    answered: r.answered === 1,
    answerMessageId: r.answer_message_id,
    effectfulCalls: r.effectful_calls ?? 0,
    ended: r.ended_at !== null,
    convKey: r.conv_key,
    subjectId: r.subject_id,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// THE DISPOSITION — the two writers in this file.
//
// PHASE-2 progress.md, T1 adjudication #2, ruled under standing authority: the plan clause
// "going idle reconciles to PAUSED, never complete" STANDS, and it is reconciled with the
// P2 drive boundary ("an in_progress task does not EVER just get ignored") by three riders,
// all three of which are implemented here and tested beside them:
//
//   (a) the transition keys on the ENGINE's own RECORD of the turn — `turns.exit_reason` +
//       `turns.answered` + `turns.effectful_calls`, plus the delivery ledger — and NEVER on
//       the shape of the model's prose. There is no regex in this file and no text is read;
//   (b) the REOPEN edge is part of the same requirement: the owner's next ask resumes the
//       work to the exact state it was paused from;
//   (c) paused work stays visible: `status='paused'` is a status the owner sees on the
//       board and the daily brief reads (PHASE-2 T7 lands that surface), NOT the hidden
//       `deliverable_shown` flag whose invisibility was the actual complaint behind P2.
//
// WHY THE DIFFERENCE FROM `deliverable_shown` IS STRUCTURAL, not a matter of degree. The
// deleted stamp inferred DELIVERY from the coexistence of a non-empty reply and open tasks,
// applied to EVERY in_progress task, was invisible, and stood the ladder down silently.
// This pauses only when the engine holds a DELIVERY RECEIPT for the turn, only when the
// turn performed ZERO effectful calls (a turn that acted is still working — the yacht
// research hour had exec and web calls in it and would not pause here), records itself in
// `task_log`, and is undone by the owner's next word.
//
// WHERE THESE TWO WRITE (PHASE-2 T8b, the conversion T6 declared and dated): both go
// through `transition()` on the `work` spine now. The pause carries the delivery receipt it
// already held as its evidence_ref, which is what lets it be `by: 'engine'` at all (G6: the
// engine may only assert what it can point at); the reopen is the OWNER's word and says so.
// ════════════════════════════════════════════════════════════════════════════════

/** States this disposition may move FROM. The drive states, and only those. */
const DRIVE_STATES = ["'claimed'"];

export interface PauseResult { paused: number; ids: string[] }

/**
 * The turn spoke to the owner, performed nothing, and closed nothing: the ball is with the
 * person, so the work stops being driven and starts waiting — visibly.
 *
 * Returns 0 without touching anything unless ALL of these hold, each a recorded fact:
 *   * the turn record says `answered` (the truthful-answer key, not "some text existed");
 *   * a real delivery for that turn is on the ledger (the receipt);
 *   * the turn recorded ZERO effectful calls (it did not DO anything, it TALKED);
 *   * the caller did not itself transition a ticket this turn.
 * Recurring schedules are carved out: a schedule is never paused by a missed close-out
 * (janitorial, not forgery — the carve-out is carried verbatim from the going-idle
 * reconciliation this replaces).
 *
 * `touchedSince` IS THE SCOPE, and it is the difference between this and the stamp P2
 * deleted. That one marked EVERY in_progress task delivered; this one may only dispose of
 * work THIS TURN ACTUALLY TOUCHED — `updated_at` inside the turn's own window. A backlog
 * item nobody moved is not this turn's to park, it is the poke ladder's to drive, and the
 * "idle in_progress task gets driven, always" invariant survives untouched because the rows
 * it guards are exactly the rows this window excludes.
 */
export function pauseDriveWorkWaitingOnOwner(
  agentId: string, turnNumber: number | null | undefined,
  opts?: {
    transitionedThisTurn?: boolean;
    conversationId?: string | null;
    /** SQLite datetime text ('YYYY-MM-DD HH:MM:SS'). Omitted only in unit tests. */
    touchedSince?: string | null;
    /** SWEEP-A TB2: did this turn DELEGATE the ask it was serving (a join under the trigger
     *  work row)? See the refusal below. */
    delegatedThisTurn?: boolean;
  },
): PauseResult {
  const none: PauseResult = { paused: 0, ids: [] };
  if (opts?.transitionedThisTurn) return none;
  // ⚠ SWEEP-A TB2 — A DELEGATING TURN IS NOT A TURN THAT HANDED THE BALL BACK.
  //
  // This disposition's whole premise is "the turn TALKED and did not ACT, so the work is now
  // waiting on the person". A turn that opened a delegation join did act: the work is waiting
  // on the PIECES, not on the owner, and pausing the compile self-task at that moment is the
  // same error as closing the owner's ticket on the status line — a job marked parked because
  // somebody said they had started it.
  //
  // MEASURED (run bmsfy5txir3, `delegation-longhorizon` attempt 1): the mid-delegation
  // snapshot read `"Compile final report" -> SELF status=paused`, which is clause (a)'s red
  // and, through `synthesisHonestlyOpen`, half of clause (d)'s. The delegating turn delivers
  // one status line and executes no NON-IDEMPOTENT call, so every gate below passed and the
  // engine paused the very task the owner had just told the agent to keep in progress.
  //
  // requirement preserved: the disposition still fires for a turn that genuinely answered and
  // performed nothing — that is unchanged and is what every other caller sees. This refuses
  // exactly one shape, and the shape is a ROW (`joinState(triggerWorkId) !== null`), never a
  // reading of what the turn said.
  if (opts?.delegatedThisTurn) return none;
  const outcome = turnOutcome(agentId, turnNumber);
  if (!outcome || !outcome.answered) return none;
  if (outcome.effectfulCalls > 0) return none;
  if (!turnDeliveredToPerson(agentId, turnNumber, opts?.conversationId ?? null)) return none;

  const db = getDb();
  const since = opts?.touchedSince ?? null;
  const sinceMs = since == null ? null : tsToMs(since);
  const rows = db.prepare(
    `SELECT w.id AS id, w.state AS state FROM work w
      WHERE ${taskScope('w')}
        AND w.agent_id = ? AND w.state IN (${DRIVE_STATES.join(', ')})
        AND w.is_paused = 0 AND w.repeat_interval IS NULL
        ${sinceMs != null ? 'AND w.updated_at >= ?' : ''}
      ORDER BY w.updated_at DESC LIMIT 10`,
  ).all(...(sinceMs != null ? [agentId, sinceMs] : [agentId])) as Array<{ id: string; state: string }>;
  if (rows.length === 0) return none;

  // The receipt this whole disposition is keyed on, resolved once: it is both the reason the
  // pause is allowed and the evidence G6 requires of an engine assertion.
  const receipt = terminalDeliveryForTurn(agentId, turnNumber, opts?.conversationId ?? null);
  const ids: string[] = [];
  for (const t of rows) {
    const r = setTrackerStatus(t.id, 'paused', {
      by: receipt ? 'engine' : 'agent', actorId: agentId,
      evidenceRef: receipt,
      expectedState: t.state as WorkState,
      reason: `turn ${turnNumber} delivered a reply to the person and executed no effectful call; `
        + 'the work is waiting on them, so it stops being driven and is surfaced by aging instead',
    });
    if (r.kind === 'applied') ids.push(t.id);
  }
  if (ids.length > 0) {
    // Written SYNCHRONOUSLY, in the same tick as the disposition. An audit entry that
    // lands one microtask later is an audit entry a crash can lose, and "the pause is
    // recorded where somebody can find it" is a property this file's tests assert.
    for (const id of ids) {
      writeTaskLog({
        taskId: id, fromEntity: 'engine', entryKind: 'transition',
        fromStatus: 'in_progress', toStatus: 'paused',
        actionTaken: 'waiting on the owner (turn answered, nothing performed, nothing closed)',
        reason: `turn ${turnNumber} delivered a reply to the person and executed no effectful call; `
          + 'the work is waiting on them, so it stops being driven and is surfaced by aging instead',
      });
    }
    logger.info('turn-end disposition: drive work reconciled to paused (waiting on the owner)', {
      agentId, turnNumber, count: ids.length, ids,
    }, agentId);
  }
  return { paused: ids.length, ids };
}

export interface ResumeResult { resumed: number; ids: string[] }

/**
 * THE REOPEN EDGE (rider b). The owner said something, so work that was waiting on them is
 * waiting no longer: it returns to EXACTLY the state it was paused from.
 *
 * Keyed on `status_before_pause`, which is the engine's own record that IT paused this row.
 * A task the owner or the model paused deliberately has no such record and is never touched
 * — that distinction is the whole reason the column is written rather than assuming
 * `in_progress`.
 */
export function resumeWorkOnOwnerAsk(agentId: string): ResumeResult {
  const db = getDb();
  const rows = db.prepare(
    `SELECT w.id AS id, w.status_before_pause AS prev FROM work w
      WHERE ${taskScope('w')}
        AND w.agent_id = ? AND w.state = 'paused' AND w.status_before_pause IS NOT NULL
        AND w.is_paused = 0
      ORDER BY w.updated_at DESC LIMIT 10`,
  ).all(agentId) as Array<{ id: string; prev: string }>;
  const ids: string[] = [];
  for (const t of rows) {
    // `by: 'owner'` is the literal truth of this edge and it is what makes it legal without
    // evidence: the owner spoke, and their word is the authority G8 recognises.
    const r = setTrackerStatus(t.id, t.prev as TrackerStatus, {
      by: 'owner', actorId: 'owner', expectedState: 'paused',
      reason: 'the engine paused this because the work was waiting on the owner; they have now spoken',
    });
    if (r.kind === 'applied') ids.push(t.id);
  }
  if (ids.length > 0) {
    for (const id of ids) {
      writeTaskLog({
        taskId: id, fromEntity: 'engine', entryKind: 'transition',
        fromStatus: 'paused', toStatus: 'in_progress',
        actionTaken: 'the owner answered; the work is driving again',
        reason: 'the engine paused this because the work was waiting on the owner; they have now spoken',
      });
    }
    logger.info('reopen edge: the owner answered, so engine-paused work resumed', {
      agentId, count: ids.length, ids,
    }, agentId);
  }
  return { resumed: ids.length, ids };
}
