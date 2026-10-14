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
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { turnContext } from '../agent/turn-context.js';
import { clearReferencesToWork } from './work-refs.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import { noSuchWorkDetail, noteUnsettled, type WorkPatchOutcome } from './outcome.js';
import {
  transition, rejectClaim, appendWorkEvent,
  type Actor, type Claim, type WorkOutcome, type WorkState,
} from './store.js';
import {
  statusToState, stateToStatus, TRACKER_ROOT_KIND, WORK_EVENT, validatedExpr, taskScope,
  type TrackerStatus,
} from './tracker-view.js';
// t129's gate names the owner in its refusal. `config/platform.ts` is a leaf read of the
// config row, so it adds no cycle to this module.
import { getOwnerName } from '../config/platform.js';
// SLOW-INFERENCE T79c: the durable effort meter's ADVANCE half. `effort-governor.ts` is a
// leaf (imports only the DB connection), so importing it here creates no cycle with the
// CHARGE half at `agent/v2/steps/execute/tracker-counting.ts` — see that module's header.
import { advanceBaseline } from '../tracker/effort-governor.js';

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

// ════════════════════════════════════════════════════════════════════════════════
// t118 — THE WORK SPINE'S TEXT COLUMNS ARE REDACTED AT THE DOOR
//
// WHY HERE AND NOT AT THE CALLERS. The tracker-scaffold leak was one caller holding a raw
// owner message, and it was fixed at its own source (`tracker-floors.ts`), because that path
// had sinks this door cannot see (a dashboard broadcast and the PM rename handoff, neither
// of which is a column). t139 removed the message from that floor altogether — it writes no
// prose from the turn's message and the handoff is deleted. But the census that fix demanded found the SAME SHAPE in eight more
// writers into the same four columns — the A2A ASSIGN payload becoming a task's
// title/description/goal (`tracker/schema.ts`), model-authored tool arguments on create and
// edit, an apprentice's completion summary (`agent/spawner.ts`), engine-rendered delivery
// evidence (`tracker/pm-agent.ts`, `teardown/finalize-record.ts`) — and the list grows every
// time someone opens or patches work.
//
// A redact call per caller is EXACTLY THE DISEASE THAT PRODUCED THIS DEFECT: the helper sat
// one import away from the leaking line for five months, and the only reason it was ever
// noticed is that a random draw happened to cross a floor of six untracked calls with a
// credential in the message. Nine call sites each owing a call they can forget is nine
// chances to reproduce it, and a tenth writer tomorrow owes it too.
//
// So the DOOR owes it. Every text column on `work` that can receive owner- or model-authored
// prose passes `redactHandedCredentials` — the tree's ONE redactor, which returns its input
// BY REFERENCE when the agent has handled no credential, so the ordinary write pays a map
// lookup and no string is rebuilt (G2: assembled bytes cannot move).
//
// KEYED TO THE ROW'S AGENTS, UNION. The handed-value set is per agent, and a work row has up
// to three: its assignee, its creator/requester, and (on a patch) whoever the row belongs to
// now. The union is deliberate and is the SAFE direction — redacting a value agent B handled
// out of agent A's row is still correct (it is a secret either way), whereas keying on one
// agent and guessing wrong leaves the value in the clear. Over-redaction cannot leak.
// ════════════════════════════════════════════════════════════════════════════════

/** Every `TrackerAttr` that can carry owner- or model-authored prose.
 *
 *  THE CENSUS CLAUSE READS THIS LIST against `TrackerAttr` itself, so a new text column
 *  added to the union and not classified here fails rather than passing silently. The
 *  columns deliberately absent are absent because they cannot carry prose: ids, agent
 *  handles, enums, counts, timestamps and the JSON `depends_on` id array. */
export const CREDENTIAL_BEARING_WORK_TEXT = [
  'title', 'description', 'original_description', 'goal', 'notes',
  'completion_summary', 'result', 'evidence_json',
] as const satisfies readonly TrackerAttr[];

const BEARING = new Set<string>(CREDENTIAL_BEARING_WORK_TEXT);

/** One string, redacted against every agent the row belongs to. */
function scrubText(agentIds: readonly (string | null | undefined)[], text: string): string {
  let out = text;
  const seen = new Set<string>();
  for (const a of agentIds) {
    if (typeof a !== 'string' || a.length === 0 || a === 'user' || a === 'engine') continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out = redactHandedCredentials(a, out);
  }
  return out;
}

/** `null`/`undefined` pass through untouched so the door never turns a CLEAR into a write. */
function scrubMaybe(
  agentIds: readonly (string | null | undefined)[], text: string | null | undefined,
): string | null | undefined {
  return typeof text === 'string' ? scrubText(agentIds, text) : text;
}

/** The agents a row belongs to, for a patch that names a prose column. One SELECT, taken
 *  ONLY when such a column is named — an ordinary status/schedule patch reads nothing. */
function rowAgents(id: string): readonly (string | null)[] {
  try {
    const r = getDb().prepare(
      'SELECT agent_id, assignee_agent, requester_id FROM work WHERE id = ?',
    ).get(id) as { agent_id: string | null; assignee_agent: string | null; requester_id: string | null } | undefined;
    return r ? [r.agent_id, r.assignee_agent, r.requester_id] : [];
  } catch (err) {
    // A redaction that cannot resolve its agents must not fail the write; it degrades to the
    // pre-t118 behaviour for this one patch and says so, loudly, rather than throwing inside
    // someone else's transaction.
    logger.warn('work text redaction could not resolve the row\'s agents; patch proceeds unredacted', {
      workId: id, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** A patch with every prose column redacted against the row's agents. Returns the SAME
 *  object when the patch names no prose column, so the common path allocates nothing. */
function scrubPatch(id: string, patch: WorkPatch): WorkPatch {
  let needs = false;
  for (const k of Object.keys(patch)) {
    if (BEARING.has(k) && typeof (patch as Record<string, unknown>)[k] === 'string') { needs = true; break; }
  }
  if (!needs) return patch;
  const agents = rowAgents(id);
  if (agents.length === 0) return patch;
  const out: Record<string, unknown> = { ...patch };
  for (const k of Object.keys(out)) {
    if (BEARING.has(k) && typeof out[k] === 'string') out[k] = scrubText(agents, out[k] as string);
  }
  return out as WorkPatch;
}

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
      // t118: the door's redaction, on the two prose columns this insert binds.
      scrubText([p.createdBy], p.title), scrubMaybe([p.createdBy], p.description) ?? null,
      p.level ?? 1, p.groupId ?? null,
      p.origin.sourceMessageId, p.origin.turn, p.origin.convKey, p.origin.kind, at, at,
    );
    appendWorkEvent(id, 'opened', p.createdBy, { kind: 'project', title: scrubText([p.createdBy], p.title) });
  });
  return id;
}

/**
 * THE TASK→ASK EDGE (UX-REPAIR round 2 T11). "This tracker task exists to satisfy that ask"
 * lived only in prose — the task's origin line renders *"created from the owner's dashboard
 * conversation at …, asking: …"* — so the ask's own `compile_resolved`, and the receipt it
 * names, were unreachable from the task. Two separate defects (the PM's blind review, and the
 * owner escalation that fired 25 s after the answer shipped) both needed this one edge.
 *
 * No schema change and no new column: `work.source_message_id` already exists and already
 * carries exactly this fact everywhere else that has it (`delivery-evidence.ts:52-70`,
 * `task-stamps.ts:98`, `tools.ts:698`, `spawner.ts:861`). An ask's id IS `ask:<messageId>`
 * (`store.ts:602`), so stamping the ask's own source message makes the edge resolvable with
 * the derivation the spine already publishes, rather than a second pointer to keep in step.
 *
 * Only fills a GAP: a caller that states an origin keeps it byte-identically.
 */
function askSourceMessageForCreatingTurn(agentId: string, creator: string, originTurn: number | null): string | null {
  try {
    const turn = currentTurnNumber(agentId);
    if (!turn) return null;
    const r = getDb().prepare(
      `SELECT root_id FROM work
        WHERE kind = 'ask' AND agent_id = ? AND state = 'claimed' AND claimed_by_turn = ?
        ORDER BY opened_at DESC LIMIT 1`,
    ).get(agentId, turn) as { root_id: string } | undefined;
    if (r?.root_id) return r.root_id;
    return originTurn !== null ? askOfDelegateReplyWake(creator, originTurn) : null;
  } catch (err) {
    // A missing edge is the status quo, never a failed task creation.
    logger.warn('task create: could not resolve the creating turn\'s ask; the task is opened without the edge', {
      agentId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * t139 — THE DELEGATED ASK A WAKE TURN IS FINISHING (the gap `work/join-drive.ts` names).
 *
 * The owner asks; the agent hands the job (or parts of it) to helpers; the ask is HELD behind
 * the join. When a helper's reply lands, the agent is woken to finish the job — on a turn that
 * serves no ask at all (its turn record carries no subject and no root). A task the agent opens
 * there was born with no link, so the task list could show only the agent's own restatement and
 * never the owner's words (driven in `work/__tests__/t139-every-request-lands-on-the-task-list.test.ts`).
 *
 * The tie is RECORDED facts, never a guess by text:
 *   * the creating turn's own record says it serves NOTHING (`turns.subject_kind = 'none'`, no
 *     root) — an ask turn is linked by its root above, and an engine, occurrence, A2A or
 *     continuation turn has a subject of its own, so none of them is ever re-pointed here;
 *   * the newest inbound row the agent had when that turn started is a delegate's reply on a
 *     PIECE of one of its asks (`work.root_kind = 'a2a_thread'`, `root_id` = the reply's thread,
 *     `parent_id` = the ask) — so a turn woken by anything else (a mailbox notice, a contact) is
 *     never tied to the owner's ask, which would present someone else's message as the owner's
 *     request (#12).
 * The ask's own state is deliberately NOT a condition: whether the engine already relayed a
 * single piece (the ask is done) or is waiting for the agent to combine several (blocked,
 * compile pending), a task opened on the turn that reply woke continues THAT request.
 *
 * Point reads: the `turns` primary key, `idx_messages_agent_created`, `ix_work_root`, the `work`
 * primary key. It runs only when a task is opened with no stated origin, never on an assembly.
 */
function askOfDelegateReplyWake(agentId: string, turn: number): string | null {
  const db = getDb();
  const t = db.prepare(
    `SELECT subject_kind, root_kind, (unixepoch(started_at) * 1000 + 999) AS started_ms
       FROM turns WHERE agent_id = ? AND turn_number = ?`,
  ).get(agentId, turn) as { subject_kind: string | null; root_kind: string | null; started_ms: number | null } | undefined;
  if (!t || t.subject_kind !== 'none' || t.root_kind !== null || t.started_ms === null) return null;
  // The row the turn woke on: the newest inbound row (not an engine events-lane row) at its start.
  // t145 (M1b): "at its start" is the message-sequence high-water recorded at pickup, because every
  // clock here is whole-second and a notice landing in the turn's first second is not separable by
  // time. A turn this process did not pick up (no bag for it) keeps the whole-second bound.
  const bag = turnContext(agentId);
  const pickup = bag && bag.turnNumber === turn ? bag.pickupSeq : null;
  const woke = db.prepare(
    `SELECT a2a_thread_id FROM messages
      WHERE agent_id = ? AND role = 'user' AND lane <> 'events' AND ${pickup === null ? 'created_at' : 'seq'} <= ?
      ORDER BY created_at DESC, seq DESC LIMIT 1`,
  ).get(agentId, pickup ?? t.started_ms) as { a2a_thread_id: string | null } | undefined;
  if (!woke?.a2a_thread_id) return null;
  const ask = db.prepare(
    `SELECT a.root_id AS root_id FROM work p JOIN work a ON a.id = p.parent_id
      WHERE p.kind = 'task' AND p.root_kind = 'a2a_thread' AND p.root_id = ?
        AND a.kind = 'ask' AND a.agent_id = ?
      ORDER BY p.opened_at DESC LIMIT 1`,
  ).get(woke.a2a_thread_id, agentId) as { root_id: string } | undefined;
  return ask?.root_id ?? null;
}

export function openTrackerTask(p: OpenTrackerTaskInput): string {
  const db = getDb();
  const id = p.id ?? uuidv4();
  const at = now();
  const sourceMessageId = p.origin.sourceMessageId
    ?? askSourceMessageForCreatingTurn(p.assignedTo ?? p.createdBy, p.createdBy, p.origin.turn);
  // `agent_id` is NOT NULL on the spine and the legacy column was nullable, so an unassigned
  // task belongs to its creator until someone claims it — the same COALESCE migration `135`
  // used (`COALESCE(t.assigned_to, t.created_by)`), not a new rule.
  const taskAgents: readonly (string | null | undefined)[] = [p.assignedTo, p.createdBy];
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
      // t118: the door's redaction, on the four prose columns this insert binds, keyed to
      // the assignee AND the creator (an A2A ASSIGN row is created by the sender whose
      // model authored the payload and assigned to the receiver).
      scrubText(taskAgents, p.title), scrubMaybe(taskAgents, p.description) ?? null,
      scrubMaybe(taskAgents, p.originalDescription) ?? null, scrubMaybe(taskAgents, p.goal) ?? null,
      p.priority ?? 'normal', p.stepNumber ?? null, p.totalSteps ?? null, p.phase ?? 1,
      JSON.stringify(p.dependsOn ?? []), p.assignedToGroup ?? null, p.taskKind ?? null,
      p.a2aThreadId ?? null,
      sourceMessageId, p.origin.turn, p.origin.convKey, p.origin.kind, at, at,
    );
    appendWorkEvent(id, 'opened', p.createdBy, { kind: 'task', title: scrubText(taskAgents, p.title), project_id: p.projectId ?? null });
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
 *
 * SWEEP CORE-2 item 3 (SWEEP-F T2) — `next_run_at` LEFT THIS UNION for the same reason.
 * It is the platform's firing clock, and fourteen call sites reached it through this
 * forty-five-column door with no way for the compiler to tell a caller it was moving a
 * schedule rather than a title. It is `work/next-run.ts`'s now, behind doors that each
 * demand a reason. `schedule_status` and the rest stay here: they are ordinary attributes,
 * and the ones that must move WITH a fire time ride along in that module's own statement.
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
  | 'anchor_local' | 'attempts'
  // UX-REPAIR round 2 T13: `work.tz` existed since migration 135 and was DEAD — absent from
  // this union, so no attribute write could name it, and absent from `scheduleRowColumns`, so
  // the scheduler never read it. The declared per-reminder zone contract was silently void and
  // every calendar-unit reminder resolved against the PROCESS timezone instead.
  | 'tz';
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
  // t118: the door's redaction. Applied to the PATCH, before `patchAssignments` reads it, so
  // every prose column a patcher names is scrubbed no matter which of the thirty-seven call
  // sites named it. A patch that names no prose column is passed through by reference.
  const { sets, values } = patchAssignments(scrubPatch(id, patch));
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
  // t118: `notes` is a prose column and this is its own door (the CASE-append shape cannot
  // go through `patchWork`), so the redaction is owed here too.
  entry = scrubText(rowAgents(id), entry);
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

/**
 * Delete a tracker row and its children. The dashboard's delete routes and the memory
 * route's cleanup both did this against the legacy tables; descendants BELOW the children are
 * detached rather than followed, so `parent_id`'s FK stays satisfiable and the blast radius
 * stays one level deep.
 *
 * ── WHY IT ROUTES THROUGH `work-refs.ts` (W2-B item C) ──
 * This swept two of the FOUR things that reference `work(id)` — `work_events` and
 * `adjudications` — and left `techniques.build_project_id` and the self-reference
 * `work.parent_id` alone. All four are `NO ACTION`, so the consequence was not a stranded row
 * but a RAISE: measured with `foreign_keys = ON`, deleting a project with a grandchild
 * occurrence, or one whose own row or whose child had built a technique, threw
 * `FOREIGN KEY constraint failed` and the whole delete failed in front of the user. The
 * grandchild half was patched at ONE of five callers (`gateway/routes/tracker.ts`'s project
 * route calls `deleteOccurrencesOf` first and its comment logs the deleter as the real
 * defect); the technique half was patched at none, and a technique is built BY a project, so
 * that reference is the normal case for the table.
 *
 * `clearReferencesToWork` is the tree's one list of the four, and `work-refs.ts`'s header
 * already records that three call sites had three different ideas of it. This was the third.
 *
 * ── WHY IT IS CALLED TWICE, AND IN THIS ORDER ──
 * The helper NULLS `work.parent_id` on everything pointing INTO the set it is given. Handing
 * it the children and the row together would null the children's own `parent_id` and the
 * `WHERE parent_id = ?` delete below would then match nothing. So: the children's family,
 * then the children; then the row's family, then the row. The first call is what releases the
 * GRANDCHILDREN, which is the shape that raised.
 */
export function deleteTrackerRow(id: string): number {
  const db = getDb();
  let changes = 0;
  withUnit(() => {
    const children = (db.prepare('SELECT id FROM work WHERE parent_id = ?').all(id) as
      Array<{ id: string }>).map(r => r.id);
    clearReferencesToWork(children);         // all four for the children — see `work-refs.ts`
    db.prepare('DELETE FROM work WHERE parent_id = ?').run(id);
    clearReferencesToWork([id]);             // all four for the row itself
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

// ════════════════════════════════════════════════════════════════════════════════════════
// t129 — THE BLOCKED-WORK DISPOSAL DOOR. (v3.3.2 blast run 4, clause P4; triage Lane D + S5)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT IT REFUSES ──
// A PRIMARY-role agent killed ANOTHER agent's PM-upheld blocked row with one
// `work_update(action="status", status="cancelled")` and got `isError: false`: the row went
// `abandoned`, still assigned to the victim, with `owner_rows_naming_it = 0`. The escalation
// ladder was not slow — it was PRE-EMPTED, because the row left `blocked` before any steer
// could be spent. The drive and the full clause list are in
// `tracker/__tests__/blocked-work-is-the-owners-to-dispose.test.ts`.
//
// ── THE RULE, DERIVED FROM THE STANDING OWNER RULING ──
// OR-PM-1v2: blocked/declined work *"is NOT reassignable by agents — it ESCALATES to the
// user."* Disposal is strictly worse than the reassignment that ruling fences: the work does
// not move, it VANISHES, and none of the three legitimate reasons it names (assignee
// gone/deactivated · multi-agent coordination · user-requested) covers "an agent decided to
// cancel it". THE DISPOSAL IS THE RULING THE ESCALATION EXISTS TO OBTAIN, so it belongs to the
// person the escalation is addressed to. Nothing new is decided here; the ruling is read.
//
// The triage left exactly one point open — *"whether a PM-upheld block should be un-disposable
// by ANY agent including the assignee until the owner rules"* — and the sentence above answers
// it. So the predicate has two independent legs:
//
//   * a BYSTANDER (an actor that is not the assignee) may never dispose of a blocked row; and
//   * NOBODY under a model's control may dispose of a PM-RULED one — the assignee included.
//
// An ORDINARY (unruled) block stays the assignee's to close out. The triage names that the
// normal path and run-4's P5 depends on it, so it is deliberately untouched.
//
// ── ⚠ WHY THE GATE IS IN THIS FUNCTION, AND NOT WHERE IT FIRST LANDED ──
// The first cut guarded `tracker/schema.ts`'s `setTaskStatus`/`setTaskStatusResult`. The
// review census found a model-driven path BELOW that: `agent/spawner.ts` computes
// `taskStatus = … : status === 'fallen' ? 'fallen' : …` and calls `setTrackerStatus` DIRECTLY
// with `by: 'agent'`, so `complete_task(status="fallen")` still disposed of a PM-ruled blocked
// row. Applying the same refusal at that site would have been a SECOND COPY of this
// predicate, which is the drift class this whole fix round is about. This function's own
// docstring already says what it is — *"The tracker's one status writer"* — so it is the one
// place every tracker status writer crosses, and the gate is unbypassable from here by
// construction rather than by enumeration. It is also still TRACKER-scoped, which was the
// original argument for not putting it in `transition()`: that is the one writer of
// `work.state` for every kind OR1 folded onto the table — asks, commitments, occurrences and
// T4's join pieces, which are `kind='task'` too — and this is a ruling about the tracker's
// two nouns only.
//
// ── TWO THINGS IT DELIBERATELY DOES NOT DO ──
//   1. IT DOES NOT TOUCH RESOLVING FORWARD. Only TERMINAL targets reach the predicate, so any
//      agent may still move a blocked row back to `in_progress`/`on_deck`/`paused` — that IS
//      the resolution the block is waiting for, and it stays recorded like any transition.
//   2. IT DOES NOT TOUCH `complete`. A `done` close is already two-key-fenced by
//      `transition()`'s G9, ACTOR-INDEPENDENTLY: Key 2 needs the owner's `authoritative` claim
//      or a SYSTEM_CLOSER, and no agent has either, so any agent's `complete` on a blocked row
//      can only FILE a Key-1 close request — `[FILED]`, a `validation_requested` event, and
//      the state does not move. If this gate swallowed `complete`, that recorded request —
//      the useful half — would stop being written. The discriminator is the spine's own:
//      terminal AND not `done`.
//
// Every AUTHORITATIVE door is unchanged by construction, because it carries
// `claim: 'authoritative'`: the owner's dashboard PUT, the owner's verdict, and the PM's six
// `work_validate` doors all pass it. `Actor` is a closed compiler-enforced union, so that is
// provable from the type rather than from a caller census.

/** The two disposals this gate is about: `cancelled`/`fallen` in the tracker's words. `done`
 *  is excluded on purpose — see note 2 above. */
const BLOCKED_DISPOSALS: ReadonlySet<TrackerStatus> = new Set<TrackerStatus>(['cancelled', 'fallen']);

/** Whose word a status change arrives under. An authority turns the key; `engine`, `healer`
 *  and `scheduler` are subsystems with their own fences (G6 makes the engine point at real
 *  evidence) and are not what this ruling is about. `agent` and `pm` are the two actors a
 *  MODEL drives, and the drive is theirs. */
const MODEL_DRIVEN: ReadonlySet<string> = new Set(['agent', 'pm']);

/**
 * The refusal, or `null` when this call is none of this gate's business.
 *
 * Returned rather than thrown, and in the same shape a `transition()` gate refuses in, so
 * every existing `if (!workSettled(r))` branch and `closeRefusalText`'s renderer read it with
 * no second code path.
 */
function blockedDisposalRefusal(
  id: string, status: TrackerStatus, input: SetStatusInput,
): (WorkOutcome & { kind: 'refused' }) | null {
  if (!BLOCKED_DISPOSALS.has(status)) return null;
  // ⚠ t130 — THE OWNER'S AUTHORITY, NOT ANY AUTHORITATIVE-SHAPED CLAIM.
  //
  // This read `input.claim === 'authoritative'` alone, and run 5 of the blast caught what that
  // let through: the acting PM calling, in its own turn, with its own authored reason,
  //
  //     work_validate { action: "override", approve: true, override_request_id: "…" }
  //     → "[OK] override approved. Task a3dee56a forced to \"cancelled\"."
  //
  // ~35 s after the probe armed, on a PM-UPHELD blocked row, three orders of magnitude inside
  // the 1200 s escalate floor. `tracker/tools.ts`'s override-approve door passes
  // `claim: 'authoritative'` under a comment that says out loud what it is for — *"Force the
  // status through (bypass engine hard gate)"* — so the claim was carrying TWO meanings and
  // this gate read only one:
  //
  //   · "a human authority has ruled"  — the owner's door, which this exemption is FOR; and
  //   · "the PM's override verb"       — a door a MODEL calls, whose stated purpose is
  //                                      bypassing engine hard gates.
  //
  // Under OR-PM-1v2 the second is the destruction the ruling forbids: a model-driven override
  // of a PM-upheld block, pre-escalation, is exactly the disposal that is supposed to reach
  // the owner instead. It is the run-4 hole again, wearing the one hat the gate was told to
  // trust — and t129's own §2 clause ("it is the claim that decides, not the name") was a
  // GREEN TEST holding it open. Right abstraction for the owner; wrong for a verb a model can
  // call. That clause is inverted now.
  //
  // BLAST RADIUS, verified door by door rather than inherited. Of the six `by:'pm'` +
  // authoritative callers, only override-approve can name a disposal on a blocked row:
  //   · reject-pause (`tools.ts:3733`), reject-close (`:4645`), reject-block (`:4796`) are
  //     confined by their own ALLOWED_TARGETS to in_progress/on_deck/blocked, and retask
  //     (`:3864`) to in_progress/on_deck — none is in `BLOCKED_DISPOSALS`;
  //   · the Key-2 close (`:4487`) targets `complete`, which this gate deliberately leaves to
  //     G9 (the triage's census of five did not name this one; it is unaffected for that
  //     reason);
  //   · the stale-A2A sweep (`pm-agent.ts:2545`) DOES target `fallen`, and is safe only
  //     because its candidate query reads `t.state = 'on_deck'` — it never sees a blocked row.
  //     Recorded because that is a property of its SELECT, not of this gate.
  //   · override-approve (`:4931`) takes `req.requestedStatus` unconstrained. That is the hole.
  // The OWNER's routes are untouched by construction: `gateway/routes/tracker.ts:452` and
  // `:734` pass `by: 'owner'`, and so does the dashboard's bulk close (`:890`), which is the
  // path that SHOULD dispose of these rows.
  //
  // ── AND THE EXEMPTION IS DELETED, NOT NARROWED. ──
  // The prescribed one-line fix was `claim === 'authoritative' && by === 'owner'`. Measured:
  // that line is DEAD CODE, and the mutant proved it — replacing it with `by === 'owner'`
  // alone changed no test and no behaviour, because `Actor` is a closed union
  // (`store.ts:61`: owner | pm | agent | engine | scheduler | healer), `MODEL_DRIVEN` is
  // {agent, pm}, and so every actor the narrowed clause would have exempted is ALREADY
  // exempted one line below by not being model-driven. Narrowing the claim check to the owner
  // is therefore exactly equivalent to removing it — and only `owner` and `pm` may asssert the
  // claim at all (`store.ts:AUTHORITIES`), with `pm` being the actor this fix exists to stop.
  //
  // So the rule is stated ONCE instead of twice: the gate is about actors a MODEL drives, and
  // an authoritative-shaped claim buys such an actor nothing. Keeping both guards would mean
  // two overlapping predicates for one fact, with the redundant one untestable — which is the
  // drift class this lane has already been sent back for twice. The owner's exemption now
  // rests on the single fact that the owner is not a model.
  if (!MODEL_DRIVEN.has(input.by)) return null;

  // ⚠ ONE QUESTION, ONE SOURCE. This used to be a hand-written `EXISTS` over `adjudications`
  // that omitted `validatedExpr`'s freshness clause, and the consequence was measured: a row
  // blocked -> upheld -> resolved forward -> blocked AGAIN on a fresh obstacle read as upheld
  // (gate said 1, `validatedExpr` said 0), so ONE upheld block marked the row for life and
  // refused the assignee's own ordinary close-out — breaking the very path this gate promises
  // to leave alone, and P5's dependency with it. `excludeSystemClosers` is the single declared
  // difference from the board's reading of the same rows; the argument for it is on
  // `validatedExpr` itself.
  const row = getDb().prepare(
    `SELECT w.agent_id AS agent_id, w.state AS state,
            ${validatedExpr('w', 'blocked', { excludeSystemClosers: true })} AS ruled
       FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
  ).get(id) as { agent_id: string; state: WorkState; ruled: number } | undefined;
  // Not a tracker task, or gone: `transition()`'s G1 owns both answers and says them better.
  if (!row || row.state !== 'blocked') return null;

  const actorId = input.actorId ?? input.by;
  const isAssignee = actorId === row.agent_id;
  const ruled = row.ruled === 1;

  if (isAssignee && !ruled) return null;   // the normal close-out path; P5 depends on it

  const why = ruled
    ? 'an authority has RULED on this block — the obstacle is confirmed real, '
      + `so the disposal is ${getOwnerName()}'s call, not an agent's`
    : "blocked work is not a bystander's to dispose of — it belongs to its assignee until "
      + `${getOwnerName()} rules otherwise`;

  return { kind: 'refused', workId: id, reason: 'blocked-disposal-not-the-actors', detail: why };
}


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

  // t129: the blocked-work disposal gate. HERE, and not one layer up in `tracker/schema.ts`,
  // because this function is "the tracker's one status writer" and that is the only place
  // every tracker status writer crosses — see the gate's own header below.
  const disposal = blockedDisposalRefusal(id, status, input);
  if (disposal) {
    logger.warn('blocked-work disposal refused', { workId: id, status, by: input.by, actorId: input.actorId });
    return disposal;
  }
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
  // SLOW-INFERENCE T79c: a genuine advance moves the effort baseline. `result.kind`
  // is `'applied'` ONLY when `transition()` actually moved `work.state` — never on a
  // refusal, and never on G4's "already in that state" no-op. That is what makes a
  // looping agent's same-status spam (the tool's own `[NO-OP] ... no change made`
  // text at `tracker/tools.ts`) unable to reset its own meter: `setTrackerStatus` is
  // this platform's ONE status writer for the tracker's two nouns (doc comment
  // above), so `work_update(action="status")`, `work_update(action="complete_step")`
  // and `work_update(action="close_project")` — and every PM validate/override path
  // — all clear this same gate. Rung AFTER `withUnit`, deliberately, the same reason
  // `transition()` itself rings its own post-transaction effects afterward: pure
  // bookkeeping must never be able to fail or roll back a state change that has
  // already been decided.
  if (result.kind === 'applied') {
    advanceBaseline(id);
  }
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
export function deliveryForAgentSince(
  agentId: string, sinceMs: number, notBeforeTurn?: number | null,
): string | null {
  const floor = notBeforeTurn ?? null;
  const r = getDb().prepare(
    `SELECT id FROM deliveries
      WHERE agent_id = ? AND outcome = 'delivered' AND tool <> 'engine-ack'
        AND CAST(strftime('%s', created_at) AS INTEGER) * 1000 >= ?
        AND (@floor IS NULL OR turn_number IS NULL OR turn_number >= @floor)
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(agentId, sinceMs, { floor }) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * The same question asked of a work row: its own agent, its own opening instant — AND NOT
 * BEFORE THE CLOSE REQUEST'S OWN TURN (UX-REPAIR round 2 T11).
 *
 * ── WHAT THE OLD WINDOW ADMITTED, measured (investigation-round2.md §2) ──
 * "The newest delivery by this agent since the task opened" spans every turn between. On S4
 * (2026-08-10) the task opened 06:11:11 and the close was filed 06:15:14, so the newest
 * delivery in the window was the 06:11:16 line *"On it — I've handed Squarespace to one helper
 * and WordPress to another"* — which became the task's recorded `result_delivery_id`. The
 * `tool <> 'engine-ack'` exclusion could not catch it: that ack was MODEL-authored on the
 * dashboard and is indistinguishable at the ledger from a real answer. The PM was then told to
 * dereference a pointer that named an acknowledgement.
 *
 * ── THE NARROWING, AND WHY IT IS THIS ONE ──
 * A close request is filed FROM a turn, so the turn is the boundary the ledger already
 * records: a delivery this agent made on an EARLIER turn is, by construction, not what this
 * close is reporting. Nothing else is removed — a delivery from the close's own turn (the
 * ordinary "answered then closed" shape, and G7's requirement) resolves exactly as before, a
 * LATER delivery still resolves, and a delivery with no turn stamp at all (1,372 of 14,810
 * rows on the live box: alerts, a2a hand-offs, owner-closes) is untouched, because "unknown
 * turn" is not "earlier turn". None → null, which is the true answer: nothing has delivered
 * this yet, and G7's refusal is the correct outcome rather than a false receipt.
 */
export function deliveryForTaskClose(workId: string): string | null {
  const w = getDb().prepare('SELECT agent_id, opened_at FROM work WHERE id = ?')
    .get(workId) as { agent_id: string; opened_at: number } | undefined;
  if (!w) return null;
  return deliveryForAgentSince(w.agent_id, w.opened_at, currentTurnNumber(w.agent_id) || null);
}

// ⟨TOMBSTONE⟩ `deliveryAboutWorkSince` lived here (t124): "has a person been told about THIS
// row since the first steer?", answered from the turn's recorded root (`ask` / `occurrence`).
// t142 replaced its only caller — the escalation sweep's `spokeSince` branch — with the told
// RECORD (`work/validation-drive.ts:recordPersonTold`, a `person_told` event keyed by the
// delivery that told the person), and t146 deleted it once nothing called it. Its `occurrence`
// edge was the over-credit t142 removed (any scheduled-run output retired an escalation).
// requirement preserved: unrelated chatter never retires an escalation, and an a2a / engine-ack
// / undelivered send never counts — asserted by the told record's own refusals in
// `work/__tests__/t142-a-person-was-told.test.ts` §5 and the driven arm in
// `work/__tests__/blocked-work-reaches-the-owner.test.ts` §2.

// ⟨TOMBSTONE⟩ `claimOccurrence` lived here and was D21's timestamp CAS: one UPDATE keyed on
// `next_run_at = ?`. It moved to `work/occurrences.ts` and CHANGED SHAPE in PHASE-2 T8c2
// item 4, because keying exactly-once on a clock was the defect, not the implementation:
// the caller could only obtain that clock through `msToText`, which drops milliseconds, so
// every schedule started from a real clock reading was permanently unclaimable. The claim is
// now the INSERT of a `work(kind='occurrence')` row, refused by `ux_work_occurrence` — a
// constraint, and durable, so a crashed fire cannot lose the occurrence either.
// requirement preserved: exactly-once, the claim token, advance-at-fire, and the unfired
// release — all four asserted in `work/__tests__/occurrences.test.ts`.

// ⟨TOMBSTONE⟩ `stopLiveSchedule` lived here. SWEEP CORE-2 item 3 moved it to
// `work/next-run.ts` as `clearLiveSchedule`, unchanged SQL, because it SETS `next_run_at` and
// that column now has exactly one writing module. Its one caller
// (`scheduler/runner.ts:terminateLiveScheduleOnFallen`) imports it from there.
// requirement preserved: `changes === 1` is still the token that says THIS caller won the
// race, which is what keeps two terminators from both announcing a termination — asserted in
// `scheduler/__tests__/fallen-terminates.test.ts`.

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
