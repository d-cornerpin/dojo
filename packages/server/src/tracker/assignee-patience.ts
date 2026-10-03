// ════════════════════════════════════════════════════════════════════════════════
// THE PM WAITS FOR THE MODEL IT ASSIGNED — AND THAT IS ALL IT DOES.
// (t90 D1 — tracker report #6, owner's own box; reworked under OWNER RULING 2026-10-02)
//
// ── THE REPORT, AND WHAT ACTUALLY FIRED ──
// *"A sub-agent was assigned a long-running multi-step project … intentionally configured to use a
// slower model — a deliberate owner choice, not a malfunction. The sub-agent was making progress.
// Because it was slow, the PM interpreted the pace as a stall … it stopped the sub-agent mid-task
// and silently reassigned the tracker task to the primary. This happened repeatedly."*
//
// Diagnosed on v3.2.2 before any code: the poke ladder's rung 4. `POKE_THRESHOLDS.autoReset` is a
// fixed wall-clock 3,600 s measured against `idleSeconds = now - work.updated_at`, and a task row
// only moves when its assignee calls a work verb — so a slow model that legitimately spends an
// hour between verb calls is indistinguishable from a dead one. The rung moved the task to
// `on_deck`, failed the scheduled run, and sent an A2A `intent: 'ASSIGN'` to the primary.
//
// ── ⛔ THE OWNER'S RULING, AND THE HISTORY IT CORRECTS ──
// The report's own fix ideas asked for "notify the user and ask whether to wait, reassign, or
// cancel", and the first cut of this module built exactly that: a decision ask, an answer record,
// and two dashboard doors. The owner struck it out on 2026-10-02:
//
//   *"The user should not be bothered with these things. The PM's job is to simply keep the agent
//   working on their task. Their job is not to reassign a task because they don't feel it is
//   getting worked on fast enough. At no point during the construction of the dojo did I ever ask
//   for the PM agent to simply reassign tasks to another agent."*
//
// The fix ideas were the REPORTING AGENT's voice, not his. So the ask is gone with the
// reassignment it was asking about, and what is left is small on purpose:
//
//   1. PATIENCE — never poke a slow model on a fast model's clock. This is the half of the
//      original fix the ruling explicitly keeps, because poking a box mid-inference is still
//      wrong whatever the PM is allowed to do afterwards.
//   2. THE HUMAN REASSIGNMENT AUDIT — when a PERSON moves a task through the dashboard, the
//      record says who, why, and what the previous assignee was last seen doing. The PM can no
//      longer reassign at all (`work_update:reassign` left `PM_ALLOWED_WORK_OPS`), so this writer
//      now has exactly one class of caller, which is the only reason it survived the rework.
//
// Everything else the PM may do about a slow task is poke it, and dead PROCESSES remain the engine
// reaper's job (`agent/stuck-thresholds.ts`, the 75-minute heartbeat cliff) — the PM never
// inherits that.
//
// ── WHY THE FLOOR IS DERIVED AND NOT CHOSEN (and how R6 is kept byte-for-byte) ──
// A "slow model multiplier" needs a REFERENCE speed to multiply against, and no such number exists
// anywhere in this platform — inventing one is exactly the "scaling the numbers" fix SLOW-INFERENCE
// ruling R1 rejected. What DOES exist is `resolveStreamPatience`: the provider's declared
// first-chunk and idle allowances, i.e. the platform's own answer to "how long may ONE call on this
// provider legitimately take before we call it stuck". One ladder step cannot honestly be shorter
// than that. So each rung's threshold becomes `max(today's threshold, floor × rung)` — a FLOOR,
// never a replacement:
//
//   * an UNDECLARED provider resolves to the defaults (90 s + 60 s = 150 s), and
//     max(300,150) max(900,300) max(1800,450) max(3600,600) = 300/900/1800/3600, which is today's
//     table EXACTLY. R6 is not a promise here, it is arithmetic, and the keystone clause in
//     `the-pm-waits-for-the-model-it-assigned.test.ts` asserts the whole table unchanged.
//   * the owner's DS4 row (~600 s first chunk) floors rung 1 at 20 minutes and rung 4 at 80, so
//     the slow sub-agent in the report is poked on its own clock instead of a cloud model's.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { resolveStreamPatience } from '../agent/stream-patience.js';
import { AUDIT_KIND } from '../work/audit-trail.js';
import { appendWorkEvent } from '../work/store.js';
import { recordRemediation } from '../work/poke-ladder.js';

const logger = createLogger('assignee-patience');

/**
 * The `entry_kind` payload values this module owns.
 *
 * ⚠ NO NEW `work_events.kind`, DELIBERATELY. `work_events.kind` carries migration 152's CHECK
 * against `event-kinds.ts`, and `work-event-kinds-conformance.test.ts` asserts the union and the
 * CHECK set-equal in both directions — a new kind is a table rebuild on every lived-in body.
 * `work/join-drive.ts` and `work/engine-checkpoint-note.ts` both ride `kind='audit'` with their
 * own `entry_kind` for exactly this reason, and migration 152's header names that landing place.
 * This module is the third user of the same seam, not a fourth mechanism.
 */
export const PATIENCE_ENTRY = {
  /** A HUMAN's reassignment, with the prior assignee's last known state. The only kind left:
   *  the PM cannot reassign, and `work_update:reassign` is the primary's verb acting for a person. */
  reassigned: 'reassignment',
} as const;

/** The ladder's four rungs, in the order `pm-agent.ts` evaluates them. */
export interface PokeThresholds { first: number; second: number; escalate: number; autoReset: number }

export interface PatienceFloor {
  /** Seconds one legitimate model call may take on this assignee's provider, patience total. */
  floorSeconds: number;
  /** `declared` when a provider row named it, `default` when nothing is declared (R6 path). */
  basis: 'declared' | 'default';
  modelId: string | null;
}

/**
 * How long ONE call on this agent's model may legitimately run, per the platform's own
 * declaration. The read is the same `models JOIN providers` shape migration 163 rides and
 * `agent/model.ts` already performs; the resolver is the shipped one, so a provider that
 * declares patience for its transport gets the same number honoured here. A missing agent, a
 * missing model or an unreadable row all fall to the defaults — which is the R6 path, and the
 * only safe direction: an unknown provider must not buy itself extra silence.
 */
export function patienceFloorFor(agentId: string | null | undefined): PatienceFloor {
  const fallback: PatienceFloor = {
    floorSeconds: Math.ceil((resolveStreamPatience(null).firstChunkMs
      + resolveStreamPatience(null).idleMs) / 1000),
    basis: 'default',
    modelId: null,
  };
  if (!agentId) return fallback;
  try {
    const row = getDb().prepare(
      `SELECT m.id AS model_id,
              p.first_chunk_timeout_ms AS first_chunk_timeout_ms,
              p.stream_idle_timeout_ms AS stream_idle_timeout_ms
         FROM agents a
         JOIN models m ON m.id = a.model_id
         JOIN providers p ON p.id = m.provider_id
        WHERE a.id = ?`,
    ).get(agentId) as {
      model_id: string;
      first_chunk_timeout_ms: number | null;
      stream_idle_timeout_ms: number | null;
    } | undefined;
    if (!row) return fallback;
    const patience = resolveStreamPatience({
      firstChunkTimeoutMs: row.first_chunk_timeout_ms,
      streamIdleTimeoutMs: row.stream_idle_timeout_ms,
    });
    return {
      floorSeconds: Math.ceil((patience.firstChunkMs + patience.idleMs) / 1000),
      // The resolver's OWN answer to "did a provider declare this", not a second reading of the
      // same columns. T79e's own fix wave removed exactly this lie from a log line: a default
      // and a declaration can be the same number and are never the same instruction.
      basis: patience.firstChunkDeclared || patience.idleDeclared ? 'declared' : 'default',
      modelId: row.model_id,
    };
  } catch {
    return fallback;
  }
}

/**
 * The ladder's thresholds, floored by one legitimate call per rung. NEVER shortened: every
 * value is a `max`, so this function cannot make the PM more aggressive than it is today for
 * any row, declared or not. That one-directionality is the whole safety argument and
 * `a-floor-never-shortens-the-ladder` drives it with a provider that declares a 1-second
 * patience — the shape that would otherwise bring the ladder forward.
 */
export function flooredThresholds(base: PokeThresholds, floorSeconds: number): PokeThresholds {
  const f = Number.isFinite(floorSeconds) && floorSeconds > 0 ? floorSeconds : 0;
  return {
    first: Math.max(base.first, f),
    second: Math.max(base.second, f * 2),
    escalate: Math.max(base.escalate, f * 3),
    autoReset: Math.max(base.autoReset, f * 4),
  };
}

/** What the assignee was last seen doing — the half of a reassignment record a person
 *  cannot reconstruct afterwards. */
export function assigneeLastState(agentId: string | null | undefined): string {
  if (!agentId) return 'unassigned';
  try {
    const row = getDb().prepare(
      `SELECT a.status AS status, a.updated_at AS updated_at,
              (SELECT MAX(created_at) FROM messages WHERE agent_id = a.id) AS last_message_at
         FROM agents a WHERE a.id = ?`,
    ).get(agentId) as
      { status: string; updated_at: string | null; last_message_at: string | null } | undefined;
    if (!row) return 'the assigned agent no longer exists';
    const seen = row.last_message_at ?? row.updated_at;
    return seen ? `status=${row.status}, last activity ${seen}` : `status=${row.status}`;
  } catch {
    return 'unknown';
  }
}

/**
 * EVERY HUMAN REASSIGNMENT LEAVES A RECORD: who moved it, why, and what the previous assignee was
 * last seen doing (report fix idea 5, the one the owner's ruling leaves standing).
 *
 * Wired at the two places a task's assignee actually changes for a person — the dashboard's task
 * update and the `work_update:reassign` verb the PRIMARY still holds — so the record cannot be
 * skipped by whoever drives it. The PM is not among them any more and cannot become one by
 * accident: it lost the verb, and `the-pm-waits-for-the-model-it-assigned.test.ts` §2 censuses
 * every write that could reach an assignee from the sweep.
 */
export function recordReassignment(p: {
  taskId: string; actor: string; fromAgentId: string | null; toAgentId: string | null;
  toGroupId?: string | null; reason: string;
}): void {
  const priorState = assigneeLastState(p.fromAgentId);
  appendWorkEvent(p.taskId, AUDIT_KIND, p.actor, {
    entry_kind: PATIENCE_ENTRY.reassigned,
    reason: p.reason,
    action_taken: `reassigned ${p.fromAgentId ?? 'unassigned'} → `
      + `${p.toAgentId ?? p.toGroupId ?? 'unassigned'}`,
    note: `prior assignee last state: ${priorState}`,
  });
  // AND the ladder re-arms, which is what the call site used to do by itself. Carried here with
  // its invariant intact — `recordRemediation`'s contract is "only at a remediation event", and a
  // reassignment is one of the four it names — so the record and the re-arm cannot come apart.
  recordRemediation(p.taskId, p.actor, p.reason);
  logger.info('reassignment recorded and the ladder re-armed', {
    taskId: p.taskId, actor: p.actor, from: p.fromAgentId, to: p.toAgentId ?? p.toGroupId,
  });
}
