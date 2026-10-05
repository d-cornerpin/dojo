// ════════════════════════════════════════════════════════════════════════════════════════
// WHO ENDED THE TURN — the attribution the re-serve ladder was missing (C2).
//
// ── THE DEFECT, AND IT WAS A RECORD THAT LIED ────────────────────────────────────────────────
// `work/ask-settlement.ts`'s re-serve ladder counts SILENCES. Its own words are "the same question
// served into the same silence", and its premise is that the model saw the ask and did not answer
// it. After MAX_ASK_RE_SERVES it stands the ask down to `blocked` — an OWED state the OPEN WORK
// surface still renders, but one the drain's `state = 'open'` queue stops picking up.
//
// A turn that runs into the tool-loop cap is CUT OFF BY THE ENGINE mid-work: it writes
// `[System: This turn reached 75 tool calls…]`, notes a checkpoint, schedules a self-continuation,
// and falls through the same teardown as every other turn. That teardown could not see the cap, so
// its derivation flattened it to `no_reply_intended` — A CLAIM ABOUT THE MODEL'S INTENT, about a
// turn the model never got to finish. The ladder then spent a rung on it, and four such cuts took
// an ask nobody answered and nobody declined out of circulation.
//
// ── MEASURED (owner's body, 10,934 turns) ────────────────────────────────────────────────────
//   answered 5,451 · no_reply_intended 3,977 · handoff 1,356 · park 117 · unknown 33.
//   `iteration_cap` — declared in `TurnExitReason`, CHECKed by the column, published in the
//   telemetry enum — HAD NEVER BEEN WRITTEN ONCE. One `finalizeTurn` call site exists in
//   production and it could emit five of the seventeen words. All 10 stand-downs to `blocked` read
//   `no_reply_intended`, and whether any of them was really a cut is UNKNOWABLE FROM THE RECORD.
//   That is the defect, not a mitigation — so the fix is both halves: the teardown writes
//   `iteration_cap`, and this module decides what it means.
//
// ── OWNER RULING 10(d) ───────────────────────────────────────────────────────────────────────
// Ambiguity about whether the owner was answered resolves toward ANSWERING AGAIN, never toward
// closing or parking. An engine cut is the purest case: nobody decided anything.
//
// ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────────────────────
// The ladder's BOUND. The owner's other standing complaint is that agents REPEAT THEMSELVES, and
// the bound is what stops a question being served into genuine silence for ever. A cut is handed
// back on the same path as a silence and simply spends nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/**
 * Exit reasons where the ENGINE or the OWNER ended the turn — not the model.
 *
 * `stop` is here because it is the OWNER interrupting, and an ask must not be parked because
 * somebody pressed stop four times. `park` is here because the turn got BUSY rather than silent (a
 * park with a live join under the ask itself is already caught by the settlement's hold arm, above
 * the ladder). `brake` and `identical_call` are the engine refusing further tool calls.
 *
 * DELIBERATELY ABSENT, each for a stated reason:
 *   · `no_reply_intended` — the model saw the ask and chose silence. That is exactly what the bound
 *     exists for, and moving it here would disarm the anti-repetition half entirely.
 *   · `answered` — the turn claims an answer the evidence read cannot find. That is the model's
 *     claim failing, not a cut; the owner's body carries that shape twice.
 *   · `handoff` / `delegation_exit` / `compile_pending` — the model chose to hand the work to a
 *     peer. A decision, and the hold arm owns the join case.
 *
 * ⚠ ALL ELEVEN ARE NOW WRITTEN, AND THAT IS NEW (t93, BACKLOG line 17). For most of this set's
 * life EIGHT of these words had no writer anywhere — `stop`, `preempt`, `provider_error`,
 * `stream_idle`, `abort`, `terminated`, `budget`, `identical_call`, 0 rows each across 10,934
 * turns — and they were classified ANYWAY, so that the day one was wired the correct treatment
 * was already decided rather than discovered. That day arrived: the engine sites that end a turn
 * for each cause now carry their reason to the recorder (`agent/v2/engine-exit.ts` for the seven
 * cuts, `steps/teardown/finalize-record.ts`'s derivation for `identical_call`), the reaper closes
 * a dead process's abandoned rows as `terminated`, and the whole set reaches this predicate from
 * production rather than from a fixture. The census that keeps it true both ways —
 * an enum member losing its writer, and a writer appearing for a word nobody classified — is
 * `agent/v2/__tests__/eight-exit-reasons-get-their-writers.test.ts`.
 *
 * STILL UNWRITTEN, named rather than left to be re-measured: `delegation_exit` and
 * `compile_pending`. Both are MODEL dispositions (see the absences above), both are declared in
 * the enum, the DB CHECK and the telemetry whitelist with zero production references, and neither
 * is in this set — so wiring them is a change to what the ladder CHARGES, not just to what the
 * record says, and it needs its own judgment. t93 refused to slip it in: the obvious site for
 * `delegation_exit` is a turn that today records `park`, which IS engine-imposed, so the move
 * would start spending rungs on delegating turns.
 */
export const ENGINE_IMPOSED_EXITS: ReadonlySet<string> = new Set([
  'iteration_cap', 'park', 'brake', 'stop', 'preempt', 'provider_error',
  'stream_idle', 'abort', 'terminated', 'budget', 'identical_call',
]);

/**
 * Did the ENGINE end this turn? Read from the turn's own record.
 *
 * The record is already written when the settlement asks: `finalizeTurn` runs in the same teardown,
 * about forty statements earlier, and the ordering is load-bearing for other reasons too
 * (`steps/teardown/finalize-record.ts` states them).
 *
 * NO RECORD MEANS NO, and that is the conservative direction rather than the tidy one. At a real
 * finalize the row always exists, so a missing one is a test fixture or a crash; inferring "it must
 * have been a cut" there would silently disarm the bound for every caller that does not write one.
 * A read that throws answers the same way, for the same reason.
 */
export function turnWasEngineCut(agentId: string, turnNumber: number | null): boolean {
  if (turnNumber == null) return false;
  try {
    const r = getDb().prepare(
      'SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?',
    ).get(agentId, turnNumber) as { exit_reason: string | null } | undefined;
    return r?.exit_reason ? ENGINE_IMPOSED_EXITS.has(r.exit_reason) : false;
  } catch {
    return false;
  }
}

/** The sentence the hand-back is recorded under, so the row says WHY no rung was spent. */
export function engineCutHandBackReason(turnNumber: number | null): string {
  return `re-opened: the engine ended the turn (${turnNumber ?? '?'}) before it delivered an answer `
    + '— the model never declined this ask, so the person is still waiting and the re-serve ladder '
    + 'is NOT spent on a turn the model did not get to finish';
}
