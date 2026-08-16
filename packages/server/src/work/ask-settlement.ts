// ════════════════════════════════════════════════════════════════════════════════
// THE SETTLEMENT AUTHORITY FOR OWNER ASKS — SWEEP-A TB1 (`DESIGN-2BUGS/DESIGN.md` §1).
//
// ONE function decides whether an owner's ask is settled. Before this file, FOUR did
// (verify report M2, measured at `3439240`): the delivery-transaction closer, the boot
// reconciler's answered arm, the model's own `work_close_request` tool, and the join relay —
// each at a different moment, each with partial evidence, none aware of the others. The
// teardown batch-claim then wrote `claimed` AFTER the only closer scoped to that turn had
// already swept, so a whole class of answered asks was stranded `claimed` for ever: 36
// historical rows on the dev box, reproduced 4/4 by the kit scenario `ask-burst-always-settles`.
//
// ── THE RULE, STATED ONCE ──
// An ask closes only against a recorded DELIVERED delivery in the ask's own conversation
// that the ask entered the model's context BEFORE — and only if the ask row carries no
// unresolved delegation (`remaining_children > 0` or `compile_pending = 1` HOLDS it). An ask
// that got no qualifying delivery is returned to `open` — visible again — never left
// `claimed`, never closed.
//
// ── THE GOVERNING PRIORITY (owner ruling, 2026-08-05) ──
// "The user asks the agent to do something and it does it. Period." Every ambiguous-evidence
// tie-break in this file errs toward SERVING THE ASK AGAIN. Worst case the owner hears an
// answer twice; it never errs toward silence, a parked ticket or a quiet close. The
// no-double-answer protection the teardown batch-claim was built for (F9) survives strictly
// SUBORDINATE to that, and it survives as a PROPERTY rather than a mechanism: an answer
// delivered closes every ask it settled, with the receipt on the row, so the drain has
// nothing left to re-serve. Dedup is the record being correct.
//
// ⚠ WHAT THIS REVERSES, AND WHO REVERSED IT. `closeAsksForDelivery`'s own header recorded the
// opposite trade-off — an ask left `claimed` is "visible and inert … nobody is re-answered" —
// and P6b's revert refusal records the same direction ("a duplicate send is worse than a
// stranded ask"). The owner overruled that direction on 2026-08-05, in those words. The
// residual it buys is stated rather than hidden: a turn that executed a non-idempotent tool
// call and then delivered NOTHING hands its ask back, so the re-serve can repeat that call.
// The transition reason names the turn so the repeat is findable. P6b's own function
// (`revertAskClaimOnAbort`) is untouched and still refuses on the ABORT path; this is the
// turn-boundary adjudication, and at the boundary the owner's ruling governs.
//
// ── WHAT LIVES HERE AND WHAT DOES NOT ──
// The evidence predicate lives in `settleAsk` and nowhere else. The three invocation
// wrappers below carry SCOPE (which rows to ask about) and no decision of their own:
//   (a) `settleAsksForDelivery` — inside `recordDelivery`'s existing transaction, so the
//       delivery row and the close it causes still commit together (PHASE-4 T2's unit);
//   (b) `settleAsksAtTurnFinalize` — the final adjudicator, over every ask the turn CLAIMED
//       or that entered its ASSEMBLED CONTEXT. Structural invariant: no ask remains
//       `claimed` by a finalized turn;
//   (c) `reconcileOrphanedClaims` — boot, unchanged in trigger and window; only its
//       answered arm's decision is now shared.
// The join arm (`settleJoinDelivered`) is the same rule invoked from the relay and is folded
// in by SWEEP-A TB2, which also owns the join DRIVING, the escalation ladder and everything
// `blocked` beyond the hold written here.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { recordServingTurnByRowid, START_ACK_ORIGIN_INTENT } from '../memory/message-store.js';
import {
  appendWorkEvent, askIdForMessage, claimFailedJoinForLateAnswer, isTerminal,
  revertAskClaimOnAbort, transition,
  type WorkState,
} from './store.js';

const logger = createLogger('ask-settlement');

/** Tools whose delivery is NOT an answer to the ask that is open.
 *
 *  ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02). The marker said T4 would remove the
 *  `engine-ack` lane entirely. It removed the ENGINE'S PROSE from it instead: the lane's one
 *  surviving caller delivers the model's own opening line early, which is the shape OR2
 *  wants. The exclusion stands for the reason it always really had — A START-ACK IS NOT AN
 *  ANSWER — and closing an ask on one would mark a question answered before anybody looked
 *  at it. Kept in step with `agent/v2/answered-edge.ts`'s `NON_ANSWERING_TOOLS`.
 *
 *  Carried here VERBATIM from `work/store.ts` with the closer it belonged to. */
export const NON_ANSWERING_DELIVERY_TOOLS = new Set(['engine-ack']);

/**
 * ⚠ SWEEP-A TB2 — AND NEITHER IS A TOOL-CALL CHIP. The same doctrine, one row deeper.
 *
 * `messages.display_kind = 'tool-turn'` is an assistant row whose CONTENT is the model's
 * `tool_use` blocks; the dashboard renders it as a chip. It is `user-visible` (the person can
 * see that a tool ran) but it is not a REPLY, and the dashboard door records a `deliveries`
 * row for it exactly as it does for prose.
 *
 * MEASURED, not reasoned about — the premature close the kit scenario `delegation-longhorizon`
 * clause (e) reproduced 2 of 2 at `3439240` pointed at a chip on BOTH attempts (read from the
 * live body at TB2 Step 0):
 *
 *   ask:3857ef59  done 10:34:39  receipt 3da6365b -> message a03a5ac9  display_kind=tool-turn
 *   ask:b72e81ad  done 10:40:49  receipt 49c963a2 -> message 98ffe54b  display_kind=tool-turn
 *
 * …and on both attempts the model's real prose reply landed AFTER the delegation join opened,
 * so with the chip excluded the HOLD arm below fires on the real reply and the ask is never
 * terminal at all. That is why this is a NARROWING of the evidence rather than a re-open at
 * the turn boundary: the record is read as HISTORY, and a `done` that is later undone is
 * still a job that was marked finished before it happened.
 *
 * The exclusion is keyed on the delivery's OWN message row, so a channel send that records no
 * message id (email, iMessage, SMS) is untouched — it is excluded only when the row it
 * carried is provably a chip.
 */
/*
 * SWEEP CORE-2 item 7 ADDS `working-note`, and it is the same argument one step later rather
 * than a new one. A working note is a bubble the PLATFORM ITSELF has already declared not to
 * be the answer — mid-turn when the narration rode with a tool call
 * (`post-call-classify/terminal-text.ts`, 2026-07-10), or at the turn boundary when the
 * ledger key named a different bubble (`steps/teardown/draft-reclassify.ts`). Every one of
 * those bubbles STREAMED, so `deliveries` holds a dashboard receipt for it (PHASE-2 T5), and
 * without this entry an ask could be closed on a receipt pointing at a row the platform has
 * on record as drafting. That is CT0's defect class — `done` on the opening status line — in
 * a new spelling, and it is excluded here for the reason the chip is: it is a NARROWING of
 * what may count as an answer, never a widening.
 */
export const NON_ANSWERING_DISPLAY_KINDS = ['tool-turn', 'working-note'] as const;

// ⚠ DECLARED HERE, ABOVE THE PREDICATES, rather than beside the join arm that reads it:
// SWEEP CORE-1 CT0's `NOT_A_SUPERSEDED_BUBBLE` is a module-level SQL fragment and needs
// this set at module-evaluation time. It moved WHOLE — comment, name and value unchanged.
/**
 * ⚠ SWEEP-A TB13 — THE ENGINE'S OWN RELAY, NAMED ON THE LEDGER RATHER THAN INFERRED.
 *
 * `a2a-join-relay` is the tool the engine records when IT hands a delegated answer to the
 * owner (`agent/a2a-transport.ts`, both the one-piece deterministic relay and the compile
 * ladder's last rung). No model can call it: it is written by the platform, from the pieces
 * the peers actually returned, and it is by construction the compiled answer to the join it
 * names. That is why it is exempt from the delegating-turn narrowing below and why it is what
 * the ladder asks about before it speaks a second time.
 *
 * `a2a-join-failed` and `a2a-join-late` are deliberately NOT here: the first is a notice that
 * there is no answer, and the second has its own arm with its own boundary.
 */
export const ENGINE_JOIN_RELAY_TOOLS = new Set(['a2a-join-relay']);

/** How far back a boot reconciliation will reach. Carried verbatim from the pickup-stamp
 *  reconciliation it replaced (`index.ts` 4b1): a claim stranded by a genuine crash is
 *  seconds-to-minutes old, and anything older is history a restart must not re-answer. */
export const ORPHAN_CLAIM_WINDOW_MINUTES = 30;

/** Where in the lifecycle the question is being asked. It selects the TIE-BREAK when there
 *  is no evidence — never the evidence itself, which is identical at all three.
 *
 *  `join` (SWEEP-A TB2) is the fourth, and it is the one moment whose EVIDENCE differs, for a
 *  stated reason: a compiled answer to a delegated job arrives on a LATER turn than the one
 *  that opened the join, so "this turn's delivery" cannot be the test. What replaces it is
 *  strictly narrower, never wider — the delivery must postdate the join's own `join_complete`
 *  event, so nothing the delegating turn said about STARTING the work can ever be read as the
 *  answer to it. */
export type SettlementMoment = 'delivery' | 'finalize' | 'boot' | 'join';

export type AskSettlementVerdict = 'closed' | 'held' | 'reopened' | 'unchanged';

export interface AskSettlementOutcome {
  workId: string;
  verdict: AskSettlementVerdict;
  /** The delivery the close points at, when one was found. */
  deliveryId: string | null;
  /** Why, in one line, for the log and for the caller that wants to say something. */
  detail: string;
}

export interface SettlementContext {
  agentId: string;
  /** The turn whose record is the evidence. */
  turnNumber: number | null;
  at: SettlementMoment;
  /** The ask's own message row, when the caller holds it. A settlement stamps
   *  `messages.served_by_turn` as PART of closing — the fact the teardown batch-claim used
   *  to write on its own, so the "this turn answered this row" record and the "this ask is
   *  closed" record can never disagree. `setAnswerMessageId` keys on exactly this column. */
  rowid?: number | null;
  actorId?: string | null;
  /** JOIN MOMENT ONLY: the delivery the relay just recorded, when the caller holds one. It is
   *  still CHECKED here (delivered, this agent, not a chip, postdating `join_complete`) — the
   *  caller narrows the scope, the authority decides. */
  deliveryId?: string | null;
  /** JOIN MOMENT ONLY: the sentence recorded on the transition. */
  reason?: string;
  /** JOIN MOMENT ONLY: WHICH join fact this settlement is made of. It selects the boundary
   *  the delivery must postdate and nothing else — the evidence read is one query either way.
   *   * `compiled`    — the countdown reached zero and the combined answer went out. The
   *                     children must ALL have settled and the delivery must postdate the
   *                     row's own `join_complete`. This is the arm bug 2 is about.
   *   * `late-answer` — the join already FAILED CLOSED (the owner has been told no answer was
   *                     coming) and a real answer arrived afterwards. There is no completed
   *                     countdown to postdate — that is the whole situation — so the boundary
   *                     is the ask's own arrival, exactly as the delivery arm uses it.
   *                     requirement preserved (PHASE-2 AUDIT-FIX): a late answer still reaches
   *                     the owner, ONCE, and the exactly-once guard is the `failed -> open`
   *                     transition that precedes this call.
   *   * `engine-relay` — UX-REPAIR ROUND 12 T48. The same SHAPE as `compiled` in every respect
   *                     that decides anything (the children must all have settled, the delivery
   *                     must postdate `join_complete`, the delegating turn's own bubbles are
   *                     still not the receipt) — it is a distinct WORD so the `compile_resolved`
   *                     row says which hand composed the answer the ask closed on: the model's,
   *                     or the ladder's relay of the peers' own text. The rule is shared below
   *                     rather than copied, so the two cannot drift. */
  basis?: 'compiled' | 'engine-relay' | 'late-answer';
}

interface AskRow {
  id: string;
  agent_id: string;
  kind: string;
  state: WorkState;
  conversation_id: string | null;
  opened_at: number;
  root_id: string;
  remaining_children: number | null;
  compile_pending: number;
  claimed_by_turn: number | null;
  result_delivery_id: string | null;
}

function readAsk(workId: string): AskRow | undefined {
  return getDb().prepare(
    `SELECT id, agent_id, kind, state, conversation_id, opened_at, root_id,
            remaining_children, compile_pending, claimed_by_turn, result_delivery_id
       FROM work WHERE id = ?`,
  ).get(workId) as AskRow | undefined;
}

/**
 * THE EVIDENCE. One query, asked the same way at all three moments.
 *
 * Four narrowings, each of which is a negative control in `__tests__/ask-settlement.test.ts`:
 *   * the send must have SUCCEEDED (`outcome = 'delivered'`);
 *   * it must belong to the TURN being adjudicated;
 *   * it must have gone to the ask's OWN conversation (an email to a third party sent while
 *     working on the owner's question is not its answer);
 *   * it must POSTDATE the ask's arrival — a delivery recorded before the ask existed cannot
 *     be its answer, which is the shape the fresh probe pair produced and the shape a
 *     remediation keyed only on `answer_message_id` would have mis-read (verify report §5.6).
 * Plus the `engine-ack` exclusion, carried verbatim, and (T25) the eighth narrowing: a
 * delivery the owed-interrupt path already recorded this ask as still owed PAST.
 *
 * THE COMPARISON IS AT THE LEDGER'S OWN RESOLUTION, and that is a decision rather than a
 * rounding accident: `deliveries.created_at` is `datetime('now')`, i.e. whole seconds, while
 * `work.opened_at` is epoch-ms. Comparing at millisecond precision against a column that
 * does not carry milliseconds would manufacture false negatives inside the same second. Both
 * sides are therefore floored to the second; the arm still bites on any delivery recorded in
 * an EARLIER second than the ask arrived, which is what "predates" means on this ledger.
 */
function qualifyingDelivery(
  ask: AskRow, turnNumber: number | null,
): { id: string; tool: string } | null {
  if (turnNumber == null || ask.conversation_id == null) return null;
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  return (getDb().prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = ? AND d.turn_number = ? AND d.conversation_id = ?
        AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND ${NOT_A_TOOL_CHIP}
        AND ${NOT_A_SUPERSEDED_BUBBLE}
        AND ${NOT_A_START_ACK}
        AND ${NOT_OWED_PAST_THIS_DELIVERY}
        AND unixepoch(d.created_at) >= ?
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(ask.agent_id, turnNumber, ask.conversation_id, ...excluded,
    ask.id, turnNumber, Math.floor(ask.opened_at / 1000)) as
    { id: string; tool: string } | undefined) ?? null;
}

/**
 * THE SAME EVIDENCE READ, EXPOSED — SWEEP-A TB3.
 *
 * The remediation pass has to know whether an ask was answered before it can dispose of a row
 * that is already TERMINAL (`abandoned`, or `done` on a receipt that turns out to be a chip),
 * and `settleAsk` refuses terminal rows by design. Rather than let the pass re-state the rule
 * — a second decider, which is the disease this arc exists to cure — the authority's OWN
 * predicate is exported and the pass asks it.
 *
 * It is a READ. It decides nothing and writes nothing: the state change still goes through
 * `settleAsk`, and the pass supplies only SCOPE (which row, which turn). DESIGN §5 states the
 * requirement in the same words — *"the split uses the same evidence predicate as the
 * authority itself, so remediation and forward behaviour cannot disagree."*
 */
export function askAnswerEvidence(
  workId: string, turnNumber: number | null,
): { id: string; tool: string } | null {
  const ask = readAsk(workId);
  if (!ask || ask.kind !== 'ask') return null;
  return qualifyingDelivery(ask, turnNumber);
}

/** The fifth narrowing, as a SQL fragment so the delivery arm and the join arm cannot drift
 *  apart. Literal by construction (the list is a frozen tuple of lowercase identifiers), so
 *  the statement still prepares under the schema-conformance walk. */
const NOT_A_TOOL_CHIP =
  `NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = d.message_id AND m.display_kind IN (${
    NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ')}))`;

/**
 * ⚠ SWEEP CORE-1 CT0 — THE SIXTH NARROWING, AND IT IS THE SAME SENTENCE A THIRD TIME.
 *
 * "A START-ACK IS NOT AN ANSWER" was written for the `engine-ack` LANE; TB2 wrote it again
 * one row deeper for the tool-call CHIP. Neither reaches the third form: **the model's own
 * opening line, delivered under the ordinary dashboard door, while the turn is still
 * working.** It is an `agent-text` bubble, it is `user-visible`, it is `delivered`, it is in
 * the ask's own conversation and it postdates the ask's arrival — it passes all five — and
 * mid-turn it is the ONLY delivery in existence, so the delivery arm closes the ask on it.
 *
 * MEASURED, not reasoned about — three investigate-shaped asks driven through the real door
 * (`POST /api/chat/kevin/messages`) at the SHIPPED build `587693e`, 2026-08-09, all three
 * marked `done` on the ack, seconds after the question arrived and tens of seconds before
 * the answer existed:
 *
 *   ask:d8cf8457  done 09:36:02 (+9 s)  receipt -> "On it — checking the folder now."
 *                                        answer  09:36:09  "16 .ts files … store.ts, 1,667 lines"
 *   ask:1f5911cc  done 09:38:39 (+4 s)  receipt -> "On it — checking each part separately."
 *                                        answer  09:39:16  "All four parts checked…"
 *   ask:ed356166  done 09:41:26 (+4 s)  receipt -> "On it — checking the folder now."
 *                                        answer  09:41:41  "29 .ts files directly in that folder…"
 *
 * THE PLATFORM ALREADY KNEW. `turns.answer_message_id` — the truthful-answer key, whose ONE
 * setter is `noteTerminalAnswer` — named the REAL answer on all three while
 * `work.result_delivery_id` named the ack. Two halves of one edge, disagreeing. Box-wide at
 * that instant: 2,632 `done` asks carry a dashboard receipt, 2,053 of which ARE the turn's
 * answer key; 324 name a different bubble of a turn that DID record an answer, and 255 name
 * a bubble of a turn that recorded no answer at all.
 *
 * SO THE RULE IS TIME-SHAPED, and that is the whole design: mid-turn the authority cannot
 * know which bubble was the answer — nobody can, the turn has not finished speaking — so the
 * delivery moment is left EXACTLY as TB1 built it and a quick answer still closes instantly.
 * ONCE THE TURN HAS ENDED the record says which bubble was the answer, and from that moment
 * the only model bubble that can be an ask's receipt is that one.
 *
 * WHAT IT DELIBERATELY CANNOT REACH, each excluded by MEASUREMENT on the live body:
 *   * a delivery with no message row at all — every `auto-route` channel send (28 of 28 on
 *     this box carry `message_id IS NULL`), exactly as the chip narrowing is keyed;
 *   * the ENGINE'S OWN JOIN RELAY (`ENGINE_JOIN_RELAY_TOOLS`), which IS persisted as an
 *     `assistant`/`agent-text` row (28 of 28) but is written by the platform under a tool no
 *     model can call, out of the pieces the peers returned — TB13's correction, kept whole:
 *     25 of those 28 sit on turns that recorded no answer key and would have been refused;
 *   * a turn still running (`ended_at IS NULL`) — which is every delivery-moment close and
 *     the whole of the boot crash arm, so `reconcileOrphanedClaims` is untouched.
 */
const NOT_A_SUPERSEDED_BUBBLE =
  `NOT EXISTS (
     SELECT 1 FROM messages mb
       JOIN turns tb ON tb.agent_id = d.agent_id AND tb.turn_number = d.turn_number
      WHERE mb.id = d.message_id
        AND mb.role = 'assistant' AND mb.display_kind = 'agent-text'
        AND d.tool NOT IN (${[...ENGINE_JOIN_RELAY_TOOLS].map((t) => `'${t}'`).join(', ')})
        AND tb.ended_at IS NOT NULL
        AND (tb.answer_message_id IS NULL OR tb.answer_message_id <> d.message_id))`;

/**
 * ⚠ UX-REPAIR T2 — THE SEVENTH NARROWING, AND IT IS THE DOCTRINE AT THE ONE MOMENT THE
 * ENGINE COULD ALWAYS HAVE ENFORCED IT.
 *
 * A START-ACK IS NOT AN ANSWER. Three narrowings already say it — the `engine-ack` LANE, the
 * tool-call CHIP, and the sixth's superseded bubble. The sixth is the closest, and it is
 * deliberately TIME-SHAPED: it needs `turns.ended_at`, because mid-turn nobody can know which
 * bubble was the answer. That argument is sound, and it does not apply here.
 *
 * FOR THIS ONE CLASS THE ENGINE KNOWS AT THE INSTANT. The promoted start line is not inferred
 * from prose or from a missing `model_id`; the engine DECIDES to promote it
 * (`post-call-classify/terminal-text.ts` sets `engineStartAckDeliveredThisTurn` two statements
 * before it triggers the delivery) and now says so on the row, in the column built for saying
 * it. So this narrowing asks a fact that is already true when the delivery lands, and it needs
 * no turn record at all.
 *
 * MEASURED THROUGH THE REAL DOOR at `ba49131`, one request, floor model, BehaviorBot:
 *   turn 4526, ask:9eaab2ba — `done` at +4.2 s on delivery a6c01865, whose message was
 *   "On it — reading both files now."; `ct0_receipt_repointed` at +12.0 s. A 7.754 s window in
 *   which `openObligations` told the MODEL, mid-turn, that it owed the person nothing.
 * And the crash shape, turn 4527: killed between the ack and the answer, the ask stayed `done`
 * on that same "On it" across the reboot — nobody was ever answered.
 *
 * WHAT IT DOES NOT WIDEN, and each of these has a control in
 * `__tests__/an-ask-never-reads-done-on-a-start-ack.test.ts`:
 *   * an UNSTAMPED bubble is untouched — TB1's instant close for a genuine quick answer is
 *     exactly as it was, and CT0's boundary arm remains the backstop for it;
 *   * a DIFFERENT `origin_intent` is untouched — the rule names one value, never the column;
 *   * a delivery with no message row (every channel send) cannot be reached, keyed the same
 *     way the chip and bubble narrowings are.
 *
 * THE OWNER-PRIORITY CHECK (`:19-26`): refusing the ack cannot park the ask. It stays
 * `claimed`, the real answer's own delivery closes it, and if the turn dies the boot arms find
 * a live claim on a dead turn and hand it back OPEN with a named cause — which is the outcome
 * that priority asks for, and the one the close-on-the-ack was preventing.
 */
const NOT_A_START_ACK =
  `NOT EXISTS (SELECT 1 FROM messages ma WHERE ma.id = d.message_id
                 AND ma.origin_intent = '${START_ACK_ORIGIN_INTENT}')`;

/**
 * ⚠ UX-REPAIR ROUND 6 T25 — THE EIGHTH NARROWING: A DELIVERY THE ENGINE ALREADY SAID DID NOT
 * ANSWER THIS ASK.
 *
 * THE LEDGER, agent 57b52025, 2026-08-10, one turn:
 *   23:00:35  "Compare the three best e-ink tablets under $400…"      → turn 4655's subject
 *   23:00:43  "quick one — what's 15% of $240?"          arrived 8 s INTO the running turn
 *   23:01:15  the RESEARCH bubble lands (delivery 6a20d864) — no math in it
 *   23:01:15  the owed-interrupt path writes its re-prompt: "While you were working, the user
 *             also sent: 'quick one — what's 15% of $240?'. Reply ONLY to it"
 *   23:01:18  settlement closes that ask, open→done, ON delivery 6a20d864
 *   23:03:25  the next turn actually answers the math
 * Two engine mechanisms, three seconds apart, opposite verdicts. Had turn 4656 died, the board
 * would read `done` on an ask whose answer never existed.
 *
 * THE DISCRIMINATOR IS THE MECHANISM'S OWN RECORD. Not arrival timing (a burst the model
 * answers in one composite reply is the same timing and must still close — ARM 2's control),
 * and never the re-prompt's quoted TEXT, which is the prose-as-authority shape this tree
 * removes on sight. So the owed-interrupt path now records its subjects BY ID
 * (`recordOwedInterruptSubjects`, migration 159) with the delivery ROWID HIGH-WATER at the
 * instant it fired, and this narrowing reads that receipt: a delivery at or below that water
 * existed BEFORE anything told the model this ask was still owed, so by the engine's own
 * record it is not the ask's answer.
 *
 * ROWID, not the clock, and that is the same choice migration 088 made for the archive
 * high-water: `deliveries.created_at` is `datetime('now')` — whole seconds — and the incident's
 * bubble and record share a second exactly. A tie-free monotonic key decides it; a truncated
 * timestamp would have to guess.
 *
 * WHAT IT DOES NOT WIDEN, each a control in
 * `__tests__/a-waiting-ask-closes-only-on-its-own-answer.test.ts`:
 *   * an ask with NO owed-interrupt record is untouched — the rule names the record, not
 *     mid-turn arrival;
 *   * a record from a DIFFERENT turn does not narrow this turn's evidence;
 *   * the extra round the interrupt itself buys still closes the ask: that delivery is ABOVE
 *     the water, in the same turn, and remains qualifying evidence.
 *
 * THE OWNER-PRIORITY CHECK (`:19-26`): refusing this delivery cannot park the ask. With no
 * qualifying delivery the finalize arm hands it back OPEN — visible, on the re-serve ladder —
 * which is the "answer again rather than fall silent" direction the ruling asks for, and the
 * opposite of what closing it on someone else's receipt did.
 */
const NOT_OWED_PAST_THIS_DELIVERY =
  `NOT EXISTS (SELECT 1 FROM work_events oi
                WHERE oi.work_id = ? AND oi.kind = 'owed_interrupt'
                  AND json_extract(oi.payload, '$.turnNumber') = ?
                  AND d.rowid <= json_extract(oi.payload, '$.deliveryHighWater'))`;

/**
 * THE OWED-INTERRUPT PATH'S RECEIPT — written here because `work/` is the spine's single
 * writer (PART A of `__tests__/single-writer-conformance.test.ts`), read by the narrowing
 * above so the writer and the reader cannot drift.
 *
 * Called from the engine step that composes the re-prompt, with the message ids it is about to
 * quote. Everything it needs is already in that step's hands; what was missing was anywhere to
 * put it. Best-effort by construction: an owed message with no ask row (a burst sibling the
 * ledger never ticketed) is skipped, and a failure here must never cost the re-prompt itself.
 */
export function recordOwedInterruptSubjects(
  agentId: string, owedMessageIds: readonly string[], turnNumber: number,
): void {
  if (owedMessageIds.length === 0) return;
  const db = getDb();
  const water = (db.prepare(
    'SELECT COALESCE(MAX(rowid), 0) AS water FROM deliveries WHERE agent_id = ?',
  ).get(agentId) as { water: number }).water;
  for (const messageId of owedMessageIds) {
    const workId = askIdForMessage(messageId);
    const exists = db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId);
    if (!exists) continue;
    appendWorkEvent(workId, 'owed_interrupt', 'engine', { turnNumber, deliveryHighWater: water });
    logger.info('owed mid-turn ask recorded on its own ledger: this turn\'s earlier deliveries are not its answer', {
      agentId, workId, turnNumber, deliveryHighWater: water,
    }, agentId);
  }
}

/**
 * SWEEP CORE-1 CT0 — is the receipt this row is settled on a bubble THIS FINISHED TURN does
 * not call its answer? One read, asked with the SAME fragment the evidence predicate uses,
 * so the arm that corrects the row and the predicate that judges it can never disagree about
 * what a superseded bubble is.
 *
 * Scoped to the turn being adjudicated: an ask another turn settled is that turn's business
 * and is not re-opened by this boundary.
 */
function receiptIsASupersededBubble(ask: AskRow, turnNumber: number | null): boolean {
  if (turnNumber == null || ask.result_delivery_id == null) return false;
  return getDb().prepare(
    `SELECT 1 AS hit FROM deliveries d
      WHERE d.id = ? AND d.agent_id = ? AND d.turn_number = ?
        AND NOT (${NOT_A_SUPERSEDED_BUBBLE}) LIMIT 1`,
  ).get(ask.result_delivery_id, ask.agent_id, turnNumber) !== undefined;
}

// ════════════════════════════════════════════════════════════════════════════════
// THE RE-SERVE LADDER — SWEEP CORE-1 CT0, closing SWEEP-A TB3 §8.3
//
// TB3 recorded the hole and could not close it inside its own scope: *"the settlement
// authority's no-evidence arm has NO BOUND OF ITS OWN: it will hand an ask back forever, and
// the only thing between that and a spin is a counter owned by a different subsystem for a
// different reason."* That counter is `MAX_DRAIN_STUCK = 4` (`agent/turn-state.ts`), the
// HUMAN DRAIN'S per-CONVERSATION ladder. It is real, durable and it did its job — but it is
// not this arm's bound, it counts a different thing, and when it trips it writes the whole
// conversation off.
//
// MEASURED ON THE LIVE BODY, both shapes:
//   ask:3bba2728  handed back on turns 452, 457, 458, 459, 460, 461 — SIX serves, three
//                 minutes, every turn exiting `no_reply_intended`, ending `abandoned` by the
//                 drain's write-off;
//   ask:ec6392a5  handed back on 4285 and 4286 and served a third time on 4287 (45 seconds).
//
// THE LADDER, on OR2's shape (steer → tell the owner) and bounded PER ROW:
//   serves 1..MAX_ASK_RE_SERVES+1  the ask goes back OPEN and the drain re-serves it. The
//                                  count rides on the transition reason, so the record says
//                                  "serve 3 of 4" rather than leaving a reader to add up.
//   beyond that                    THE RE-SERVE STANDS DOWN. The ask is not closed, not
//                                  abandoned and not forgotten: it is HELD `blocked`, which
//                                  is an OWED state the OPEN WORK surface renders, so the
//                                  model keeps being reminded it owes this answer while the
//                                  drain — whose queue is `state = 'open'` — stops picking it
//                                  up. A steer the model can still act on, and a row the
//                                  owner can still see, instead of a spin.
//
// The counter is a COUNT over the row's own durable log, never a maintained integer — the
// same discipline `join-drive.ts` uses for its ladder, and for the same reason.
//
// ⚠ HANDED UP, stated rather than left to be discovered: OR2's LAST rung — the platform
// telling the OWNER in its own voice — is not wired here. `recordFloorGhost` is the surface
// for it and it needs a new declared `OUT_OF_BAND_GHOST_SUBJECTS` value, which the ghost
// census and the dashboard's owner-alert allowlist both judge. That is a surface change with
// its own review, and it is named in the CT0 report rather than slipped in beside this one.
// ════════════════════════════════════════════════════════════════════════════════

/** How many times the authority will hand ONE ask back before it stands the re-serve down.
 *  Three, on the same orchestrator judgment (Phase-0 standing authority) that set the join
 *  ladder's N — and beside it on purpose, so the two bounds are read together. */
export const MAX_ASK_RE_SERVES = 3;

/** The marker the ladder spends against, inside the `audit` payload — see `join-drive.ts`. */
export const RE_SERVE_MARKER = 'ct0_ask_re_served';

/** How many hand-backs this row has already spent. A COUNT over the log. */
function reServesSpent(workId: string): number {
  try {
    return (getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events
        WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?`,
    ).get(workId, RE_SERVE_MARKER) as { n: number } | undefined)?.n ?? 0;
  } catch (err) {
    // A ladder that cannot read its own counter must not spend an unbounded number of serves.
    // Reporting it as already spent is the safe direction: the ask is HELD and visible rather
    // than re-served for ever, which is the failure this bound exists to refuse.
    logger.warn('ask re-serve ladder: could not read its own counter; treating it as spent', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Record one rung's spend on the row's own history. */
function recordReServe(workId: string, attempt: number, why: string): void {
  appendWorkEvent(workId, 'audit', 'ask-settlement', {
    marker: RE_SERVE_MARKER, attempt, bound: MAX_ASK_RE_SERVES + 1,
    reason: `the ask was handed back to be served again (${attempt + 1} of ${MAX_ASK_RE_SERVES + 1}): ${why}`,
  });
}

/** The ladder's top rung: stop re-serving, keep the ask OWED and in front of the model. */
function standDownReServe(
  ask: AskRow, ctx: SettlementContext, actorId: string, spent: number,
  out: (v: AskSettlementVerdict, d: string, id?: string | null) => AskSettlementOutcome,
): AskSettlementOutcome {
  const reason = `re-serve stood down after ${spent + 1} serves: turn ${ctx.turnNumber ?? '?'} finalized `
    + 'without delivering an answer, as the ones before it did. The ask is NOT answered and is '
    + 'NOT closed — it is held OWED and stays in front of the agent, but the drain will stop '
    + 'serving the same question into the same silence';
  if (ask.state === 'blocked') return out('held', 'already held: the re-serve ladder is spent');
  const r = transition(ask.id, {
    to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason,
  });
  if (r.kind !== 'applied') return out('unchanged', `stand-down refused: ${r.kind}`);
  logger.error('ask re-serve STOOD DOWN: the same question was served into silence up to its bound', {
    agentId: ask.agent_id, workId: ask.id, serves: spent + 1, bound: MAX_ASK_RE_SERVES + 1,
    turnNumber: ctx.turnNumber,
  }, ask.agent_id);
  return out('held', reason);
}

/** Is there delegated work under this ask that has not come back and been compiled yet? */
function joinOutstanding(ask: AskRow): boolean {
  return (ask.remaining_children ?? 0) > 0 || ask.compile_pending === 1;
}

/**
 * THE AUTHORITY. Every transition of a `kind='ask'` row into `done` goes through here, and
 * so does every decision NOT to.
 */
export function settleAsk(workId: string, ctx: SettlementContext): AskSettlementOutcome {
  const actorId = ctx.actorId ?? ctx.agentId;
  const out = (verdict: AskSettlementVerdict, detail: string, deliveryId: string | null = null):
  AskSettlementOutcome => ({ workId, verdict, deliveryId, detail });

  const ask = readAsk(workId);
  if (!ask) return out('unchanged', 'no such work row');
  if (ask.kind !== 'ask') return out('unchanged', `not an ask (kind=${ask.kind})`);

  // ── THE ORDERING ARM (SWEEP-A TB2). A turn that ANSWERED and then DELEGATED. ──
  //
  // The chip narrowing above kills the premature close whenever the model delegates before it
  // speaks — the join is open by the time the real reply lands, so the hold arm fires and the
  // row is never terminal. It cannot help the other ordering. MEASURED, run `bmsg2ufve1q`
  // `ask:b66cbb75`: the model wrote a genuine prose status line at +19 s and only issued its
  // `send_to_agent` calls at +40 s, so at the instant of the close there was no delegated work
  // in existence and no evidence any was coming.
  //
  // At the TURN BOUNDARY there is. The join is on the row, and the ticket says `done` on a
  // delivery that answered nothing — the exact state every safety net downstream is blind to.
  // So the boundary hands it back: two recorded moves, `done -> open` (the only legal exit
  // from `done`, and it needs the engine actor pointing at the receipt it is undoing) and then
  // the ordinary HOLD. The person's ask is OWED again and the ladder can drive it.
  //
  // ⚠ WHAT THIS DOES NOT DO, stated rather than left to be discovered: the `done` transition
  // already happened and stays in the history. A judge that reads the event log will still see
  // it. The row is honest from the turn boundary onward, not retroactively — undoing the
  // RECORD would be the forgery this spine exists to refuse.
  //
  // ⚠ SWEEP-A TB3 — AND AT BOOT, FOR THE SAME SHAPE THE SAME TURN LEFT BEHIND. Finalize is
  // where this arm belongs, and a process killed between the delegation and the finalize
  // never reaches it: the row survives the crash `done` with its join unresolved, which is
  // bug 2's own state with nobody left to correct it. The boot reconciler already exists for
  // turns that died mid-lifecycle and already carries the bound — thirty minutes, dead turn —
  // so the crash window is that arm's scope widened by one shape, never a second mechanism.
  if (ask.state === 'done' && (ctx.at === 'finalize' || ctx.at === 'boot') && joinOutstanding(ask)) {
    // ⚠ SWEEP-A TB6 — AND IT DROPS THE RECEIPT IT IS UNDOING. `evidenceRef` names the
    // delivery so the undo can be audited (and G6 requires the engine to point at something);
    // `clearResultDelivery` takes the row off it. Those are two different jobs: the event is
    // the RECORD of what was undone and stays, the column is CURRENT STATE — "the delivery
    // this row is settled on" — and a row that has just been handed back is settled on
    // nothing. Without the clear the row went back to `open`/`blocked` still pointing at a
    // superseded receipt (TB5 §Q5, `ask:fa74a65f`: 4 m 55 s of it, and the correct settlement
    // landed 114 s after the window). Two readers were measurably wrong for that whole time:
    // the kit's (e2) clause read the stale pointer as the ask's receipt, and
    // `owedSendObligations` — the claimed-delivery floor's "is this person still owed an
    // answer" query — EXCLUDED the row, because it filters `result_delivery_id IS NULL` on the
    // belief (stated in its own comment) that a non-`done` row cannot carry one. It can, and
    // this was how.
    const undo = transition(workId, {
      to: 'open', by: 'engine', actorId: 'ask-settlement', expectedState: 'done',
      evidenceRef: ask.result_delivery_id ?? undefined,
      clearResultDelivery: true,
      reason: 'handed back: this turn closed the ask and THEN delegated the work under it — '
        + 'the delivery it closed on answered nothing, and the delegated pieces are still out',
    });
    if (undo.kind === 'applied') {
      logger.warn('ask handed back at the turn boundary: it was closed and then delegated under', {
        agentId: ask.agent_id, workId, remaining: ask.remaining_children,
        compilePending: ask.compile_pending, turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      const held = settleAsk(workId, ctx);
      return held.verdict === 'unchanged'
        ? out('reopened', 'handed back after a close-then-delegate turn')
        : held;
    }
  }

  // ── THE RECEIPT-TRUTH ARM (SWEEP CORE-1 CT0). A turn that ACKED, and then either answered
  //    or said nothing more. ──
  //
  // The sixth narrowing above makes the EVIDENCE honest from the turn boundary onward. This
  // arm is what it is for: a row already closed mid-turn on a bubble the finished turn does
  // not call its answer is re-adjudicated once, here, and the two outcomes are the two
  // TB3's remediation pass used for the identical shape one row up (a chip receipt):
  //
  //   * THE TURN REALLY ANSWERED — the receipt MOVES to the delivery that carried the
  //     answer. State is untouched, because the ask really is done: the person has their
  //     result. Nothing is re-served, nothing is asked twice, and no second answer is
  //     provoked. What changes is only that the record now names the thing that answered.
  //   * THE TURN NEVER ANSWERED — it said "On it" and stopped. Nobody was answered, so the
  //     ask is NOT done: it goes back OWED and visible, with the cause NAMED on the
  //     transition, exactly as the ordering arm hands back a close-then-delegate turn.
  //
  // ⚠ The same rider the ordering arm carries applies here: the `done` transition already
  // happened and STAYS in the history. The row is honest from the boundary onward, never
  // retroactively — undoing the RECORD would be the forgery this spine exists to refuse.
  if (ask.state === 'done' && (ctx.at === 'finalize' || ctx.at === 'boot')
      && receiptIsASupersededBubble(ask, ctx.turnNumber)) {
    const answer = qualifyingDelivery(ask, ctx.turnNumber);
    if (answer) {
      getDb().prepare('UPDATE work SET result_delivery_id = ?, updated_at = ? WHERE id = ?')
        .run(answer.id, Date.now(), workId);
      appendWorkEvent(workId, 'audit', actorId, {
        marker: 'ct0_receipt_repointed',
        from_delivery_id: ask.result_delivery_id, to_delivery_id: answer.id, tool: answer.tool,
        turn_number: ctx.turnNumber,
        reason: 'the ask was closed mid-turn on the model\'s opening start-ack. The same turn '
          + 'went on to deliver a real answer, and the receipt now points at that instead — '
          + 'a start-ack is not an answer, and the ticket must name what answered.',
      });
      logger.info('ask receipt re-pointed: it named the start-ack, not the answer', {
        agentId: ask.agent_id, workId, from: ask.result_delivery_id, to: answer.id,
        turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      return out('unchanged', `receipt re-pointed to the answer this turn delivered (${answer.tool})`, answer.id);
    }
    const undo = transition(workId, {
      to: 'open', by: 'engine', actorId: 'ask-settlement', expectedState: 'done',
      evidenceRef: ask.result_delivery_id ?? undefined,
      clearResultDelivery: true,
      reason: 'handed back: this ask was closed on the model\'s opening start-ack and the turn '
        + 'then finished without delivering an answer — nobody was answered, so the person is '
        + 'still waiting and the ask is owed again rather than left looking finished',
    });
    if (undo.kind === 'applied') {
      // The hand-back spends a rung of the re-serve ladder like every other one: a question
      // served into "On it" four times over is the same spin the bound exists to refuse.
      recordReServe(workId, reServesSpent(workId), 'the turn acked and then finished without answering');
      logger.warn('ask handed back at the turn boundary: it was closed on a start-ack that nothing followed', {
        agentId: ask.agent_id, workId, receipt: ask.result_delivery_id, turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      const after = settleAsk(workId, ctx);
      return after.verdict === 'unchanged'
        ? out('reopened', 'handed back after a turn that acked and never answered')
        : after;
    }
  }

  if (isTerminal(ask.state)) return out('unchanged', `already ${ask.state}`);

  // ── THE JOIN ARM (SWEEP-A TB2). The delegated job's own settlement, on the same rule. ──
  //    It is ABOVE the hold arm deliberately: at this moment `compile_pending` is still 1 —
  //    it is `transition()` that clears it on a terminal move — so a hold tested first would
  //    hold the very row whose answer has just landed, for ever.
  if (ctx.at === 'join') return settleOnJoin(ask, ctx, actorId, out);

  // ── HOLD. The owner asked for something the agent delegated: it is NOT answered because a
  //    turn spoke, and it must stay OWED and visible until the delegated work settles and its
  //    compiled answer actually lands. `blocked` is an existing OWED state — the OPEN WORK
  //    surface renders it, so the model keeps being reminded the job is still owed. ──
  if (joinOutstanding(ask)) {
    if (ask.state === 'blocked') return out('held', 'already held on the delegation');
    const reason = 'held: delegated work is still outstanding '
      + `(${ask.remaining_children ?? 0} child(ren) remaining`
      + `${ask.compile_pending === 1 ? ', compile pending' : ''}) — `
      + 'an ask is not answered because a turn spoke about starting it';
    const r = transition(workId, {
      to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason,
    });
    if (r.kind !== 'applied') return out('unchanged', `hold refused: ${r.kind}`);
    logger.info('ask held: delegated work outstanding', {
      agentId: ask.agent_id, workId, remaining: ask.remaining_children, compilePending: ask.compile_pending,
    }, ask.agent_id);
    return out('held', reason);
  }

  // ── CLOSE. Something was DELIVERED for it — never because a model said so. ──
  const evidence = qualifyingDelivery(ask, ctx.turnNumber);
  if (evidence) {
    const r = transition(workId, {
      to: 'done', by: 'agent', actorId, resultDeliveryId: evidence.id,
      expectedState: ask.state, reason: `delivered via ${evidence.tool}`,
    });
    if (r.kind !== 'applied') return out('unchanged', `close refused: ${r.kind}`, evidence.id);
    // The serve edge, written as part of the settlement rather than by a second owner.
    if (ctx.rowid != null && ctx.turnNumber != null) {
      recordServingTurnByRowid({ agentId: ask.agent_id, rowid: ctx.rowid, servedByTurn: ctx.turnNumber });
    }
    return out('closed', `delivered via ${evidence.tool}`, evidence.id);
  }

  // ── NO EVIDENCE. ──
  // Mid-turn this means nothing yet: the turn may be about to answer, and re-opening a live
  // claim would race the turn that holds it.
  if (ctx.at === 'delivery') return out('unchanged', 'no qualifying delivery yet; the turn is still live');
  // At boot the second arm below (`reconcileOrphanedClaims`) owns the no-evidence case,
  // because a crashed turn's disposition is P6b's counted question, not this one.
  if (ctx.at === 'boot') return out('unchanged', 'no qualifying delivery; the crash arm decides');
  // At turn finalize the question is settled: this turn is over, nothing was delivered for
  // this ask, and the person is still waiting. It goes back — visible.
  if (ask.state === 'open') return out('unchanged', 'already open and waiting');
  const spent = reServesSpent(workId);
  if (spent >= MAX_ASK_RE_SERVES) return standDownReServe(ask, ctx, actorId, spent, out);
  const reason = `re-opened: turn ${ctx.turnNumber ?? '?'} finalized with no delivery that answers this ask — `
    + `the person is still waiting, so the ask is visible again rather than parked `
    + `(serve ${spent + 2} of ${MAX_ASK_RE_SERVES + 1})`;
  const r = transition(workId, {
    to: 'open', by: 'agent', actorId, expectedState: ask.state, reason,
  });
  if (r.kind !== 'applied') return out('unchanged', `re-open refused: ${r.kind}`);
  recordReServe(workId, spent + 1, 'the turn finalized without delivering an answer');
  logger.info('ask re-opened: its turn finalized without delivering an answer', {
    agentId: ask.agent_id, workId, turnNumber: ctx.turnNumber, from: ask.state,
    reServe: spent + 1, bound: MAX_ASK_RE_SERVES,
  }, ask.agent_id);
  return out('reopened', reason);
}

// ════════════════════════════════════════════════════════════════════════════════
// THE JOIN ARM — SWEEP-A TB2, folding `settleJoinDelivered` in (DESIGN §1b, row 5)
//
// requirement preserved: *"close the join-ask when the compiled result is actually delivered
// — already evidence-backed"*, and `compile_resolved` is finally written on it. What the old
// function could not do is refuse: it took whatever delivery id the relay handed it and moved
// the row, so the delegating turn's own status line was an acceptable receipt. The rule here
// is the authority's, stated once and not weakened:
//
//   * the CHILDREN must actually have settled — `remaining_children = 0`, no exception. This
//     is the "settled is not widened" refusal in code: a job with a piece still out is not a
//     job whose answer can be pointed at.
//   * the DELIVERY must actually have landed AFTER the join completed. `join_complete` is the
//     row's own event, written inside the same transaction as the decrement that reached zero,
//     so it is the honest boundary between "talking about starting it" and "answering it".
//   * and it must be an answer at all — delivered, this agent's, not a tool-call chip, not an
//     `engine-ack`.
//
// WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS STRICTLY NARROWER. The compile driver used
// to ask `answerReceiptForAsk(join.rootId)` — "does the ask record an answer?" — which is TRUE
// the moment `messages.answer_message_id` is stamped at the delegating turn's finalize. On
// every recorded red run that was true within seconds of the delegation, so the driver
// cleared `compile_pending` and the compile was never driven. That is the same status-line
// error one layer up, and it is why `compile_resolved` had been written 0 times ever.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * THE TURN THAT DELEGATED, from the row's own `claim_turn` event. `null` when the ask was
 * never claimed (the B3 shape), in which case this narrowing simply does not apply.
 *
 * ⚠ WHY THE COMPILED ANSWER MUST COME FROM A LATER TURN, and it is a MEASUREMENT, not a
 * theory. Run `bmsg278e0k2`, `ask:de4b50c5` (2026-08-05 12:25): the tool-chip narrowing worked
 * and the hold fired on the status line at 12:25:36 — but the two toy workers came back one
 * second later (12:25:37), and the delegating turn's SECOND status line at 12:25:40 postdated
 * `join_complete`, so the join arm read *"I'll compile the final report once they're back"* as
 * the compiled report and closed the ask. The timing clause passed and the system stopped
 * driving — which is Bug 2 wearing a slightly later hat.
 *
 * A turn cannot compile an answer out of pieces that had not come back when it started. The
 * delegation exit ENDS the turn that opened the join (`steps/execute/delegation-exit.ts`), so
 * the compile is always a later turn's work; and the engine's own relay records
 * `turn_number = NULL` (verified on delivery `42559251`), which is why NULL qualifies.
 *
 * ⚠ SWEEP-A TB13 — THAT LAST CLAUSE WAS A FALSE PROXY, AND IT COST AN OWNER A DUPLICATE
 * ANSWER. The relay does NOT always record no turn: `recordDelivery` stamps `turn_number` from
 * the AMBIENT turn context (`agent/v2/deliveries.ts`), so whenever the peer's reply lands while
 * the delegating turn is still open, the engine's own relay carries THAT turn's number and this
 * narrowing excluded it. Measured on the dev body: **21 of 65** recorded `a2a-join-relay`
 * deliveries carry a turn number, and **5 of 5** recorded since this narrowing landed were
 * refused as the receipt. Four were rescued by the model's own later compiled answer; the
 * fifth — battery `bmshcidpw8d`, `ask:f8da81b2`, relay `bc839833` on turn 4039 — stayed
 * `compile_pending`, ran the whole ladder, and its LAST rung relayed the same single piece to
 * the owner a second time 52 s later (`2fc0347e`). That is the duplicate answer
 * `delegation-duplicate-reconciled` clause (c) exists to refuse.
 *
 * The rule is unchanged and the proxy is corrected: what must never count is THE MODEL'S OWN
 * BUBBLES on the delegating turn, and the engine's relay is not one — it is written by the
 * platform, under a tool no model can call, out of the pieces the peers returned
 * (`ENGINE_JOIN_RELAY_TOOLS`). Every other narrowing still applies to it: it must be
 * `delivered`, this agent's, not a tool-call chip, and it must postdate `join_complete`. The
 * negative control this clause was built for (`bmsg278e0k2`'s late status line) is re-driven
 * beside the new positive in `work/__tests__/join-settlement.test.ts` §(ii-b).
 */
function delegatingTurn(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT json_extract(payload, '$.turn_number') AS t FROM work_events
      WHERE work_id = ? AND kind = 'claim_turn' ORDER BY id DESC LIMIT 1`,
  ).get(workId) as { t: number | null } | undefined;
  return r?.t ?? null;
}


/** The `detail` the join relay stamps on its delivery row — ONE derivation, imported by the
 *  writer (`deliverJoinResultToOwner`) and by every reader, so "which join was this?" cannot
 *  drift between them. The outbound scope MERGES the details of every door a send crosses
 *  (`a; b`), so readers must match on containment, not equality. */
export function joinDeliveryDetail(joinId: string): string {
  return `join ${joinId}`;
}

/** When the join's countdown reached zero, from the row's own event. `null` when it never
 *  did — in which case there is no compiled anything and nothing can qualify. */
function joinCompletedAt(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = 'join_complete'`,
  ).get(workId) as { at: number | null } | undefined;
  return r?.at ?? null;
}

/** The compiled answer's receipt, or null. One statement, whether the caller named a delivery
 *  or not — a named one is CHECKED against the same predicate, never trusted. */
function compiledDelivery(
  ask: AskRow, completedAtMs: number, named: string | null | undefined, afterTurn: number | null,
): { id: string; tool: string } | null {
  const db = getDb();
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  const relayTools = [...ENGINE_JOIN_RELAY_TOOLS];
  const floorSec = Math.floor(completedAtMs / 1000);
  // The delegating turn's own bubbles are not the compiled answer. Two things are not those
  // bubbles: a delivery from a LATER turn, and a delivery from NO turn — and (TB13) the
  // ENGINE'S OWN RELAY OF THIS JOIN whatever turn it happens to be stamped with, because the
  // platform wrote it out of the pieces the peers returned and no model can call that tool.
  //
  // The exemption is keyed to THIS ROW's relay (`joinDeliveryDetail`), not to the tool alone.
  // Driven, not assumed: with the tool alone, one join's relay settled a DIFFERENT ask that
  // shared the conversation — the conversation-scoped read has no join identity of its own, so
  // widening by tool would have widened it across rows. The negative control is in
  // `work/__tests__/join-settlement.test.ts` §(ii-b).
  const relaySql = relayTools.map((_, i) => `@r${i}`).join(', ');
  const laterTurn = afterTurn == null ? ''
    : `AND (d.turn_number IS NULL OR d.turn_number > @afterTurn
            OR (d.tool IN (${relaySql}) AND d.detail LIKE @joinDetail))`;
  const bind = (extra: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = {
      agentId: ask.agent_id, floorSec, joinDetail: `%${joinDeliveryDetail(ask.id)}%`, ...extra,
    };
    excluded.forEach((t, i) => { o[`x${i}`] = t; });
    relayTools.forEach((t, i) => { o[`r${i}`] = t; });
    if (afterTurn != null) o.afterTurn = afterTurn;
    return o;
  };
  const excludedSql = excluded.map((_, i) => `@x${i}`).join(', ');
  if (named) {
    return (db.prepare(
      `SELECT d.id AS id, d.tool AS tool FROM deliveries d
        WHERE d.id = @named AND d.agent_id = @agentId AND d.outcome = 'delivered'
          AND d.tool NOT IN (${excludedSql})
          AND ${NOT_A_TOOL_CHIP}
          AND ${NOT_A_SUPERSEDED_BUBBLE}
          AND unixepoch(d.created_at) >= @floorSec
          ${laterTurn}`,
    ).get(bind({ named })) as { id: string; tool: string } | undefined) ?? null;
  }
  if (ask.conversation_id == null) return null;
  return (db.prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = @agentId AND d.conversation_id = @conv AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excludedSql})
        AND ${NOT_A_TOOL_CHIP}
        AND ${NOT_A_SUPERSEDED_BUBBLE}
        AND unixepoch(d.created_at) >= @floorSec
        ${laterTurn}
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(bind({ conv: ask.conversation_id })) as
    { id: string; tool: string } | undefined) ?? null;
}

/**
 * SWEEP-A TB13 — HAS THE ENGINE ALREADY TOLD THE OWNER THIS JOIN'S ANSWER?
 *
 * The exactly-once discipline the relay's own header claims ("the caller has already won the
 * right to deliver — the exactly-once guard is the `work` transition that precedes this call")
 * has one hole, and battery `bmshcidpw8d` drove through it: when the settlement that follows a
 * relay is REFUSED, no transition happens, the row stays `compile_pending`, and the ladder's
 * last rung relays the same pieces again 52 s later. A guard that only exists when the row
 * moves is not a guard for the case where the row does not move.
 *
 * This is the durable answer to the only question that matters before speaking again: is there
 * already a DELIVERED engine relay for THIS join that postdates its own `join_complete`? It
 * reads the delivery ledger — never a flag, never a counter, so a restart, a re-drive and a
 * reaper pass all read the same fact.
 */
export function priorEngineJoinRelay(workId: string): { id: string; tool: string } | null {
  const ask = readAsk(workId);
  if (!ask) return null;
  const completedAt = joinCompletedAt(workId);
  if (completedAt == null) return null;
  const tools = [...ENGINE_JOIN_RELAY_TOOLS];
  const bind: Record<string, unknown> = {
    agentId: ask.agent_id,
    floorSec: Math.floor(completedAt / 1000),
    detail: `%${joinDeliveryDetail(workId)}%`,
  };
  tools.forEach((t, i) => { bind[`t${i}`] = t; });
  return (getDb().prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = @agentId AND d.outcome = 'delivered'
        AND d.tool IN (${tools.map((_, i) => `@t${i}`).join(', ')})
        AND d.detail LIKE @detail
        AND unixepoch(d.created_at) >= @floorSec
      ORDER BY d.created_at ASC, d.rowid ASC LIMIT 1`,
  ).get(bind) as { id: string; tool: string } | undefined) ?? null;
}

function settleOnJoin(
  ask: AskRow,
  ctx: SettlementContext,
  actorId: string,
  out: (v: AskSettlementVerdict, detail: string, deliveryId?: string | null) => AskSettlementOutcome,
): AskSettlementOutcome {
  const basis = ctx.basis ?? 'compiled';
  // ONE completed-countdown rule, asked as "is this the late-answer arm?" rather than as a list
  // of the arms that are not. T48 added a third basis, and a third `basis === 'compiled'` test
  // at each of the three sites below would have silently routed it down the late-answer arm —
  // boundary at the ask's own arrival, no delegating-turn constraint — which is a different
  // rule wearing the same name.
  const lateAnswer = basis === 'late-answer';
  let boundaryMs: number;
  if (!lateAnswer) {
    if ((ask.remaining_children ?? -1) !== 0) {
      return out('unchanged',
        `the children have not all settled (${ask.remaining_children ?? 'no join'} outstanding)`);
    }
    const completedAt = joinCompletedAt(ask.id);
    if (completedAt == null) return out('unchanged', 'the join never recorded a completion');
    boundaryMs = completedAt;
  } else {
    boundaryMs = ask.opened_at;
  }
  // The late-answer arm has no delegating-turn constraint: its whole situation is that the
  // countdown never completed and an answer arrived out of band, on whatever turn carried it.
  const evidence = compiledDelivery(
    ask, boundaryMs, ctx.deliveryId, lateAnswer ? null : delegatingTurn(ask.id),
  );
  if (!evidence) {
    return out('unchanged', lateAnswer
      ? 'the late answer produced no delivery that can be pointed at'
      : 'the compiled answer has not landed for the owner yet');
  }
  const reason = ctx.reason ?? 'the compiled answer reached the owner';
  const r = transition(ask.id, {
    to: 'done', by: 'engine', actorId, reason,
    evidenceRef: evidence.id, resultDeliveryId: evidence.id,
  });
  if (r.kind !== 'applied') return out('unchanged', `join close refused: ${r.kind}`, evidence.id);
  // The fact `compile_pending` existed to record, finally written on a real completion. The
  // flag itself is cleared by `transition()`'s terminal arm, so this event is the HISTORY of
  // the resolution rather than a second owner of the column.
  appendWorkEvent(ask.id, 'compile_resolved', actorId, {
    reason, basis, delivery_id: evidence.id, tool: evidence.tool, boundary_at: boundaryMs,
  });
  // UX-REPAIR round 2 T11 — THE DELIVERY LEARNS WHAT IT ANSWERED, from the authority that just
  // decided it. A compiled answer usually lands on a BARE WAKE (S4 turn 4555: `turns.kind`
  // NULL, `subject_kind='none'`), so the delivery is written with `root_kind=''`/`root_id=''`
  // and no reverse lookup can find it — while the delegating turn's ACK, which does carry
  // `root_kind='ask'`, is the only row that answers "which delivery belongs to this ask".
  // This is RECORDED, not inferred: at this instant the settlement authority holds both ids.
  // Only ever fills a blank — an already-attributed delivery is never re-pointed.
  try {
    getDb().prepare(
      `UPDATE deliveries SET root_kind = 'ask', root_id = ?
        WHERE id = ? AND COALESCE(root_kind, '') = '' AND COALESCE(root_id, '') = ''`,
    ).run(ask.id, evidence.id);
  } catch (err) {
    logger.warn('join settled: the compiled delivery could not be stamped with the ask it answered', {
      workId: ask.id, deliveryId: evidence.id, error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('join settled: the compiled answer reached the owner', {
    agentId: ask.agent_id, workId: ask.id, deliveryId: evidence.id, tool: evidence.tool,
  }, ask.agent_id);
  return out('closed', reason, evidence.id);
}

/**
 * INVOCATION (d) — THE JOIN RELAY. Scope only; the decision is `settleAsk`'s.
 *
 * `deliveryId` is what the caller just recorded, when it holds one; omit it and the authority
 * looks for the compiled answer itself, which is what the turn-end compile drain needs (the
 * MODEL delivered it, so no relay holds an id).
 */
export function settleAskOnJoin(
  parentWorkId: string,
  p: {
    agentId?: string; deliveryId?: string | null; reason: string; actorId?: string | null;
    basis?: 'compiled' | 'engine-relay' | 'late-answer';
  },
): AskSettlementOutcome {
  // `agentId` is SCOPE the join arm does not need — it reads the agent off the row it is
  // about — so it is optional here and the actor defaults to the relay's own name.
  return settleAsk(parentWorkId, {
    agentId: p.agentId ?? 'a2a-join', turnNumber: null, at: 'join',
    deliveryId: p.deliveryId ?? null, reason: p.reason, basis: p.basis,
    actorId: p.actorId ?? 'a2a-join',
  });
}

/**
 * An answer arrived AFTER the join failed closed. It still reaches the owner, once.
 *
 * RELOCATED from `work/store.ts` with the settle it composes (SWEEP-A TB2). Two recorded moves
 * rather than one silent overwrite: `failed -> open` (the join is live again) then the
 * authority's join close against the delivery that carried the update. The transport performs
 * exactly these two calls with the send in between, unchanged.
 *
 * requirement preserved: the exactly-once guard is the `failed -> open` transition — one
 * caller wins it, everyone else gets `conflict`, and that is what stops the owner being told
 * twice. `claimFailedJoinForLateAnswer` still owns that half and is untouched.
 */
export function reopenJoinForLateAnswer(
  parentWorkId: string, deliveryId: string, reason: string,
): AskSettlementOutcome | { kind: 'refused'; reason: string } {
  const reopened = claimFailedJoinForLateAnswer(parentWorkId, deliveryId, reason);
  if (reopened.kind !== 'applied') {
    return { kind: 'refused', reason: reopened.kind === 'no_change' ? 'already-in-state' : reopened.reason };
  }
  return settleAskOnJoin(parentWorkId, { deliveryId, reason, basis: 'late-answer' });
}

// ════════════════════════════════════════════════════════════════════════════════
// INVOCATION (a) — AT EACH DELIVERY, INSIDE THE DELIVERY TRANSACTION
// ════════════════════════════════════════════════════════════════════════════════

export interface DeliveryCloseInput {
  agentId: string;
  turnNumber: number | null;
  deliveryId: string;
  conversationId: string | null;
  tool: string;
  outcome: string;
}

/**
 * A quick ask is done when something was DELIVERED for it — never because a model said so.
 *
 * This is the shape the solo lifecycle has always had and it is deliberately unchanged:
 * opened -> pickup -> done-with-receipt AT SEND TIME. Moving the close to finalize would have
 * made every quick answer wait for the turn boundary, which is a behaviour change nobody
 * asked for.
 *
 * The arguments narrow the SCOPE (which rows this delivery could possibly answer); the
 * decision is `settleAsk`'s, and it re-reads the ledger row this call just inserted rather
 * than trusting the arguments — one evidence read, in one place, at all three moments.
 */
export function settleAsksForDelivery(p: DeliveryCloseInput): number {
  if (p.outcome !== 'delivered') return 0;
  if (p.turnNumber == null || p.conversationId == null) return 0;
  if (NON_ANSWERING_DELIVERY_TOOLS.has(p.tool)) return 0;
  const rows = getDb().prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed'
        AND claimed_by_turn = ? AND conversation_id = ?`,
  ).all(p.agentId, p.turnNumber, p.conversationId) as Array<{ id: string }>;
  let closed = 0;
  for (const r of rows) {
    const s = settleAsk(r.id, { agentId: p.agentId, turnNumber: p.turnNumber, at: 'delivery' });
    if (s.verdict === 'closed') closed++;
  }
  return closed;
}

// ════════════════════════════════════════════════════════════════════════════════
// INVOCATION (b) — TURN FINALIZE, THE FINAL ADJUDICATOR
// ════════════════════════════════════════════════════════════════════════════════

/** One row of the assembled-context set: the ask, and the message row to stamp when it
 *  settles. Produced by `agent/v2/counterparty.ts:assembledContextAsks`, which READS and
 *  writes nothing — the state change is the authority's alone. */
export interface AssembledAsk { workId: string; rowid: number }

export interface FinalizeSettlementInput {
  agentId: string;
  turnNumber: number;
  /** Every ask that entered this turn's context: the same-conversation rows that were inside
   *  the final assembly. Rows arriving AFTER it are deliberately absent (OPEN-12: a genuinely
   *  newer message gets its own turn) — that exclusion lives in the read, not here. */
  assembled?: AssembledAsk[];
}

export interface FinalizeSettlementResult { closed: number; held: number; reopened: number }

/**
 * The turn is over. Every ask it CLAIMED, and every ask that entered its ASSEMBLED CONTEXT,
 * gets its verdict now: closed with the receipt, held on an unresolved delegation, or handed
 * back open.
 *
 * ── THE STRUCTURAL INVARIANT ── no ask remains `claimed` by a finalized turn. That is the
 * line that makes the fossil class unrepresentable, and `__tests__/ask-done-census.test.ts`
 * PART B is the census that keeps it true.
 *
 * The claimed set is scoped by TURN and not by conversation: an ask this turn picked up and
 * then answered somewhere else is still this turn's to dispose of.
 */
export function settleAsksAtTurnFinalize(p: FinalizeSettlementInput): FinalizeSettlementResult {
  const result: FinalizeSettlementResult = { closed: 0, held: 0, reopened: 0 };
  const db = getDb();
  const claimed = db.prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed' AND claimed_by_turn = ?`,
  ).all(p.agentId, p.turnNumber) as Array<{ id: string }>;
  // SWEEP-A TB2 — the third scope: an ask THIS TURN CLOSED. `claimed_by_turn` is nulled by
  // the close, so the turn is re-identified through the receipt the close points at. Narrow
  // by construction: it can only ever match a row this turn's own delivery closed.
  //
  // ⚠ SWEEP CORE-1 CT0 — the `remaining_children > 0 OR compile_pending = 1` filter came OFF.
  // It was the ordering arm's own question ("did this turn close it and THEN delegate?"), and
  // asking it HERE made the scope answer a question only one of the arms cares about. The
  // receipt-truth arm needs the same set without a delegation on it — a turn that acked, then
  // answered, and delegated nothing is the ordinary investigate shape and was invisible. The
  // arms ask their own questions; the scope only says WHICH ROWS this turn is responsible for.
  const closedByThisTurn = db.prepare(
    `SELECT w.id AS id FROM work w
      WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'done'
        AND w.result_delivery_id IN (
          -- the outcome filter is redundant here (the receipt on the row can only ever have
          -- come from a delivered row) and it is written anyway: the enumeration guard in
          -- owner-close-receipt.test.ts requires EVERY production reader of this table to
          -- carry it, and a reader that is safe by argument rather than by predicate is the
          -- shape that guard exists to refuse.
          SELECT d.id FROM deliveries d
           WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered')`,
  ).all(p.agentId, p.agentId, p.turnNumber) as Array<{ id: string }>;

  const seen = new Set<string>();
  const tally = (v: AskSettlementVerdict): void => {
    if (v === 'closed') result.closed++;
    else if (v === 'held') result.held++;
    else if (v === 'reopened') result.reopened++;
  };
  for (const r of [...claimed, ...closedByThisTurn]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    tally(settleAsk(r.id, { agentId: p.agentId, turnNumber: p.turnNumber, at: 'finalize' }).verdict);
  }
  for (const a of p.assembled ?? []) {
    if (seen.has(a.workId)) continue;
    seen.add(a.workId);
    tally(settleAsk(a.workId, {
      agentId: p.agentId, turnNumber: p.turnNumber, at: 'finalize', rowid: a.rowid,
    }).verdict);
  }
  if (result.closed > 0 || result.held > 0 || result.reopened > 0) {
    logger.info('turn finalize: owner asks adjudicated', {
      agentId: p.agentId, turnNumber: p.turnNumber, ...result, considered: seen.size,
    }, p.agentId);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// INVOCATION (c) — BOOT RECONCILE OF CRASHED TURNS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Crash test B, the durable half: a process killed between the CLAIM and the EFFECT.
 *
 * The claim is in the database and the turn is not, so on restart the ask reads as being
 * served by a turn that will never finish. Three outcomes and no fourth:
 *   * the dead turn DELIVERED  -> the authority closes it against that delivery (the same
 *     evidence `settleAsksForDelivery` would have used had the process lived one more
 *     statement). Its decision is no longer this function's;
 *   * it recorded ZERO effectful calls -> hand the ask back, the person is served again;
 *   * it recorded some -> HOLD it, because the effect already happened and a second turn
 *     would repeat it (P6b, unchanged: the crash case is the one the counted input exists
 *     for, and the turn boundary — where the owner's 2026-08-05 ruling governs — never ran).
 *
 * Trigger and window are carried verbatim: boot only, ≤30 minutes, dead turns.
 * Relocated from `work/store.ts` with the decision it now shares.
 *
 * ── SWEEP-A TB3: THE CRASH WINDOW, THE FOURTH OUTCOME ──
 * A turn that CLOSED an ask and then DELEGATED under it is handed back at its own boundary
 * (TB2's ordering arm). A turn killed between those two moments never reaches its boundary,
 * so the row survives the crash `done` with an unresolved join — the exact state every safety
 * net downstream is blind to, and the state bug 2 was about. Same trigger, same window, same
 * dead-turn predicate; only the scope is one shape wider, and the row leaves `done` on the
 * first look so it can never be adjudicated twice.
 */
export function reconcileOrphanedClaims():
{ reArmed: number; held: number; closed: number; handedBack: number } {
  const db = getDb();
  const since = Date.now() - ORPHAN_CLAIM_WINDOW_MINUTES * 60 * 1000;
  const answered = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, w.claimed_by_turn AS turn_number
      FROM work w
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND w.updated_at >= ?
       AND t.ended_at IS NULL
     GROUP BY w.id
  `).all(since) as Array<{ id: string; agent_id: string; turn_number: number }>;
  let closed = 0;
  for (const a of answered) {
    const s = settleAsk(a.id, {
      agentId: a.agent_id, turnNumber: a.turn_number,
      at: 'boot', actorId: 'boot-reconciliation',
    });
    if (s.verdict === 'closed') closed++;
  }

  const rows = db.prepare(`
    SELECT w.id AS id, COALESCE(t.effectful_calls, 0) AS effectful_calls
      FROM work w
      LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND w.updated_at >= ?
       AND (t.turn_number IS NULL OR t.ended_at IS NULL)
  `).all(since) as Array<{ id: string; effectful_calls: number }>;
  let reArmed = 0; let held = 0;
  for (const r of rows) {
    const res = revertAskClaimOnAbort(
      r.id, r.effectful_calls,
      'boot reconciliation: the claiming turn never finished (process killed between claim and effect)',
    );
    if (res === null) held++;
    else if (res.kind === 'applied') reArmed++;
  }
  // ── THE CRASH WINDOW (SWEEP-A TB3) ──
  // `claimed_by_turn` was NULLed by the close, so the serving turn is re-identified through
  // the receipt the close points at — the same re-identification `settleAsksAtTurnFinalize`
  // performs for the same shape, written the same way on purpose.
  const crashed = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, d.turn_number AS turn_number
      FROM work w
      JOIN deliveries d ON d.id = w.result_delivery_id AND d.agent_id = w.agent_id
                       AND d.outcome = 'delivered'
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = d.turn_number
     WHERE w.kind = 'ask' AND w.state = 'done'
       AND (w.remaining_children > 0 OR w.compile_pending = 1)
       AND w.updated_at >= ?
       AND t.ended_at IS NULL
     GROUP BY w.id
  `).all(since) as Array<{ id: string; agent_id: string; turn_number: number | null }>;
  let handedBack = 0;
  for (const c of crashed) {
    const s = settleAsk(c.id, {
      agentId: c.agent_id, turnNumber: c.turn_number,
      at: 'boot', actorId: 'boot-reconciliation',
    });
    if (s.verdict === 'held' || s.verdict === 'reopened') handedBack++;
  }

  if (reArmed > 0 || held > 0 || closed > 0 || handedBack > 0) {
    logger.warn('boot reconciliation of orphaned ask claims', { reArmed, held, closed, handedBack });
  }
  return { reArmed, held, closed, handedBack };
}
