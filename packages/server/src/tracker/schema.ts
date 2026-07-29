// The tracker's data access layer.
//
// PHASE-2 T8b: every statement in this file now reads and writes `work`. The row SHAPES
// below are unchanged on purpose — `TaskRow` / `ProjectRow` are what `mapTaskRow` /
// `mapProjectRow` turn into the shared `Task` / `Project` types the dashboard board renders,
// so the storage moved and the contract did not. The translation (vocabulary, time form,
// column names, which `work` rows are the tracker's) lives in ONE place,
// `work/tracker-view.ts`, and the writes in `work/tracker-store.ts`; this file composes them.
//
// What was deleted here rather than moved: `updateTask()`'s status branch. It was PINNED
// §13's "route R2" — a generic column patcher that applied NO gate to a state change, with
// eleven call sites. Status now goes through `transition()` like every other state change on
// the spine, and the attribute half stays a patch.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { writeTaskLog } from './task-log.js';
import { isDashboardHiddenAgent, isPMAgent } from '../config/platform.js';
import {
  taskRowColumns, projectRowColumns, taskScope, projectScope,
  statusToState, type TrackerStatus,
} from '../work/tracker-view.js';
import {
  openTrackerProject, openTrackerTask, patchWork, appendWorkNotes,
  setTrackerStatus, type WorkPatch, type SetStatusInput,
} from '../work/tracker-store.js';
import type { Actor } from '../work/store.js';
import type { Project, ProjectDetail, Task, PokeEntry } from '@dojo/shared';

const logger = createLogger('tracker-schema');

// ── Row Types ──

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
  status_before_pause: string | null;
  last_run_at: string | null;
  schedule_status: string;
  assigned_to_group: string | null;
  kind: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  pause_validated: number;
  complete_validated: number;
  blocked_validated: number;
  validation_escalated_at: string | null;
  goal: string | null;
  result: string | null;
  evidence_json: string | null;
}

interface PokeRow {
  id: string;
  task_id: string;
  agent_id: string;
  poke_number: number;
  poke_type: string;
  sent_at: string;
  response_received: number;
}

/** The two projections, built once. Interpolating a constant fragment rather than re-typing
 *  the column list at each call site is what keeps "the row shape" one fact. */
const TASK_COLS = taskRowColumns();      // names the table literally — see tracker-view.ts
const PROJECT_COLS = projectRowColumns();
const TASK_WHERE = taskScope('work');
const PROJECT_WHERE = projectScope('work');

// ── Row Mappers ──

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

function resolveAgentName(agentId: string | null): string | null {
  if (!agentId) return null;
  try {
    const db = getDb();
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    return agent?.name ?? agentId;
  } catch {
    return agentId;
  }
}

function mapTaskRow(row: TaskRow): Task {
  let dependsOn: string[] = [];
  try {
    dependsOn = JSON.parse(row.depends_on) as string[];
  } catch {
    dependsOn = [];
  }

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as Task['status'],
    assignedTo: row.assigned_to,
    assignedToName: resolveAgentName(row.assigned_to),
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
    statusBeforePause: row.status_before_pause ?? null,
    scheduleStatus: row.schedule_status ?? 'unscheduled',
    assignedToGroup: row.assigned_to_group ?? null,
    kind: row.kind ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    pauseValidated: (row.pause_validated ? 1 : 0) as 0 | 1,
    completeValidated: (row.complete_validated ? 1 : 0) as 0 | 1,
    blockedValidated: (row.blocked_validated ? 1 : 0) as 0 | 1,
    validationEscalatedAt: row.validation_escalated_at ?? null,
    goal: row.goal ?? null,
    result: row.result ?? null,
    evidence: parseEvidence(row.evidence_json),
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

function mapPokeRow(row: PokeRow): PokeEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    pokeNumber: row.poke_number,
    pokeType: row.poke_type as PokeEntry['pokeType'],
    sentAt: row.sent_at,
    responseReceived: row.response_received === 1,
  };
}

// ── Project CRUD ──

export function createProject(params: {
  title: string;
  description?: string;
  level: number;
  createdBy: string;
  // P1 lineage spine: see createTask. Applied to the project row AND inherited
  // by its inline tasks.
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

  // One transaction for the project row AND its inline tasks: a failed task
  // insert (e.g. an FK reject on assigned_to) must not strand an empty
  // project (2026-07-17 run bmrpkqai2v6: two orphan zero-task projects from
  // exactly that; the PM had no row to poke and the model "reused" an empty
  // shell). Broadcasts fire after commit so a rollback never announces
  // phantom rows.
  db.transaction(() => {
    openTrackerProject({
      id: projectId, title, description: description ?? null, level, createdBy,
      origin: params.origin,
    });

    if (tasks && tasks.length > 0) {
      const totalSteps = tasks.length;

      for (const task of tasks) {
        const taskId = uuidv4();
        taskIds.push(taskId);

        // Status default: all subtasks land in 'in_progress'. The previous
        // model (only the first-step task assigned to the creator started
        // in_progress, everything else 'on_deck') routinely produced the
        // failure mode where the agent finished the first task and then
        // never returned to the on_deck pile, those tasks went unseen
        // forever. New rule: 'on_deck' is reserved for "scheduled for
        // later". A task with no future scheduled_start belongs in
        // 'in_progress' so the assigned agent (and the PM) keep seeing it
        // as work to do.
        //
        // Phase 7: original_description is an immutable copy of the user's
        // original ask. Mirrors the standalone createTask path. Without it the
        // onTaskComplete hook surfaces "(none recorded)" to the parent.
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
    complete: 0,
    blocked: 0,
    failed: 0,
    paused: 0,
  };

  for (const task of tasks) {
    switch (task.status) {
      case 'on_deck': taskCounts.pending++; break;
      case 'in_progress': taskCounts.inProgress++; break;
      case 'complete': taskCounts.complete++; break;
      case 'blocked': taskCounts.blocked++; break;
      case 'fallen': taskCounts.failed++; break;
      case 'paused': taskCounts.paused++; break;
    }
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
 * Bulk-close a project AND every still-open task on it. "Open" = anything
 * not already in a terminal state (complete/fallen). Tasks get the chosen
 * status and a note explaining who closed them and why. The project itself
 * moves to the matching terminal status.
 *
 * Returns counts so callers can render a useful result string.
 */
export function closeProjectAndOpenTasks(params: {
  projectId: string;
  closingAgentId: string;
  /** User-facing intent: did the work actually finish, or are we abandoning it? */
  taskStatus: 'complete' | 'cancelled';
  projectStatus: 'complete' | 'cancelled';
  reason: string;
  /** The delivery that makes a `complete` close true. `transition()`'s G7 refuses `done`
   *  without one — see the note on `refused` below. */
  resultDeliveryId?: string | null;
}): { projectId: string; tasksClosed: number; alreadyClosed: number; refused: number } {
  const db = getDb();
  const { projectId, closingAgentId, taskStatus, projectStatus, reason } = params;

  // Kanban DB-status mapping. The board only renders the six legacy task
  // statuses (on_deck/in_progress/paused/complete/blocked/fallen); storing
  // a literal "cancelled" on a task would make it disappear from the board.
  // So a user-facing "cancelled" task is stored as "fallen" (the existing
  // "didn't make it" terminal column) with a clear note. The project row
  // itself stores the literal user-facing status, it isn't column-rendered.
  const dbTaskStatus: TrackerStatus = taskStatus === 'cancelled' ? 'fallen' : 'complete';
  const noteMarker = taskStatus === 'cancelled' ? '[CANCELLED]' : '[Completed via bulk close]';

  const tasks = db
    .prepare(`SELECT work.id AS id, work.state AS state FROM work WHERE ${TASK_WHERE} AND work.parent_id = ?`)
    .all(projectId) as Array<{ id: string; state: string }>;

  let tasksClosed = 0;
  let alreadyClosed = 0;
  let refused = 0;
  const TERMINAL = new Set(['done', 'failed', 'abandoned']);

  const closedTransitions: Array<{ taskId: string; from: string; to: string }> = [];
  const txn = db.transaction(() => {
    for (const t of tasks) {
      if (TERMINAL.has(t.state)) {
        alreadyClosed++;
        continue;
      }
      const r = setTrackerStatus(t.id, dbTaskStatus, {
        by: 'agent', actorId: closingAgentId,
        reason: `bulk-closed with its project: ${reason}`,
        resultDeliveryId: params.resultDeliveryId ?? null,
      });
      if (r.kind !== 'applied') {
        // The gate refused (almost always G7: a `complete` close with no delivery to point
        // at). Counted and surfaced rather than swallowed — a silent skip here is how the
        // board and the truth drift apart.
        refused++;
        logger.warn('bulk close refused for task', { taskId: t.id, result: r });
        continue;
      }
      closedTransitions.push({ taskId: t.id, from: r.from, to: r.to });
      tasksClosed++;
    }
    const pr = setTrackerStatus(projectId, projectStatus as TrackerStatus, {
      by: 'agent', actorId: closingAgentId, reason,
      resultDeliveryId: params.resultDeliveryId ?? null,
    });
    if (pr.kind !== 'applied') {
      refused++;
      logger.warn('bulk close refused for project', { projectId, result: pr });
    }
  });
  txn();

  // Write the task_log entries OUTSIDE the closing transaction so a single
  // failure to write a log row never rolls back the actual status changes.
  // The log writer is best-effort by design (see task-log.ts).
  for (const tx of closedTransitions) {
    void writeTaskLog({
      taskId: tx.taskId,
      fromEntity: `agent:${closingAgentId}`,
      entryKind: 'transition',
      fromStatus: tx.from,
      toStatus: tx.to,
      actionTaken: `bulk-closed via tracker_close_project (${noteMarker})`,
      reason,
    });
  }

  logger.info('Project bulk-closed', { projectId, tasksClosed, alreadyClosed, refused, taskStatus, projectStatus, closingAgentId });

  // Broadcast updated tasks + project so the dashboard repaints.
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

  return { projectId, tasksClosed, alreadyClosed, refused };
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
    if (r.kind !== 'applied' && r.kind !== 'noop') {
      logger.warn('project status change refused', { projectId: id, result: r });
    }
  }
  if (Object.keys(patch).length > 0) patchWork(id, patch);

  logger.info('Project updated', { projectId: id, updates });

  const project = getProject(id);
  if (project) {
    broadcast({
      type: 'tracker:project_updated',
      data: project,
    });
  }
}

// ── Task CRUD ──

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
  // P1 lineage spine (migration 112): REQUIRED so every creation path states
  // its origin deliberately. Values may be null (legacy/no-turn contexts), the
  // PARAM may not be omitted: a new writer that forgets lineage fails to
  // compile instead of silently minting origin-less work.
  origin: { kind: string | null; sourceMessageId: string | null; turn: number | null; convKey: string | null };
}): string {
  const { projectId, title, description, assignedTo, createdBy, priority, stepNumber, dependsOn, phase, kind } = params;

  // v2.8.x rule: 'on_deck' is reserved for tasks with a future
  // scheduled_start (the scheduler owns the transition to 'in_progress'
  // at fire time). Tasks with no schedule belong in 'in_progress' so
  // they stay visible to the assigned agent and the PM. createTask
  // doesn't take scheduled_start directly; the trackerCreateTask
  // wrapper applies the schedule override after this insert.
  const taskId = openTrackerTask({
    projectId: projectId ?? null,
    title,
    description: description ?? null,
    // original_description is an immutable copy of the user's original ask.
    // Phase 7 onTaskComplete uses it to surface the original intent to the
    // parent agent at completion time even if the description was edited.
    originalDescription: description ?? null,
    status: 'in_progress',
    assignedTo: assignedTo ?? null,
    createdBy,
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
 * Engine-driven task creation for A2A ASSIGN intent.
 *
 * Called from deliverA2AMessage when an agent's send_to_agent uses
 * intent=ASSIGN. Auto-creates a tracker task on behalf of the sender so
 * the assignment is structurally tracked from the moment of the handoff
 *, no LLM cooperation required.
 *
 * If a task already exists for this thread (later ASSIGNs on the same
 * thread are treated as clarifications, not new assignments), returns
 * the existing task ID instead of creating a duplicate.
 *
 * Returns null only on hard DB error so callers can fall back gracefully
 *, the message itself still gets delivered even if the auto-task fails.
 */
export function autoCreateAssignTask(params: {
  senderId: string;
  receiverId: string;
  payload: string;
  threadId: string;
  // P1 lineage spine: the id of the ASSIGN message row that births this task
  // (the one origin key this path always had in hand and never stored).
  assignMessageId?: string | null;
}): { taskId: string; isNew: boolean } | null {
  const db = getDb();
  try {
    // v2.9.22, never auto-create tracker rows for system agents
    // (PM/Healer/Dreamer). Their roles are meta and they don't own
    // user-facing work tasks. ASSIGN to a system agent is still a
    // valid wake-the-agent signal; the message delivers, just no
    // tracker row is created. Pre-fix, every ASSIGN to PM (typical
    // close-out escalation pattern) auto-created a task assigned
    // to PM, which then became invisible to the user but kept
    // firing PM validation loops (production incident 2026-06-07).
    if (isDashboardHiddenAgent(params.receiverId)) {
      logger.info('autoCreateAssignTask skipped, receiver is a system agent', {
        receiverId: params.receiverId, senderId: params.senderId, threadId: params.threadId,
      }, params.senderId);
      return null;
    }

    // v2.10.2, never auto-create tracker rows when the SENDER is the
    // PM agent. PM's remediation flow is supposed to re-open the
    // existing task via tracker_retask (or close it via tracker_override
    // / tracker_validate), NOT fork a new task. Pre-fix, PM
    // sending send_to_agent(intent='ASSIGN') to remediate a close-out
    // miss spawned a duplicate task and left the original abandoned,
    // producing two tasks for one unit of work and, for non-idempotent
    // tools (gmail_send, sms_send, voice_call, exec hitting live APIs),
    // a duplicate side effect. Production incident 2026-06-08: Email
    // 08 (Mariana Vázquez task) duplicated when PM rerouted the primary agent
    // after an auto-pause. The ASSIGN message itself still delivers
    // and wakes the receiver; just no fork.
    if (isPMAgent(params.senderId)) {
      logger.info('autoCreateAssignTask skipped, sender is PM (remediation should use tracker_retask)', {
        senderId: params.senderId, receiverId: params.receiverId, threadId: params.threadId,
      }, params.senderId);
      return null;
    }

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

    // Phase B.1: goal is required on every task. For engine-auto-created
    // ASSIGN tasks we use the payload itself as the goal, it IS the
    // sender's stated definition of done for the receiver.
    // v2.8.x rule: auto-created ASSIGN tasks land in 'in_progress' so the
    // receiver and the PM keep seeing them as work to do.
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

// ── ID prefix resolution ──
//
// The tracker list tools display task/project ids truncated to 8 chars
// (see tracker/tools.ts, `t.id.slice(0, 8)`). Agents naturally copy that
// prefix back when calling update/pause/etc. tools, but the underlying
// DB rows have full UUID primary keys, so a WHERE id = 'aaa73e0e' lookup
// returns nothing even when the task exists. This caused a loop where
// the agent couldn't act on any task it saw in the list.
//
// These resolvers accept either a full UUID or a ≥4-char prefix and
// return a discriminated result so callers can surface precise errors
// to the agent (not_found vs ambiguous vs too short) instead of the
// generic "Task was deleted while being updated" that the runtime was
// synthesizing from a null updateTask() return.

export type IdResolution =
  | { ok: true; id: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'not_found' | 'ambiguous'; matches?: string[] };

function resolveIdIn(kind: 'task' | 'project', idOrPrefix: string, agentId?: string): IdResolution {
  if (!idOrPrefix || typeof idOrPrefix !== 'string') {
    return { ok: false, reason: 'empty' };
  }
  const input = idOrPrefix.trim();
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (input.length < 4) return { ok: false, reason: 'too_short' };

  const db = getDb();
  const scope = kind === 'task' ? TASK_WHERE : PROJECT_WHERE;

  // Full UUID form (with or without dashes), try direct lookup first.
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

  // Correctness-floor: the weak model routinely passes the human-readable
  // TITLE it saw in a tracker_list_active row where an id is expected
  // ("Mechanical Keyboards Research"). Rather than hard-fail with not_found,
  // fall back to resolving that string as a TITLE scoped to THIS agent's own
  // task/project before erroring. Only runs when the id/prefix search found
  // nothing, so it never competes with a real id and only helps a wrong-shape
  // arg do the right thing. Requires an agentId to scope; unscoped callers
  // (no agentId) keep the original id-only behavior.
  if (agentId) {
    const byTitle = resolveByTitleScoped(kind, input, agentId);
    if (byTitle) return byTitle;
  }
  return { ok: false, reason: 'not_found' };
}

/**
 * Resolve an id argument that turned out to be a TITLE, scoped to the calling
 * agent's own rows (tasks: assigned_to OR created_by; projects: created_by).
 * Tries an exact case-insensitive title match first, then a prefix match for
 * light wording drift. Returns ok on a single hit, ambiguous on several, or
 * null when nothing matched (caller then emits the normal not_found).
 */
function resolveByTitleScoped(kind: 'task' | 'project', title: string, agentId: string): IdResolution | null {
  const db = getDb();
  const scope = kind === 'task' ? TASK_WHERE : PROJECT_WHERE;
  const scopeSql = kind === 'task' ? '(work.agent_id = ? OR work.requester_id = ?)' : 'work.requester_id = ?';
  const scopeParams = kind === 'task' ? [agentId, agentId] : [agentId];

  // Exact, case-insensitive.
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

/** Resolve a project id from a full UUID, ≥4-char prefix, or (with agentId) a title. */
export function resolveProjectId(idOrPrefix: string, agentId?: string): IdResolution {
  return resolveIdIn('project', idOrPrefix, agentId);
}

/**
 * Format a resolver failure as a clear error string for an agent tool
 * response. Callers should check `ok` first and only call this on
 * failures.
 */
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
      // 2026-07-17 (the PM 189-call spin): a title-shaped input deserves an
      // explicit title-vs-id correction, or the floor model retries the same
      // title forever. Title resolution is also scoped to the CALLER's own
      // tasks, so a cross-agent title can list-match yet not resolve here.
      const titleShaped = /\s/.test(input.trim());
      const titleHint = titleShaped
        ? ` That looks like a TITLE, not an id: pass the id (or its first 8 characters) shown in [brackets] by the listing.`
        : '';
      return `Error: ${Kind} not found: '${input}'.${titleHint} It may have been deleted or completed. Use work_update(action='list') to see current ${kind}s.`;
    }
    case 'ambiguous': {
      const shown = (resolution.matches ?? []).map(m => m.slice(0, 12)).join(', ');
      return `Error: ${kind} id prefix '${input}' matches multiple ${kind}s. Use a longer prefix or the full id. Candidates: ${shown}`;
    }
  }
}

export function listTasks(filter?: {
  status?: string;
  assignedTo?: string;
  priority?: string;
  projectId?: string;
}): Task[] {
  const db = getDb();

  const conditions: string[] = [TASK_WHERE];
  const params: unknown[] = [];

  if (filter?.status) {
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

  const sql = `${TASK_COLS} WHERE ${conditions.join(' AND ')}`
    + ' ORDER BY work.priority DESC, work.step_number ASC, work.opened_at ASC';

  const rows = db.prepare(sql).all(...params) as TaskRow[];
  return rows.map(mapTaskRow);
}

/**
 * Patch a task's editable columns.
 *
 * PHASE-2 T8b: the `status` argument is GONE. It was PINNED §13's route R2 — a state change
 * with no gate, no reason, no event and no actor, sitting beside `transition()`. Callers that
 * want a status change call `setTaskStatus` below, which is `transition()` and says who and
 * why. This function now does exactly what its name says: it patches columns.
 */
export function updateTask(id: string, updates: Partial<{
  assignedTo: string | null;
  priority: string;
  notes: string;
  title: string;
  description: string | null;
  pausedUntil: string | null;
  // Editable structural fields, added so tracker_edit_task can change them
  // without forcing a delete+recreate. None of these have notification or
  // scheduler side-effects that the simpler tools (update_status, pause)
  // already cover, so it's safe to update them in the generic edit path.
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
  if (updates.assignedTo !== undefined) patch.agent_id = updates.assignedTo;
  if (updates.priority !== undefined) patch.priority = updates.priority;
  if (updates.notes !== undefined) patch.notes = updates.notes;
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.pausedUntil !== undefined) patch.paused_until = tsToMsOrNull(updates.pausedUntil);
  if (updates.dependsOn !== undefined) patch.depends_on = JSON.stringify(updates.dependsOn);
  if (updates.stepNumber !== undefined) patch.step_number = updates.stepNumber;
  if (updates.phase !== undefined) patch.phase = updates.phase;
  if (updates.scheduledStart !== undefined) patch.scheduled_start = tsToMsOrNull(updates.scheduledStart);
  if (updates.repeatInterval !== undefined) patch.repeat_interval = updates.repeatInterval;
  if (updates.repeatUnit !== undefined) patch.repeat_unit = updates.repeatUnit;
  if (updates.repeatEndType !== undefined) patch.repeat_end_type = updates.repeatEndType;
  if (updates.repeatEndValue !== undefined) patch.repeat_end_value = updates.repeatEndValue;
  if (updates.repeatDaysOfWeek !== undefined) patch.repeat_days_of_week = updates.repeatDaysOfWeek;
  if (updates.anchorTime !== undefined) patch.anchor_local = updates.anchorTime;

  const changes = patchWork(id, patch);
  if (changes === 0) {
    // UPDATE matched zero rows, the id doesn't exist. Callers that pass
    // the result through tracker tools should have already resolved the
    // id via resolveTaskId() before calling updateTask(), so hitting this
    // path generally means a race (task deleted between resolve and
    // update) or a caller that bypassed the resolver.
    logger.warn('updateTask: UPDATE affected zero rows (task id does not exist)', { taskId: id });
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
 * Change a task's status. THE tracker's status door: `transition()` with the tracker's
 * vocabulary on the outside and the spine's on the inside.
 *
 * Returns the refreshed `Task` on success and `null` when the gate refused — and the refusal
 * is logged with its gate name, because "the status did not change and nobody said why" is
 * the exact silence this phase is removing. Callers that need to tell the model WHY use
 * `setTaskStatusResult`.
 */
export function setTaskStatus(id: string, status: TrackerStatus, input: SetStatusInput): Task | null {
  const r = setTrackerStatus(id, status, input);
  if (r.kind !== 'applied' && r.kind !== 'noop') {
    logger.warn('task status change refused', { taskId: id, status, result: r });
    return null;
  }
  const task = getTask(id);
  if (task) broadcast({ type: 'tracker:task_updated', data: task });
  return task;
}

/** The same call, handing the caller the gate's own verdict so it can be steered on. */
export function setTaskStatusResult(id: string, status: TrackerStatus, input: SetStatusInput) {
  const r = setTrackerStatus(id, status, input);
  const task = getTask(id);
  if (task) broadcast({ type: 'tracker:task_updated', data: task });
  return { result: r, task };
}

/** SQLite-form TEXT -> epoch ms, for the two legacy TEXT instants `updateTask` still takes
 *  from its callers (the tool arguments are ISO strings the model wrote). */
function tsToMsOrNull(text: string | null): number | null {
  if (text == null || text === '') return null;
  const ms = Date.parse(/[TZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function addTaskNotes(id: string, notes: string): void {
  const timestamp = new Date().toISOString();
  appendWorkNotes(id, `[${timestamp}] ${notes}`);
  logger.info('Task notes added', { taskId: id, notesLength: notes.length });
}

/**
 * Replace the entire notes field on a task with the provided content.
 * Use when the existing notes are wrong or stale and need to be
 * rewritten wholesale. For appending without losing prior entries use
 * addTaskNotes instead.
 */
export function setTaskNotes(id: string, notes: string): void {
  patchWork(id, { notes });
  logger.info('Task notes replaced', { taskId: id, notesLength: notes.length });
}

/**
 * Wipe the notes field on a task back to NULL. Use when the existing
 * notes are obsolete and no replacement content is appropriate.
 */
export function clearTaskNotes(id: string): void {
  patchWork(id, { notes: null });
  logger.info('Task notes cleared', { taskId: id });
}

// ── Poke Log ──

export function logPoke(taskId: string, agentId: string, pokeNumber: number, pokeType: string): string {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO poke_log (id, task_id, agent_id, poke_number, poke_type, sent_at, response_received)
    VALUES (?, ?, ?, ?, ?, datetime('now'), 0)
  `).run(id, taskId, agentId, pokeNumber, pokeType);

  logger.info('Poke logged', { pokeId: id, taskId, agentId, pokeNumber, pokeType });

  broadcast({
    type: 'tracker:poke',
    data: { taskId, agentId, pokeType },
  });

  return id;
}

export function getPokeLog(taskId: string): PokeEntry[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM poke_log WHERE task_id = ? ORDER BY poke_number ASC').all(taskId) as PokeRow[];
  return rows.map(mapPokeRow);
}

export function getLastPoke(taskId: string): PokeEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM poke_log WHERE task_id = ? ORDER BY poke_number DESC LIMIT 1').get(taskId) as PokeRow | undefined;
  if (!row) return null;
  return mapPokeRow(row);
}

/**
 * Clear the poke log for a task. INVARIANT: this is the DELETE that re-arms
 * the escalation ladder. Call it ONLY at a remediation event (reassign,
 * retask, auto-reset), never mid-cycle. Each remediation starts a genuinely
 * new escalation cycle, so wiping the rows here is what lets the deterministic
 * ladder start fresh from nudge(1) the next time the task stalls. Because
 * nothing else clears these rows, the cross-restart poke dedup (never re-send
 * the same poke within a cycle) stays intact.
 */
export function clearPokeLog(taskId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM poke_log WHERE task_id = ?').run(taskId);
  logger.info('Poke log cleared (remediation, new escalation cycle)', { taskId });
}
