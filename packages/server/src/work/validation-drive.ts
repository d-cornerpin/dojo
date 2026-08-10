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
  pendingCloseRequestExpr,
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
 */
export const ownerEscalationOrderingExpr = (a: string): string =>
  `(CASE WHEN (`
  + `    (${a}.state = 'done' AND ${validatedExpr(a, 'done')} = 0)`
  + `    OR (${a}.state = 'claimed' AND ${pendingCloseRequestExpr(a)} = 1)`
  + `  ) THEN ${validationAttemptRecordedExpr(a)} ELSE 1 END)`;

export interface OwnerEscalationRow {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  updated: string;
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
           w.agent_id AS assigned_to, ${msToText('w.updated_at')} as updated
    FROM work w
    WHERE ${taskScope('w')}
      AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
      AND ${awaitingUserVerdictExpr('w')} = 0
      AND COALESCE(w.agent_id, '') NOT IN (${placeholders})
      AND COALESCE(w.requester_id, '') NOT IN (${placeholders})
      AND (
        (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
        -- PHASE-2 T8T: the other half of "an unvalidated close does not sit forever".
        -- Migration 139 means a worker's own close leaves the row claimed with a Key-1
        -- request on it instead of moving it to done, so reading only the done arm would let
        -- exactly the rows this sweep exists for age out of its sight.
        OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
        -- An active missed_runs_paused_at means the ENGINE paused this task for missed runs
        -- (alertMissedRuns), not the agent — not the owner's call. The PM sweep adjudicates
        -- that unvalidated pause and D12 owns its resolution.
        OR (w.state = 'paused' AND ${validatedExpr('w', 'paused')} = 0 AND w.missed_runs_paused_at IS NULL)
        OR (w.state = 'blocked' AND ${validatedExpr('w', 'blocked')} = 0)
      )
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
             ${alreadyDeliveredReceiptExpr('w')} AS deliveryId
      FROM work w
      WHERE ${taskScope('w')}
        AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
        AND ${awaitingUserVerdictExpr('w')} = 0
        AND COALESCE(w.agent_id, '') NOT IN (${placeholders})
        AND COALESCE(w.requester_id, '') NOT IN (${placeholders})
        AND (
          (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
          OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
          OR (w.state = 'paused' AND ${validatedExpr('w', 'paused')} = 0 AND w.missed_runs_paused_at IS NULL)
          OR (w.state = 'blocked' AND ${validatedExpr('w', 'blocked')} = 0)
        )
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
// it: *"David, is this actually in_progress? Reply yes/no with any context. **Primary agent**:
// when David replies, call work_validate(action="apply_user_validation", task_id="77cba094-…",
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
// never be escalated again. kevin's turn was compliance, not a drop.
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
export function countRowsHeldBackFromOwner(
  staleBeforeMs: number,
  serviceAgentIds: readonly string[],
): number {
  const serviceParams = serviceAgentIds.length > 0 ? [...serviceAgentIds] : ['__none__'];
  const placeholders = serviceParams.map(() => '?').join(',');
  try {
    return (getDb().prepare(`
      SELECT COUNT(*) AS n FROM work w
      WHERE ${taskScope('w')}
        AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
        AND ${awaitingUserVerdictExpr('w')} = 0
        AND COALESCE(w.agent_id, '') NOT IN (${placeholders})
        AND COALESCE(w.requester_id, '') NOT IN (${placeholders})
        AND (
          (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
          OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
        )
        AND ${validationAttemptRecordedExpr('w')} = 0
        AND w.updated_at < ?
    `).get(...serviceParams, ...serviceParams, staleBeforeMs) as { n: number }).n;
  } catch {
    return 0;
  }
}
