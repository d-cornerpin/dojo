// ════════════════════════════════════════════════════════════════════════════════════════
// HOW LONG A DELEGATION WAITS — ON THE RECIPIENT'S CLOCK, NOT A CLOUD MODEL'S.
// (t103 item B — OWNER RULING 2026-10-05, decision #1: "A2A reply-patience scales with the
//  recipient's model speed (reuse the PM-ladder machinery)".)
//
// ── WHAT FIRED BEFORE THIS, measured at `09514572` ────────────────────────────────────
// `MAX_A2A_TURN_RETRIES = 2` (`agent/turn-state.ts`) is a FIXED COUNT of dedicated A2A turns.
// When they are spent the runtime records a synthetic `ABANDONED` reply on the recipient's
// behalf and settles the asker's join piece. The turns are queued back to back by
// `queueSelfWake`, which is why live-test report #3 measured the whole thing happening inside
// "roughly thirty to sixty seconds of each send" — the platform declared a delegate gone while
// the recipient had simply not replied yet.
//
// Two turns is the right number for a model that answers in seconds. On a box whose provider
// DECLARES that one legitimate call may take ten minutes (the owner's own slow local row), two
// turns is not patience at all: the engine gives up inside the window it already agreed a
// single call is allowed to occupy.
//
// ── THE RULE, AND WHY IT REUSES THE LADDER'S FLOOR RATHER THAN A NEW NUMBER ───────────
// t90's `tracker/assignee-patience.ts` already answers "how long may ONE call on this agent's
// provider legitimately take" — `patienceFloorFor`, off the provider's own declared first-chunk
// and idle allowances through the shipped `resolveStreamPatience`. That is the only honest
// reference speed this platform has, and inventing a second one is the "scaling the numbers"
// fix SLOW-INFERENCE ruling R1 rejected. So:
//
//     budget(turns) = max(MAX_A2A_TURN_RETRIES,
//                         ceil(MAX_A2A_TURN_RETRIES × recipientFloor / undeclaredFloor))
//
//   * an UNDECLARED provider resolves to the standing defaults, so `recipientFloor` IS
//     `undeclaredFloor`, the ratio is exactly 1, and the budget is 2 — today's constant,
//     byte-identical, for every row that does not declare. That is arithmetic, not a promise,
//     and §2's keystone clause asserts it the way t90's R6 keystone asserts the ladder table.
//   * a provider declaring ~600 s first chunk floors at 660 s against the undeclared 150 s and
//     earns 9 turns, so the slow recipient in the report is waited for on its own clock.
//
// ── ONE-DIRECTIONAL, AND THAT IS THE WHOLE SAFETY ARGUMENT ────────────────────────────
// Every value is a `max` against today's constant, exactly as `flooredThresholds` is, so this
// function cannot make the engine give up SOONER than it does today for any row — including the
// adversarial shape, a provider that declares a 1-second patience. `a2aRetryBudgetFor` is a
// FLOOR on patience, never a replacement for it.
//
// Unbounded above by the provider's declaration, deliberately and exactly as the ladder's rungs
// are: the declaration is owner-entered configuration, never a model's or a peer's choice, and
// capping it here would re-introduce a chosen number on the axis the floor exists to remove.
// ════════════════════════════════════════════════════════════════════════════════════════

import { patienceFloorFor } from '../tracker/assignee-patience.js';
import { MAX_A2A_TURN_RETRIES } from './turn-state.js';

/** What the budget was, and why — so a log line and a notice can say it without recomputing. */
export interface A2ARetryBudget {
  /** Dedicated A2A turns this recipient gets before the synthetic ABANDONED settles. */
  turns: number;
  /** Seconds one legitimate call on the RECIPIENT's provider may take. */
  floorSeconds: number;
  /** The undeclared-provider floor the ratio is taken against. */
  baselineSeconds: number;
  /** `declared` when the recipient's provider named a patience, `default` otherwise. */
  basis: 'declared' | 'default';
}

/**
 * The dedicated-A2A-turn budget for THIS recipient, and the numbers it was derived from.
 *
 * A missing agent, a missing model or an unreadable row all resolve to the default floor
 * through `patienceFloorFor`, which returns today's constant — the only safe direction, since
 * an unknown provider must not buy itself extra silence.
 */
export function a2aRetryBudgetFor(agentId: string | null | undefined): A2ARetryBudget {
  const baselineSeconds = patienceFloorFor(null).floorSeconds;
  const floor = patienceFloorFor(agentId);
  const scaled = baselineSeconds > 0
    ? Math.ceil((MAX_A2A_TURN_RETRIES * floor.floorSeconds) / baselineSeconds)
    : MAX_A2A_TURN_RETRIES;
  return {
    turns: Math.max(MAX_A2A_TURN_RETRIES, Number.isFinite(scaled) ? scaled : MAX_A2A_TURN_RETRIES),
    floorSeconds: floor.floorSeconds,
    baselineSeconds,
    basis: floor.basis,
  };
}
