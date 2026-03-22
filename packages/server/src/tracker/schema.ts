import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
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
  next_run_at: string | null;
  run_count: number;
  is_paused: number;
  last_run_at: string | null;
  schedule_status: string;
  assigned_to_group: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
    nextRunAt: row.next_run_at ?? null,
    runCount: row.run_count ?? 0,
    isPaused: Boolean(row.is_paused),
    scheduleStatus: row.schedule_status ?? 'unscheduled',
    assignedToGroup: row.assigned_to_group ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
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
    // Find the lowest step number to auto-start it
    const sortedSteps = tasks
      .map((t, i) => ({ ...t, idx: i, step: t.stepNumber ?? (i + 1) }))
      .sort((a, b) => a.step - b.step);
    const firstStepNumber = sortedSteps[0]?.step ?? 1;

    for (const task of tasks) {
      const taskId = uuidv4();
      taskIds.push(taskId);

      const assignee = task.assignedTo ?? createdBy;
      const stepNum = task.stepNumber ?? null;
      // Auto-start: if this is the first step and assigned to the creator, start as in_progress
      const isFirstStep = stepNum === firstStepNumber || (stepNum === null && tasks.indexOf(task) === 0);
      const status = (isFirstStep && assignee === createdBy) ? 'in_progress' : 'on_deck';

      db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, status, assigned_to, created_by, priority,
                           step_number, total_steps, phase, depends_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        taskId,
        projectId,
        task.title,
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
  };

  for (const task of tasks) {
    switch (task.status) {
      case 'on_deck': taskCounts.pending++; break;
      case 'in_progress': taskCounts.inProgress++; break;
      case 'complete': taskCounts.complete++; break;
      case 'blocked': taskCounts.blocked++; break;
      case 'fallen': taskCounts.failed++; break;
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

export function updateProject(id: string, updates: Partial<{ status: string; currentPhase: number }>): void {
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
}): string {
  const db = getDb();
  const taskId = uuidv4();

  const { projectId, title, description, assignedTo, createdBy, priority, stepNumber, dependsOn, phase } = params;

  // If the creator is also the assignee, start as in_progress (they're about to work on it)
  const initialStatus = (assignedTo && assignedTo === createdBy) ? 'in_progress' : 'on_deck';

  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, assigned_to, created_by, priority,
                       step_number, total_steps, phase, depends_on, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'), datetime('now'))
  `).run(
    taskId,
    projectId ?? null,
    title,
    description ?? null,
    initialStatus,
    assignedTo ?? null,
    createdBy,
    priority ?? 'normal',
    stepNumber ?? null,
    phase ?? 1,
    JSON.stringify(dependsOn ?? []),
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

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return null;
  return mapTaskRow(row);
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

  params.push(id);

  db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

  logger.info('Task updated', { taskId: id, updates });

  const task = getTask(id);
  if (!task) {
    logger.warn('Task not found after update (may have been deleted)', { taskId: id });
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
