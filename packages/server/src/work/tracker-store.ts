// PHASE-2 T8b — THE TRACKER'S WRITES, ON THE SPINE.
//
// The other half of `tracker-view.ts`: that file is how a tracker row is READ out of `work`,
// this one is how it gets IN. Together they are the whole of "the order-ticket IS the
// tracker" (OR1) for the tracker's own storage.
//
// THE TWO-CLAUSE PROPERTY this file exists inside (orchestrator ruling, PHASE-2 ledger
// 2026-07-29, T6 acceptance §3): the single-writer walk names the `work/` DIRECTORY as its
// boundary, preserving the sharp guarantee in two parts —
//   (a) every write to `work` / `work_events` / `adjudications` lives under `work/`, and
//   (b) `work.state` UPDATEs exist ONLY in `store.ts`, inside `transition()`.
// So this file may INSERT a tracker row and patch its attribute columns; it may NOT move a
// row's state, and it does not try to — `setTrackerStatus` below calls `transition()` and
// hands back its result unchanged, including its refusals.
//
// WHAT REPLACED WHAT, so the removal can be checked rather than trusted:
//   `tracker/schema.ts:createTask` / `:createProject` (raw INSERT INTO legacy_*)  -> here
//   `tracker/schema.ts:updateTask` (a generic column patcher with NO gate, PINNED §13's
//     "route R2", 11 call sites)                                                  -> here,
//     split in two: attribute writes land in `patchWork`, the status argument goes through
//     `transition()`. The two-mechanism disease was that ONE function did both and the
//     status half had no gate at all.

import { v4 as uuidv4 } from 'uuid';
import type { OutcomeRefused } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { patchAssignments } from '../db/patch.js';
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import { noSuchWorkDetail, noteUnsettled, type WorkPatchOutcome } from './outcome.js';
import {
  transition, rejectClaim, appendWorkEvent,
  type Actor, type Claim, type WorkOutcome, type WorkState,
} from './store.js';
import {
  statusToState, stateToStatus, TRACKER_ROOT_KIND, WORK_EVENT,
  type TrackerStatus,
} from './tracker-view.js';

const logger = createLogger('tracker-store');

const now = (): number => Date.now();

// ════════════════════════════════════════════════════════════════════════════════
// 1 — CREATION
// ════════════════════════════════════════════════════════════════════════════════

/** Origin, exactly as `tracker/schema.ts` has required it since migration 112: the param may
 *  not be omitted, the values may be null. A new writer that forgets lineage fails to
 *  compile instead of silently minting origin-less work. */
export interface TrackerOrigin {
  kind: string | null;
  sourceMessageId: string | null;
  turn: number | null;
  convKey: string | null;
}

export interface OpenTrackerProjectInput {
  id?: string;
  title: string;
  description?: string | null;
  level?: number;
  createdBy: string;
  groupId?: string | null;
  origin: TrackerOrigin;
}

export interface OpenTrackerTaskInput {
  id?: string;
  projectId?: string | null;
  title: string;
  description?: string | null;
  originalDescription?: string | null;
  goal?: string | null;
  status?: TrackerStatus;
  assignedTo?: string | null;
  assignedToGroup?: string | null;
  createdBy: string;
  priority?: string | null;
  stepNumber?: number | null;
  totalSteps?: number | null;
  phase?: number | null;
  dependsOn?: string[];
  taskKind?: string | null;
  a2aThreadId?: string | null;
  /** Which tracker vintage this row is. Defaults to `TRACKER_ROOT_KIND`; the engine's own
   *  >=6 floor passes `engine_scaffold`, which is the T8c rekey of `ENGINE_AUTO_MARKER`. */
  rootKind?: string;
  origin: TrackerOrigin;
}

/** `requester` is the spine's four-value enum (`owner|agent|schedule|watcher`) and is NOT the
 *  same fact as `requester_id`. Migration `135` derived it the same way — a literal `'user'`
 *  creator is the owner, everything else is an agent — and this keeps that one rule in one
 *  place rather than at each insert. */
const requesterOf = (createdBy: string): string => (createdBy === 'user' ? 'owner' : 'agent');

export function openTrackerProject(p: OpenTrackerProjectInput): string {
  const db = getDb();
  const id = p.id ?? uuidv4();
  const at = now();
  withUnit(() => {
    db.prepare(`
      INSERT INTO work (
        id, kind, parent_id, agent_id, requester, requester_id, root_kind, root_id,
        state, intent, wakes, closes_thread, title, description, level, phase_count,
        current_phase, group_id, source_message_id, origin_turn, origin_conv_key, origin_kind,
        opened_at, updated_at, provenance
      ) VALUES (?, 'project', NULL, ?, ?, ?, ?, ?, 'open', 'tracker', 0, 0, ?, ?, ?, 1, 1,
                ?, ?, ?, ?, ?, ?, ?, 'live')
    `).run(
      id, p.createdBy, requesterOf(p.createdBy), p.createdBy, TRACKER_ROOT_KIND, id,
      p.title, p.description ?? null, p.level ?? 1, p.groupId ?? null,
      p.origin.sourceMessageId, p.origin.turn, p.origin.convKey, p.origin.kind, at, at,
    );
    appendWorkEvent(id, 'opened', p.createdBy, { kind: 'project', title: p.title });
  });
  return id;
}

export function openTrackerTask(p: OpenTrackerTaskInput): string {
  const db = getDb();
  const id = p.id ?? uuidv4();
  const at = now();
  // `agent_id` is NOT NULL on the spine and the legacy column was nullable, so an unassigned
  // task belongs to its creator until someone claims it — the same COALESCE migration `135`
  // used (`COALESCE(t.assigned_to, t.created_by)`), not a new rule.
  withUnit(() => {
    db.prepare(`
      INSERT INTO work (
        id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
        root_kind, root_id, state, intent, wakes, closes_thread,
        title, description, original_description, goal, priority, step_number, total_steps,
        phase, depends_on, assigned_to_group, task_kind, a2a_thread_id,
        source_message_id, origin_turn, origin_conv_key, origin_kind,
        opened_at, updated_at, provenance
      ) VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, 'tracker', 0, 0,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')
    `).run(
      id, p.projectId ?? null, p.assignedTo ?? p.createdBy, p.assignedTo ?? null,
      requesterOf(p.createdBy), p.createdBy, p.rootKind ?? TRACKER_ROOT_KIND, id,
      statusToState(p.status ?? 'in_progress'),
      p.title, p.description ?? null, p.originalDescription ?? null, p.goal ?? null,
      p.priority ?? 'normal', p.stepNumber ?? null, p.totalSteps ?? null, p.phase ?? 1,
      JSON.stringify(p.dependsOn ?? []), p.assignedToGroup ?? null, p.taskKind ?? null,
      p.a2aThreadId ?? null,
      p.origin.sourceMessageId, p.origin.turn, p.origin.convKey, p.origin.kind, at, at,
    );
    appendWorkEvent(id, 'opened', p.createdBy, { kind: 'task', title: p.title, project_id: p.projectId ?? null });
  });
  return id;
}

// ════════════════════════════════════════════════════════════════════════════════
// 2 — ATTRIBUTE WRITES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Every `work` column a tracker writer may patch, and NOT ONE MORE.
 *
 * `state`, `closed_at`, `result_delivery_id`, `claimed_by_turn`, `remaining_children` and
 * `compile_pending` are deliberately absent: they are `transition()`'s, and a patcher that
 * could reach them would be the ungated second writer this phase is removing. The union is
 * the gate — a caller that names one of those does not compile.
 */
export type TrackerAttr =
  | 'parent_id' | 'agent_id' | 'assignee_agent' | 'requester_id' | 'conversation_id'
  | 'title' | 'goal' | 'priority' | 'notes' | 'description' | 'original_description'
  | 'completion_summary' | 'result' | 'evidence_json'
  | 'step_number' | 'total_steps' | 'phase' | 'depends_on' | 'assigned_to_group' | 'task_kind'
  | 'level' | 'phase_count' | 'current_phase' | 'group_id'
  | 'source_message_id' | 'origin_turn' | 'origin_conv_key' | 'origin_kind'
  | 'a2a_thread_id' | 'last_smell_flag'   // PHASE-2 T10F: `deliverable_shown` dropped (`145`)
  | 'scheduled_start' | 'repeat_interval' | 'repeat_unit' | 'repeat_end_type'
  | 'repeat_end_value' | 'repeat_days_of_week' | 'schedule_status' | 'is_paused'
  | 'paused_until' | 'status_before_pause' | 'last_run_at' | 'missed_runs_paused_at'
  | 'anchor_local' | 'next_run_at' | 'attempts';
// PHASE-2 T8c item 2: the six ticket-stamp columns left this union with their storage. They
// are `work_events` rows of kind `activity` now (see `stampTicket` below), so a patcher that
// could still name them would be writing a column nothing reads.

export type WorkPatch = Partial<Record<TrackerAttr, unknown>>;

/**
 * Patch a work row's attribute columns.
 *
 * M7 (PHASE-4 T5): the values obey `db/patch.ts`'s ONE RULE — `undefined` LEAVES a column
 * alone, `null` CLEARS it. A caller holding a maybe-undefined expression that MEANS clear
 * says so with `?? null`; a caller that means leave-alone can pass the expression as it is.
 *
 * `updated_at` moves by default because that is what every legacy writer did
 * (`updated_at = datetime('now')` on the same statement). The opt-out exists for ONE named
 * reason and carries it: requirement #15 says the denormalized activity stamps must never
 * bump `updated_at`, because the PM ladder reads that column as "when did this work last
 * MOVE" and a stamp is not a move. `tracker/task-stamps.ts` passes `touch: false`.
 *
 * PHASE-6 T0D — G1, THE ATTRIBUTE DOOR'S OWN. This was a bare `UPDATE … WHERE id = ?`
 * returning `number`, with no existence check, no log and no outcome type, so a write
 * against an id from an earlier session did nothing and told nobody. It is the same gate
 * `transition()` has carried since PHASE-2, on the other half of the row, telling the same
 * story in the same sentence (`noSuchWorkDetail`).
 *
 * THE CHECK COSTS NOTHING ON THE PATH THAT MATTERS, and that is why it is shaped this way:
 * SQLite's `changes` counts rows the statement PROCESSED, not rows whose values differed, so
 * `changes === 0` after a non-empty patch means no row matched — no probing SELECT is owed.
 * The one extra read is on the empty-patch branch, which is the rare caller bug.
 */
export function patchWork(id: string, patch: WorkPatch, opts?: { touch?: boolean }): WorkPatchOutcome {
  const { sets, values } = patchAssignments(patch);
  // A patch that mentions no field CHANGED NOTHING, so `updated_at` may not move either:
  // the PM ladder reads that column as "when did this work last MOVE" and a clock bumped by
  // an empty patch is a receipt for something that did not happen. (Before M7 this function
  // did the opposite twice over — an all-`undefined` patch erased every column it named AND
  // bumped the clock, and an empty `{}` bumped the clock on its own.)
  //
  // It is still a `no_change` and not a refusal — nothing was asked — UNLESS the row is not
  // there, because then the caller has two problems and only one of them is about the world.
  if (sets.length === 0) {
    return getDb().prepare('SELECT 1 FROM work WHERE id = ?').get(id)
      ? { kind: 'no_change', workId: id, reason: 'empty-patch', detail: `no field named for ${id}` }
      : refuseNoSuchWork(id);
  }
  if (opts?.touch !== false) {
    sets.push('updated_at = ?');
    values.push(now());
  }
  values.push(id);
  const changes = getDb()
    .prepare(`UPDATE work SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
  return changes === 0 ? refuseNoSuchWork(id) : { kind: 'applied', value: changes };
}

/** The attribute door's stale-id refusal, built once so its two branches cannot drift. */
function refuseNoSuchWork(id: string): OutcomeRefused<'no-such-work'> & { workId: string } {
  return { kind: 'refused', workId: id, reason: 'no-such-work', detail: noSuchWorkDetail(id) };
}

/** The same patch applied to every row matching a predicate on ONE column. The only shape
 *  the legacy tree used it in (`SET assigned_to_group = NULL WHERE assigned_to_group = ?`),
 *  kept narrow on purpose: a general WHERE here would be a SQL door. */
export function patchWorkWhere(
  where: { column: 'assigned_to_group' | 'group_id' | 'parent_id'; equals: unknown },
  patch: WorkPatch,
): number {
  const { sets, values } = patchAssignments(patch);
  if (sets.length === 0) return 0;
  sets.push('updated_at = ?');
  values.push(now(), where.equals);
  return getDb().prepare(
    `UPDATE work SET ${sets.join(', ')} WHERE ${where.column} = ?`,
  ).run(...values).changes;
}

/** Append a timestamped line to `notes`, preserving `addTaskNotes`'s exact SQL shape (the
 *  CASE keeps a first note from becoming `NULL || text`). */
export function appendWorkNotes(id: string, entry: string): number {
  return getDb().prepare(`
    UPDATE work SET
      notes = CASE WHEN notes IS NULL THEN ? ELSE notes || char(10) || ? END,
      updated_at = ?
    WHERE id = ?
  `).run(entry, entry, now(), id).changes;
}

/** `attempts` is the spine's name for `run_count` (T8a §2.3a). Incremented, never assigned,
 *  for the same reason the legacy scheduler incremented it: two fires racing must not lose
 *  a count. */
export function bumpWorkAttempts(id: string): number {
  return getDb().prepare('UPDATE work SET attempts = attempts + 1, updated_at = ? WHERE id = ?')
    .run(now(), id).changes;
}

/** Delete a tracker row and its children. The dashboard's delete routes and the memory
 *  route's cleanup both did this against the legacy tables; children are detached rather
 *  than orphaned so `parent_id`'s FK stays satisfiable. */
export function deleteTrackerRow(id: string): number {
  const db = getDb();
  let changes = 0;
  withUnit(() => {
    db.prepare('DELETE FROM work_events WHERE work_id IN (SELECT id FROM work WHERE parent_id = ?)').run(id);
    db.prepare('DELETE FROM adjudications WHERE work_id IN (SELECT id FROM work WHERE parent_id = ?)').run(id);
    db.prepare('DELETE FROM work WHERE parent_id = ?').run(id);
    db.prepare('DELETE FROM work_events WHERE work_id = ?').run(id);
    db.prepare('DELETE FROM adjudications WHERE work_id = ?').run(id);
    changes = db.prepare('DELETE FROM work WHERE id = ?').run(id).changes;
  });
  return changes;
}

/** Detach children without deleting them (the memory route's "unfile these tasks"). */
export function detachChildren(parentId: string): number {
  return getDb().prepare('UPDATE work SET parent_id = NULL, updated_at = ? WHERE parent_id = ?')
    .run(now(), parentId).changes;
}

// ════════════════════════════════════════════════════════════════════════════════
// 3 — STATUS, WHICH IS A TRANSITION
// ════════════════════════════════════════════════════════════════════════════════

export interface SetStatusInput {
  by: Actor;
  actorId?: string | null;
  reason: string;
  evidenceRef?: string | null;
  resultDeliveryId?: string | null;
  claim?: Claim;
  expectedState?: WorkState;
  claimedByTurn?: number | null;
  note?: string | null;
  /** Legacy side-effect of `updateTask({ status: 'paused' })`: the resume time rides the
   *  same call. Epoch-ms; the legacy column was TEXT and `137` converted it. */
  pausedUntilMs?: number | null;
  /**
   * Whether this pause also stops the SCHEDULE (`is_paused`).
   *
   * They are TWO AXES and conflating them is a live bug, not a tidiness point: T6's reopen
   * edge negative-controls them against each other, because the engine's "the ball is with
   * the owner" pause must NOT stop a recurring schedule, while `work_update(action="status")
   * (status='paused')` deliberately does — `updateTask`'s own comment said so ("keep
   * is_paused in sync ... regardless of whether the pause came from work_update(action="status")
   * or work_schedule(action="pause")"). Default false; the tool paths opt IN.
   */
  syncSchedulePause?: boolean;
}

/**
 * The tracker's one status writer.
 *
 * It carries the side-effects `tracker/schema.ts:updateTask` performed alongside the status
 * assignment, because they are part of the SAME requirement and splitting them across two
 * calls is how a paused row ends up with `is_paused = 0`:
 *   * into `paused`  -> `is_paused = 1`, remember the status we came from, set `paused_until`
 *   * out of `paused` -> clear all three (and leave `is_paused` alone on a close, exactly as
 *     the old code did: a completed recurring task stays paused-from-the-scheduler's-view)
 * `pause_validated = 0` needs no statement any more: the flag is now
 * "an authority upheld the CURRENT pause", so entering `paused` afresh un-validates it by
 * construction (`tracker-view.ts:validatedExpr`).
 */
export function setTrackerStatus(
  id: string, status: TrackerStatus, input: SetStatusInput,
): WorkOutcome {
  const db = getDb();
  const to = statusToState(status);
  const before = db.prepare('SELECT state FROM work WHERE id = ?').get(id) as
    { state: WorkState } | undefined;

  let result!: WorkOutcome;
  withUnit(() => {
    result = transition(id, {
      to,
      by: input.by,
      reason: input.reason,
      evidenceRef: input.evidenceRef ?? null,
      resultDeliveryId: input.resultDeliveryId ?? null,
      claim: input.claim,
      expectedState: input.expectedState,
      claimedByTurn: input.claimedByTurn ?? null,
      note: input.note ?? null,
      actorId: input.actorId ?? undefined,
    });
    if (result.kind !== 'applied') return;

    if (to === 'paused') {
      noteUnsettled(patchWork(id, {
        ...(input.syncSchedulePause ? { is_paused: 1 } : {}),
        status_before_pause: before && before.state !== 'paused' ? stateToStatus(before.state) : null,
        ...(input.pausedUntilMs !== undefined ? { paused_until: input.pausedUntilMs } : {}),
      }), 'setTrackerStatus: pause bookkeeping', { taskId: id });
    } else {
      noteUnsettled(patchWork(id, {
        ...(input.syncSchedulePause && to !== 'done' ? { is_paused: 0 } : {}),
        paused_until: null,
        status_before_pause: null,
      }), 'setTrackerStatus: pause bookkeeping cleared', { taskId: id });
    }
  });
  return result;
}

/**
 * The delivery a PROJECT's completion points at.
 *
 * `transition()`'s G7 refuses `done` without a `deliveries` row, and a project has no
 * delivery of its own — it finishes because its children did. So it points at a REAL
 * delivery: the most recent one its own completed children were closed against. That is
 * evidence, not a sentinel: the row already exists, it was written by a transport door
 * (T5), and it says exactly why the project is finished.
 *
 * Returns null when no child was ever closed against a delivery, and the caller then gets a
 * refusal rather than a manufactured receipt. That is the gate doing its job.
 */
export function deliveryForCompletedChildren(projectId: string): string | null {
  const r = getDb().prepare(
    `SELECT result_delivery_id AS id FROM work
      WHERE parent_id = ? AND state = 'done' AND result_delivery_id IS NOT NULL
      ORDER BY closed_at DESC LIMIT 1`,
  ).get(projectId) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * The delivery a TASK's close points at when the closer is the agent that did the work.
 *
 * The newest recorded delivery by that agent since the work opened. The `a2a` lane is
 * INCLUDED here, unlike `terminalDeliveryForTurn`'s owner-facing question: an apprentice
 * hands its result to the agent that spawned it, and that hand-off IS the delivery for that
 * piece of work. `engine-ack` is excluded for the reason it is excluded everywhere else —
 * the engine saying "on it" is not the work arriving.
 *
 * Null when the agent delivered nothing, and the close is then refused by G7. That refusal
 * is the phase's central requirement, not a failure of this function.
 */
export function deliveryForAgentSince(agentId: string, sinceMs: number): string | null {
  const r = getDb().prepare(
    `SELECT id FROM deliveries
      WHERE agent_id = ? AND outcome = 'delivered' AND tool <> 'engine-ack'
        AND CAST(strftime('%s', created_at) AS INTEGER) * 1000 >= ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(agentId, sinceMs) as { id: string } | undefined;
  return r?.id ?? null;
}

/** The same question asked of a work row: its own agent, its own opening instant. */
export function deliveryForTaskClose(workId: string): string | null {
  const w = getDb().prepare('SELECT agent_id, opened_at FROM work WHERE id = ?')
    .get(workId) as { agent_id: string; opened_at: number } | undefined;
  if (!w) return null;
  return deliveryForAgentSince(w.agent_id, w.opened_at);
}

// ⟨TOMBSTONE⟩ `claimOccurrence` lived here and was D21's timestamp CAS: one UPDATE keyed on
// `next_run_at = ?`. It moved to `work/occurrences.ts` and CHANGED SHAPE in PHASE-2 T8c2
// item 4, because keying exactly-once on a clock was the defect, not the implementation:
// the caller could only obtain that clock through `msToText`, which drops milliseconds, so
// every schedule started from a real clock reading was permanently unclaimable. The claim is
// now the INSERT of a `work(kind='occurrence')` row, refused by `ux_work_occurrence` — a
// constraint, and durable, so a crashed fire cannot lose the occurrence either.
// requirement preserved: exactly-once, the claim token, advance-at-fire, and the unfired
// release — all four asserted in `work/__tests__/occurrences.test.ts`.

/** Stop a live schedule, once. `changes === 1` is the token that says THIS caller won the
 *  race, which is what keeps two terminators from both announcing a termination. */
export function stopLiveSchedule(workId: string): boolean {
  const r = getDb().prepare(`
    UPDATE work
       SET schedule_status = 'completed', is_paused = 1, next_run_at = NULL, updated_at = ?
     WHERE id = ? AND schedule_status IN ('waiting', 'running')
  `).run(now(), workId);
  return r.changes === 1;
}

/**
 * The turn-finalize ticket stamp — ONE EVENT, not six columns (PHASE-2 T8c item 2, executing
 * T8a's booked collapse).
 *
 * Deliberately does NOT touch `updated_at` — the drive ladder's idle clock — which is
 * requirement #15 and is conformance-locked. That is now true BY CONSTRUCTION rather than by
 * remembering to leave a column out of a SET list: an event log has no `updated_at` to touch.
 *
 * The three COALESCEs are gone with the columns. They were maintaining "the last turn that
 * ANSWERED" and "the last delivery summary" across turns that did neither, i.e. one statement
 * keeping three facts in step. `work/tracker-view.ts:stampColumns` asks the log for each fact
 * separately ("the newest activity", "the newest that answered", "the newest that
 * delivered"), so there is nothing left to keep in step.
 */
export function stampTicket(workId: string, f: {
  activityTurn: number; activityAt: number; activityOutcome: string;
  answeredTurn: number | null; answeredAt: number | null; deliverySummary: string | null;
}): void {
  appendWorkEvent(workId, WORK_EVENT.activity, 'engine', {
    turn: f.activityTurn,
    outcome: f.activityOutcome,
    answered: f.answeredTurn !== null ? 1 : 0,
    delivery_summary: f.deliverySummary,
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// 4 — THE TWO-KEY WRITES (the flag columns' successors)
// ════════════════════════════════════════════════════════════════════════════════

/** An authority upholds the row's CURRENT claim — the write behind `*_validated = 1`.
 *  `transition()` files the adjudication when a state actually moves; this is the case where
 *  the state is already right and only the verdict is missing. */
export function upholdClaim(
  id: string, claimState: WorkState, _by: Actor, byId: string, note: string,
): number {
  const rowid = withUnit((): number => {
    const info = getDb().prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
       VALUES (?, ?, 'upheld', ?, NULL, ?, ?)`,
    ).run(id, claimState, byId, note, now());
    appendWorkEvent(id, 'claim_upheld', byId, { claim_state: claimState, note });
    return Number(info.lastInsertRowid);
  });
  logger.info('claim upheld', { workId: id, claimState, by: byId });
  return rowid;
}

/** A thrown-back claim — the write behind `revert_count = revert_count + 1`. Delegates to
 *  `store.ts:rejectClaim` so `adjudications` keeps one writer module. */
export function throwBackClaim(
  id: string, claimState: WorkState, by: Actor, byId: string, note: string,
): void {
  const r = rejectClaim(id, { claimState, by, byId, note });
  if (r.kind !== 'applied') {
    logger.warn('claim rejection refused', { workId: id, reason: r.reason, detail: r.detail });
  }
}

/** `revert_count = 0`. A COUNT cannot be assigned, so a reset is a MARKER the count reads
 *  past — which also means the history survives the reset instead of being erased. */
export function resetRevertCount(id: string, actorId: string, reason: string): void {
  appendWorkEvent(id, WORK_EVENT.revertReset, actorId, { reason });
}

/** `validation_escalated_at` + `validation_thread_id`, as one event. */
export function recordValidationEscalation(id: string, actorId: string, threadId: string | null): void {
  appendWorkEvent(id, WORK_EVENT.validationEscalated, actorId, { thread_id: threadId });
}

/** `awaiting_user_verdict = 1` + `user_verdict_requested_at = now`. */
export function requestUserVerdict(id: string, actorId: string, detail: unknown): void {
  appendWorkEvent(id, WORK_EVENT.userVerdictRequested, actorId, detail);
}

/** `awaiting_user_verdict = 0` + `user_verdict_requested_at = NULL`. */
export function clearUserVerdict(id: string, actorId: string, reason: string): void {
  appendWorkEvent(id, WORK_EVENT.userVerdictCleared, actorId, { reason });
}
