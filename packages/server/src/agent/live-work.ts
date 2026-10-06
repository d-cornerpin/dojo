// ════════════════════════════════════════════════════════════════════════════════════════
// A-5b — "IS THERE ANYTHING A STOP WOULD CUT?", ASKED IN ONE PLACE.
//
// OWNER RULING 2026-10-05 (#9), verbatim intent: *"STOP means stop for anything that agent is
// doing"* — so an agent with a live background job is NOT idle, the stop control stays offered
// while anything runs, and the press cuts the turn AND every background job.
//
// A-5 made the stop REACH background work (the media dials, the video poll loop, the run-once
// job rows). A-5b made it VISIBLE on the agent card. Neither gave the question one owner, and
// the cost was measured, not feared: the card learned to offer the button for a background job
// while `POST /agents/:id/stop` still answered `400 "Agent is not currently working"` off the
// `agents.status` column — so the newly-visible button, pressed, cut nothing. Two surfaces
// asking "is this agent busy?" of two different facts is how that happens, and it is why this
// is a module and not a third expression.
//
// ── THE ONE FACT, AND WHY IT IS NOT `agents.status` ──
// `agents.status` answers "is a TURN in flight". It is the right fact for every reader that
// asks whether the agent can accept work, and this module deliberately does not touch it: a
// background render does not make an agent unavailable, and widening the column's meaning
// would move the ground under the drains, the Healer, the reset guard and the boot sweep.
// The stop question is a different question, and it is answered off the two facts that
// actually outlive a turn:
//
//   1. THE LIVE ABORT REGISTRY (`shared-state.ts`), scope `background` — every dial that
//      registered itself as able to outlive its turn. This is what `abortInFlight` will cut.
//   2. THE OPEN JOB ROWS — `generation_jobs` (queued/running) and `video_jobs`
//      (queued/polling). These exist because the registry alone CANNOT answer: `image_create`'s
//      delivery IIFE waits for the agent to go idle before it dials, so during that wait there
//      is nothing registered and nothing fenced, and the ROW is the only standing fact.
//      `stopAgent` cuts both, so the predicate must see both.
//
// ── WHY `max` AND NOT `turn + background` ──
// A video poll loop holds a registration AND owns a row for the same job, so summing would
// report two things to stop where the owner can see one. Every background registration this
// engine opens belongs to a job row, and a row can exist with no registration (the pre-dial
// window above) — so the number of DISTINCT things is the larger of the two counts, never the
// sum. A count that over-reports is not cosmetic: it is the text on the button.
//
// ── THE COUNTS ARE CLAIMS, NOT PROMISES ──
// By the time a click lands the job may have finished, and the stop path is idempotent, so a
// button offered one poll too late costs nothing. The opposite error — withholding it while a
// thirty-minute render burns — is the one this file exists to prevent.
// ════════════════════════════════════════════════════════════════════════════════════════

import { countAbortable } from './shared-state.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';

/**
 * What a stop would cut for one agent, right now.
 *
 * The shape is deliberately the one already on the wire (`AgentDetail.inFlight`) and in the
 * dashboard's rule (`dashboard/src/lib/stop-affordance.ts`'s `StopSubject`), so the route, the
 * frame and the rendering rule read the same two numbers rather than three similar ones.
 */
export interface LiveWork {
  /** Live turn-scoped registrations — the calls this turn owns. */
  readonly turn: number;
  /** Distinct background things: live `background` registrations and open media job rows. */
  readonly background: number;
}

/** True when ANYTHING is in flight for this agent. THE predicate; nothing re-derives it. */
export function hasLiveWork(w: LiveWork): boolean {
  return w.turn > 0 || w.background > 0;
}

/**
 * Count the open media job ROWS this agent owns.
 *
 * Every failure is zero, never a throw: this is read on the stop path and from inside
 * `openAgentCall`, and a bookkeeping table must never be able to stop a stop or break a dial.
 * A pre-migration database has no tables at all, which is the ordinary case at boot.
 */
function openJobRows(agentId: string): number {
  let n = 0;
  try {
    n += (getDb().prepare(
      "SELECT COUNT(*) AS n FROM generation_jobs WHERE agent_id = ? AND status IN ('queued','running')",
    ).get(agentId) as { n: number }).n;
  } catch { /* no table, no db, no claim */ }
  try {
    n += (getDb().prepare(
      "SELECT COUNT(*) AS n FROM video_jobs WHERE agent_id = ? AND status IN ('queued','polling')",
    ).get(agentId) as { n: number }).n;
  } catch { /* as above */ }
  return n;
}

/** Read the live facts. A pure read — this module is never a writer of either of them. */
export function liveWork(agentId: string): LiveWork {
  return {
    turn: countAbortable(agentId, 'turn'),
    background: Math.max(countAbortable(agentId, 'background'), openJobRows(agentId)),
  };
}

/**
 * A-5b / L40 — THE EMISSION THE COMPOSER NEEDED, AND WHY A RENDERING RULE COULD NOT DO IT.
 *
 * The Chat composer's dots-and-stop state is driven entirely by `agent:status` frames. Those
 * frames describe a TURN: `working` when one starts, `idle` when it ends. A background job that
 * is still running after the turn ends produces no further frame of any kind, so there is
 * nothing for a rendering rule to be clever about — the composer has never been TOLD. The
 * review's own wording: *"needs a new emission, not a rendering rule"*.
 *
 * So the lifecycle edges speak. This is called when a background registration opens or
 * releases (`abortable-call.ts`) and when a media job row changes state (the two job modules'
 * own `emitUpdate` chokepoints), and it carries the predicate's ANSWER rather than raw
 * material: the per-job frames (`generation_job:update`, `video_job:update`) already existed
 * and are not enough, because answering "does this agent still have anything running" from
 * them means a client keeping its own tally of every job it has ever seen — a second copy of
 * this file, written in a component, drifting.
 *
 * Best-effort by construction: a frame that cannot be sent must never fail the dial or the
 * stop that triggered it.
 */
export function announceLiveWork(agentId: string): void {
  try {
    const w = liveWork(agentId);
    broadcast({
      type: 'agent:jobs',
      agentId,
      turn: w.turn,
      background: w.background,
      stoppable: hasLiveWork(w),
    });
  } catch { /* never let a frame break the work it describes */ }
}
