// The tracker's writes onto `work`; `tracker-view.ts` is the read side. `work.state` moves only through
// `transition()` in `store.ts` (see `setTrackerStatus`); every write to `work`, `work_events` and
// `adjudications` lives under `work/`.

import { v4 as uuidv4 } from 'uuid';
import type { OutcomeRefused } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { patchAssignments } from '../db/patch.js';
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import { noSuchWorkDetail, type WorkPatchOutcome } from './outcome.js';
import { transition, appendWorkEvent, isTerminal, type Actor, type WorkOutcome, type WorkState } from './store.js';
import { statusToState, TRACKER_ROOT_KIND, SERVICE_ROOT_KIND, WORK_EVENT, type TrackerStatus } from './tracker-view.js';
import { takeoverRefusal, rowFacts, rehome, workerOfRecord } from './row-authority.js';
import { planJson, type Plan } from './plan-json.js';
import { isSystemServiceAgent, isPrimaryAgent } from '../config/platform.js';

const logger = createLogger('tracker-store');

const now = (): number => Date.now();


/** Every field must be passed (null allowed) so a writer that forgets lineage fails to compile. */
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
  plan?: Plan;   // stored as `plan_json`
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
  /** Defaults to `TRACKER_ROOT_KIND`; the engine's own floor passes `engine_scaffold`. */
  rootKind?: string;
  origin: TrackerOrigin;
}

/** The spine's `requester` enum (not `requester_id`): a literal 'user' creator is the owner, else an agent. */
const requesterOf = (createdBy: string): string => (createdBy === 'user' ? 'owner' : 'agent');

// Prose columns are redacted at the door so no caller owes the call. Redaction is keyed to the union of
// the row's agents (assignee, creator, current owner): redacting a value another agent handled is still
// correct, while keying to one agent and guessing wrong would leave it in the clear.

/** Every `TrackerAttr` that can carry prose; a test checks it against `TrackerAttr`, so a new text
 *  column must be classified here. */
export const CREDENTIAL_BEARING_WORK_TEXT = [
  'title', 'description', 'original_description', 'goal', 'notes',
  'result', 'evidence_json', 'hold_reason',
] as const satisfies readonly TrackerAttr[];

const BEARING = new Set<string>(CREDENTIAL_BEARING_WORK_TEXT);

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

/** The agents a row belongs to, read only when a patch names a prose column. */
function rowAgents(id: string): readonly (string | null)[] {
  try {
    const r = getDb().prepare(
      'SELECT agent_id, assignee_agent, requester_id FROM work WHERE id = ?',
    ).get(id) as { agent_id: string | null; assignee_agent: string | null; requester_id: string | null } | undefined;
    return r ? [r.agent_id, r.assignee_agent, r.requester_id] : [];
  } catch (err) {
    // A redaction that cannot resolve its agents must not fail the write; the patch goes unredacted.
    logger.warn('work text redaction could not resolve the row\'s agents; patch proceeds unredacted', {
      workId: id, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** The patch with prose columns redacted; the SAME object when it names none. */
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
      scrubText([p.createdBy], p.title), scrubMaybe([p.createdBy], p.description) ?? null,
      p.level ?? 1, p.groupId ?? null,
      p.origin.sourceMessageId, p.origin.turn, p.origin.convKey, p.origin.kind, at, at,
    );
    if (p.plan) db.prepare('UPDATE work SET plan_json = ? WHERE id = ?').run(planJson(p.plan, (t) => scrubText([p.createdBy], t)), id);   // the plan, scrubbed like every prose column
    appendWorkEvent(id, 'opened', p.createdBy, { kind: 'project', title: scrubText([p.createdBy], p.title), ...(p.plan ? { planned: true, steps: p.plan.steps.length } : {}) });
  });
  return id;
}

/** The source message of the ask the creating turn is serving, so the task links to its request.
 *  Only fills a gap: a caller-stated origin wins. */
function askSourceMessageForCreatingTurn(agentId: string): string | null {
  try {
    const turn = currentTurnNumber(agentId);
    if (!turn) return null;
    const r = getDb().prepare(
      `SELECT root_id FROM work
        WHERE kind = 'ask' AND agent_id = ? AND state = 'claimed' AND claimed_by_turn = ?
        ORDER BY opened_at DESC LIMIT 1`,
    ).get(agentId, turn) as { root_id: string } | undefined;
    return r?.root_id ?? null;
  } catch (err) {
    // A missing link must not fail task creation.
    logger.warn('task create: could not resolve the creating turn\'s ask; the task is opened without the edge', {
      agentId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A service agent's task opened by itself or by the engine is its own housekeeping, not board work. */
const opensAsHousekeeping = (worker: string, requester: string): boolean =>
  isSystemServiceAgent(worker) && (requester === worker || requester === 'engine');

export function openTrackerTask(p: OpenTrackerTaskInput): string {
  const db = getDb();
  const id = p.id ?? uuidv4();
  const at = now();
  const sourceMessageId = p.origin.sourceMessageId
    ?? askSourceMessageForCreatingTurn(p.assignedTo ?? p.createdBy);
  // `agent_id` is NOT NULL, so an unassigned task belongs to its creator until someone claims it.
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
      requesterOf(p.createdBy), p.createdBy,
      p.rootKind ?? (opensAsHousekeeping(p.assignedTo ?? p.createdBy, p.createdBy) ? SERVICE_ROOT_KIND : TRACKER_ROOT_KIND), id,
      statusToState(p.status ?? 'in_progress'),
      // Redacted at the door, keyed to the assignee and the creator.
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


/** Every `work` column a tracker writer may patch. `state`, `closed_at`, `result_delivery_id`,
 *  `claimed_by_turn`, `remaining_children`, `compile_pending` (`transition()`) and `next_run_at`
 *  (`work/next-run.ts`) are absent on purpose: naming one does not compile. */
export type TrackerAttr =
  | 'parent_id' | 'agent_id' | 'assignee_agent' | 'requester_id' | 'conversation_id'
  | 'title' | 'goal' | 'priority' | 'notes' | 'description' | 'original_description'
  | 'result' | 'evidence_json'
  | 'step_number' | 'total_steps' | 'phase' | 'depends_on' | 'assigned_to_group' | 'task_kind'
  | 'level' | 'phase_count' | 'current_phase' | 'group_id'
  | 'source_message_id' | 'origin_turn' | 'origin_conv_key' | 'origin_kind'
  | 'a2a_thread_id'
  | 'scheduled_start' | 'repeat_interval' | 'repeat_unit' | 'repeat_end_type'
  | 'repeat_end_value' | 'repeat_days_of_week' | 'schedule_status' | 'is_paused'
  | 'paused_until' | 'last_run_at'
  | 'anchor_local' | 'attempts' | 'hold_kind' | 'hold_reason' | 'hold_at'
  // `tz` is the per-reminder zone (see `scheduleRowColumns`); null means the box timezone.
  | 'tz';
// The stamp columns are gone: stamps are `work_events` rows of kind `activity` (see `stampTicket`).

export type WorkPatch = Partial<Record<TrackerAttr, unknown>>;

/**
 * Patch a work row's attribute columns: `undefined` leaves a column alone, `null` clears it. `updated_at`
 * moves unless `touch: false` (the PM ladder reads it as when the work last moved). After a non-empty
 * patch `changes === 0` means no row matched, so it refuses with no-such-work.
 */
export function patchWork(id: string, patch: WorkPatch, opts?: { touch?: boolean }): WorkPatchOutcome {
  // Prose columns are redacted first; a patch naming none passes through by reference.
  const { sets, values } = patchAssignments(scrubPatch(id, patch));
  // An empty patch changes nothing, so `updated_at` stays put; it is `no_change` unless the row is missing.
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

/** The same patch for every row matching ONE column; kept narrow so it never becomes a SQL door. */
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

/** Incremented in SQL, never assigned, so two racing fires cannot lose a count. */
export function bumpWorkAttempts(id: string): number {
  return getDb().prepare('UPDATE work SET attempts = attempts + 1, updated_at = ? WHERE id = ?')
    .run(now(), id).changes;
}

/** Detach children without deleting them (the memory route's "unfile these tasks"). */
export function detachChildren(parentId: string): number {
  return getDb().prepare('UPDATE work SET parent_id = NULL, updated_at = ? WHERE parent_id = ?')
    .run(now(), parentId).changes;
}


export interface SetStatusInput {
  by: Actor;
  actorId?: string | null;
  reason: string;
  evidenceRef?: string | null;
  resultDeliveryId?: string | null;
  expectedState?: WorkState;
  claimedByTurn?: number | null;
  note?: string | null;
  userQuote?: string | null;   // the owner's words for acting on another live agent's work; checked, never trusted
}

/** The tracker's one status writer: `transition()` with the tracker's words (a hold is `work/done/hold.ts`). */
export function setTrackerStatus(
  id: string, status: TrackerStatus, input: SetStatusInput,
): WorkOutcome {
  const to = statusToState(status);

  // Another live agent's work is not reopened or moved on an agent's say-so.
  const disposal = takeoverRefusal(id, to, input);
  if (disposal) {
    logger.warn(`status change refused (${disposal.reason})`, { workId: id, status, by: input.by, actorId: input.actorId });
    return disposal;
  }
  const result = transition(id, {
    to,
    by: input.by,
    reason: input.reason,
    evidenceRef: input.evidenceRef ?? null,
    resultDeliveryId: input.resultDeliveryId ?? null,
    expectedState: input.expectedState,
    claimedByTurn: input.claimedByTurn ?? null,
    note: input.note ?? null,
    actorId: input.actorId ?? undefined,
  });
  // Reopened work its holder ended on goes to the main agent that reopened it, else to the worker of record.
  const f = result.kind === 'applied' && isTerminal(result.value.from) && !isTerminal(to) ? rowFacts(id) : null;
  if (f && !f.holderLive) rehome(id, f.holder, input.actorId && isPrimaryAgent(input.actorId) ? input.actorId : workerOfRecord(f.holder), 'reopen');
  return result;
}

/** The delivery a project's completion points at: the newest one its completed children closed against.
 *  Null when none exists, and the caller then gets a refusal rather than a manufactured receipt. */
export function deliveryForCompletedChildren(projectId: string): string | null {
  const r = getDb().prepare(
    `SELECT result_delivery_id AS id FROM work
      WHERE parent_id = ? AND state = 'done' AND result_delivery_id IS NOT NULL
      ORDER BY closed_at DESC LIMIT 1`,
  ).get(projectId) as { id: string } | undefined;
  return r?.id ?? null;
}


/** The turn-finalize stamp: one `activity` event per task, never touching `updated_at` (the drive
 *  ladder's idle clock). `stampColumns` in `tracker-view.ts` reads each fact back off the log. */
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

/** `validation_escalated_at` + `validation_thread_id`, as one event. */
export function recordValidationEscalation(id: string, actorId: string, threadId: string | null): void {
  appendWorkEvent(id, WORK_EVENT.validationEscalated, actorId, { thread_id: threadId });
}

