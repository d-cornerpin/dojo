// The tracker's data access layer: every statement reads and writes `work`. `TaskRow` / `ProjectRow` map to the
// shared `Task` / `Project` types the dashboard board renders. The translation (vocabulary, time form, column
// names, which `work` rows are the tracker's) lives in `work/tracker-view.ts` and the writes in
// `work/tracker-store.ts`; this file composes them. A status change goes through `transition()`, never a patch.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { isDashboardHiddenAgent, isPMAgent } from '../config/platform.js';
import {
  taskRowColumns, projectRowColumns, taskScope, projectScope, dueScope,
  statusToState, tsToMs, msToText, revertCountExpr, type TrackerStatus,
} from '../work/tracker-view.js';
import { TERMINAL_STATE_NAMES } from '../work/terminal-states.js';
import { TOLD, DISMISSED, stallKey } from '../healer/owner-notices.js';
import {
  openTrackerProject, openTrackerTask, patchWork,
  setTrackerStatus, type WorkPatch, type SetStatusInput,
} from '../work/tracker-store.js';
import { workSettled, noteUnsettled, findObligationByTypedId, type Actor } from '../work/store.js';
import { writeAssignee } from '../work/row-authority.js';
import { isTerminalName } from '../work/terminal-states.js';
import { decide } from '../work/done/decide.js';
import type { Project, ProjectDetail, Task } from '@dojo/shared';
import type { Plan } from '../work/plan.js';
import { heldExpr, workingExpr } from '../work/done/hold.js';
import { latestHandIn } from '../work/done/record.js';
import { proofLines } from '../work/done/proof.js';

const logger = createLogger('tracker-schema');


interface ProjectRow {
  id: string;
  title: string;
  description: string | null;
  level: number;
  status: string;
  created_by: string;
  phase_count: number;
  current_phase: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TaskRow {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  status: string;
  assigned_to: string | null;
  created_by: string;
  priority: string;
  step_number: number | null;
  total_steps: number | null;
  phase: number;
  depends_on: string;
  notes: string | null;
  scheduled_start: string | null;
  repeat_interval: number | null;
  repeat_unit: string | null;
  repeat_end_type: string | null;
  repeat_end_value: string | null;
  repeat_days_of_week: string | null;
  anchor_time: string | null;
  next_run_at: string | null;
  run_count: number;
  is_paused: number;
  paused_until: string | null;
  hold_kind: 'paused' | 'blocked' | null;
  hold_reason: string | null;
  last_run_at: string | null;
  schedule_status: string;
  assigned_to_group: string | null;
  kind: string | null;
  created_at: string;
  updated_at: string;
  last_moved_at: string;
  worker_id: string | null;
  completed_at: string | null;
  goal: string | null;
  result: string | null;
  evidence_json: string | null;
}

/** The two projections, built once: the one place the row shape is spelled. */
const TASK_COLS = taskRowColumns();      // names the table literally (see tracker-view.ts)
const PROJECT_COLS = projectRowColumns();
const TASK_WHERE = taskScope('work');
const PROJECT_WHERE = projectScope('work');


function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    level: row.level,
    status: row.status as Project['status'],
    createdBy: row.created_by,
    phaseCount: row.phase_count,
    currentPhase: row.current_phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** The assignee's name, and whether the worker the ladder drives is gone (missing or terminated), from one lookup. */
function assigneeOf(agentId: string | null, workerId: string | null): { name: string | null; gone: boolean } {
  try {
    const rows = getDb().prepare('SELECT id, name, status FROM agents WHERE id IN (?, ?)')
      .all(agentId, workerId) as Array<{ id: string; name: string; status: string }>;
    const worker = rows.find((r) => r.id === workerId);
    return { name: agentId && (rows.find((r) => r.id === agentId)?.name ?? agentId), gone: !!workerId && (!worker || worker.status === 'terminated') };
  } catch {
    return { name: agentId, gone: false };
  }
}

function mapTaskRow(row: TaskRow): Task {
  let dependsOn: string[] = [];
  try {
    dependsOn = JSON.parse(row.depends_on) as string[];
  } catch {
    dependsOn = [];
  }

  const assignee = assigneeOf(row.assigned_to, row.worker_id);
  const handIn = row.status === 'handed_in' ? latestHandIn(row.id) : null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as Task['status'],
    hold: row.hold_kind ?? null,
    holdReason: row.hold_reason ?? null,
    assignedTo: row.assigned_to,
    assignedToName: assignee.name,
    assigneeGone: assignee.gone,
    createdBy: row.created_by,
    priority: row.priority as Task['priority'],
    stepNumber: row.step_number,
    totalSteps: row.total_steps,
    phase: row.phase,
    dependsOn,
    notes: row.notes,
    scheduledStart: row.scheduled_start ?? null,
    repeatInterval: row.repeat_interval ?? null,
    repeatUnit: row.repeat_unit ?? null,
    repeatEndType: row.repeat_end_type ?? 'never',
    repeatEndValue: row.repeat_end_value ?? null,
    repeatDaysOfWeek: row.repeat_days_of_week ?? null,
    anchorTime: row.anchor_time ?? null,
    nextRunAt: row.next_run_at ?? null,
    runCount: row.run_count ?? 0,
    isPaused: Boolean(row.is_paused),
    pausedUntil: row.paused_until ?? null,
    scheduleStatus: row.schedule_status ?? 'unscheduled',
    assignedToGroup: row.assigned_to_group ?? null,
    kind: row.kind ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMovedAt: row.last_moved_at,
    completedAt: row.completed_at,
    goal: row.goal ?? null,
    result: row.result ?? null,
    evidence: parseEvidence(row.evidence_json),
    handIn: handIn ? { outcome: handIn.outcome, note: handIn.note, proof: proofLines(handIn.items) } : null,
  };
}

function parseEvidence(raw: string | null): Task['evidence'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Task['evidence']) : [];
  } catch {
    return [];
  }
}


export function createProject(params: {
  title: string;
  description?: string; plan?: Plan;
  level: number;
  createdBy: string;
  // Applied to the project row AND inherited by its inline tasks (see createTask).
  origin: { kind: string | null; sourceMessageId: string | null; turn: number | null; convKey: string | null };
  tasks?: Array<{
    title: string;
    description?: string;
    assignedTo?: string;
    priority?: 'high' | 'normal' | 'low';
    stepNumber?: number;
    dependsOn?: string[];
    phase?: number;
  }>;
}): { projectId: string; taskIds: string[] } {
  const db = getDb();
  const projectId = uuidv4();
  const taskIds: string[] = [];

  const { title, description, level, createdBy, tasks } = params;

  // One transaction for the project row AND its inline tasks: a failed task insert (e.g. an FK reject on
  // assigned_to) must not strand an empty project. Broadcasts fire after commit, so a rollback announces nothing.
  db.transaction(() => {
    openTrackerProject({
      id: projectId, title, description: description ?? null, level, createdBy,
      origin: params.origin, plan: params.plan,
    });

    if (tasks && tasks.length > 0) {
      const totalSteps = tasks.length;

      for (const task of tasks) {
        const taskId = uuidv4();
        taskIds.push(taskId);

        // All subtasks land in 'in_progress': 'on_deck' is reserved for work scheduled for later, so the assigned
        // agent and the PM keep seeing it. original_description is an immutable copy of the user's original ask.
        openTrackerTask({
          id: taskId,
          projectId,
          title: task.title,
          description: task.description ?? null,
          originalDescription: task.description ?? null,
          status: 'in_progress',
          assignedTo: task.assignedTo ?? createdBy,
          createdBy,
          priority: task.priority ?? 'normal',
          stepNumber: task.stepNumber ?? null,
          totalSteps,
          phase: task.phase ?? 1,
          dependsOn: task.dependsOn ?? [],
          origin: params.origin,
        });
      }
    }
  })();

  // Post-commit broadcasts (the rows are real now).
  for (const taskId of taskIds) {
    const createdTask = getTask(taskId);
    if (createdTask) {
      broadcast({
        type: 'tracker:task_updated',
        data: createdTask,
      });
    }
  }

  logger.info('Project created', { projectId, title, taskCount: taskIds.length }, createdBy);

  const project = getProject(projectId);
  if (project) {
    broadcast({
      type: 'tracker:project_updated',
      data: project,
    });
  }

  return { projectId, taskIds };
}

export function getProject(id: string): ProjectDetail | null {
  const db = getDb();

  const row = db.prepare(
    `${PROJECT_COLS} WHERE ${PROJECT_WHERE} AND work.id = ?`,
  ).get(id) as ProjectRow | undefined;
  if (!row) return null;

  const project = mapProjectRow(row);

  const taskRows = db.prepare(
    `${TASK_COLS} WHERE ${TASK_WHERE} AND work.parent_id = ?
      ORDER BY work.step_number ASC, work.opened_at ASC`,
  ).all(id) as TaskRow[];
  const tasks = taskRows.map(mapTaskRow);

  const taskCounts = {
    pending: 0,
    inProgress: 0,
    handedIn: 0,
    sentBack: 0,
    complete: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const task of tasks) {
    switch (task.status) {
      case 'on_deck': taskCounts.pending++; break;
      case 'in_progress': taskCounts.inProgress++; break;
      case 'handed_in': taskCounts.handedIn++; break;
      case 'sent_back': taskCounts.sentBack++; break;
      case 'complete': taskCounts.complete++; break;
      case 'fallen': taskCounts.failed++; break;
      case 'cancelled': taskCounts.cancelled++; break;
    }
    if (task.hold === 'blocked') taskCounts.blocked++;
  }

  return { ...project, tasks, taskCounts };
}

export function listProjects(filter?: { status?: string }): Project[] {
  const db = getDb();

  let sql = `${PROJECT_COLS} WHERE ${PROJECT_WHERE}`;
  const params: unknown[] = [];

  if (filter?.status) {
    sql += ' AND work.state = ?';
    params.push(statusToState(filter.status));
  }

  sql += ' ORDER BY work.updated_at DESC';

  const rows = db.prepare(sql).all(...params) as ProjectRow[];
  return rows.map(mapProjectRow);
}

/**
 * The owner closes a project from the dashboard: his decision (`work/done/decide.ts`, owner_done or
 * cancel) closes its still-open tasks with it. Returns counts and every row that did not close.
 */
export function closeProjectAndOpenTasks(params: {
  projectId: string;
  taskStatus: 'complete' | 'cancelled';
  reason: string;
}): { projectId: string; tasksClosed: number; alreadyClosed: number; refused: number; unsettled: Array<{ workId: string; text: string }>; projectClosed: boolean } {
  const { projectId, reason } = params;
  const verdict = params.taskStatus === 'cancelled' ? 'cancel' : 'owner_done';
  const tasks = getDb()
    .prepare(`SELECT work.id AS id, work.state AS state FROM work WHERE ${TASK_WHERE} AND work.parent_id = ?`)
    .all(projectId) as Array<{ id: string; state: string }>;
  const alreadyClosed = tasks.filter((t) => isTerminalName(t.state)).length;
  // The decision closes the project's open tasks with it; a project its tasks already settled is closed.
  const settled = isTerminalName((getDb().prepare('SELECT state FROM work WHERE id = ?').get(projectId) as { state: string } | undefined)?.state ?? '');
  const pr = settled ? null : decide({ workId: projectId, deciderAgentId: null, verdict, reason });
  const unsettled = pr?.kind === 'refused' ? [{ workId: projectId, text: pr.text }]
    : (pr?.unclosed ?? []).map((workId) => ({ workId, text: 'did not close with its project' }));
  const tasksClosed = pr?.kind === 'decided' ? tasks.length - alreadyClosed - pr.unclosed.length : 0;
  logger.info('Project bulk-closed by the owner', { projectId, tasksClosed, alreadyClosed, refused: unsettled.length, verdict });

  for (const t of tasks) {
    const updated = getTask(t.id);
    if (updated) {
      broadcast({ type: 'tracker:task_updated', data: updated });
    }
  }
  const project = getProject(projectId);
  if (project) {
    broadcast({ type: 'tracker:project_updated', data: project });
  }

  return { projectId, tasksClosed, alreadyClosed, refused: unsettled.length, unsettled, projectClosed: settled || pr?.kind === 'decided' };
}

export function updateProject(
  id: string,
  updates: Partial<{ status: string; currentPhase: number; title: string; description: string | null }>,
  actor?: { by: Actor; actorId?: string; reason?: string; resultDeliveryId?: string | null },
): void {
  const patch: WorkPatch = {};
  if (updates.currentPhase !== undefined) patch.current_phase = updates.currentPhase;
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;

  if (updates.status !== undefined) {
    const r = setTrackerStatus(id, updates.status as TrackerStatus, {
      by: actor?.by ?? 'agent',
      actorId: actor?.actorId ?? null,
      reason: actor?.reason ?? `project status -> ${updates.status}`,
      resultDeliveryId: actor?.resultDeliveryId ?? null,
    });
    if (!workSettled(r)) {
      logger.warn('project status change refused', { projectId: id, result: r });
    }
  }
  if (Object.keys(patch).length > 0) noteUnsettled(patchWork(id, patch), 'updateProject: project attributes patched', { taskId: id });

  logger.info('Project updated', { projectId: id, updates });

  const project = getProject(id);
  if (project) {
    broadcast({
      type: 'tracker:project_updated',
      data: project,
    });
  }
}


export function createTask(params: {
  projectId?: string;
  title: string;
  description?: string;
  assignedTo?: string;
  createdBy: string;
  priority?: 'high' | 'normal' | 'low';
  stepNumber?: number;
  dependsOn?: string[];
  phase?: number;
  kind?: string;
  /** The goal rides the INSERT, so the row is announced complete rather than patched after the broadcast. */
  goal?: string | null;
  // REQUIRED so every creation path states its origin: a null value is allowed, omitting the param is a compile error.
  origin: { kind: string | null; sourceMessageId: string | null; turn: number | null; convKey: string | null };
}): string {
  const { projectId, title, description, assignedTo, createdBy, priority, stepNumber, dependsOn, phase, kind, goal } = params;

  // 'on_deck' is reserved for tasks with a future scheduled_start (the scheduler moves them to 'in_progress'
  // at fire time). createTask takes no schedule: the trackerCreateTask wrapper applies it after this insert.
  const taskId = openTrackerTask({
    projectId: projectId ?? null,
    title,
    description: description ?? null,
    // An immutable copy of the user's original ask, kept when the description is later edited.
    originalDescription: description ?? null,
    status: 'in_progress',
    assignedTo: assignedTo ?? null,
    createdBy,
    goal: goal ?? null,
    priority: priority ?? 'normal',
    stepNumber: stepNumber ?? null,
    phase: phase ?? 1,
    dependsOn: dependsOn ?? [],
    taskKind: kind ?? null,
    origin: params.origin,
  });

  logger.info('Task created', { taskId, title, projectId, assignedTo }, createdBy);

  const task = getTask(taskId);
  if (task) {
    broadcast({
      type: 'tracker:task_updated',
      data: task,
    });
  }

  return taskId;
}

/**
 * Re-announce a row that a creation door settled after `createTask` broadcast it (a future `scheduled_start`,
 * `setNextRun`, a later goal patch): neither `setTrackerStatus` nor `setNextRun` broadcasts, since they are
 * work-store writers inside transactions. A no-op when `announced` (the view the creation frame carried)
 * already equals the stored row, so an unscheduled creation emits exactly ONE frame.
 * @returns true when a correcting frame was sent.
 */
export function broadcastTaskSettled(taskId: string, announced: Task | null): boolean {
  const settled = getTask(taskId);
  if (!settled) return false;
  if (announced && JSON.stringify(announced) === JSON.stringify(settled)) return false;
  broadcast({ type: 'tracker:task_updated', data: settled });
  return true;
}

/**
 * Engine-driven task creation for A2A ASSIGN intent (called from deliverA2AMessage), so the assignment is
 * tracked from the handoff with no LLM cooperation. A later ASSIGN on the same thread is a clarification:
 * it returns the existing task id. Null only on a hard DB error; the message itself still delivers.
 */
export function autoCreateAssignTask(params: {
  senderId: string;
  receiverId: string;
  payload: string;
  threadId: string;
  // The id of the ASSIGN message row that births this task (its lineage origin).
  assignMessageId?: string | null;
  taskId?: string | null;
}): { taskId: string; isNew: boolean } | null {
  const db = getDb();
  try {
    // Never auto-create rows for system agents (PM/Healer/Dreamer): they own no user-facing work, and a task
    // assigned to the PM would be invisible to the user yet keep firing PM validation loops. The message still delivers.
    if (isDashboardHiddenAgent(params.receiverId)) {
      logger.info('autoCreateAssignTask skipped, receiver is a system agent', {
        receiverId: params.receiverId, senderId: params.senderId, threadId: params.threadId,
      }, params.senderId);
      return null;
    }

    // Never auto-create when the SENDER is the PM: its remediation re-opens the existing task (work_validate
    // retask/override/validate), and a forked task duplicates the work and any non-idempotent side effect.
    // The ASSIGN still delivers and wakes the receiver.
    if (isPMAgent(params.senderId)) {
      logger.info('autoCreateAssignTask skipped, sender is PM (remediation should use work_validate(action="retask"))', {
        senderId: params.senderId, receiverId: params.receiverId, threadId: params.threadId,
      }, params.senderId);
      return null;
    }

    // A transfer's task rides its job's ASSIGN and takes its thread; one that has a thread by then is not taken.
    if (params.taskId && db.prepare('UPDATE work SET a2a_thread_id = ?, updated_at = ? WHERE id = ? AND a2a_thread_id IS NULL')
      .run(params.threadId, Date.now(), params.taskId).changes === 1) return { taskId: params.taskId, isNew: true };

    // Reuse if a task already exists for this thread.
    const existing = db
      .prepare(`SELECT work.id AS id FROM work WHERE ${TASK_WHERE} AND work.a2a_thread_id = ? LIMIT 1`)
      .get(params.threadId) as { id: string } | undefined;
    if (existing?.id) {
      return { taskId: existing.id, isNew: false };
    }

    // Title: first sentence (or first 80 chars) of the payload, cleaned up.
    const cleaned = params.payload.trim();
    const sentenceEnd = cleaned.search(/[.!?\n]/);
    const rawTitle = sentenceEnd > 0 && sentenceEnd <= 100
      ? cleaned.slice(0, sentenceEnd).trim()
      : cleaned.slice(0, 80).trim();
    const title = rawTitle.length > 0 ? rawTitle : 'Assigned task (untitled)';

    // The payload IS the sender's stated definition of done, so it is the goal. ASSIGN tasks land in
    // 'in_progress' so the receiver and the PM keep seeing them.
    const taskId = openTrackerTask({
      title,
      description: params.payload,
      originalDescription: params.payload,
      goal: params.payload.trim().slice(0, 2000) || title,
      status: 'in_progress',
      assignedTo: params.receiverId,
      createdBy: params.senderId,
      priority: 'normal',
      phase: 1,
      dependsOn: [],
      a2aThreadId: params.threadId,
      origin: {
        kind: 'a2a_assign',
        sourceMessageId: params.assignMessageId ?? null,
        turn: null,
        convKey: 'a2a:' + params.threadId,
      },
    });

    logger.info('Auto-created task for A2A ASSIGN', {
      taskId, threadId: params.threadId, senderId: params.senderId, receiverId: params.receiverId, title,
    }, params.senderId);

    const task = getTask(taskId);
    if (task) {
      broadcast({ type: 'tracker:task_updated', data: task });
    }

    return { taskId, isNew: true };
  } catch (err) {
    logger.warn('autoCreateAssignTask failed, proceeding without auto-task', {
      threadId: params.threadId, error: err instanceof Error ? err.message : String(err),
    }, params.senderId);
    return null;
  }
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare(
    `${TASK_COLS} WHERE ${TASK_WHERE} AND work.id = ?`,
  ).get(id) as TaskRow | undefined;
  if (!row) return null;
  return mapTaskRow(row);
}

// Resolvers accept a full UUID or a >=4-char prefix (list tools show ids truncated to 8 chars) and return a
// discriminated result, so callers can say not_found vs ambiguous vs too short precisely.

export type IdResolution =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: 'empty' | 'too_short' | 'not_found' | 'ambiguous';
      matches?: string[];
      /** True when the TITLE fallback also ran and found nothing, so the message never claims a lookup that did
       *  not happen. Only meaningful on `not_found`. */
      triedTitle?: boolean;
      /** The typed id is this agent's own open promise (`findObligationByTypedId`), not a task. */
      promise?: boolean;
    };

function resolveIdIn(kind: 'task' | 'project', idOrPrefix: string, agentId?: string): IdResolution {
  if (!idOrPrefix || typeof idOrPrefix !== 'string') {
    return { ok: false, reason: 'empty' };
  }
  const input = idOrPrefix.trim();
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (input.length < 4) return { ok: false, reason: 'too_short' };

  const db = getDb();
  const scope = kind === 'task' ? TASK_WHERE : PROJECT_WHERE;

  if (input.length >= 32) {
    const row = db.prepare(`SELECT work.id AS id FROM work WHERE ${scope} AND work.id = ?`)
      .get(input) as { id: string } | undefined;
    if (row) return { ok: true, id: row.id };
    // Fall through to prefix match, the "full" id may be malformed
  }

  // Prefix match. Limit to 5 so we can detect ambiguity cheaply.
  const matches = db.prepare(`SELECT work.id AS id FROM work WHERE ${scope} AND work.id LIKE ? LIMIT 5`)
    .all(`${input}%`) as Array<{ id: string }>;

  if (matches.length === 1) return { ok: true, id: matches[0].id };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches: matches.map(m => m.id) };

  // A weak model often passes the human-readable TITLE where an id is expected, so when the id/prefix search
  // found nothing, resolve the string as a TITLE scoped to THIS agent's own rows (needs an `agentId`). It stays
  // even though a dead id can then match a live row's title: hard-failing a title-shaped argument sent the PM
  // into a retry loop on the same string (pinned in `__tests__/id-resolution-and-the-title-fallback.test.ts`).
  // Ask rows (kind='ask') sit outside TASK_WHERE/PROJECT_WHERE by construction. The refusal says the title
  // was tried too (`triedTitle`), so a model learns both routes failed.
  if (agentId) {
    const byTitle = resolveByTitleScoped(kind, input, agentId);
    if (byTitle) return byTitle;
    return { ok: false, reason: 'not_found', triedTitle: true, promise: kind === 'task' && !!findObligationByTypedId(agentId, input) };
  }
  return { ok: false, reason: 'not_found', triedTitle: false };
}

/** Resolve an id argument that is really a TITLE, scoped to the caller's own rows (tasks: assigned_to OR
 *  created_by; projects: created_by): exact case-insensitive match first, then prefix. Returns ok on one hit,
 *  ambiguous on several, null on none. */
function resolveByTitleScoped(kind: 'task' | 'project', title: string, agentId: string): IdResolution | null {
  const db = getDb();
  const scope = kind === 'task' ? TASK_WHERE : PROJECT_WHERE;
  const scopeSql = kind === 'task' ? '(work.agent_id = ? OR work.requester_id = ?)' : 'work.requester_id = ?';
  const scopeParams = kind === 'task' ? [agentId, agentId] : [agentId];

  let rows = db.prepare(
    `SELECT work.id AS id FROM work WHERE ${scope} AND lower(work.title) = lower(?) AND ${scopeSql} LIMIT 5`,
  ).all(title, ...scopeParams) as Array<{ id: string }>;

  // Prefix, for trailing wording drift, only if exact found nothing. Escape
  // LIKE wildcards in the model-supplied title so they match literally.
  if (rows.length === 0) {
    const escaped = title.replace(/[\\%_]/g, '\\$&');
    rows = db.prepare(
      `SELECT work.id AS id FROM work WHERE ${scope} AND work.title LIKE ? ESCAPE '\\' AND ${scopeSql} LIMIT 5`,
    ).all(`${escaped}%`, ...scopeParams) as Array<{ id: string }>;
  }

  if (rows.length === 1) return { ok: true, id: rows[0].id };
  if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows.map(r => r.id) };
  return null;
}

/** Resolve a task id from a full UUID, ≥4-char prefix, or (with agentId) a title. */
export function resolveTaskId(idOrPrefix: string, agentId?: string): IdResolution {
  return resolveIdIn('task', idOrPrefix, agentId);
}

export function resolveProjectId(idOrPrefix: string, agentId?: string): IdResolution {
  return resolveIdIn('project', idOrPrefix, agentId);
}

/** Format a resolver failure as an error string for an agent tool response (call only on failures). */
export function formatResolveError(
  kind: 'task' | 'project',
  input: string,
  resolution: Exclude<IdResolution, { ok: true }>,
): string {
  const Kind = kind === 'task' ? 'Task' : 'Project';
  switch (resolution.reason) {
    case 'empty':
      return `Error: ${kind} id is required.`;
    case 'too_short':
      return `Error: ${kind} id '${input}' is too short. Provide at least 4 characters of the id (8-char prefixes from work_open/work_update listings work fine).`;
    case 'not_found': {
      // An `ask:` / `piece:ask:` id from the OPEN WORK block is a request, or a piece of one,
      // not a task: no task verb takes it, and none closes it. Say what it is, not "not found".
      if (kind === 'task' && /^(piece:)?ask:/.test(input.trim())) {
        const what = input.trim().startsWith('piece:') ? 'a piece of a request' : 'a request';
        return `Error: '${input}' is ${what} from the person who asked, not a task, so no task call takes it. It ends when you answer them; reply with your normal message.`;
      }
      // The agent's own open promise closes through the promise ledger, not a task verb.
      if (resolution.promise) {
        return `Error: '${input}' is a promise you made, not a task, so no task call takes it. Close it with work_close_request(action='commitment', id, disposition='kept' or 'dropped').`;
      }
      // A title-shaped input gets an explicit title-vs-id correction, or the floor model retries the same
      // title forever. Title resolution is scoped to the CALLER's own tasks.
      const titleShaped = /\s/.test(input.trim());
      const titleHint = titleShaped
        ? ` That looks like a TITLE, not an id: pass the id (or its first 8 characters) shown in [brackets] by the listing.`
        : '';
      // When the title fallback ALSO ran and found nothing, say so: otherwise the model retries the same title.
      const triedTitle = resolution.triedTitle
        ? ` It was looked up as an id and no ${kind} of yours matches it as a title either, so a different spelling will not help.`
        : '';
      return `Error: ${Kind} not found: '${input}'.${titleHint}${triedTitle} It may have been deleted or completed. Use work_update(action='list') to see current ${kind}s.`;
    }
    case 'ambiguous': {
      const shown = (resolution.matches ?? []).map(m => m.slice(0, 12)).join(', ');
      return `Error: ${kind} id prefix '${input}' matches multiple ${kind}s. Use a longer prefix or the full id. Candidates: ${shown}`;
    }
  }
}

export interface TaskListFilter {
  status?: string;
  assignedTo?: string;
  priority?: string;
  projectId?: string;
  /** Restrict to the overdue set (`dueScope()` declares what the word means). */
  overdue?: boolean;
}

/** The WHERE of a task list, shared by the whole list and the paged one (one filter, one meaning). */
function taskListWhere(filter?: TaskListFilter): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [TASK_WHERE];
  const params: unknown[] = [];

  // Ordered before the optional filters so the `?` this fragment emits binds first.
  if (filter?.overdue) {
    conditions.push(dueScope('work'));
    params.push(Date.now());
  }
  if (filter?.status === 'paused' || filter?.status === 'blocked') {
    conditions.push(heldExpr('work', filter.status));   // a hold, not a state
  } else if (filter?.status === 'in_progress') {
    conditions.push(workingExpr('work'));   // Working: claimed or sent back
  } else if (filter?.status) {
    conditions.push('work.state = ?');
    params.push(statusToState(filter.status));
  }
  if (filter?.assignedTo) {
    conditions.push('work.agent_id = ?');
    params.push(filter.assignedTo);
  }
  if (filter?.priority) {
    conditions.push('work.priority = ?');
    params.push(filter.priority);
  }
  if (filter?.projectId) {
    conditions.push('work.parent_id = ?');
    params.push(filter.projectId);
  }
  return { conditions, params };
}

// `priority` is TEXT, so ORDER BY priority DESC would list high-priority work last: ranked explicitly.
const TASK_LIST_ORDER = " ORDER BY CASE work.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,"
  + ' work.step_number ASC, work.opened_at ASC';

export function listTasks(filter?: TaskListFilter): Task[] {
  const { conditions, params } = taskListWhere(filter);
  const sql = `${TASK_COLS} WHERE ${conditions.join(' AND ')}${TASK_LIST_ORDER}`;
  const rows = getDb().prepare(sql).all(...params) as TaskRow[];
  return rows.map(mapTaskRow);
}

/** The finished tasks a board page holds: the chat history's own page (the dashboard's existing
 *  "load older" pattern). A display page, not a cap on what is kept or what can be read. */
export const TASK_CLOSED_PAGE = 50;

/**
 * The board's list, PAGED. Live tasks (not finished) come whole; finished ones come newest-closed first, one
 * page at a time. `before` is the cursor of the oldest finished task held (its closed time as listed, and its
 * id for ties); with a cursor only the page before it is returned. `closedHasOlder` says a further page exists.
 */
export function listTasksPage(
  filter: TaskListFilter | undefined,
  page: { before?: { at: string; id: string }; hideAgentIds?: ReadonlySet<string> } = {},
): { tasks: Task[]; closedHasOlder: boolean } {
  const db = getDb();
  const { conditions, params } = taskListWhere(filter);
  // System agents' tasks are dropped HERE, before the page is cut: dropped after, a page made only of them
  // reached the board empty and its cursor never moved. One that was sent back, or that a standing owner card
  // names, stays visible for the owner.
  const hidden = [...(page.hideAgentIds ?? [])];
  if (hidden.length > 0) {
    const marks = hidden.map(() => '?').join(', ');
    conditions.push(`((COALESCE(work.requester_id, '') NOT IN (${marks}) AND (COALESCE(work.agent_id, '') NOT IN (${marks}) OR ${revertCountExpr('work')} > 0))
      OR EXISTS (SELECT 1 FROM healer_state c WHERE c.scope = ? AND c.key = ? || work.id
        AND NOT EXISTS (SELECT 1 FROM healer_state d WHERE d.scope = ? AND d.key = c.key)))`);
    params.push(...hidden, ...hidden, TOLD, stallKey(''), DISMISSED);
  }
  const terminal = `work.state IN (${TERMINAL_STATE_NAMES.map((st) => `'${st}'`).join(', ')})`;
  const open = page.before ? [] : (db.prepare(`${TASK_COLS} WHERE ${[...conditions, `NOT ${terminal}`].join(' AND ')}${TASK_LIST_ORDER}`).all(...params) as TaskRow[]);
  // The order and the cursor share ONE key: the closed time as the caller sees it (`completedAt`, to the
  // second), then the id; ordering by ms while comparing at the second let same-second closes straddle a page edge.
  const closedAt = msToText('work.closed_at');
  const cursor = page.before ? [`(${closedAt} < ? OR (${closedAt} = ? AND work.id < ?))`] : [];
  const cursorParams = page.before ? [page.before.at, page.before.at, page.before.id] : [];
  const closed = db.prepare(`${TASK_COLS} WHERE ${[...conditions, terminal, ...cursor].join(' AND ')} ORDER BY ${closedAt} DESC, work.id DESC LIMIT ?`).all(...params, ...cursorParams, TASK_CLOSED_PAGE + 1) as TaskRow[];
  return { tasks: [...open, ...closed.slice(0, TASK_CLOSED_PAGE)].map(mapTaskRow), closedHasOlder: closed.length > TASK_CLOSED_PAGE };
}

/** Patch a task's editable columns. Status is not one of them: a status change goes through `setTaskStatusResult`,
 *  which is `transition()` and says who and why. */
export function updateTask(id: string, updates: Partial<{
  assignedTo: string | null;
  priority: string;
  notes: string;
  title: string;
  description: string | null;
  // Editable structural fields, so work_update(action="edit") can change them without delete+recreate; none has
  // notification or scheduler side effects.
  dependsOn: string[];
  stepNumber: number | null;
  phase: number | null;
  scheduledStart: string | null;
  repeatInterval: number | null;
  repeatUnit: string | null;
  repeatEndType: string | null;
  repeatEndValue: string | null;
  repeatDaysOfWeek: string | null;
  anchorTime: string | null;
}>): Task | null {
  const patch: WorkPatch = {};
  // The assignee half is written by `writeAssignee` (`work/row-authority.ts`), the one writer of the assignee
  // columns. The only caller passing `assignedTo` is the OWNER's dashboard PUT (`gateway/routes/tracker.ts`, which
  // records the reassignment itself); the model doors move work only through `moveAssignee`.
  let assigneeWritten = false;
  if (updates.assignedTo !== undefined) {
    const changed = writeAssignee(id, updates.assignedTo === null ? { clear: true } : { agentId: updates.assignedTo });
    if (changed === 0) {
      logger.warn('updateTask: assignee not applied (no such work)', { taskId: id });
      return null;
    }
    assigneeWritten = true;
  }
  if (updates.priority !== undefined) patch.priority = updates.priority;
  if (updates.notes !== undefined) patch.notes = updates.notes;
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.dependsOn !== undefined) patch.depends_on = JSON.stringify(updates.dependsOn);
  if (updates.stepNumber !== undefined) patch.step_number = updates.stepNumber;
  if (updates.phase !== undefined) patch.phase = updates.phase;
  if (updates.scheduledStart !== undefined) patch.scheduled_start = tsToMs(updates.scheduledStart);
  if (updates.repeatInterval !== undefined) patch.repeat_interval = updates.repeatInterval;
  if (updates.repeatUnit !== undefined) patch.repeat_unit = updates.repeatUnit;
  if (updates.repeatEndType !== undefined) patch.repeat_end_type = updates.repeatEndType;
  if (updates.repeatEndValue !== undefined) patch.repeat_end_value = updates.repeatEndValue;
  if (updates.repeatDaysOfWeek !== undefined) patch.repeat_days_of_week = updates.repeatDaysOfWeek;
  if (updates.anchorTime !== undefined) patch.anchor_local = updates.anchorTime;

  const patched = assigneeWritten && Object.keys(patch).length === 0
    ? { kind: 'applied' as const, value: 1 }
    : patchWork(id, patch);
  if (patched.kind !== 'applied') {
    // The door refused or had nothing to do: generally a race (task deleted between resolve and update) or a
    // caller that bypassed `resolveTaskId()`. The log names which; the null is the same for both.
    logger.warn(`updateTask: patch not applied (${patched.reason})`, { taskId: id, detail: patched.detail });
    return null;
  }

  logger.info('Task updated', { taskId: id, updates });

  const task = getTask(id);
  if (!task) {
    logger.warn('updateTask: task deleted between UPDATE and SELECT (race)', { taskId: id });
    return null;
  }

  broadcast({
    type: 'tracker:task_updated',
    data: task,
  });

  return task;
}

/**
 * Change a task's status: THE tracker's status door, `transition()` with the tracker's vocabulary outside and
 * the spine's inside. Hands the caller the gate's own verdict so it can be steered on.
 */
export function setTaskStatusResult(id: string, status: TrackerStatus, input: SetStatusInput) {
  const r = setTrackerStatus(id, status, input);
  const task = getTask(id);
  if (task) broadcast({ type: 'tracker:task_updated', data: task });
  return { result: r, task };
}

// The blocked-work disposal gate lives in `work/tracker-store.ts` on `setTrackerStatus`, the one status writer:
// model-driven paths below these doors (`agent/spawner.ts` calls it directly) would bypass a guard placed here.
