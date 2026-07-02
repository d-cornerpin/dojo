import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { writeTaskLog } from './task-log.js';
import { isDashboardHiddenAgent, isPMAgent } from '../config/platform.js';
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

  db.prepare(`
    INSERT INTO projects (id, title, description, level, status, created_by, phase_count, current_phase, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, 1, 1, datetime('now'), datetime('now'))
  `).run(projectId, title, description ?? null, level, createdBy);

  if (tasks && tasks.length > 0) {
    const totalSteps = tasks.length;

    for (const task of tasks) {
      const taskId = uuidv4();
      taskIds.push(taskId);

      const assignee = task.assignedTo ?? createdBy;
      const stepNum = task.stepNumber ?? null;
      // Status default: all subtasks land in 'in_progress'. The previous
      // model (only the first-step task assigned to the creator started
      // in_progress, everything else 'on_deck') routinely produced the
      // failure mode where the agent finished the first task and then
      // never returned to the on_deck pile — those tasks went unseen
      // forever. New rule: 'on_deck' is reserved for "scheduled for
      // later". A task with no future scheduled_start belongs in
      // 'in_progress' so the assigned agent (and the PM) keep seeing it
      // as work to do. Project subtasks created here have no per-task
      // scheduled_start under the current API, so all of them are
      // in_progress. Sequencing is still expressed via step_number for
      // the agent to read, but the engine does not gate visibility.
      const status = 'in_progress';

      // Phase 7: original_description is an immutable copy of the user's
      // original ask. Mirrors the standalone createTask path. tracker_create_project
      // creates tasks via this code path; without this column being set the
      // onTaskComplete hook surfaces "(none recorded)" to the parent.
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, original_description, status, assigned_to, created_by, priority,
                           step_number, total_steps, phase, depends_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        taskId,
        projectId,
        task.title,
        task.description ?? null,
        task.description ?? null,
        status,
        assignee,
        createdBy,
        task.priority ?? 'normal',
        stepNum,
        totalSteps,
        task.phase ?? 1,
        JSON.stringify(task.dependsOn ?? []),
      );

      // Broadcast the new task
      const createdTask = getTask(taskId);
      if (createdTask) {
        broadcast({
          type: 'tracker:task_updated',
          data: createdTask,
        });
      }
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

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) return null;

  const project = mapProjectRow(row);

  const taskRows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY step_number ASC, created_at ASC').all(id) as TaskRow[];
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

  let sql = 'SELECT * FROM projects';
  const params: unknown[] = [];

  if (filter?.status) {
    sql += ' WHERE status = ?';
    params.push(filter.status);
  }

  sql += ' ORDER BY updated_at DESC';

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
}): { projectId: string; tasksClosed: number; alreadyClosed: number } {
  const db = getDb();
  const { projectId, closingAgentId, taskStatus, projectStatus, reason } = params;

  // Kanban DB-status mapping. The board only renders the six legacy task
  // statuses (on_deck/in_progress/paused/complete/blocked/fallen); storing
  // a literal "cancelled" on a task would make it disappear from the board.
  // So a user-facing "cancelled" task is stored as "fallen" (the existing
  // "didn't make it" terminal column) with a clear note. The project row
  // itself stores the literal user-facing status — it isn't column-rendered.
  const dbTaskStatus = taskStatus === 'cancelled' ? 'fallen' : 'complete';
  const noteMarker = taskStatus === 'cancelled' ? '[CANCELLED]' : '[Completed via bulk close]';

  const tasks = db
    .prepare('SELECT id, status FROM tasks WHERE project_id = ?')
    .all(projectId) as Array<{ id: string; status: string }>;

  let tasksClosed = 0;
  let alreadyClosed = 0;
  const TERMINAL = new Set(['complete', 'fallen', 'cancelled']);

  // Phase B.0: tasks.notes is read-only legacy. Bulk-close transitions
  // land in task_log instead. We capture the per-task prior status inside
  // the loop so each transition entry has the right from→to pair.
  const closeStmt = db.prepare(`
    UPDATE tasks
    SET status = ?,
        is_paused = 0,
        completed_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const closedTransitions: Array<{ taskId: string; from: string; to: string }> = [];
  const txn = db.transaction(() => {
    for (const t of tasks) {
      if (TERMINAL.has(t.status)) {
        alreadyClosed++;
        continue;
      }
      closeStmt.run(dbTaskStatus, t.id);
      closedTransitions.push({ taskId: t.id, from: t.status, to: dbTaskStatus });
      tasksClosed++;
    }
    db.prepare(`
      UPDATE projects
      SET status = ?,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(projectStatus, projectId);
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

  logger.info('Project bulk-closed', { projectId, tasksClosed, alreadyClosed, taskStatus, projectStatus, closingAgentId });

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

  return { projectId, tasksClosed, alreadyClosed };
}

export function updateProject(
  id: string,
  updates: Partial<{ status: string; currentPhase: number; title: string; description: string | null }>,
): void {
  const db = getDb();

  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
    if (updates.status === 'complete') {
      setClauses.push("completed_at = datetime('now')");
    }
  }

  if (updates.currentPhase !== undefined) {
    setClauses.push('current_phase = ?');
    params.push(updates.currentPhase);
  }

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    params.push(updates.title);
  }

  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    params.push(updates.description);
  }

  params.push(id);

  db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

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
}): string {
  const db = getDb();
  const taskId = uuidv4();

  const { projectId, title, description, assignedTo, createdBy, priority, stepNumber, dependsOn, phase, kind } = params;

  // v2.8.x rule: 'on_deck' is reserved for tasks with a future
  // scheduled_start (the scheduler owns the transition to 'in_progress'
  // at fire time). Tasks with no schedule belong in 'in_progress' so
  // they stay visible to the assigned agent and the PM. createTask
  // doesn't take scheduled_start directly; the trackerCreateTask
  // wrapper applies the schedule override after this insert by calling
  // updateTask(taskId, { status: 'on_deck' }) when hasSchedule is true.
  // Default here is in_progress for both self-assigned and other-
  // assigned tasks.
  const initialStatus = 'in_progress';

  // original_description is an immutable copy of the user's original ask.
  // Phase 7 onTaskComplete uses it to surface the original intent to the
  // parent agent at completion time even if the description was edited.
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, original_description, status, assigned_to, created_by, priority,
                       step_number, total_steps, phase, depends_on, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    taskId,
    projectId ?? null,
    title,
    description ?? null,
    description ?? null,
    initialStatus,
    assignedTo ?? null,
    createdBy,
    priority ?? 'normal',
    stepNumber ?? null,
    phase ?? 1,
    JSON.stringify(dependsOn ?? []),
    kind ?? null,
  );

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
 * — no LLM cooperation required.
 *
 * If a task already exists for this thread (later ASSIGNs on the same
 * thread are treated as clarifications, not new assignments), returns
 * the existing task ID instead of creating a duplicate.
 *
 * Returns null only on hard DB error so callers can fall back gracefully
 * — the message itself still gets delivered even if the auto-task fails.
 */
export function autoCreateAssignTask(params: {
  senderId: string;
  receiverId: string;
  payload: string;
  threadId: string;
}): { taskId: string; isNew: boolean } | null {
  const db = getDb();
  try {
    // v2.9.22 — never auto-create tracker rows for system agents
    // (PM/Healer/Dreamer). Their roles are meta and they don't own
    // user-facing work tasks. ASSIGN to a system agent is still a
    // valid wake-the-agent signal; the message delivers, just no
    // tracker row is created. Pre-fix, every ASSIGN to PM (typical
    // close-out escalation pattern) auto-created a task assigned
    // to PM, which then became invisible to the user but kept
    // firing PM validation loops (production incident 2026-06-07).
    if (isDashboardHiddenAgent(params.receiverId)) {
      logger.info('autoCreateAssignTask skipped — receiver is a system agent', {
        receiverId: params.receiverId, senderId: params.senderId, threadId: params.threadId,
      }, params.senderId);
      return null;
    }

    // v2.10.2 — never auto-create tracker rows when the SENDER is the
    // PM agent. PM's remediation flow is supposed to re-open the
    // existing task via tracker_retask (or close it via tracker_override
    // / tracker_validate_complete), NOT fork a new task. Pre-fix, PM
    // sending send_to_agent(intent='ASSIGN') to remediate a close-out
    // miss spawned a duplicate task and left the original abandoned —
    // producing two tasks for one unit of work and, for non-idempotent
    // tools (gmail_send, sms_send, voice_call, exec hitting live APIs),
    // a duplicate side effect. Production incident 2026-06-08: Email
    // 08 (Mariana Vázquez task) duplicated when PM rerouted the primary agent
    // after an auto-pause. The ASSIGN message itself still delivers
    // and wakes the receiver; just no fork.
    if (isPMAgent(params.senderId)) {
      logger.info('autoCreateAssignTask skipped — sender is PM (remediation should use tracker_retask)', {
        senderId: params.senderId, receiverId: params.receiverId, threadId: params.threadId,
      }, params.senderId);
      return null;
    }

    // Reuse if a task already exists for this thread.
    const existing = db
      .prepare('SELECT id FROM tasks WHERE a2a_thread_id = ? LIMIT 1')
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

    const taskId = uuidv4();
    // Phase B.1: goal is required on every task. For engine-auto-created
    // ASSIGN tasks we use the payload itself as the goal — it IS the
    // sender's stated definition of done for the receiver.
    const autoGoal = params.payload.trim().slice(0, 2000) || title;
    // v2.8.x rule: auto-created ASSIGN tasks land in 'in_progress' so the
    // receiver and the PM keep seeing them as work to do. 'on_deck' is now
    // reserved for future-scheduled tasks (the scheduler owns the
    // transition); auto-ASSIGN has no schedule.
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, description, original_description, goal, status, assigned_to, created_by, priority,
                         step_number, total_steps, phase, depends_on, a2a_thread_id, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, 'in_progress', ?, ?, 'normal', NULL, NULL, 1, '[]', ?, datetime('now'), datetime('now'))
    `).run(
      taskId,
      title,
      params.payload,
      params.payload,
      autoGoal,
      params.receiverId,
      params.senderId,
      params.threadId,
    );

    logger.info('Auto-created task for A2A ASSIGN', {
      taskId, threadId: params.threadId, senderId: params.senderId, receiverId: params.receiverId, title,
    }, params.senderId);

    const task = getTask(taskId);
    if (task) {
      broadcast({ type: 'tracker:task_updated', data: task });
    }

    return { taskId, isNew: true };
  } catch (err) {
    logger.warn('autoCreateAssignTask failed — proceeding without auto-task', {
      threadId: params.threadId, error: err instanceof Error ? err.message : String(err),
    }, params.senderId);
    return null;
  }
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return null;
  return mapTaskRow(row);
}

// ── ID prefix resolution ──
//
// The tracker list tools display task/project ids truncated to 8 chars
// (see tracker/tools.ts — `t.id.slice(0, 8)`). Agents naturally copy that
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

function resolveIdIn(table: 'tasks' | 'projects', idOrPrefix: string): IdResolution {
  if (!idOrPrefix || typeof idOrPrefix !== 'string') {
    return { ok: false, reason: 'empty' };
  }
  const input = idOrPrefix.trim();
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (input.length < 4) return { ok: false, reason: 'too_short' };

  const db = getDb();

  // Full UUID form (with or without dashes) — try direct lookup first.
  if (input.length >= 32) {
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(input) as { id: string } | undefined;
    if (row) return { ok: true, id: row.id };
    // Fall through to prefix match — the "full" id may be malformed
  }

  // Prefix match. Limit to 5 so we can detect ambiguity cheaply.
  const matches = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT 5`)
    .all(`${input}%`) as Array<{ id: string }>;

  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length === 1) return { ok: true, id: matches[0].id };
  return { ok: false, reason: 'ambiguous', matches: matches.map(m => m.id) };
}

/** Resolve a task id from a full UUID or ≥4-char prefix. */
export function resolveTaskId(idOrPrefix: string): IdResolution {
  return resolveIdIn('tasks', idOrPrefix);
}

/** Resolve a project id from a full UUID or ≥4-char prefix. */
export function resolveProjectId(idOrPrefix: string): IdResolution {
  return resolveIdIn('projects', idOrPrefix);
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
      return `Error: ${kind} id '${input}' is too short. Provide at least 4 characters of the id (8-char prefixes from tracker_list_active work fine).`;
    case 'not_found':
      return `Error: ${Kind} not found: '${input}'. It may have been deleted or completed. Use tracker_list_active to see current ${kind}s.`;
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

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.assignedTo) {
    conditions.push('assigned_to = ?');
    params.push(filter.assignedTo);
  }
  if (filter?.priority) {
    conditions.push('priority = ?');
    params.push(filter.priority);
  }
  if (filter?.projectId) {
    conditions.push('project_id = ?');
    params.push(filter.projectId);
  }

  let sql = 'SELECT * FROM tasks';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY priority DESC, step_number ASC, created_at ASC';

  const rows = db.prepare(sql).all(...params) as TaskRow[];
  return rows.map(mapTaskRow);
}

export function updateTask(id: string, updates: Partial<{
  status: string;
  assignedTo: string;
  priority: string;
  notes: string;
  title: string;
  description: string | null;
  pausedUntil: string | null;
  // Editable structural fields — added so tracker_edit_task can change them
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
  const db = getDb();

  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
    if (updates.status === 'complete') {
      setClauses.push("completed_at = datetime('now')");
    }
    // Keep is_paused in sync with status so the scheduler respects paused
    // state regardless of whether the pause came from tracker_update_status
    // or tracker_pause_schedule.
    if (updates.status === 'paused') {
      setClauses.push('is_paused = 1');
      // v2.7.18 - reset pause validation flag every time we transition into
      // paused so PM re-evaluates from scratch (catches repeated game
      // attempts where the agent unpauses + re-pauses with the same notes).
      setClauses.push('pause_validated = 0');
      // Save the current status so we can restore it on auto-resume.
      // Look up the task's current status BEFORE we overwrite it.
      const currentTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string } | undefined;
      if (currentTask && currentTask.status !== 'paused') {
        setClauses.push('status_before_pause = ?');
        params.push(currentTask.status);
      }
      // Set paused_until if provided
      if (updates.pausedUntil !== undefined) {
        setClauses.push('paused_until = ?');
        params.push(updates.pausedUntil);
      }
    } else {
      // Moving OUT of paused — clear pause fields
      if (updates.status !== 'complete') {
        setClauses.push('is_paused = 0');
      }
      setClauses.push('paused_until = NULL');
      setClauses.push('status_before_pause = NULL');
    }
  }

  // Allow setting paused_until without changing status (e.g., updating the resume time)
  if (updates.pausedUntil !== undefined && updates.status === undefined) {
    setClauses.push('paused_until = ?');
    params.push(updates.pausedUntil);
  }

  if (updates.assignedTo !== undefined) {
    setClauses.push('assigned_to = ?');
    params.push(updates.assignedTo);
  }

  if (updates.priority !== undefined) {
    setClauses.push('priority = ?');
    params.push(updates.priority);
  }

  if (updates.notes !== undefined) {
    setClauses.push('notes = ?');
    params.push(updates.notes);
  }

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    params.push(updates.title);
  }

  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    params.push(updates.description);
  }

  if (updates.dependsOn !== undefined) {
    setClauses.push('depends_on = ?');
    params.push(JSON.stringify(updates.dependsOn));
  }

  if (updates.stepNumber !== undefined) {
    setClauses.push('step_number = ?');
    params.push(updates.stepNumber);
  }

  if (updates.phase !== undefined) {
    setClauses.push('phase = ?');
    params.push(updates.phase);
  }

  if (updates.scheduledStart !== undefined) {
    setClauses.push('scheduled_start = ?');
    params.push(updates.scheduledStart);
  }

  if (updates.repeatInterval !== undefined) {
    setClauses.push('repeat_interval = ?');
    params.push(updates.repeatInterval);
  }

  if (updates.repeatUnit !== undefined) {
    setClauses.push('repeat_unit = ?');
    params.push(updates.repeatUnit);
  }

  if (updates.repeatEndType !== undefined) {
    setClauses.push('repeat_end_type = ?');
    params.push(updates.repeatEndType);
  }

  if (updates.repeatEndValue !== undefined) {
    setClauses.push('repeat_end_value = ?');
    params.push(updates.repeatEndValue);
  }

  if (updates.repeatDaysOfWeek !== undefined) {
    setClauses.push('repeat_days_of_week = ?');
    params.push(updates.repeatDaysOfWeek);
  }

  if (updates.anchorTime !== undefined) {
    setClauses.push('anchor_time = ?');
    params.push(updates.anchorTime);
  }

  params.push(id);

  const result = db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

  if (result.changes === 0) {
    // UPDATE matched zero rows — the id doesn't exist. Callers that pass
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
    // Rare race: row was present during UPDATE (.changes >= 1) but deleted
    // before the SELECT. Honest diagnostic now that the zero-rows case
    // is handled separately above.
    logger.warn('updateTask: task deleted between UPDATE and SELECT (race)', { taskId: id });
    return null;
  }

  broadcast({
    type: 'tracker:task_updated',
    data: task,
  });

  return task;
}

export function addTaskNotes(id: string, notes: string): void {
  const db = getDb();
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${notes}`;

  db.prepare(`
    UPDATE tasks SET
      notes = CASE WHEN notes IS NULL THEN ? ELSE notes || char(10) || ? END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(entry, entry, id);

  logger.info('Task notes added', { taskId: id, notesLength: notes.length });
}

/**
 * Replace the entire notes field on a task with the provided content.
 * Use when the existing notes are wrong or stale and need to be
 * rewritten wholesale. For appending without losing prior entries use
 * addTaskNotes instead.
 */
export function setTaskNotes(id: string, notes: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE tasks SET notes = ?, updated_at = datetime('now') WHERE id = ?
  `).run(notes, id);
  logger.info('Task notes replaced', { taskId: id, notesLength: notes.length });
}

/**
 * Wipe the notes field on a task back to NULL. Use when the existing
 * notes are obsolete and no replacement content is appropriate.
 */
export function clearTaskNotes(id: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE tasks SET notes = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(id);
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
