// The stuck-threshold table: every "how long until stuck" cliff with its owner and reason.
// The four deliberately disagree (dead process, wedged turn, dormancy, orphan run); this table DECLARES it.
// Imports stay empty: engine, Healer and scheduler read it without an edge to each other.
// Not members: STUCK_AGENT_CHECK_MS and HEALER_WATCHDOG_INTERVAL_MS (check cadences), MAX_DRAIN_STUCK (a count).
// A new stuck cliff is added here as a row beside the four, never as a private constant.

export const STUCK_AGENT_THRESHOLD_MINUTES = 75;

export const HEALER_WORKING_STUCK_MINUTES = 10;

export const DORMANT_THRESHOLD_DAYS = 7;

export const HARD_STUCK_THRESHOLD_MINUTES = 120;

export type StuckThresholdId =
  | 'agent_working_dead_process'
  | 'agent_working_wedged_turn'
  | 'agent_dormant'
  | 'recurring_run_hard_stuck';

/** One cliff, enforced from one site. */
export interface StuckThreshold {
  readonly id: StuckThresholdId;
  /** The duration in MILLISECONDS. One unit, so two cliffs can be compared. */
  readonly ms: number;
  /** Who enforces it. One owner per cliff, named, not "the system". */
  readonly owner: string;
  /** The requirement it encodes: what breaks if it moves. Judged by a person, not restated. */
  readonly reason: string;
  /** The constant (or literal) it was CARRIED from, with its file. Never invented. */
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
      'D18, reworded SLOW-INFERENCE T79b and t137: the arithmetic this used to cite — "(15 min) x (1 + up to 3 continuations)" — went stale when the continuation count stopped being capped at 3, and since t137 (OR-LONG-JOBS) there is no continuation cap at all: a long job parks and continues for as long as each stretch of it makes progress. That is not a reason to raise this cliff: what actually keeps a long-but-LIVE turn from being reaped was never the continuation count, it is the 30s heartbeat that keeps `updated_at` fresh on every live process, checkpointing or not, plus the in-process `activeRuns` guard. A turn with a hundred continuations is still a hundred heartbeats; this cliff only ever catches a process that stopped sending them, i.e. one that is actually dead.',
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
