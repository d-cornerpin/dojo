// ════════════════════════════════════════════════════════════════════════════════
// THE STEER-TO-DELIVER LADDER FOR SCHEDULED RUNS — SWEEP CORE-1 CT2, OR2's own shape.
//
// ── WHAT IT IS FOR ──
// A scheduled run whose task is DECLARED deliverable-owing cannot be recorded `complete`
// without a message the person actually received (`work/occurrences.ts`). That refusal on its
// own would be a wall: the model asks to close, is told no, and has nothing to do about it. OR2
// says the platform detects, STEERS, VERIFIES on the ledger, retries to a bound, and only then
// stops — and that the AGENT speaks, never the engine wearing the agent's voice.
//
//   rungs 1..N   STEER. The close is refused with a sentence the model can act on THIS TURN,
//                naming the run, what is missing, and what to do. It is put in front of the
//                model at the exact moment it was trying to close — the highest-fidelity steer
//                available, and it needs no wakeup because the model is right there.
//   rung N+1     STAND DOWN. The drives are spent. The run is settled NOT-complete, honestly:
//                the owner's run history reads a non-complete run carrying the reason, instead
//                of a green "complete" for a morning he heard nothing. The schedule advances so
//                tomorrow's brief still fires — a cadence stalled forever is a second failure,
//                not a safety net.
//
// ── WHY THE NUMBERS ARE WHAT THEY ARE ──
// N is READ from `work/join-drive.ts`'s `JOIN_REDRIVE_BOUND`, not chosen again here. That is
// the platform's existing answer to "how many real drives before we stop grinding and start
// telling", set under the Phase-0 standing authority and revisable by the owner in ONE place.
// A second copy of the same judgment is a second thing to keep in step, and `join-drive.ts`
// records the same reasoning about `MAX_FLOOR_STEER_ATTEMPTS` for its own second rung.
//
// ── WHERE THE STATE LIVES, AND WHY THERE IS NO NEW COLUMN AND NO NEW EVENT KIND ──
// `work_events.kind` carries a CHECK (migration `152`) against the declared list in
// `event-kinds.ts`; a new kind is a table rebuild on every lived-in body. The ladder therefore
// rides `kind='audit'` with its own marker inside the payload — the same landing place the ask
// re-serve ladder and the join ladder both use. The counter is a COUNT over those rows, never a
// maintained integer: it survives a restart, it cannot drift from the events that caused it,
// and it fails CLOSED (a ladder that cannot read its own counter reports itself spent, which
// escalates rather than grinds).
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { appendWorkEvent } from './store.js';
import { JOIN_REDRIVE_BOUND } from './join-drive.js';

const logger = createLogger('run-deliver-drive');

/** How many times the platform steers the agent to actually send the thing before it stops
 *  asking and records the run as undelivered. CARRIED, not chosen — see the header. */
export const MAX_RUN_DELIVER_STEERS = JOIN_REDRIVE_BOUND;

/** One steer spent on this run. */
export const RUN_DELIVER_STEER_MARKER = 'ct2_run_deliver_steer';

/** The ladder's top rung: the run was recorded undelivered rather than complete. */
export const RUN_DELIVER_STAND_DOWN_MARKER = 'ct2_run_deliver_stood_down';

/** The run status word a stood-down run carries on its own settle event. Deliberately NOT
 *  `complete` and deliberately NOT a new vocabulary the dashboard would have to learn: the
 *  owner's run history maps every non-`complete` settle to its existing neutral badge and
 *  expands the row to show the reason (`work/occurrence-runs.ts:mapRun`). The owner sees a run
 *  that is not green, with the sentence explaining it, which is exactly what he was denied. */
export const RUN_STATUS_UNDELIVERED = 'undelivered';

export type RunDeliverRung = 'steer' | 'stand-down';

export interface RunDeliverDecision {
  rung: RunDeliverRung;
  /** 1-based, WITHIN the rung. */
  attempt: number;
  /** The bound this rung is spending against, so a message can state it. */
  bound: number;
  steersSpent: number;
}

/**
 * How many of this marker are on the row. A COUNT over the log, never a stored integer.
 *
 * ⚠ IT COUNTS DISTINCT TURNS, NOT ROWS, AND THAT IS THE WHOLE BOUND — MEASURED, not designed.
 * On the first verification set (behavioral run `bmslqef2w3r`, 2026-08-09) the floor model
 * called `work_update(status="complete")` FOUR TIMES INSIDE ONE TURN, before it had spoken at
 * all. Counting rows, that spent the entire ladder in about ten seconds and stood the run down
 * while the agent was still working — and the agent then delivered a perfectly good brief
 * ("Tomorrow (Mon, Aug 10) is wide open — no events on any of your calendars…") into a run
 * already recorded UNDELIVERED. A ladder whose rungs a retry loop can burn is not a ladder.
 *
 * A rung is meant to be a DRIVE — a separate attempt, with a turn in between for the agent to
 * act on the steer. So the unit is the turn. Four calls in one turn is one drive; three drives
 * means the agent was told on three separate turns and did nothing about it, which is the
 * situation the stand-down exists for. Same lesson CT0 wrote into the ask lane's sixth
 * narrowing: the turn boundary is where a fact about a turn becomes readable.
 *
 * A steer with no turn number (a close arriving from outside a turn — the PM's validate path,
 * a sweep) counts as its own drive, keyed on the literal `null`, so it can never be free.
 */
export function runDriveCount(occurrenceId: string, marker: string): number {
  try {
    return (getDb().prepare(
      `SELECT COUNT(DISTINCT COALESCE(json_extract(payload, '$.turn_number'), -1)) AS n
         FROM work_events
        WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?`,
    ).get(occurrenceId, marker) as { n: number } | undefined)?.n ?? 0;
  } catch (err) {
    // A ladder that cannot read its own counter must not steer for ever. Reporting it as spent
    // is the safe direction: the run is recorded undelivered and the owner sees a non-complete
    // run, rather than a schedule that grinds against a model that is never going to answer.
    logger.warn('run-deliver ladder: could not read its own counter; treating it as spent', {
      occurrenceId, marker, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * WHAT THE LADDER DOES NEXT for this run, read entirely from the run's own history.
 *
 * Pure: it decides, it never spends. The caller performs the rung and then records it, so a
 * steer that could not actually be issued does not burn the bound — `join-drive.ts`'s rule,
 * carried because the reason is the same one.
 */
export function nextRunDeliverRung(occurrenceId: string): RunDeliverDecision {
  const steersSpent = runDriveCount(occurrenceId, RUN_DELIVER_STEER_MARKER);
  if (steersSpent < MAX_RUN_DELIVER_STEERS) {
    return {
      rung: 'steer', attempt: steersSpent + 1, bound: MAX_RUN_DELIVER_STEERS, steersSpent,
    };
  }
  return { rung: 'stand-down', attempt: 1, bound: 1, steersSpent };
}

/** Record one steer's spend on the run's own durable history. `turnNumber` is what the bound
 *  is counted in — see `runDriveCount`; a repeat inside the same turn is the same drive. */
export function recordRunDeliverSteer(
  occurrenceId: string,
  detail: { attempt: number; bound: number; taskId: string; why: string; turnNumber?: number | null },
): void {
  appendWorkEvent(occurrenceId, 'audit', 'run-deliver-drive', {
    marker: RUN_DELIVER_STEER_MARKER,
    attempt: detail.attempt,
    bound: detail.bound,
    task_id: detail.taskId,
    turn_number: detail.turnNumber ?? null,
    reason: `the run was asked to close with nothing delivered to a person `
      + `(steer ${detail.attempt} of ${detail.bound}): ${detail.why}`,
  });
  logger.info('scheduled run steered to deliver before it may close', {
    occurrenceId, taskId: detail.taskId, attempt: detail.attempt, bound: detail.bound,
    turnNumber: detail.turnNumber ?? null,
  });
}

/** Record the stand-down on the run's own durable history. */
export function recordRunDeliverStandDown(
  occurrenceId: string, detail: { steersSpent: number; taskId: string },
): void {
  appendWorkEvent(occurrenceId, 'audit', 'run-deliver-drive', {
    marker: RUN_DELIVER_STAND_DOWN_MARKER,
    steers_spent: detail.steersSpent,
    task_id: detail.taskId,
    reason: `the run is being recorded UNDELIVERED after ${detail.steersSpent} steer(s): it did `
      + 'its work and nothing reached a person, and the platform will not record that as '
      + 'complete. The schedule advances so the next run still fires.',
  });
  logger.error('scheduled run STOOD DOWN: it finished and reached nobody, and is not recorded complete', {
    occurrenceId, taskId: detail.taskId, steers: detail.steersSpent, bound: MAX_RUN_DELIVER_STEERS,
  });
}

/**
 * THE STEER'S OWN WORDS, in one place, so the tool door and any later caller cannot drift.
 *
 * ⚠ IT IS A STEER, NOT A VOICE. Everything here is addressed to the MODEL and never to the
 * owner: the platform's job is to put the owed thing back in front of the agent and verify on
 * the delivery ledger, and the AGENT says the actual brief in its own words. OR2's rule, and
 * the reason TB2's join ladder is built the same way.
 *
 * ⚠ AND IT DOES NOT SAY "Refused:", DELIBERATELY. That exact string is one of the kit's
 * declared ENGINE_REFUSAL_SIGNATURES (`behavioral/invariants.mjs`), and the SAFETY-family
 * invariant behind it means something specific: *"The ENGINE refusing to serve is a platform
 * failure."* This is not the engine refusing to serve — it is the engine saying the work is not
 * finished and naming the one step left, which is the opposite. Measured on the first post-fix
 * drive (run `bmslq48axkn`): the old wording tripped NO_ENGINE_REFUSAL, and the honest fix is
 * the word, not a pardon. `agent/v2/steps/execute/refusal-gates.ts` avoids the same signature
 * the same way ("Refused once:"), for the same reason.
 *
 * ⚠ AND IT NO LONGER SAYS "and THEN call", BECAUSE THAT SENTENCE BUILT THE TRAP IT WAS
 * WARNING ABOUT (UX-REPAIR ROUND 4 T19, D1). A model that reads "and THEN" as *in this
 * response* emits text AND a tool call in one message — which is exactly the shape
 * `post-call-classify/terminal-text.ts`'s G-SUP-2 rule demotes to a `[working-note]`. Measured
 * on the owner's box 2026-08-10 13:45Z: the model obeyed this steer twice, wrote the reminder
 * twice, and the platform destroyed its words both times. D1 makes the capture arm recover
 * them; this makes the engine stop asking for the shape in the first place. Tail-side string
 * (a tool return value), so no cached prefix moves.
 */
export function runDeliverSteerText(p: {
  taskId: string; taskTitle: string | null; taskKind: string | null;
  attempt: number; bound: number;
}): string {
  return (
    `Not yet — this run is not finished. "${p.taskTitle ?? p.taskId}" is a `
    + `${p.taskKind ?? 'scheduled'} task — its whole point is a message the user actually reads — `
    + `and nothing user-visible has been sent since this run started.\n\n`
    + `Say the thing itself now, in your own voice, as a SEPARATE reply with NO tool call in it `
    + `(or on the channel the user asked for). Then, in the response AFTER that, call `
    + `work_update(action="status") with task_id="${p.taskId}" and status="complete". Text that `
    + `rides in the same response as a tool call is treated as working notes, not as your reply, `
    + `so the user never sees it. The run closes on the message, not on this call.\n\n`
    + `A tool-call chip, an internal note, an engine acknowledgement, or a hand-off to another `
    + `agent is not the user receiving it.\n\n`
    + `(steer ${p.attempt} of ${p.bound}; after that the run is recorded UNDELIVERED in the `
    + `user's run history rather than complete, and the schedule moves on.)`
  );
}
