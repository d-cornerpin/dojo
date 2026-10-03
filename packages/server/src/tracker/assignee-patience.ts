// ════════════════════════════════════════════════════════════════════════════════
// THE PM MAY WAIT AND IT MAY ASK. IT MAY NOT TAKE THE WORK AWAY.
// (t90 Deliverable 1 — tracker report #6, owner's own box, v3.2.2)
//
// ── THE REPORT, IN ITS OWN WORDS ──
// *"A sub-agent was assigned a long-running multi-step project … intentionally configured to use
// a slower model — a deliberate owner choice, not a malfunction. The sub-agent was making
// progress. Because it was slow, the PM interpreted the pace as a stall … it stopped the
// sub-agent mid-task and silently reassigned the tracker task to the primary. This happened
// repeatedly."* The owner could not get work done by the agent he chose.
//
// ── WHAT ACTUALLY FIRED ON v3.2.2 (diagnosed before this module was written) ──
// `pm-agent.ts`'s poke ladder, rung 4. `POKE_THRESHOLDS[priority].autoReset` is a FIXED
// wall-clock count of seconds (normal: 3600) measured against `idleSeconds = now -
// work.updated_at`, and a task row only moves when its assignee calls a work verb. A slow
// model that legitimately spends an hour between verb calls is therefore indistinguishable
// from a dead one, and the rung did three things with no owner in the loop:
//
//   1. `setTrackerStatus(task.id, 'on_deck')` — the assignment is taken away mid-work;
//   2. `onTaskRunComplete(task.id, 'failed', …)` for a scheduled task;
//   3. an A2A `intent: 'ASSIGN'` to the PRIMARY agent, text ending *"needs to be reassigned or
//      investigated"*, chosen deliberately (the comment says so) so the primary WAKES and
//      reassigns. The owner was never told. The primary is the fallback bin the report names.
//
// The ladder then re-arms on the remediation marker, which is the *"repeatedly"*: every time the
// owner re-assigned the project, the same clock ran out and the same handoff happened again.
//
// ── THE TWO SEPARATE QUESTIONS THIS MODULE SPLITS (plan rulings R1, R2, R5) ──
// R1 says no wall-clock threshold may decide "is this agent stuck", and R2 says stuck detection
// is count-based, full stop. Both are about DECIDING STUCK. A poke is not a verdict of stuck —
// it is a question, and the ladder's lower rungs are allowed to ask it on a clock. So:
//
//   PATIENCE  — how long before the PM asks anything at all. Still a clock, now floored by the
//               platform's OWN declared allowance for a single model call on that assignee's
//               provider. The PM may not call an agent idle sooner than the engine would let
//               one of its calls run.
//   AUTHORITY — what the terminal rung may DO. It may ask the owner. It may not move work.
//               Stuck is now the owner's verdict (or the count-based effort meter's, T79c/T79d,
//               which is untouched here and remains the only mechanism that judges a loop).
//
// ── WHY THE FLOOR IS DERIVED AND NOT CHOSEN (and how R6 is kept byte-for-byte) ──
// A "slow model multiplier" needs a REFERENCE speed to multiply against, and no such number
// exists anywhere in this platform — inventing one would be exactly the "scaling the numbers"
// fix R1 explicitly rejected. What DOES exist is `resolveStreamPatience`: the provider's
// declared first-chunk and idle allowances, i.e. the platform's own answer to "how long may one
// call on this provider legitimately take before we call it stuck". One ladder step cannot
// honestly be shorter than that. So each rung's threshold becomes
// `max(today's threshold, floor × rung)` — a FLOOR, never a replacement:
//
//   * an UNDECLARED provider resolves to the defaults (90 s + 60 s = 150 s), and
//     max(300,150) max(900,300) max(1800,450) max(3600,600) = 300/900/1800/3600, which is
//     today's table EXACTLY. R6 is not a promise here, it is arithmetic, and
//     `the-pm-waits-for-the-model-it-assigned.test.ts` asserts the whole table unchanged.
//   * the owner's DS4 row (~600 s first chunk) floors rung 1 at 20 minutes and rung 4 at 80,
//     so the slow sub-agent in the report gets asked about instead of overridden.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { resolveStreamPatience } from '../agent/stream-patience.js';
import { AUDIT_KIND } from '../work/audit-trail.js';
import { appendWorkEvent } from '../work/store.js';
import { requestUserVerdict } from '../work/tracker-store.js';
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
  /** The owner (or the primary) says: this assignee is slow on purpose, leave it alone. */
  extended: 'patience_extended',
  /** The same authority takes it back. */
  revoked: 'patience_revoked',
  /** The terminal rung's ASK: assignee silent, owner must choose wait / reassign / cancel. */
  decisionRequested: 'assignee_silent_decision_requested',
  /** Every reassignment, whoever made it, with the prior assignee's last known state. */
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

/** The newest patience decision for this task, or null when nobody has made one. */
function newestPatienceEntry(taskId: string): string | null {
  try {
    const row = getDb().prepare(
      `SELECT json_extract(payload, '$.entry_kind') AS entry_kind
         FROM work_events
        WHERE work_id = ? AND kind = ?
          AND json_extract(payload, '$.entry_kind') IN (?, ?)
        ORDER BY id DESC LIMIT 1`,
    ).get(taskId, AUDIT_KIND, PATIENCE_ENTRY.extended, PATIENCE_ENTRY.revoked) as
      { entry_kind: string | null } | undefined;
    return row?.entry_kind ?? null;
  } catch {
    return null;
  }
}

/**
 * Is this task flagged "slow agent, use extended patience" (report fix idea 4)?
 *
 * Derived from the newest grant/revoke event rather than stored as a column, which is the same
 * reason `override-requests.ts` derives "pending" from the record: *"a fact maintained in two
 * places drifts, and a fact derived from the record cannot."* It also means no migration, and a
 * grant survives a restart because it IS the history.
 */
export function extendedPatience(taskId: string): boolean {
  return newestPatienceEntry(taskId) === PATIENCE_ENTRY.extended;
}

/** Grant the flag. `actor` is the authority — the owner through a door, or the primary. */
export function grantExtendedPatience(taskId: string, actor: string, reason: string): void {
  appendWorkEvent(taskId, AUDIT_KIND, actor, {
    entry_kind: PATIENCE_ENTRY.extended, reason, action_taken: 'extended patience granted',
  });
  logger.info('extended patience granted: the PM will notify, never intervene', { taskId, actor });
}

/** Take it back. The ladder returns to its floored-but-ordinary behaviour. */
export function revokeExtendedPatience(taskId: string, actor: string, reason: string): void {
  appendWorkEvent(taskId, AUDIT_KIND, actor, {
    entry_kind: PATIENCE_ENTRY.revoked, reason, action_taken: 'extended patience revoked',
  });
  logger.info('extended patience revoked', { taskId, actor });
}

/** What the assignee was last seen doing — carried into the ask so the owner can judge. */
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

export interface DecisionAsk {
  taskId: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  idleMinutes: number;
  floor: PatienceFloor;
}

/**
 * THE TERMINAL RUNG, REBUILT (report fix ideas 2 and 3; plan ruling R5).
 *
 * The old rung took the work away and told the primary to re-home it. This one asks the OWNER
 * and changes nothing else: the task keeps its assignee, its status and its history.
 *
 * `requestUserVerdict` is the existing seam and it is load-bearing in a way worth naming: every
 * PM sweep query already carries `AND awaitingUserVerdictExpr(w) = 0`, so flipping it stands the
 * ladder down on this task until the owner answers. "Ask and wait" needs no new state machine —
 * the stand-down is what the flag has always meant, and the dashboard already renders both the
 * `verdict?` badge and the amber `user_verdict_request` line in the task log.
 *
 * Returns false when the owner has already been asked, so a 60-second sweep cannot re-ask.
 */
export function requestAssigneeDecision(ask: DecisionAsk): boolean {
  const who = ask.assigneeName ?? ask.assigneeId ?? 'the assignee';
  const question =
    `"${ask.title}" has not moved for ${ask.idleMinutes} minutes and ${who} has not answered the `
    + `escalation ladder. Nothing has been changed. Choose: WAIT (leave it with ${who}), `
    + `REASSIGN (name the agent you want it moved to), or CANCEL the task. `
    + `${who} was last seen: ${assigneeLastState(ask.assigneeId)}. `
    + `Patience for this assignee: ${ask.floor.floorSeconds}s per step, ${ask.floor.basis}`
    + `${ask.floor.modelId ? ` (model ${ask.floor.modelId})` : ''}.`;

  appendWorkEvent(ask.taskId, AUDIT_KIND, 'pm', {
    entry_kind: PATIENCE_ENTRY.decisionRequested,
    reason: question,
    action_taken: 'owner decision requested: wait / reassign / cancel',
    note: `assignee=${ask.assigneeId ?? 'none'} idle_minutes=${ask.idleMinutes}`,
  });
  requestUserVerdict(ask.taskId, 'pm', {
    source: 'assignee_silent',
    assignee: ask.assigneeId,
    idle_minutes: ask.idleMinutes,
    options: ['wait', 'reassign', 'cancel'],
    patience_floor_seconds: ask.floor.floorSeconds,
    patience_basis: ask.floor.basis,
  });
  logger.warn('PM asked the owner what to do; no work was moved', {
    taskId: ask.taskId, assignee: ask.assigneeId, idleMinutes: ask.idleMinutes,
    patienceFloorSeconds: ask.floor.floorSeconds, patienceBasis: ask.floor.basis,
  });
  return true;
}

/**
 * EVERY REASSIGNMENT LEAVES A RECORD (report fix idea 5): who moved it, why, and what the
 * previous assignee was last seen doing. Called from the one place a task's assignee actually
 * changes by verb (`work_update:reassign`), so the record cannot be skipped by whoever calls it
 * — the owner through the dashboard, the primary, or the PM.
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
