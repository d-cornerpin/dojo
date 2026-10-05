// ════════════════════════════════════════════════════════════════════════════════════════
// THE PM RE-REVIEW BOUND — a validation nobody can satisfy must not buy an LLM review every minute.
//
// ⚠ THE MEASURED SHAPE. On a user's box the PM held three validations permanently pending, and the
// stall capture found the same fingerprint every single minute for hours: the poke loop ticked, the
// review ran, the validator returned no verdict, and the review was re-driven. Three rows that could
// not be satisfied therefore bought one full PM review — board assembly, an engine event, a model
// turn — every 60 seconds, for ever. The brief's words: "permanently-wedged validations must not
// re-drive the review every minute".
//
// ── WHAT ALREADY EXISTS, AND WHY IT IS THE THING THAT NEEDS A BOUND RATHER THAN THE BOUND ──
// `tracker/pm-agent.ts` gates its reviews on `lastSituationReportHash`: an unchanged ACTIONABLE
// issue-set is skipped, which is the engine-level "don't firehose the primary". Three places release
// that hash, and they are all correct in themselves:
//
//   · the issue-set emptied   — the set is resolved; the next occurrence must not compare equal
//                               to a stale hash (the {A} -> {} -> {A} case AUDIT-FIX fixed).
//   · SWEEP-A TB8 JOB 2       — a review that was HANDED rows and ruled on none releases the hash,
//                               "without this the review that ruled on nothing was also the LAST
//                               review those rows ever got". That sentence is right, and it is the
//                               one with no ceiling on it.
//   · a thrown PM review      — retry next cycle, for the same reason.
//
// So the defect is not the release. The defect is that the release is UNCONDITIONAL: `reReview` is
// `missed.length > 0` and nothing asks how many times this has already happened.
//
// ── WHY THE CLOCK CANNOT COME FROM THE DURABLE LEDGER, which is the first thing to try ──
// `work/validation-drive.ts` already counts attempts per row (`validationAttemptCount`), one row
// written per missed row per review, so the ledger IS a durable tick counter and a backoff keyed on it
// would survive restarts. It cannot work, and the reason is worth writing down so nobody spends an
// afternoon on it: the counter only advances when a review RUNS. Suppress a review and the count
// freezes, so a ledger-derived gap never elapses and the row is never reviewed again. The clock has to
// be read where the TICK is, which is why this gate sits on the tick and holds its own instant.
//
// ── A BACKOFF, NEVER A SKIP-FOR-EVER ──
// The brief offers "backoff or skip-until-changed". It is a backoff, and the cap is the whole reason:
// a bound that eventually stops reviewing a row would re-create exactly the silence TB8 removed — a
// row awaiting Key 2 that nobody ever asks about again. The gap doubles and then STOPS doubling, so a
// wedged set is still reviewed, for ever, just not sixty times an hour. Nothing is removed, nothing
// expires, no count is compared against a ceiling that abandons it.
//
// ⚠ AND THE FIRST TWO DRIVES ARE DELIBERATELY UNTOUCHED. TB8's measurement was TWO PM validation
// turns in a row returning no verdict, and the fix for it was this re-drive. A bound that bit on the
// second drive would undo the thing it is bounding. The gap after the first drive is one tick, so the
// behaviour TB8 measured is byte-for-byte what it was; the ceiling only appears on the third.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The longest the backoff may grow to.
 *
 * ⚠ THIS IS THE LINE THAT MAKES IT A BACKOFF AND NOT AN ABANDONMENT. Thirty minutes is chosen against
 * the product's own owner-escalation clock (`VALIDATION_ESCALATION_MIN`, 5 minutes): by the time the
 * gap reaches the cap the owner has long since been told the row is unvalidated, so the review is no
 * longer the thing standing between him and the information — it is the PM still trying. A wedged set
 * costs roughly 50 reviews a day at this cap instead of 1,440, and is never dropped.
 */
export const RE_REVIEW_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * The gap owed after `drives` consecutive re-drives of the SAME issue-set, in ms.
 *
 * Doubling from one tick, capped. Exported because it is the whole policy and a clause should be able
 * to read the schedule out of it rather than re-deriving it from observed behaviour.
 */
export function reReviewGapMs(drives: number, baseGapMs: number): number {
  const exponent = Math.max(0, drives - 1);
  // Doubling is computed in floating point rather than by shifting, because `1 << 40` wraps to a
  // negative number and a NEGATIVE gap would make every tick eligible — the exact opposite of a bound.
  const gap = baseGapMs * Math.pow(2, Math.min(exponent, 40));
  return Math.min(gap, RE_REVIEW_BACKOFF_CAP_MS);
}

export interface ReReviewDecision {
  /** True when this tick must NOT re-drive the review. */
  readonly heldBack: boolean;
  /** How many re-drives this issue-set has been granted, including this one when it is let through. */
  readonly drives: number;
  /** How long since the last granted re-drive. */
  readonly waitedMs: number;
  /** The gap that applies — owed when held back, owed NEXT when let through. */
  readonly gapMs: number;
}

interface HeldSet {
  readonly key: string;
  readonly drives: number;
  readonly lastDriveAtMs: number;
}

let held: HeldSet | null = null;

/**
 * May this tick re-drive the review of an issue-set the dedup hash has already released?
 *
 * ⚠ PLACEMENT, WHICH IS A REAL DECISION AND IS ARGUED HERE BECAUSE THE CALL SITE CANNOT CARRY IT.
 * This is asked AFTER the issue-set-hash comparison, not before it, and the difference is not
 * cosmetic. Before the comparison it would see every tick whose set was unchanged — including the
 * ordinary, already-cheap case the hash gate exists to skip — and would start reporting a backoff as
 * the reason for a skip whose real reason was "nothing changed". After it, the gate is reached only
 * when something RELEASED the hash, which is precisely the re-drive path this bound is for, and
 * `drives` therefore counts re-drives rather than ticks.
 *
 * A DOORBELL RESETS IT, for the reason the hash gate already exempts one: a doorbell IS a change, so
 * the set in front of the PM is new work and earns a fresh schedule.
 */
export function reReviewHeldBack(input: {
  /** The actionable issue-set's stable key — the same string the dedup hash compares. */
  readonly key: string;
  readonly nowMs: number;
  /** The platform's own poke cadence, passed in so this module declares no second clock. */
  readonly baseGapMs: number;
  readonly doorbell?: boolean;
}): ReReviewDecision {
  const { key, nowMs, baseGapMs, doorbell = false } = input;

  if (doorbell || held === null || held.key !== key) {
    held = { key, drives: 1, lastDriveAtMs: nowMs };
    return { heldBack: false, drives: 1, waitedMs: 0, gapMs: reReviewGapMs(1, baseGapMs) };
  }

  const gapMs = reReviewGapMs(held.drives, baseGapMs);
  const waitedMs = Math.max(0, nowMs - held.lastDriveAtMs);
  if (waitedMs >= gapMs) {
    const drives = held.drives + 1;
    held = { key, drives, lastDriveAtMs: nowMs };
    return { heldBack: false, drives, waitedMs, gapMs: reReviewGapMs(drives, baseGapMs) };
  }
  return { heldBack: true, drives: held.drives, waitedMs, gapMs };
}

/**
 * The issue-set is resolved — forget its schedule.
 *
 * ⚠ THIS IS NOT HOUSEKEEPING, it is the other half of AUDIT-FIX's own finding. That fix clears the
 * dedup hash on an empty issue-set because {A} -> {} -> {A} otherwise compared equal to a stale hash
 * and was skipped until a restart. A backoff record left behind does the identical harm by a different
 * route: the same set recurring after being genuinely resolved would arrive carrying the gap it earned
 * while it was wedged. One release, both pieces of state.
 */
export function clearReReviewBound(): void {
  held = null;
}

/** Test seam: the schedule as it stands, so a clause can assert the state and not just the verdict. */
export function reReviewBoundStateForTest(): HeldSet | null {
  return held;
}
