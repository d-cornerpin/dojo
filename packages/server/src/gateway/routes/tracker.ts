import { Hono } from 'hono';
import {
  createProject,
  getProject,
  listProjects,
  createTask,
  getTask,
  listTasks,
  updateTask,
  addTaskNotes,
  closeProjectAndOpenTasks,
} from '../../tracker/schema.js';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getPrimaryAgentId } from '../../config/platform.js';

const logger = createLogger('tracker-routes');
const trackerRouter = new Hono();

// ── Dashboard-only system-agent filter ──
//
// Projects/tasks owned by internal sensei agents (Dreamer's nightly
// vault cycles, the PM's bookkeeping, Healer's injury triage) are
// engine artifacts the user never asked for and shouldn't see in
// their kanban. Filtered out of the dashboard list endpoints by
// default; agent-side tools (tracker_list_active, the PM agent's
// monitor loops) still see them — internal agents need to keep
// coordinating with each other for the platform to work.
//
// Resolution strategy is two-pronged because system-agent identity is
// fuzzy across installs and time:
//   (1) Config-table keys (pm_agent_id, healer_agent_id, dreamer_agent_id)
//       — stable per install, portable across renames, the right
//       source of truth for "who's the current PM."
//   (2) Legacy name match (HIDDEN_AGENT_NAMES) — catches stale agents
//       from prior sessions whose IDs aren't current but whose
//       projects still exist (the DB shows ~5 historical Dreamer rows
//       across reincarnations). Names are stable defaults from the
//       platform spec.
//
// Override with ?includeSystem=true for debugging.
const HIDDEN_AGENT_NAMES = ['Dreamer', 'Healer'];
const HIDDEN_SYSTEM_CONFIG_KEYS = ['pm_agent_id', 'healer_agent_id', 'dreamer_agent_id'];

function hiddenAgentIdSet(): Set<string> {
  const ids = new Set<string>();
  try {
    const db = getDb();
    // (1) Config-driven system IDs — present-tense source of truth.
    const configPlaceholders = HIDDEN_SYSTEM_CONFIG_KEYS.map(() => '?').join(',');
    const configRows = db.prepare(
      `SELECT value FROM config WHERE key IN (${configPlaceholders})`,
    ).all(...HIDDEN_SYSTEM_CONFIG_KEYS) as Array<{ value: string }>;
    for (const r of configRows) {
      if (r.value) ids.add(r.value);
    }
    // (2) Legacy name match — catches historical agents whose IDs
    // aren't current but whose projects/tasks still exist.
    const namePlaceholders = HIDDEN_AGENT_NAMES.map(() => '?').join(',');
    const nameRows = db.prepare(
      `SELECT id FROM agents WHERE name IN (${namePlaceholders})`,
    ).all(...HIDDEN_AGENT_NAMES) as Array<{ id: string }>;
    for (const r of nameRows) ids.add(r.id);
  } catch (err) {
    logger.warn('hiddenAgentIdSet lookup failed; not hiding anything', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return ids;
}

// ── Projects ──

// GET /projects — list all projects (filtered to user-facing only)
trackerRouter.get('/projects', (c) => {
  const status = c.req.query('status');
  const includeSystem = c.req.query('includeSystem') === 'true';
  const all = listProjects(status ? { status } : undefined);
  if (includeSystem) return c.json({ ok: true, data: all });
  const hidden = hiddenAgentIdSet();
  const projects = all.filter(p => !hidden.has(p.createdBy));
  return c.json({ ok: true, data: projects });
});

// GET /projects/:id — project detail with tasks
trackerRouter.get('/projects/:id', (c) => {
  const id = c.req.param('id');
  const project = getProject(id);

  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  return c.json({ ok: true, data: project });
});

// POST /projects — create project
trackerRouter.post('/projects', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.title !== 'string') {
    return c.json({ ok: false, error: 'title (string) is required' }, 400);
  }

  if (typeof body.level !== 'number' || body.level < 1 || body.level > 3) {
    return c.json({ ok: false, error: 'level (number 1-3) is required' }, 400);
  }

  try {
    const tasksInput = Array.isArray(body.tasks)
      ? body.tasks.map((t: Record<string, unknown>) => ({
          title: t.title as string,
          description: t.description as string | undefined,
          assignedTo: t.assignedTo as string | undefined,
          priority: t.priority as 'high' | 'normal' | 'low' | undefined,
          stepNumber: t.stepNumber as number | undefined,
          dependsOn: t.dependsOn as string[] | undefined,
          phase: t.phase as number | undefined,
        }))
      : undefined;

    // createdBy must be a real agent id — tasks.assigned_to has a FK to
    // agents(id), and schema.createProject defaults task.assignedTo to
    // createdBy when a task has none. Hardcoding the literal string
    // 'dashboard' triggered FOREIGN KEY constraint failed on every
    // dashboard-initiated project. Use the primary agent (the user's
    // surrogate) as the default actor for dashboard mutations.
    const result = createProject({
      title: body.title,
      description: body.description ?? undefined,
      level: body.level,
      createdBy: getPrimaryAgentId(),
      tasks: tasksInput,
    });

    return c.json({ ok: true, data: result }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to create project', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ── Tasks ──

// GET /tasks — list tasks with filters (hides internal sensei tasks)
trackerRouter.get('/tasks', (c) => {
  const status = c.req.query('status') ?? undefined;
  const assignedTo = c.req.query('assignedTo') ?? undefined;
  const priority = c.req.query('priority') ?? undefined;
  const projectId = c.req.query('projectId') ?? undefined;
  const includeSystem = c.req.query('includeSystem') === 'true';

  const filter: Record<string, string | undefined> = {};
  if (status) filter.status = status;
  if (assignedTo) filter.assignedTo = assignedTo;
  if (priority) filter.priority = priority;
  if (projectId) filter.projectId = projectId;

  const all = listTasks(Object.keys(filter).length > 0 ? filter : undefined);
  if (includeSystem) return c.json({ ok: true, data: all });
  const hidden = hiddenAgentIdSet();
  const tasks = all.filter(t => {
    if (t.assignedTo && hidden.has(t.assignedTo)) return false;
    if (t.createdBy && hidden.has(t.createdBy)) return false;
    return true;
  });
  return c.json({ ok: true, data: tasks });
});

// GET /tasks/:id — task detail
trackerRouter.get('/tasks/:id', (c) => {
  const id = c.req.param('id');
  const task = getTask(id);

  if (!task) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  return c.json({ ok: true, data: task });
});

// POST /tasks — create standalone task
trackerRouter.post('/tasks', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.title !== 'string') {
    return c.json({ ok: false, error: 'title (string) is required' }, 400);
  }

  try {
    const taskId = createTask({
      projectId: body.projectId ?? undefined,
      title: body.title,
      description: body.description ?? undefined,
      assignedTo: body.assignedTo ?? undefined,
      // Same FK reason as POST /projects above — 'dashboard' isn't an agent.
      createdBy: getPrimaryAgentId(),
      priority: body.priority ?? undefined,
      stepNumber: body.stepNumber ?? undefined,
      dependsOn: body.dependsOn ?? undefined,
      phase: body.phase ?? undefined,
    });

    // Handle scheduling if provided
    if (body.scheduled_start) {
      const db = getDb();
      const { calculateNextRun } = await import('../../scheduler/engine.js');
      // v2.5.2 — specific_days requires the day-of-week allowlist.
      // Dashboard sends repeat_days_of_week as a CSV string (e.g. "1,3").
      const repeatDaysOfWeek = (body.repeat_days_of_week ?? null) as string | null;
      // v2.5.45 — anchor_time. Defaults to scheduled_start when caller
      // doesn't provide one (the typical UI path: pick a start time,
      // check "repeat", and the same time becomes the anchor).
      const anchorTime = (body.anchor_time ?? body.scheduled_start) as string;
      const taskForCalc = {
        id: taskId,
        scheduled_start: body.scheduled_start,
        repeat_interval: body.repeat_interval ?? null,
        repeat_unit: body.repeat_unit ?? null,
        repeat_end_type: body.repeat_end_type ?? 'never',
        repeat_end_value: body.repeat_end_value ?? null,
        run_count: 0,
        is_paused: 0,
        last_run_at: null,
        next_run_at: null,
        schedule_status: 'waiting',
        repeat_days_of_week: repeatDaysOfWeek,
        anchor_time: anchorTime,
      };
      const nextRun = calculateNextRun(taskForCalc) ?? body.scheduled_start;

      db.prepare(`
        UPDATE tasks SET
          scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
          repeat_end_type = ?, repeat_end_value = ?,
          repeat_days_of_week = ?, anchor_time = ?,
          next_run_at = ?, schedule_status = 'waiting',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        body.scheduled_start,
        body.repeat_interval ?? null,
        body.repeat_unit ?? null,
        body.repeat_end_type ?? 'never',
        body.repeat_end_value ?? null,
        repeatDaysOfWeek,
        anchorTime,
        nextRun,
        taskId,
      );
    }

    const task = getTask(taskId);
    return c.json({ ok: true, data: task }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to create task', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /tasks/:id — update task
trackerRouter.put('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);

  if (!body) {
    return c.json({ ok: false, error: 'Request body is required' }, 400);
  }

  // Check task exists
  const existing = getTask(id);
  if (!existing) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  try {
    const updates: Record<string, string> = {};
    if (body.status) updates.status = body.status;
    if (body.assignedTo !== undefined) updates.assignedTo = body.assignedTo;
    if (body.priority) updates.priority = body.priority;

    // Handle notes separately — append rather than replace
    if (body.notes) {
      addTaskNotes(id, body.notes);
    }

    if (Object.keys(updates).length > 0) {
      updateTask(id, updates);
    }

    // Handle schedule updates
    if (body.scheduled_start !== undefined) {
      const db = getDb();
      if (body.scheduled_start === null) {
        // Remove schedule
        db.prepare(`
          UPDATE tasks SET scheduled_start = NULL, repeat_interval = NULL, repeat_unit = NULL,
            repeat_end_type = NULL, repeat_end_value = NULL, repeat_days_of_week = NULL,
            anchor_time = NULL,
            next_run_at = NULL,
            schedule_status = 'unscheduled', updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
      } else {
        const { calculateNextRun } = await import('../../scheduler/engine.js');
        const existingTask = getTask(id);
        const repeatDaysOfWeek = (body.repeat_days_of_week ?? null) as string | null;
        // v2.5.45 — anchor_time. If caller provides one, use it. If not,
        // preserve the existing anchor on edit (so changing repeat_interval
        // doesn't reset the anchor). Falls back to scheduled_start only
        // when neither is set.
        const anchorTime = (
          body.anchor_time
          ?? existingTask?.anchorTime
          ?? body.scheduled_start
        ) as string;
        const taskForCalc = {
          id,
          scheduled_start: body.scheduled_start,
          repeat_interval: body.repeat_interval ?? null,
          repeat_unit: body.repeat_unit ?? null,
          repeat_end_type: body.repeat_end_type ?? 'never',
          repeat_end_value: body.repeat_end_value ?? null,
          run_count: existingTask?.runCount ?? 0,
          is_paused: 0,
          last_run_at: null,
          next_run_at: null,
          schedule_status: 'waiting',
          repeat_days_of_week: repeatDaysOfWeek,
          anchor_time: anchorTime,
        };
        const nextRun = calculateNextRun(taskForCalc) ?? body.scheduled_start;

        db.prepare(`
          UPDATE tasks SET scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
            repeat_end_type = ?, repeat_end_value = ?,
            repeat_days_of_week = ?, anchor_time = ?,
            next_run_at = ?, schedule_status = 'waiting', is_paused = 0,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          body.scheduled_start,
          body.repeat_interval ?? null,
          body.repeat_unit ?? null,
          body.repeat_end_type ?? 'never',
          body.repeat_end_value ?? null,
          repeatDaysOfWeek,
          anchorTime,
          nextRun,
          id,
        );
      }
    }

    const task = getTask(id);
    return c.json({ ok: true, data: task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update task', { error: msg, taskId: id });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /projects/:id/close — bulk-close project and every open task on it
trackerRouter.post('/projects/:id/close', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  let body: { status?: string; reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Body must be JSON: { status?: "complete"|"cancelled", reason: "…" }' }, 400);
  }

  const status = (body.status ?? 'cancelled').toLowerCase();
  if (status !== 'complete' && status !== 'cancelled') {
    return c.json({ ok: false, error: 'status must be "complete" or "cancelled"' }, 400);
  }
  const reason = (body.reason ?? '').trim();
  if (reason.length < 4) {
    return c.json({ ok: false, error: 'reason is required (short sentence; written to every closed task)' }, 400);
  }

  try {
    const result = closeProjectAndOpenTasks({
      projectId: id,
      closingAgentId: 'dashboard',
      taskStatus: status as 'complete' | 'cancelled',
      projectStatus: status as 'complete' | 'cancelled',
      reason,
    });
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to close project', { error: msg, projectId: id });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// DELETE /projects/:id — delete project and all its tasks
trackerRouter.delete('/projects/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  // Get task IDs for cascade
  const taskIds = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(id) as Array<{ id: string }>;
  const ids = taskIds.map(t => t.id);

  // Delete child rows for these tasks
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM task_runs WHERE task_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM poke_log WHERE task_id IN (${ph})`).run(...ids);
  }

  // Delete tasks
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);

  // Delete project
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);

  logger.info('Project deleted', { projectId: id, tasksDeleted: ids.length });
  return c.json({ ok: true, data: { projectId: id, tasksDeleted: ids.length } });
});

// DELETE /tasks/:id — delete a single task
trackerRouter.delete('/tasks/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM poke_log WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

  logger.info('Task deleted', { taskId: id });
  return c.json({ ok: true, data: { taskId: id } });
});

export { trackerRouter };
