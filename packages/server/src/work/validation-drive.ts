// ════════════════════════════════════════════════════════════════════════════════════════
// THE VALIDATION DRIVE — SWEEP CORE-2 item 1. The owner's own design, in one module.
//
// ── WHAT WAS BROKEN, IN SIX MEASURED DENOMINATORS ───────────────────────────────────────
//   BATTERY5 `bmsh2j4inp3`   27 coverage misses over 104 durable rows; worst wait 17.4 min
//   BATTERY5 same run        escalate-before-verdict reproduced at 17–36 min
//   BATTERY6 `bmsh708xse7`   102 miss rows, one at 36.9 min
//   BATTERY6 same run        5 of 6 owner-escalated rows never got an in-window verdict
//   BATTERY9 `bmshmu5ygd5`   ZERO Key-2 verdicts written on the box in 84 minutes
//   BATTERY9 same pair       96 of 98 handed rows missed across 27 no-verdict reviews;
//                            3 of 3 owner-escalated rows never validated
//
// ── THE OWNER'S DESIGN (2026-08-06), BINDING, IN HIS WORDS ──────────────────────────────
//   THE DOORBELL: *"so and so says they got this done. Confirm and mark it in the tracker,
//   or push back, or get more info — whatever needs done to make sure the task gets
//   completed."* A completion event that owes Key 2 TRIGGERS a targeted PM wake carrying
//   that row. No waiting on patrol sweeps; the sweeps remain as backstop only.
//
//   SPIN-RECOVERY, NEVER CAPS: *"This needs to be more of a 'get the agent back on track
//   when spinning out' thing like we do with the other agents. Then otherwise, let the PM do
//   their work."* No hard per-item attempt or time limit; nothing may render an item
//   terminally un-approvable; ONE STUBBORN ITEM NEVER DAMS THE QUEUE.
//
//   THE ORDER: the owner is told a row is unvalidated only AFTER a recorded validation
//   attempt exists for it. TB8 made that question answerable; this module makes it the law.
//
// ── WHERE THE STATE LIVES, AND WHY THERE IS NO NEW COLUMN AND NO NEW EVENT KIND ─────────
// `work_events.kind` carries a CHECK (migration `152`) against the declared list in
// `event-kinds.ts`; a new kind is a table rebuild on every lived-in body. So the attempt
// ledger rides `kind='audit'` with its own marker inside the payload — the landing place
// `join-drive.ts` and `run-deliver-drive.ts` already use, and the one migration `152`'s own
// header names for exactly this. The count is a COUNT over those rows, never a maintained
// integer: it survives a restart and it cannot drift from the events that caused it.
//
// ── AND WHY THE MARKERS LIVE HERE RATHER THAN AT EITHER END ─────────────────────────────
// `tracker/pm-agent.ts` WRITES an attempt; `scheduler/runner.ts` READS whether one exists.
// TB5 spent a whole task on what happens when one expression lives in two places and one
// copy is repaired: the writer and the reader disagree, silently, and a gate stops meaning
// what it says. One owner, imported by both.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { AUDIT_KIND } from './audit-trail.js';
import { appendWorkEvent } from './store.js';
import {
  taskScope, msToText, STATE_TO_STATUS_SQL, validatedExpr, awaitingUserVerdictExpr,
  unvalidatedCloseExpr, unvalidatedPauseExpr,
} from './tracker-view.js';

const logger = createLogger('validation-drive');

// ════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE DOORBELL
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The two shapes of "an agent says this is done and Key 2 is still owed", both produced
 * inside `transition()` — the spine's one writer — so no close path can forget to ring.
 *
 *  - `close-request`  the worker's own close. RULING 1 makes it Key 1 and only Key 1: the
 *                     `validation_requested` event lands and the row does not move.
 *  - `engine-receipt` the engine / scheduler / healer closing on a delivery receipt. The row
 *                     reaches `done` with an adjudication stamped with the ROLE, which
 *                     `validatedExpr('done')` deliberately excludes — so Key 2 is still owed.
 */
export type DoorbellShape = 'close-request' | 'engine-receipt';

export interface DoorbellRing {
  readonly workId: string;
  readonly shape: DoorbellShape;
}

export type DoorbellHandler = (ring: DoorbellRing) => void;

let doorbellHandler: DoorbellHandler | null = null;

/** Wire the validator to the doorbell. `tracker/pm-agent.ts` owns the handler; this seam is
 *  why `work/` never has to import `tracker/`. Passing null unwires (tests, teardown). */
export function setValidationDoorbellHandler(handler: DoorbellHandler | null): void {
  doorbellHandler = handler;
}

/**
 * Ring it. Fire-and-forget by design and DEFENSIVE by requirement: this is called from
 * inside the spine's single writer, and a validator that is missing or throwing must not be
 * able to fail a state change. It is LOUD in both directions — a doorbell nobody answered is
 * exactly the silent skip the owner ruled against.
 */
export function ringValidationDoorbell(ring: DoorbellRing): void {
  if (!doorbellHandler) {
    logger.warn('validation doorbell rang with NO validator wired — this row will wait for a patrol sweep', {
      workId: ring.workId, shape: ring.shape,
    });
    return;
  }
  try {
    doorbellHandler(ring);
  } catch (err) {
    logger.warn('validation doorbell handler threw (non-fatal; the state change stands)', {
      workId: ring.workId, shape: ring.shape,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE ATTEMPT LEDGER
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The validator was handed this row and returned no verdict.
 *
 * ⚠ THE STRING IS TB8's AND IS NOT RENAMED. `validation_review_miss` is already written by
 * `tracker/pm-agent.ts` and already read by the census BATTERY4 was reaching for; renaming it
 * would orphan every row on every lived-in body and make the pre-fix corpus unreadable.
 */
export const VALIDATION_ATTEMPT_MISS = 'validation_review_miss';

/**
 * There was no validator to ask — the PM row is gone, terminated, or has no model.
 *
 * This exists because the ordering law would otherwise open a hole where the law used to be:
 * gate the owner escalation on a recorded attempt, and a box whose validator is dead records
 * no attempts, escalates nothing, and tells the owner NOTHING for ever. An attempt that could
 * not be made is still an attempt, and it is the one he most needs to hear about.
 */
export const VALIDATION_ATTEMPT_UNAVAILABLE = 'validation_validator_unavailable';

/** Every marker that means "the platform tried to get this row validated". */
export const VALIDATION_ATTEMPT_MARKERS = [
  VALIDATION_ATTEMPT_MISS,
  VALIDATION_ATTEMPT_UNAVAILABLE,
] as const;

const MARKER_LIST = VALIDATION_ATTEMPT_MARKERS.map((m) => `'${m}'`).join(', ');

/** How many recorded attempts this row carries, as SQL. A COUNT over durable rows. */
export const validationAttemptCountExpr = (a: string): string =>
  `(SELECT COUNT(*) FROM work_events ve`
  + `  WHERE ve.work_id = ${a}.id AND ve.kind = '${AUDIT_KIND}'`
  + `    AND json_extract(ve.payload, '$.action_taken') IN (${MARKER_LIST}))`;

/** 1 when the platform holds a record that this row's validator was actually asked. */
export const validationAttemptRecordedExpr = (a: string): string =>
  `(CASE WHEN ${validationAttemptCountExpr(a)} > 0 THEN 1 ELSE 0 END)`;

/**
 * THE VALIDATION QUEUE'S ORDER — head-of-line blocking, designed out.
 *
 * The owner's constraint (c): *"ONE STUBBORN ITEM NEVER DAMS THE QUEUE … a steered-off spin
 * means she serves the items behind it and circles back."*
 *
 * Ordering by age alone meant the row that kept defeating the validator LED EVERY REVIEW —
 * it was the oldest, so it was always first, so it ate the turn while everything behind it
 * went unserved. BATTERY9 measured 84 minutes of exactly that.
 *
 * Attempts first, age second. A row that has already defeated the validator drops behind the
 * ones it was blocking and CIRCLES BACK as soon as their counts catch up, which they do:
 * every review that misses records a miss on every row it held, so the counts level. It is
 * not a cap and not a demotion — nothing is removed, nothing expires, and no count is ever
 * compared against a ceiling. Equal-attempt rows keep strict FIFO fairness.
 *
 * ⚠ ONE OWNER. `tracker/pm-agent.ts` builds the queue with this and the driven proof reads
 * the same string, so a test that agrees with a copy of the order cannot pass while the real
 * queue orders differently — the TB5 drift class, refused by construction.
 */
export const validationQueueOrderExpr = (a: string): string =>
  `${validationAttemptCountExpr(a)} ASC, ${a}.updated_at ASC`;

/** The same count, for callers that are not building SQL. */
export function validationAttemptCount(workId: string): number {
  try {
    return (getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events
        WHERE work_id = ? AND kind = ?
          AND json_extract(payload, '$.action_taken') IN (${MARKER_LIST})`,
    ).get(workId, AUDIT_KIND) as { n: number } | undefined)?.n ?? 0;
  } catch (err) {
    // A reader that cannot read must not manufacture a clean answer. Reporting ZERO would
    // say "nobody has tried yet", which HOLDS BACK the owner escalation — the failure
    // direction that leaves work stuck and silent. Reporting one attempt lets the owner hear
    // about it, which is the safe direction and the one OR2 asks for.
    logger.warn('validation attempt ledger unreadable; treating the row as attempted so the owner is not silenced', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE ORDERING LAW, AS THE SCHEDULER'S OWN QUERY
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE LAW: a two-key COMPLETE row may be reported to the OWNER as unvalidated only once the
 * platform holds a record that its validator was actually asked.
 *
 * SCOPE, STATED. The `paused` and `blocked` arms are a different verdict with no coverage
 * recorder behind them, so they are NOT gated — gating them would invent the very silence
 * this task removes. Their behaviour is byte-unchanged, and negative controls pin it.
 *
 * T21 REFINES THE WORD "paused", it does not widen this law: a paused row that has FILED A
 * CLOSE is a close, not a pause, and the coverage recorder behind closes is exactly what this
 * law is about. A paused row with no close request is untouched — the negative control.
 */
export const ownerEscalationOrderingExpr = (a: string): string =>
  `(CASE WHEN ${unvalidatedCloseExpr(a)}`
  + `  THEN ${validationAttemptRecordedExpr(a)} ELSE 1 END)`;

export interface OwnerEscalationRow {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  updated: string;
  /** 1 when an authority upheld the CURRENT block claim — "the PM agrees it is really stuck". */
  blocked_validated: number;
  /** Recorded failures on this row and its delegated pieces (`workFailureCountExpr`). */
  failures: number;
  /** What the agent said was in its way, from the newest blocked transition. NULL if none. */
  obstacle: string | null;
  /** The row's own priority — the key `POKE_THRESHOLDS` is indexed by, so the caller resolves
   *  this row's patience room through the ladder's table rather than guessing one. */
  priority: string;
  /** `updated_at` RAW, epoch ms. `updated` is the same instant rendered for the owner's sentence;
   *  this is the one the idle arithmetic runs on, because a clock is not a label. */
  updated_at_ms: number;
  /** 1 when a STATE shape matched (unvalidated close, unvalidated pause, blocked). A row that is
   *  here on the failure shape ALONE is 0, and only those are held to the assignee's patience. */
  by_state_arm: number;
}

/**
 * THE REALITY CHECK (UX-REPAIR round 2 T12).
 *
 * ── WHAT THE PREDICATE COULD NOT SEE, measured (investigation-round2.md §3) ──
 * Every table this sweep touched was `work`, `adjudications` and `work_events`. Not
 * `deliveries`, not `work.result_delivery_id`, not the parent ask. So on S4 (2026-08-10) it
 * escalated a job whose answer had shipped 25.4 seconds earlier:
 *   06:20:15.120  ask:6224401b… → done, result_delivery_id 8eb0439c
 *   06:20:40.569  77cba094 …    validation_escalated
 * and the question the owner was to be asked — *"is this actually in_progress?"* — was
 * unanswerable about a job that was finished and delivered. The gate that fired was working
 * exactly as specified; the specification omitted the delivery.
 *
 * ── THE CLAUSE, AND WHY IT IS THIS SHAPE ──
 * Two ways a row can already be answered, both RECORDED rather than inferred:
 *   (a) its own `result_delivery_id` resolves to a delivered receipt;
 *   (b) the ask it exists to satisfy (T11's `work.source_message_id` edge; ask ids are
 *       `ask:<messageId>`) is terminal with a delivered receipt.
 * The join is the one `work/ask-remediation.ts:236` already writes. An ask that is terminal
 * with NO receipt does not suppress anything — "terminal" is not "delivered", and the
 * genuinely-undelivered case is exactly what the 5-minute failsafe exists for.
 */
const DELIVERED_RECEIPT_EXPR = (a: string): string =>
  `(SELECT d.id FROM deliveries d WHERE d.id = ${a}.result_delivery_id AND d.outcome = 'delivered')`;

const PARENT_ASK_RECEIPT_EXPR = (a: string): string =>
  `(SELECT d.id FROM work ask JOIN deliveries d ON d.id = ask.result_delivery_id AND d.outcome = 'delivered'`
  + `  WHERE ${a}.source_message_id IS NOT NULL`
  + `    AND ask.id = 'ask:' || ${a}.source_message_id AND ask.kind = 'ask')`;

/** The receipt that says this row's work already reached the person, or NULL. */
export const alreadyDeliveredReceiptExpr = (a: string): string =>
  `COALESCE(${DELIVERED_RECEIPT_EXPR(a)}, ${PARENT_ASK_RECEIPT_EXPR(a)})`;

// ════════════════════════════════════════════════════════════════════════════════════════
// 3a · WHICH ROWS ARE THE OWNER'S PROBLEM — THE STATE ARMS, WITH ONE OWNER
//
// ⚠ THESE ARMS WERE WRITTEN TWICE. `selectRowsForOwnerEscalation` asks "who escalates" and
// `selectRowsSkippedAsDelivered` asks "who did the reality check hold back", and both carried
// their own copy of the same four-line OR group. That is the exact TB5 drift class this
// module's own header refuses ("one expression lives in two places and one copy is repaired:
// the writer and the reader disagree, silently"), and t124 hit it immediately — the blocked
// arm below had to be repaired in both copies or the log would have described a different
// population from the one that escalated. One owner now; both callers interpolate it.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * ── t124 FIX 1 — A BLESSED BLOCK IS NOT A SOLVED BLOCK, AND IT USED TO BE TREATED AS ONE. ──
 *
 * ⟨TOMBSTONE⟩ This arm read, from 2026-06-01 to t124:
 *
 *     OR (w.state = 'blocked' AND <blocked_validated> = 0)
 *
 * The conjunct is REMOVED, and its removal is the headline fix of the escalation lane.
 *
 * WHAT IT DID, driven rather than argued (`overhaul-plans/pm-cluster-triage.md` §Q4b, live
 * drive run 1): `work_validate(kind="blocked", valid=true)` → `upholdClaim(…,'blocked',…)`
 * sets `blocked_validated = 1`, so the moment the PM CONFIRMED a block was real the row left
 * this predicate permanently. It was already outside the PM's own UNVALIDATED_BLOCK lens and
 * already outside the poke ladder (which filters `in_progress`). Three sweeps, and the one
 * state that means "the platform has verified this work is genuinely stuck" was reachable by
 * none of them. The drive measured the consequence directly: 6 passes, idleness backdated to
 * 9,800 s, **zero `lane='owner'` rows**.
 *
 * WHY READING THE FLAG WAS THE ERROR, not the number behind it. `blocked_validated` answers
 * *"has an authority agreed the claim is true?"* — it is Key 2 on a BLOCK claim, and the
 * authority agreeing makes the block MORE real, not less. The predicate was treating a
 * verdict of "yes, genuinely stuck" as a resolution. Nothing in the uphold unblocks anything:
 * `upholdClaim` writes an adjudication and `tracker/tools.ts` then asks the primary, on an
 * `events`-lane notice, to "surface it to the user or unblock it manually" — a request to an
 * LLM, not a mechanism.
 *
 * SO THE ARM IS NOW THE STATE ALONE, and the bound is the one the sweep always had: the
 * top-level `NOT EXISTS (… kind='validation_escalated')` clause, which `work/tracker-view.ts`
 * records as *"a permanent stamp … one shot per row, forever"*. A blocked row gets ONE trip
 * up the ladder — two steers at the primary, then the platform's own surface — whether or not
 * the PM blessed it. It cannot loop, and it can no longer be cancelled by the blessing.
 *
 * THE NEGATIVE CONTROL IS THE OTHER TWO ARMS: `close` and `pause` KEEP their validation
 * conjunct, because for those two an uphold IS the resolution (the work is done / the pause is
 * legitimate) and there is nothing left to tell anybody.
 */
export const blockedNeedsOwnerExpr = (a: string): string => `${a}.state = 'blocked'`;

/**
 * ── t124 — THE FAILURE COUNTER THE OWNER ALREADY BELIEVED IN. ──
 *
 * OWNER RULING OR-PM-1v2 (`BACKLOG.md`, 2026-10-07), his words: blocked/declined work
 * *"should already happen after some failures/time."* The triage checked both halves against
 * the tree. **Time existed and was the ONLY trigger** — every rung of the poke ladder is
 * `now - work.updated_at`, and this sweep's own bound is `updated_at < staleBefore`.
 * **A failure counter did not exist anywhere.** A declined A2A, a refusal, an error and a
 * `blocked` status incremented nothing; the only counted things in the platform were its own
 * attempts (`currentRung`, `escalationSteerCount`), which is the engine counting how often it
 * has spoken, not how often the work has failed.
 *
 * ── WHAT COUNTS AS A FAILURE, AND WHY IT NEEDS NO NEW WRITE ──
 * The triage names three shapes. All three already land as ONE recorded row shape, because
 * all three go through `transition()`, the spine's single state writer:
 *   · a `blocked` status            → `transition` payload `$.to = 'blocked'`
 *   · an `intent:'FAIL'` decline    → `settlePieceWithoutResult(child, {to:'failed'})`
 *                                     (`agent/a2a-transport.ts` FAIL arm) → `$.to = 'failed'`
 *   · the synthetic `ABANDONED`     → `settlePieceWithoutResult(child, {to:'abandoned'})`
 *                                     (the give-up hook) → `$.to = 'abandoned'`
 * So the counter is a COUNT over durable `work_events` rows that the platform already writes,
 * read exactly the way `validationAttemptCountExpr` above reads the attempt ledger and
 * `tracker-view.ts`'s `lastEntryInto` already reads this very payload path. **No new
 * `work_events.kind`, no new column, no maintained integer, and no new WRITE anywhere.** A new
 * kind would have been available — migration `159` (`owed_interrupt`) is the worked example of
 * the three-part move (the declared list, a CHECK rebuild, a real writer) — and it is declined
 * because there is nothing left to record: every failure this counter counts is ALREADY a row.
 * Minting a second, parallel record of the same event is how a counter comes to disagree with
 * the history that caused it. This one cannot: it survives a restart and it is derived, for the
 * same reason the attempt ledger above is.
 *
 * ── AND IT COUNTS THE PIECES, which is where a DECLINE actually lands — ON TWO EDGES ──
 * A `FAIL` settles the delegated PIECE, never the task that the decline is about, and the piece
 * is a separate `work` row (`kind='task'`, `root_kind='a2a_thread'`, `root_id=<full thread id>`,
 * `parent_id NOT NULL` — `work/store.ts`'s `childrenForThread`). Pieces are OUTSIDE `taskScope`
 * by that `root_kind`, so they never escalate for themselves; the count has to reach them from
 * the row that IS in scope, and the two in-scope rows reach them by DIFFERENT columns:
 *
 *   · the row that DELEGATED the work (the asker's join row) owns its pieces by `parent_id`;
 *   · the row the decline is ABOUT — the assignee's auto-created ASSIGN task, which
 *     `tracker/schema.ts` opens `in_progress` with `a2aThreadId: threadId` and the default
 *     `root_kind='tracker'`, so it IS in scope — shares only the THREAD with the failed piece:
 *     `piece.root_id = task.a2a_thread_id`.
 *
 * The second edge is the owner's case and the one a `parent_id`-only count scores ZERO: the
 * assignee says it cannot do the work, its piece goes `failed`, the Key-1 close filer is gated
 * to success intents (`agent/a2a-transport.ts`, *"FAIL leaves the task open for the PM chase"*),
 * and the ASSIGN task is left `in_progress` on the agent that just declined it — carrying no
 * marker of the refusal at all. Both edges are columns, one level, no prose.
 *
 * `a2a_thread_id IS NOT NULL` is required on the thread edge on purpose: without it, every
 * ordinary tracker row (thread id NULL) would join every piece whose `root_id` is NULL and the
 * count would be a global failure tally wearing each row's name.
 *
 * ── THERE IS NO THRESHOLD HERE, AND THAT IS THE OWNER CORRECTION OF 2026-10-07 ──
 * The triage filed the count's threshold as a design item needing the owner's number. **There was
 * no number to wait for.** His standing rule: *"we don't specify numbers or times. We make
 * judgement calls based on how fast the model and model provider are."* This counter is therefore
 * a COUNT and nothing else — a recorded fact with no judgement in it. How much room a failure buys
 * is resolved from the assignee's own measured pace, and the whole argument lives on
 * `anyRecordedFailureExpr` below.
 */
export const FAILURE_TRANSITION_STATES = ['blocked', 'failed', 'abandoned'] as const;

const FAILURE_STATE_LIST = FAILURE_TRANSITION_STATES.map((s) => `'${s}'`).join(', ');

/**
 * The delegated pieces one row owns, by BOTH recorded edges — the `parent_id` edge for a row
 * that delegated the work, and the `a2a_thread_id` edge for the ASSIGN task a decline is about.
 *
 * ONE OWNER, and the parameters are why. The escalation arm interpolates this into a query that
 * already has the owning row in scope as `w`; `workFailureCount` below has no outer row and
 * joins one. `extraFrom`/`extraWhere` let the SECOND caller supply that join instead of
 * hand-translating the edges into a parallel query — the TB5 drift class, which this module has
 * now hit twice (the state arms above, and this), so nothing here is written twice.
 */
const pieceIdsExpr = (owner: string, extraFrom = '', extraWhere = ''): string =>
  `SELECT c.id FROM work c${extraFrom}`
  + `  WHERE c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.parent_id IS NOT NULL${extraWhere}`
  + `    AND (c.parent_id = ${owner}.id`
  + `         OR (${owner}.a2a_thread_id IS NOT NULL AND c.root_id = ${owner}.a2a_thread_id))`;

/** How many recorded failures this row and its delegated pieces have come back with, as SQL. */
export const workFailureCountExpr = (a: string): string =>
  `(SELECT COUNT(*) FROM work_events fe`
  + `  WHERE fe.kind = 'transition'`
  + `    AND json_extract(fe.payload, '$.to') IN (${FAILURE_STATE_LIST})`
  + `    AND (fe.work_id = ${a}.id`
  + `         OR fe.work_id IN (${pieceIdsExpr(a)})))`;

/**
 * ── OWNER CORRECTION, 2026-10-07 — AND IT DELETED A CONSTANT THIS LANE HAD SHIPPED. ──
 *
 * ⟨TOMBSTONE⟩ This arm first read `${workFailureCountExpr(a)} >= ESCALATION_FAILURE_THRESHOLD`,
 * with `ESCALATION_FAILURE_THRESHOLD = 3` declared here as a placeholder pending the owner's
 * number. **There was no number to wait for, and asking for one was the error.** His words:
 *
 *   *"we don't specify numbers or times. We make judgement calls based on how fast the model and
 *   model provider are. We've been over this so so many times."*
 *
 * A flat `3` is a judgement about pace with the pace taken out of it. It says the same thing about
 * an assignee whose provider answers in two seconds and one whose first chunk legitimately takes
 * ten minutes — and the second is the exact agent t90 was written to protect, after the PM read a
 * deliberately-slow model's honest pace as a stall and reassigned its work repeatedly.
 *
 * ── WHERE THE JUDGEMENT LIVES INSTEAD: ONE PLACE, AND IT IS NOT HERE ──
 * `tracker/assignee-patience.ts` already answers *"how long may ONE call on THIS assignee's model
 * legitimately take"* — `patienceFloorFor` → `resolveStreamPatience`, the provider's own declared
 * first-chunk and idle allowances. That module's header states the doctrine this correction
 * enforces: a "slow model multiplier" would need a REFERENCE speed to multiply against, *"and no
 * such number exists anywhere in this platform — inventing one is exactly the 'scaling the
 * numbers' fix SLOW-INFERENCE ruling R1 rejected."* `ESCALATION_FAILURE_THRESHOLD` was that
 * invention, in count form rather than time form.
 *
 * So the failure arm now consumes **the same source, through the same two functions, in the same
 * order as the poke ladder** (`tracker/pm-agent.ts`: `patienceFloorFor(assignee)` →
 * `flooredThresholds(POKE_THRESHOLDS[priority], floorSeconds)`), and it reads the rung that
 * platform already NAMES for escalation — `escalate`, rung 3. Nothing is chosen here: the table is
 * the ladder's, the floor is the provider's, the arithmetic is `flooredThresholds`'.
 *
 * ── WHAT IS LEFT IN SQL, AND WHY IT IS AN EXISTENCE TEST AND NOT A COUNT ──
 * `anyRecordedFailureExpr` asks *"has this work come back failed at all?"* — a FACT, with no
 * judgement in it. `>= 1` is not a tuned threshold the way `>= 3` was: it is the difference
 * between some and none. Every judgement about *how much room* that failure buys is made by the
 * patience resolution above, which is why the count stopped needing a number the moment the speed
 * judgement moved to the place that owns it.
 *
 * ── THE EFFECT, WHICH IS THE OWNER'S SENTENCE ──
 * A slow assignee's floor is large, so `max(base.escalate, floor × 3)` gives its honest attempts
 * proportionally more room before the owner is involved. A fast assignee resolves to the defaults,
 * so `max(1800, 450) = 1800` — today's table exactly, the same R6 arithmetic
 * `assignee-patience.ts` relies on — and its failures accumulate the owner's attention sooner
 * precisely because the same elapsed time means more from a model that answers quickly.
 * `flooredThresholds` is all `max`, so this arm can never be MORE aggressive than the base table
 * for any row, declared or not; that one-directionality is inherited, not re-argued.
 *
 * ── AND WHY THE RESOLUTION IS NOT CALLED FROM THIS MODULE ──
 * `work/` must not import `tracker/` (this module's doorbell seam exists for that reason), and
 * the patience family lives in `tracker/`. That is not a workaround here — it lands the split
 * this module already declares: **`scheduler/runner.ts` owns the clock, `work/validation-drive.ts`
 * owns the law.** `staleBeforeMs` is passed in for exactly that reason, and a patience-scaled idle
 * bound IS a clock. So the SQL admits a row that has failed, the scheduler resolves that row's own
 * room through the ladder's functions, and `failureArmStillWithinPatience` below is the LAW it
 * applies — one sentence, in the module that owns the predicate.
 */
export const anyRecordedFailureExpr = (a: string): string =>
  `(${workFailureCountExpr(a)} >= 1)`;

/**
 * THE LAW the scheduler applies to a row admitted by the failure arm alone: it still has room.
 *
 * `flooredEscalateSeconds` is `flooredThresholds(POKE_THRESHOLDS[priority], patienceFloorFor(
 * assignee).floorSeconds).escalate` — resolved by the caller because the resolver lives in
 * `tracker/`. Kept as a named predicate rather than a bare `<` at the call site so the law is
 * greppable from the module that owns the arm, and so the clause file and the scheduler cannot
 * disagree about which direction the comparison runs.
 *
 * A row whose assignee cannot be resolved at all gets the DEFAULT floor, never an exemption:
 * `patienceFloorFor(null)` returns the R6 defaults, so an unknown provider buys itself no extra
 * silence. That direction is `assignee-patience.ts`'s own and is not re-decided here.
 */
export function failureArmStillWithinPatience(
  idleSeconds: number, flooredEscalateSeconds: number,
): boolean {
  return idleSeconds < flooredEscalateSeconds;
}

/** The same count, for callers that are not building SQL (the log line, and the clause file). */
export function workFailureCount(workId: string): number {
  try {
    return (getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events fe
        WHERE fe.kind = 'transition'
          AND json_extract(fe.payload, '$.to') IN (${FAILURE_STATE_LIST})
          AND (fe.work_id = @id
               OR fe.work_id IN (${pieceIdsExpr('ow', ', work ow', ' AND ow.id = @id')}))`,
    ).get({ id: workId }) as { n: number } | undefined)?.n ?? 0;
  } catch (err) {
    // Same direction as `validationAttemptCount`'s unreadable branch, for the same reason: a
    // reader that cannot read must not manufacture the answer that SILENCES the owner. Zero
    // would say "nothing has failed" and hold the row back, so the failure is reported as a
    // count of zero ONLY to the log and the arm is left to the other predicates — never
    // inflated into an escalation this function cannot evidence.
    logger.warn('failure counter unreadable; reporting zero and leaving the state arms to decide', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * WHAT THE AGENT SAID WAS IN ITS WAY — the newest blocked transition's own note.
 *
 * This is a RECORDED sentence, not a generated one, and it is the only part of the owner's
 * alert that can say what was actually tried. `tracker/tools.ts` hard-gates it at creation:
 * `status="blocked"` is REFUSED below 15 characters of `notes`, with a steer naming the shape
 * ("need API key for service X", "external service Y is returning 500s"). So on the blocked
 * arm this is reliably present and reliably specific — the one thing the platform knows about
 * the obstacle that it did not compose itself.
 *
 * `$.note` and not `$.reason`: `transition()` writes the CALLER's prose to `note` and its own
 * mechanical description to `reason` (for a status change that reads
 * `work_update(action="status") -> blocked`, which tells the owner nothing he can act on).
 */
export const statedObstacleExpr = (a: string): string =>
  `(SELECT json_extract(te.payload, '$.note') FROM work_events te`
  + `  WHERE te.work_id = ${a}.id AND te.kind = 'transition'`
  + `    AND json_extract(te.payload, '$.to') = 'blocked'`
  + `  ORDER BY te.id DESC LIMIT 1)`;

/**
 * THE STATE ARMS — the four shapes of "this is the owner's problem", in one place.
 *
 * ── WHY THE FAILURE ARM IS AN ARM AND NOT A BYPASS OF THE CLOCK ──
 * "Failures/time" could have been read as `failures >= N OR stale`, dropping the staleness
 * floor for a row with a high count. It is deliberately read as `(one of these shapes) AND
 * stale` instead, with the count as a fourth SHAPE. The reason is the acceptance bar's own
 * negative control: **healthy progressing work must never escalate.** A row that failed three
 * times and is right now being retried has a moving `updated_at`, so the 5-minute quiet floor
 * excludes it — and that floor is the only thing standing between this arm and an escalation
 * fired at an agent mid-recovery. Failures change WHICH rows can escalate (a declined ASSIGN
 * left `in_progress` was in no arm at all and was therefore structurally invisible to this
 * sweep); the clock still decides WHEN.
 */
export const ownerEscalationStateArmsExpr = (a: string): string =>
  `(\n`
  + `        ${unvalidatedCloseExpr(a)}\n`
  + `        OR (${unvalidatedPauseExpr(a)} AND ${a}.missed_runs_paused_at IS NULL)\n`
  + `        OR ${blockedNeedsOwnerExpr(a)}\n`
  + `      )`;

/**
 * EVERY shape that can put a row in front of the owner: a STATE the sweep's own clock governs, or
 * a recorded FAILURE whose room is governed by the assignee's measured pace.
 *
 * The two are kept separable — and the escalating query SELECTs which one matched — because they
 * are answerable on different clocks. A blocked row is late at the sweep's bound; a failed row is
 * late at its own assignee's patience-floored escalate rung, which is longer and which only the
 * caller can resolve. Collapsing them would force one clock onto both and lose the correction
 * above.
 */
export const ownerEscalationShapesExpr = (a: string): string =>
  `(${ownerEscalationStateArmsExpr(a)} OR ${anyRecordedFailureExpr(a)})`;

/**
 * The rows the scheduler may tell the owner about. Moved here from `scheduler/runner.ts` so
 * the query and the law it now obeys live in one place, beside the spine tables they read —
 * the same reason `work/audit-trail.ts` holds the trail's SQL.
 *
 * `staleBeforeMs` is the caller's cutoff (`now - VALIDATION_ESCALATION_MIN`), passed in
 * rather than computed here so the scheduler keeps owning its clock.
 */
export function selectRowsForOwnerEscalation(
  staleBeforeMs: number,
  serviceAgentIds: readonly string[],
): OwnerEscalationRow[] {
  // Impossible-sentinel fallback so an empty list yields NOT IN ('__none__'), which matches
  // nothing (a bare '' would wrongly exclude NULL assignees via the COALESCE below).
  const serviceParams = serviceAgentIds.length > 0 ? [...serviceAgentIds] : ['__none__'];
  const placeholders = serviceParams.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status,
           w.agent_id AS assigned_to, ${msToText('w.updated_at')} as updated,
           ${validatedExpr('w', 'blocked')} AS blocked_validated,
           ${workFailureCountExpr('w')} AS failures,
           ${statedObstacleExpr('w')} AS obstacle,
           COALESCE(w.priority, 'normal') AS priority,
           w.updated_at AS updated_at_ms,
           (CASE WHEN ${ownerEscalationStateArmsExpr('w')} THEN 1 ELSE 0 END) AS by_state_arm
    FROM work w
    WHERE ${taskScope('w')}
      AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
      AND ${awaitingUserVerdictExpr('w')} = 0
      AND COALESCE(w.agent_id, '') NOT IN (${placeholders})
      AND COALESCE(w.requester_id, '') NOT IN (${placeholders})
      -- PHASE-2 T8T: "an unvalidated close does not sit forever" has two shapes, and
      -- migration 139 means the worker's own close leaves the row where it was with a
      -- Key-1 request on it. Reading only the done arm would let exactly the rows this
      -- sweep exists for age out of its sight; unvalidatedCloseExpr is both shapes and
      -- the whole state set they can sit in (T21). An active missed_runs_paused_at means
      -- the ENGINE paused this task for missed runs (alertMissedRuns), not the agent — not
      -- the owner's call; the PM sweep adjudicates that unvalidated pause and D12 owns its
      -- resolution. The blocked and failure-count arms are t124's; §3a argues both.
      AND ${ownerEscalationShapesExpr('w')}
      -- SWEEP CORE-2 item 1 — THE ORDERING LAW. The owner is not told his validator did not
      -- rule while the platform holds no record that it was ever asked.
      AND ${ownerEscalationOrderingExpr('w')} = 1
      -- UX-REPAIR round 2 T12 — THE REALITY CHECK. The owner is not asked whether work is
      -- finished when the platform's own ledger says it already reached him.
      AND ${alreadyDeliveredReceiptExpr('w')} IS NULL
      AND w.updated_at < ?
    LIMIT 20
  `).all(...serviceParams, ...serviceParams, staleBeforeMs) as OwnerEscalationRow[];
}

export interface SkippedAsDeliveredRow extends OwnerEscalationRow { deliveryId: string }

/**
 * The rows the REALITY CHECK is holding back right now, with the receipt that holds each one.
 *
 * Read only to say so out loud, exactly as `countRowsHeldBackFromOwner` below does for the
 * ordering law: a skip nobody can see is the same silent behaviour in the other direction, and
 * on the day this clause is wrong the log is where that becomes visible. Deliberately does NOT
 * write `validation_escalated` — that stamp is permanent (`work/tracker-view.ts:323-324`,
 * "one shot per row, forever"), and burning the row's one escalation on a pass that decided
 * NOT to escalate would be worse than the defect it fixes.
 */
export function selectRowsSkippedAsDelivered(
  staleBeforeMs: number,
  serviceAgentIds: readonly string[],
): SkippedAsDeliveredRow[] {
  const serviceParams = serviceAgentIds.length > 0 ? [...serviceAgentIds] : ['__none__'];
  const placeholders = serviceParams.map(() => '?').join(',');
  try {
    return getDb().prepare(`
      SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status,
             w.agent_id AS assigned_to, ${msToText('w.updated_at')} as updated,
             ${validatedExpr('w', 'blocked')} AS blocked_validated,
             ${workFailureCountExpr('w')} AS failures,
             ${statedObstacleExpr('w')} AS obstacle,
             COALESCE(w.priority, 'normal') AS priority,
             w.updated_at AS updated_at_ms,
             (CASE WHEN ${ownerEscalationStateArmsExpr('w')} THEN 1 ELSE 0 END) AS by_state_arm,
             ${alreadyDeliveredReceiptExpr('w')} AS deliveryId
      FROM work w
      WHERE ${taskScope('w')}
        AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
        AND ${awaitingUserVerdictExpr('w')} = 0
        AND COALESCE(w.agent_id, '') NOT IN (${placeholders})
        AND COALESCE(w.requester_id, '') NOT IN (${placeholders})
        AND ${ownerEscalationShapesExpr('w')}
        AND ${ownerEscalationOrderingExpr('w')} = 1
        AND ${alreadyDeliveredReceiptExpr('w')} IS NOT NULL
        AND w.updated_at < ?
      LIMIT 20
    `).all(...serviceParams, ...serviceParams, staleBeforeMs) as SkippedAsDeliveredRow[];
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE NUDGE — OR2'S SHAPE, CARRIED FROM THE FOUR SURFACES THAT ALREADY CONVERTED.
//
// The old text was written 2026-06-01 (`06e6ee3`), moved onto a live model-visible lane on
// 2026-07-17 (`2f302dc`) with the commit stating *"The note text is unchanged"*, and never
// included in the OR2 conversions. It read, in the ENGINE's voice, with the owner's name in
// it: *"Marcus, is this actually in_progress? Reply yes/no with any context. **Primary agent**:
// when Marcus replies, call work_validate(action="apply_user_validation", task_id="77cba094-…",
// …)"*. 732 chars, sliced to 400 by the events lane, cut MID-TASK-ID — so the instruction
// could not have been complied with even in principle.
//
// The recorded conversion pattern is the opposite shape (`PHASE-4.md:14`, owner ruling
// 2026-07-30): *"the AGENT is told, with an 'if the user should know, please tell the user'
// style nudge, and the agent decides and speaks."* This is that, and it is short enough that
// the 400-char gist carries it WHOLE — so the severed-instruction defect dies without touching
// the cap (O15 refused; the cap is a §T0-B budget decision).
//
// The two objections `packages/shared/src/visibility.ts:282-284` recorded when it declined to
// allowlist this note — *"it embeds raw task ids and a '**Primary agent**: call …' tool
// instruction"* — are both fixed here. Allowlisting is still NOT done, and that is the point:
// the agent speaks to the owner, not the notice.
// ════════════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════════════
// AND IT CANNOT VANISH — the bounded verify-and-re-steer OR2 already runs elsewhere.
//
// MEASURED (investigation-round2.md §3): the notice rode a no-obligation awareness lane
// (`requiresResponse:false`) under a header that says *"Surface one to the owner only if it
// genuinely matters; never reply to its sender"*, so ending the turn silently was the lane's
// DEFAULT POSTURE, not a failure — and `recordValidationEscalation` was called unconditionally
// at ask time, writing a stamp that `work/tracker-view.ts:323-324` records as *"a permanent
// stamp … one shot per row, forever"*. One silent turn ended the story, on a row that could
// never be escalated again. The primary agent's turn was compliance, not a drop.
//
// OR2's shape is engine detects → steers → VERIFIES via delivery records → bounded retry →
// the platform's own surface. This is that, with both numbers CARRIED rather than chosen:
// the bound is `MAX_FLOOR_STEER_ATTEMPTS` (the platform's existing answer to "how many steers
// before silence is a fault"), and the unit is the TURN, the same discipline
// `work/run-deliver-drive.ts:76-92` adopted after a retry loop burned a whole ladder in ten
// seconds. The one-shot suppressor STAYS for the fired case: once the agent has spoken to the
// owner, or the bound is spent and the platform surface has said so, the row is done.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The audit marker for one steer of the owner-verdict nudge. A free string inside the audit
 *  payload, the landing place migration 152's header names for exactly this. */
export const ESCALATION_STEER_MARKER = 'validation_escalation_steer';

/** How many REAL steers this row has spent — DISTINCT primary turns, never rows, so a 30-second
 *  sweep cadence cannot burn the bound between two of the agent's turns. */
export function escalationSteerCount(workId: string): number {
  try {
    return (getDb().prepare(
      `SELECT COUNT(DISTINCT COALESCE(json_extract(payload, '$.turn_number'), -id)) AS n
         FROM work_events
        WHERE work_id = ? AND kind = '${AUDIT_KIND}'
          AND json_extract(payload, '$.action_taken') = ?`,
    ).get(workId, ESCALATION_STEER_MARKER) as { n: number } | undefined)?.n ?? 0;
  } catch (err) {
    // A ladder that cannot read its own counter must not steer for ever. Reporting it spent
    // hands the row to the platform surface, which is the direction that still says something.
    logger.warn('owner-verdict ladder: could not read its own counter; treating it as spent', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

/** When the FIRST steer for this row went out, so the verify step has a boundary to read the
 *  delivery ledger against. Null when none has. */
export function firstEscalationSteerAt(workId: string): number | null {
  try {
    return (getDb().prepare(
      `SELECT MIN(created_at) AS at FROM work_events
        WHERE work_id = ? AND kind = '${AUDIT_KIND}'
          AND json_extract(payload, '$.action_taken') = ?`,
    ).get(workId, ESCALATION_STEER_MARKER) as { at: number | null } | undefined)?.at ?? null;
  } catch { return null; }
}

/** Record one steer's spend on the row's own durable history. */
export function recordEscalationSteer(
  workId: string, detail: { attempt: number; bound: number; turnNumber: number | null },
): void {
  appendWorkEvent(workId, AUDIT_KIND, 'engine', {
    entry_kind: ESCALATION_STEER_MARKER,
    from_status: null, to_status: null,
    reason: `the primary was steered to decide whether the owner needs to rule on this row`,
    action_taken: ESCALATION_STEER_MARKER,
    note: `steer ${detail.attempt} of ${detail.bound}`,
    evidence_json: null,
    turn_number: detail.turnNumber,
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE SENTENCE THE OWNER ACTUALLY READS — t124, and it is the point of the whole lane.
//
// The ladder's end is `recordFloorGhost`, the one sanctioned way the platform addresses the
// owner directly (`role='system'`, the `Heads up:` prefix). Until t124 it said this, for every
// row and every shape:
//
//   "a task has been marked blocked for over 5 minutes, your PM cannot confirm it, and your
//    agent has not come back to you about it — the platform asked it twice and got no reply."
//
// Three things wrong with that, and the third is a defect this lane CREATED and must close:
//
//   1. It never names the work. "a task" — on a box with thirty open rows the owner cannot tell
//      which one, cannot act, and cannot even ask a useful question about it.
//   2. It never says what was tried, so there is nothing in it he can act on. The agent's own
//      stated obstacle is RECORDED and hard-gated to at least 15 specific characters, and it
//      was being thrown away at exactly the moment it was needed.
//   3. ⚠ "your PM cannot confirm it" IS NOW SOMETIMES A LIE, because of this lane's own first
//      fix. Dropping the validation conjunct from the blocked arm means a PM-UPHELD block —
//      the PM checked it and agreed it is genuinely stuck — reaches this surface for the first
//      time. Shipping fix 1 without this one would have the platform tell the owner its
//      validator was silent in precisely the case where its validator had SPOKEN, and the
//      honest-record family does not permit a line that reads the same whether a fact is known,
//      unknown, or known to be the opposite.
//
// So the sentence is COMPOSED FROM THE ROW'S OWN RECORDED FACTS, and every clause is omitted
// rather than guessed when the fact behind it is missing. Nothing here is generated prose about
// the work: the title is the title, the instant is `updated_at`, the obstacle is the agent's own
// note, the attempt counts are COUNTs over durable events, and the PM's verdict is its
// adjudication. If a fact is not on file, its clause is not in the sentence.
// ════════════════════════════════════════════════════════════════════════════════════════

/** One recorded sentence per fact, with nothing asserted that is not on file. */
export function ownerEscalationAlertLine(p: {
  title: string;
  status: string;
  since: string;
  agentName: string;
  steers: number;
  failures: number;
  blockedValidated: boolean;
  obstacle: string | null;
}): string {
  const title = p.title.length > 60 ? `${p.title.slice(0, 60)}…` : p.title;
  const parts: string[] = [`"${title}" has been ${p.status} since ${p.since} and nobody has brought it to you.`];

  // THE VALIDATOR'S VERDICT, three-valued and never collapsed. "Upheld" is the case fix 1
  // opened and it is the STRONGEST thing the platform can say — the block was checked and is
  // real — so it must not be delivered in the words for "we could not check".
  if (p.status === 'blocked') {
    parts.push(p.blockedValidated
      ? `Your PM checked it and confirmed the block is real.`
      : `Your PM has not been able to confirm it.`);
  } else {
    parts.push(`Your PM cannot confirm it.`);
  }

  // WHAT THE AGENT SAID WAS IN ITS WAY. Quoted, never paraphrased, and whitespace-collapsed
  // the way every other owner-facing composer in this module treats stored prose.
  const obstacle = (p.obstacle ?? '').replace(/\s+/g, ' ').trim();
  if (obstacle) {
    const quoted = obstacle.length > 200 ? `${obstacle.slice(0, 200)}…` : obstacle;
    parts.push(`${p.agentName} said what was in the way: "${quoted}".`);
  }

  // WHAT THE PLATFORM ITSELF TRIED. The steer count is `escalationSteerCount`'s DISTINCT-turn
  // count, so it is attempts the agent actually had a turn to answer, not sweep passes.
  parts.push(p.steers === 1
    ? `The platform asked ${p.agentName} once to raise it with you and got no reply.`
    : `The platform asked ${p.agentName} ${p.steers} times to raise it with you and got no reply.`);

  // THE FAILURE COUNT, only when there is one. Omitted at zero rather than printed as "0
  // failures", which reads like a reassurance on a row that is stuck for some other reason.
  if (p.failures > 0) {
    parts.push(p.failures === 1
      ? `This work has come back failed or blocked once already.`
      : `This work has come back failed or blocked ${p.failures} times already.`);
  }

  return parts.join(' ');
}

export function ownerVerdictNudgeText(p: {
  taskId: string; title: string; status: string; agentName: string;
  ownerName: string; boundMin: number;
}): string {
  const shortId = p.taskId.slice(0, 8);
  const title = p.title.length > 60 ? `${p.title.slice(0, 60)}…` : p.title;
  return (
    `${p.agentName} marked "${title}" (${shortId}) ${p.status} over ${p.boundMin} minutes ago `
    + `and the PM still cannot confirm it. If you can settle it yourself, do that and leave `
    + `${p.ownerName} out of it. If only he can say whether it is really done, ask him in your `
    + `own voice — then record his answer with work_validate (apply_user_validation), quoting him.`
  );
}

/**
 * The rows the law is HOLDING BACK right now — stale, unvalidated, and never once put in
 * front of a validator. Read only to say so out loud: a hold nobody can see is the same
 * silent skip in the other direction.
 */
export function selectRowsHeldBackFromOwner(
  staleBeforeMs: number,
  serviceAgentIds: readonly string[],
): string[] {
  const serviceParams = serviceAgentIds.length > 0 ? [...serviceAgentIds] : ['__none__'];
  const placeholders = serviceParams.map(() => '?').join(',');
  try {
    return (getDb().prepare(`
      SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')}
        AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
        AND ${awaitingUserVerdictExpr('w')} = 0
        AND COALESCE(w.agent_id, '') NOT IN (${placeholders})
        AND COALESCE(w.requester_id, '') NOT IN (${placeholders})
        AND ${unvalidatedCloseExpr('w')}
        AND ${validationAttemptRecordedExpr('w')} = 0
        AND w.updated_at < ?
      ORDER BY w.updated_at ASC
      LIMIT 20
    `).all(...serviceParams, ...serviceParams, staleBeforeMs) as Array<{ id: string }>).map((r) => r.id);
  } catch (err) {
    logger.warn('held-back lens unreadable (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** The same set, as the count the sweep has always logged. */
export function countRowsHeldBackFromOwner(
  staleBeforeMs: number,
  serviceAgentIds: readonly string[],
): number {
  return selectRowsHeldBackFromOwner(staleBeforeMs, serviceAgentIds).length;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE FLOOR — UX-REPAIR T40. A FILED CLOSE CANNOT SIT PAST ITS BOUND IN SILENCE.
//
// ── THE INCIDENT ──
// The owner's first task after the `.27` update filed a close (RESULT + EVIDENCE on the row,
// `updated_at` moved) and never closed. His card's activity log showed ZERO validation
// events, ever. Whatever kept his validator from ruling, the ORDER above then did the rest:
// the escalation is gated on a recorded attempt, and the only two writers of that record live
// INSIDE the validator's own review. A validator that never runs writes neither marker, so
// the gate it feeds holds the row out of the owner's sight with no ceiling and no timeout.
// The hold was already said out loud in the log; nothing ever ENDED it.
//
// ── WHY THIS IS NOT A WEAKENING OF THE ORDERING LAW ──
// The law's sentence is *"the owner is told a row is unvalidated only AFTER a recorded
// validation attempt exists for it"*. It is about ORDER, not about silence: it assumes
// attempts eventually get recorded, because the validator eventually runs. This closes the
// case the assumption misses. It uses the SAME bound the escalation already uses (no new
// threshold, #14), records the SAME `validator_unavailable` marker the PM's own
// no-validator branch writes (no new kind, migration 152's CHECK untouched), and escalates
// NOTHING itself — it makes the existing escalation able to see the row on its next pass.
//
// It is also IDEMPOTENT by construction: the lens it reads selects only rows with ZERO
// recorded attempts, so a row it has already marked drops out of its own candidate set.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Record an attempt-of-record on every row past the bound that no validator has ever been
 * asked about. Returns the ids marked, for the caller's log.
 */
export function recordAttemptsForRowsNoValidatorEverSaw(
  staleBeforeMs: number,
  serviceAgentIds: readonly string[],
): string[] {
  const ids = selectRowsHeldBackFromOwner(staleBeforeMs, serviceAgentIds);
  const marked: string[] = [];
  for (const id of ids) {
    try {
      appendWorkEvent(id, AUDIT_KIND, 'engine', {
        entry_kind: 'observation',
        from_status: null,
        to_status: null,
        reason:
          'this close request has been waiting past the escalation bound and the platform '
          + 'holds no record that its validator was ever asked; recording the attempt so the '
          + 'row stops being invisible',
        action_taken: VALIDATION_ATTEMPT_UNAVAILABLE,
        note: null,
        evidence_json: null,
      });
      marked.push(id);
    } catch (err) {
      logger.warn('could not record an attempt-of-record for a held-back row (non-fatal)', {
        workId: id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (marked.length > 0) {
    logger.error('validation is STALLED: rows past the bound whose validator was never asked', {
      rows: marked.length, ids: marked.slice(0, 5),
    });
  }
  return marked;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 6 · AND THE OWNER HEARS ABOUT IT — through the toast machinery that already exists.
//
// The reality check (§3) suppresses owner ESCALATION whenever the work already reached the
// person, and the owner's incident is exactly that shape: the brief was sent, so the question
// the escalation asks — *"is this actually done?"* — is one he should never be bothered with.
// That is correct, and it is also why releasing the row above cannot, by itself, reach him.
//
// So the thing he is told is not about the WORK. It is about the VALIDATOR: task validation
// is stalled. One statement per episode (the T27 lesson — not one per row and not one per
// sweep), and the episode ENDS when validation resumes, so a later stall speaks again.
// ════════════════════════════════════════════════════════════════════════════════════════

/** True while an unresolved stall has already been announced. */
let validatorSilenceAnnounced = false;

/** Test seam / boot reset. */
export function resetValidatorSilenceEpisode(): void {
  validatorSilenceAnnounced = false;
}

export const VALIDATOR_STALLED_TOAST =
  'Task validation is stalled — closed work is waiting on the project manager and it has not '
  + 'ruled. Nothing is lost; the tasks stay open until it does.';

/**
 * @param stalledRows how many rows this sweep found past the bound with no attempt recorded
 * @param agentId     the agent whose chat the toast belongs to (the primary)
 */
export async function noteValidatorSilence(stalledRows: number, agentId: string): Promise<void> {
  if (stalledRows <= 0) {
    // The validator is ruling again — the episode is over and a NEW stall may speak.
    validatorSilenceAnnounced = false;
    return;
  }
  if (validatorSilenceAnnounced) return;
  validatorSilenceAnnounced = true;
  try {
    // Imported at the point of use, as `scheduler/runner.ts` does: `work/` is loaded by
    // modules the gateway itself pulls in, and a static edge here is a cycle.
    const { broadcast } = await import('../gateway/ws.js');
    broadcast({
      type: 'chat:error',
      agentId,
      error: VALIDATOR_STALLED_TOAST,
      code: 'VALIDATION_STALLED',
      // `warning` (auto-dismissing amber), not `error`: nothing is lost and there is no
      // action the owner must take — the platform is telling him what it is waiting on.
      severity: 'warning',
      retryable: false,
    });
  } catch (err) {
    logger.warn('validator-silence toast failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
