// ── THE STUCK-THRESHOLD TABLE (PHASE-6 T10 Step 1c) ──
//
// Four subsystems answer "how long before this counts as stuck", each from a private
// constant, and until this file none of them could see the others' answer. Research 09
// recorded it as "×3 with three thresholds/timers"; T0-SURVEY re-derived it at the phase base
// and the honest figure is FOUR time thresholds plus two numbers that are NOT thresholds —
// and this task found a FIFTH occurrence the survey's `_THRESHOLD`-shaped grep could not see,
// because it is not a constant at all: a bare `'-10 minutes'` SQL literal inside the Healer's
// own stuck detector. That is the "duplicate stuck-detector" T10 was told to point at this
// table, and it was duplicating a number that had no name to duplicate.
//
// ── WHAT A TABLE IS FOR HERE, AND WHAT IT IS NOT ──
//
// It is NOT for making the four agree. They deliberately do not: the engine reaps a
// `working` row at 75 minutes because that is what a DEAD PROCESS looks like, and the Healer
// calls a `working` row frozen at 10 minutes because that is what a WEDGED TURN looks like to
// a person watching. Unifying them would be inventing a number (#14), and the plan says so in
// its own words: the 5-minute figure is a CHECK INTERVAL and never enters a time table.
//
// What the table buys is that the disagreement is now DECLARED — four rows, four owners, four
// reasons — instead of being four files that have never met. A fifth answer has to be written
// down here, next to the four it disagrees with, which is the whole mechanism.
//
// ── DELIBERATELY NOT MEMBERS, AND THIS IS THE NAMED ERROR ──
//
//   `STUCK_AGENT_CHECK_MS`  = 5 min   (agent/runtime.ts)     — a CHECK INTERVAL: how often
//       the reaper LOOKS. Putting a cadence in a table of age cliffs is the specific mistake
//       PHASE-6.md warns about, and it now has both a site and a value on the record.
//       (`HEALER_WATCHDOG_INTERVAL_MS` is the same 5 minutes, for the same reason.)
//   `MAX_DRAIN_STUCK`       = 4       (agent/turn-state.ts)  — a COUNT of consecutive drain
//       passes. Not a duration; it cannot be compared with any row below.
//
// The unit of every row here is MINUTES unless the name says otherwise, so two cliffs can be
// compared without a conversion in the reader's head.
//
// This module imports NOTHING. That is what lets the engine, the Healer and the scheduler all
// read it without any of them acquiring an edge to the others.

/** The 75-minute engine reaper. Carried verbatim from `agent/runtime.ts`. */
export const STUCK_AGENT_THRESHOLD_MINUTES = 75;

/** The Healer's 10-minute wedged-turn call. Carried verbatim from `healer/healer-agent.ts`,
 *  and it is ALSO the number `healer/diagnostic.ts` had inline as `'-10 minutes'`. */
export const HEALER_WORKING_STUCK_MINUTES = 10;

/** Seven days of silence. Carried verbatim from `healer/diagnostic.ts`, where it was declared
 *  inside a function body. */
export const DORMANT_THRESHOLD_DAYS = 7;

/** The scheduler's 120-minute orphan-run sweep. Carried verbatim from `scheduler/runner.ts`,
 *  where it was declared inside a function body. */
export const HARD_STUCK_THRESHOLD_MINUTES = 120;

export type StuckThresholdId =
  | 'agent_working_dead_process'
  | 'agent_working_wedged_turn'
  | 'agent_dormant'
  | 'recurring_run_hard_stuck';

export interface StuckThreshold {
  readonly id: StuckThresholdId;
  /** The duration in MILLISECONDS. One unit, so two cliffs can be compared. */
  readonly ms: number;
  /** Who enforces it. One owner per cliff, named — not "the system". */
  readonly owner: string;
  /** The requirement it encodes — what breaks if it moves. Judged by a person, not restated. */
  readonly reason: string;
  /** The constant (or literal) it was CARRIED from, with its file. Never invented (#14). */
  readonly carriedFrom: string;
}

const MIN = 60_000;
const DAY = 86_400_000;

export const STUCK_THRESHOLDS: Readonly<Record<StuckThresholdId, StuckThreshold>> = {
  agent_working_wedged_turn: {
    id: 'agent_working_wedged_turn',
    ms: HEALER_WORKING_STUCK_MINUTES * MIN,
    owner: 'the Healer — its self-watchdog AND its diagnostic sweep',
    reason:
      'What a WEDGED TURN looks like to a person watching a dashboard: an agent that has said `working` for ten minutes and produced nothing is worth surfacing, even though the engine will not reap it for another hour. Deliberately far below the reaper\'s cliff — the Healer\'s job is to notice early and say so, the reaper\'s is to repair a row nothing is going to finish.',
    carriedFrom:
      'HEALER_WORKING_STUCK_MINUTES = 10 — healer/healer-agent.ts; and the bare `\'-10 minutes\'` SQL literal in healer/diagnostic.ts\'s stuck-agent query, which had no name until this table',
  },
  agent_working_dead_process: {
    id: 'agent_working_dead_process',
    ms: STUCK_AGENT_THRESHOLD_MINUTES * MIN,
    owner: 'the engine reaper — agent/runtime.ts `recoverStuckAgents`',
    reason:
      'D18: comfortably above the legal turn budget (15 min) x (1 + up to 3 continuations) plus overshoot, so a long-but-LIVE turn is never reaped. The 30s heartbeat keeps `updated_at` fresh and the in-process `activeRuns` guard is the real safety; this cliff only catches a genuinely dead process\'s rows.',
    carriedFrom: 'STUCK_AGENT_THRESHOLD_MINUTES = 75 — agent/runtime.ts',
  },
  recurring_run_hard_stuck: {
    id: 'recurring_run_hard_stuck',
    ms: HARD_STUCK_THRESHOLD_MINUTES * MIN,
    owner: 'the scheduler — scheduler/runner.ts `cleanupStaleRuns`',
    reason:
      'v2.3.8: a recurring task sitting `in_progress` this long without activity is structurally stuck REGARDLESS of which schedule_status combination got it there, so the sweep force-recovers it rather than trying to reason about the combination. It is about a RUN, not an agent, which is why it is twice the reaper\'s cliff and not the same number.',
    carriedFrom: 'HARD_STUCK_THRESHOLD_MINUTES = 120 — scheduler/runner.ts (declared inside cleanupStaleRuns)',
  },
  agent_dormant: {
    id: 'agent_dormant',
    ms: DORMANT_THRESHOLD_DAYS * DAY,
    owner: 'the Healer — healer/diagnostic.ts',
    reason:
      'A SILENCE cliff, not a stuck cliff, and it is in this table because it decides whether the other two get to fire: an agent with no activity for a week is an old test group or a paused project, and reporting it as troubled is the false alarm that teaches people to ignore the health page. The exception is deliberate — a RECENT status change (a restart writing `error`) makes it a real issue however old the messages are.',
    carriedFrom: 'DORMANT_THRESHOLD_MS = 7 * 86400000 — healer/diagnostic.ts (declared inside a function body)',
  },
};

export const STUCK_THRESHOLD_IDS: readonly StuckThresholdId[] =
  Object.keys(STUCK_THRESHOLDS) as StuckThresholdId[];
