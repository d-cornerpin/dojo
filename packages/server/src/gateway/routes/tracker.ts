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
} from '../../tracker/schema.js';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('tracker-routes');
const trackerRouter = new Hono();

// ── Projects ──

// GET /projects — list all projects
trackerRouter.get('/projects', (c) => {
  const status = c.req.query('status');
  const projects = listProjects(status ? { status } : undefined);
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

    const result = createProject({
      title: body.title,
      description: body.description ?? undefined,
      level: body.level,
      createdBy: 'dashboard',
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

// GET /tasks — list tasks with filters
trackerRouter.get('/tasks', (c) => {
  const status = c.req.query('status') ?? undefined;
  const assignedTo = c.req.query('assignedTo') ?? undefined;
  const priority = c.req.query('priority') ?? undefined;
  const projectId = c.req.query('projectId') ?? undefined;

  const filter: Record<string, string | undefined> = {};
  if (status) filter.status = status;
  if (assignedTo) filter.assignedTo = assignedTo;
  if (priority) filter.priority = priority;
  if (projectId) filter.projectId = projectId;

  const tasks = listTasks(Object.keys(filter).length > 0 ? filter : undefined);
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
      createdBy: 'dashboard',
      priority: body.priority ?? undefined,
      stepNumber: body.stepNumber ?? undefined,
      dependsOn: body.dependsOn ?? undefined,
      phase: body.phase ?? undefined,
    });

    // Handle scheduling if provided
    if (body.scheduled_start) {
      const db = getDb();
      const { calculateNextRun } = await import('../../scheduler/engine.js');
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
      };
      const nextRun = calculateNextRun(taskForCalc) ?? body.scheduled_start;

      db.prepare(`
        UPDATE tasks SET
          scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
          repeat_end_type = ?, repeat_end_value = ?,
          next_run_at = ?, schedule_status = 'waiting',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        body.scheduled_start,
        body.repeat_interval ?? null,
        body.repeat_unit ?? null,
        body.repeat_end_type ?? 'never',
        body.repeat_end_value ?? null,
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
            repeat_end_type = NULL, repeat_end_value = NULL, next_run_at = NULL,
            schedule_status = 'unscheduled', updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
      } else {
        const { calculateNextRun } = await import('../../scheduler/engine.js');
        const existingTask = getTask(id);
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
        };
        const nextRun = calculateNextRun(taskForCalc) ?? body.scheduled_start;

        db.prepare(`
          UPDATE tasks SET scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
            repeat_end_type = ?, repeat_end_value = ?,
            next_run_at = ?, schedule_status = 'waiting', is_paused = 0,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          body.scheduled_start,
          body.repeat_interval ?? null,
          body.repeat_unit ?? null,
          body.repeat_end_type ?? 'never',
          body.repeat_end_value ?? null,
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
