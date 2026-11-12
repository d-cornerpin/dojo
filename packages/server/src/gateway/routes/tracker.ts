import { Hono } from 'hono';
import { createProject, getProject, listProjects, createTask, getTask, listTasksPage, updateTask, closeProjectAndOpenTasks, resolveTaskId, formatResolveError, setTaskStatusResult, broadcastTaskSettled } from '../../tracker/schema.js';
import { getDb } from '../../db/connection.js';
import { taskScope, projectScope, type TrackerStatus } from '../../work/tracker-view.js';
// The schedule's fire time has one writing module.
import { setNextRun } from '../../work/next-run.js';
import { armScheduleOnOwnerSave } from '../../tracker/finished-task-schedule.js';
import { VERSION_GAP_REPORT_KEY } from '../../tracker/version-gap-reconcile.js';
import { workSettled, isStateConflict, noteUnsettled } from '../../work/store.js';
import { deleteTrackerRow } from '../../work/tracker-store.js';
import { decide, type Verdict } from '../../work/done/decide.js';
import { setHold, clearHold } from '../../work/done/hold.js';
import { tsToMs } from '../../work/tracker-view.js';
import { deleteOccurrencesOf } from '../../work/occurrences.js';
import { recordReassignment } from '../../tracker/assignee-patience.js';
import { createLogger } from '../../logger.js';
import type { TaskLogEntryKind } from '../../tracker/task-log.js';
import { getPrimaryAgentId, getDashboardHiddenAgentIds } from '../../config/platform.js';
import { routeFailure } from './route-failure.js';

const logger = createLogger('tracker-routes');
const trackerRouter = new Hono();

// Projects and tasks owned by internal system agents (Dreamer, PM, Healer) are engine artifacts: the
// dashboard list endpoints hide them by default (?includeSystem=true shows them); agent-side tools still see
// them. The set is getDashboardHiddenAgentIds() (config/platform.ts), also used by the auto-create gate.
function hiddenAgentIdSet(): Set<string> {
  return getDashboardHiddenAgentIds();
}

// The repeat units the engine accepts; the dashboard's dropdown offers a subset.
const REPEAT_UNITS = new Set([
  'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days',
]);

// A plain-words reason the schedule the dashboard sent cannot run, or null when it can: an unparseable
// start, an interval that is not a whole number of at least 1, an unknown unit, or an interval and unit not
// given together. Each would otherwise store a "waiting" schedule that never fires, so it is refused first.
function scheduleInputError(body: Record<string, unknown>): string | null {
  const start = body.scheduled_start;
  const interval = body.repeat_interval;
  const unit = body.repeat_unit;
  const startPresent = start !== undefined && start !== null;
  const intervalPresent = interval !== undefined && interval !== null;
  const unitPresent = unit !== undefined && unit !== null;

  if (startPresent && tsToMs(start as string | null | undefined) === null) {
    return 'The start time can\'t be read as a date. Pick a date and time the schedule can begin on.';
  }
  const intervalNum = typeof interval === 'number' ? interval : Number(interval);
  if (intervalPresent && !(Number.isFinite(intervalNum) && Number.isInteger(intervalNum) && intervalNum >= 1)) {
    return 'The repeat interval must be a whole number of at least 1.';
  }
  if (unitPresent && !REPEAT_UNITS.has(unit as string)) {
    return 'The repeat unit is not one of the options on the form.';
  }
  if (intervalPresent !== unitPresent) {
    return 'A repeat interval and a repeat unit must be set together.';
  }
  return null;
}


// GET /projects: list all projects (filtered to user-facing only)
trackerRouter.get('/projects', (c) => {
  const status = c.req.query('status');
  const includeSystem = c.req.query('includeSystem') === 'true';
  const all = listProjects(status ? { status } : undefined);
  if (includeSystem) return c.json({ ok: true, data: all });
  const hidden = hiddenAgentIdSet();
  const projects = all.filter(p => !hidden.has(p.createdBy));
  return c.json({ ok: true, data: projects });
});

// GET /projects/:id: project detail with tasks
trackerRouter.get('/projects/:id', (c) => {
  const id = c.req.param('id');
  const project = getProject(id);

  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  return c.json({ ok: true, data: project });
});

// POST /projects: create project
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

    // createdBy must be a real agent id (tasks.assigned_to has a FK to agents(id) and createProject defaults
    // the task assignee to it), so the primary agent stands in for the dashboard user.
    const result = createProject({
      origin: { kind: 'user_direct', sourceMessageId: null, turn: null, convKey: null },
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


// GET /tasks: list tasks with filters (hides internal system-agent tasks). The finished ones are paged
// (`closedBefore` + `closedBeforeId` for the page before; `closedHasOlder` says one exists).
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

  // The live tasks come whole on the first page; the finished ones a page at a time, newest closed first,
  // with the cursor of the oldest one the caller holds for the page before.
  const closedBefore = c.req.query('closedBefore');
  const closedBeforeId = c.req.query('closedBeforeId');
  // System-agent tasks are platform mechanics hidden from the board by default; one in dispute (thrown back,
  // awaiting the owner's verdict, or a STALEMATE task) stays visible so he can intervene. The hiding happens
  // in the page's own query, before the page is cut, so a page of hidden tasks can never stall the "show
  // older" cursor.
  const page = listTasksPage(Object.keys(filter).length > 0 ? filter : undefined, {
    ...(closedBefore && closedBeforeId ? { before: { at: closedBefore, id: closedBeforeId } } : {}),
    ...(includeSystem ? {} : { hideAgentIds: hiddenAgentIdSet() }),
  });
  return c.json({ ok: true, data: page.tasks, closedHasOlder: page.closedHasOlder });
});

// GET /tasks/:id: task detail
trackerRouter.get('/tasks/:id', (c) => {
  const id = c.req.param('id');
  const task = getTask(id);

  if (!task) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  return c.json({ ok: true, data: task });
});

trackerRouter.post('/tasks/:id/observation', async (c) => {
  const rawId = c.req.param('id');
  let body: { note?: string };
  try {
    body = await c.req.json();
  } catch (err) {
    return routeFailure(c, logger, err, { status: 400, message: 'invalid JSON body' });
  }
  const note = (body.note ?? '').trim();
  if (!note) return c.json({ ok: false, error: 'note is required' }, 400);

  // Resolve short prefix to full UUID for FK integrity.
  const resolved = resolveTaskId(rawId);
  if (!resolved.ok) {
    return c.json({ ok: false, error: formatResolveError('task', rawId, resolved) }, 404);
  }

  try {
    const { writeTaskLog } = await import('../../tracker/task-log.js');
    const entryId = writeTaskLog({
      taskId: resolved.id,
      fromEntity: 'user',
      entryKind: 'observation',
      note,
    });
    return c.json({ ok: true, data: { entryId } });
  } catch (err) {
    logger.error('POST /tasks/:id/observation failed', { id: rawId, error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'failed to write observation' }, 500);
  }
});

// POST /tasks/:id/decision: the owner decides a task from the dashboard (approve or send back a hand-in,
// or close or cancel it himself). The decision is `work/done/decide.ts`'s, the owner's by construction.
trackerRouter.post('/tasks/:id/decision', async (c) => {
  const rawId = c.req.param('id');
  const resolved = resolveTaskId(rawId);
  if (!resolved.ok) return c.json({ ok: false, error: formatResolveError('task', rawId, resolved) }, 404);
  let body: { verdict?: string; reason?: string };
  try {
    body = await c.req.json();
  } catch (err) {
    return routeFailure(c, logger, err, { status: 400, message: 'Body must be JSON: { verdict: "approve"|"send_back"|"owner_done"|"cancel", reason }' });
  }
  const verdict = body.verdict as Verdict;
  if (!['approve', 'send_back', 'owner_done', 'cancel'].includes(verdict)) {
    return c.json({ ok: false, error: 'verdict must be "approve", "send_back", "owner_done" or "cancel"' }, 400);
  }
  const r = decide({ workId: resolved.id, deciderAgentId: null, verdict, reason: body.reason ?? '' });
  if (r.kind !== 'decided') return c.json({ ok: false, error: r.text }, 409);
  broadcastTaskSettled(resolved.id, null);
  return c.json({ ok: true, data: { to: r.to, text: r.text } });
});

// GET /tasks/:id/log: structured audit log entries for a task
trackerRouter.get('/tasks/:id/log', async (c) => {
  const rawId = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
  const kindsParam = c.req.query('kinds');
  // The vocabulary has one owner (`TaskLogEntryKind`) instead of being restated here.
  const kinds = kindsParam
    ? (kindsParam.split(',').map((k) => k.trim()).filter(Boolean) as TaskLogEntryKind[])
    : undefined;

  const resolved = resolveTaskId(rawId);
  if (!resolved.ok) {
    return c.json({ ok: false, error: formatResolveError('task', rawId, resolved) }, 404);
  }

  try {
    const { listTaskLog } = await import('../../tracker/task-log.js');
    const entries = listTaskLog(resolved.id, { limit, kinds });
    return c.json({ ok: true, data: entries });
  } catch (err) {
    logger.error('GET /tasks/:id/log failed', { id: rawId, error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'failed to load task log' }, 500);
  }
});

// POST /tasks: create standalone task
trackerRouter.post('/tasks', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.title !== 'string') {
    return c.json({ ok: false, error: 'title (string) is required' }, 400);
  }

  // Reject a specific_days schedule with an empty or invalid day allowlist BEFORE the row is created, so a
  // config error fails loudly instead of degrading to a single fire then complete (the scheduler's
  // specific_days walk cannot advance with no allowed weekday). Mirrors the agent-side check in
  // work_open(kind="task").
  if (body.scheduled_start && body.repeat_unit === 'specific_days') {
    const { parseDaysOfWeek } = await import('../../scheduler/engine.js');
    if (!parseDaysOfWeek((body.repeat_days_of_week ?? null) as string | null)) {
      return c.json({
        ok: false,
        error: 'A "specific days" repeat needs at least one weekday selected (e.g. Mon and Wed). With no days selected the task would run once and then stop. Pick the days you want, or use a plain weekly repeat instead.',
      }, 400);
    }
  }

  // A schedule that cannot run is refused before the row is created, so the owner
  // is never told 201 for a "waiting" schedule that will never fire.
  const scheduleErr = scheduleInputError(body);
  if (scheduleErr) {
    return c.json({ ok: false, error: scheduleErr }, 400);
  }

  try {
    const taskId = createTask({
      origin: { kind: 'user_direct', sourceMessageId: null, turn: null, convKey: null },
      projectId: body.projectId ?? undefined,
      title: body.title,
      description: body.description ?? undefined,
      assignedTo: body.assignedTo ?? undefined,
      // Same FK reason as POST /projects above: 'dashboard' isn't an agent.
      createdBy: getPrimaryAgentId(),
      priority: body.priority ?? undefined,
      stepNumber: body.stepNumber ?? undefined,
      dependsOn: body.dependsOn ?? undefined,
      phase: body.phase ?? undefined,
    });

    // The view `createTask` just broadcast. The schedule below lands AFTER it, so the settle frame at the
    // end of this handler compares against this one (same seam as the agent's `work_open` door).
    const announced = getTask(taskId);

    if (body.scheduled_start) {
      const { calculateNextRun } = await import('../../scheduler/engine.js');
      // specific_days requires the day-of-week allowlist; the dashboard sends repeat_days_of_week as a CSV
      // string.
      const repeatDaysOfWeek = (body.repeat_days_of_week ?? null) as string | null;
      // anchor_time defaults to scheduled_start when the caller gives none (pick a start, check "repeat").
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

      noteUnsettled(setNextRun(taskId, {
        at: tsToMs(nextRun),
        reason: 'the owner created a schedule on the dashboard; this is its first fire time',
        alongside: {
          scheduled_start: tsToMs(body.scheduled_start),
          repeat_interval: body.repeat_interval ?? null,
          repeat_unit: body.repeat_unit ?? null,
          repeat_end_type: body.repeat_end_type ?? 'never',
          repeat_end_value: body.repeat_end_value ?? null,
          repeat_days_of_week: repeatDaysOfWeek,
          anchor_local: anchorTime,
          schedule_status: 'waiting',
        },
      }), 'dashboard: schedule recorded on task create', { taskId });

      // This door has no `kind` field, so the deliverable declaration is DERIVED from the task's definition
      // rather than asked for: otherwise every schedule the owner creates himself would stay undeclared.
      // Same call, rules and audit row as the tool door.
      const { declareDeliverableOnSchedule } = await import('../../work/deliverable-declaration.js');
      declareDeliverableOnSchedule(taskId);
    }

    // The LAST frame for this id must equal the stored row; a no-op when nothing settled.
    broadcastTaskSettled(taskId, announced);

    const task = getTask(taskId);
    return c.json({ ok: true, data: task }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to create task', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** The owner moving a card: a close or a cancel is his decision (`work/done/decide.ts`); paused and
 *  blocked put it on hold; any other move lifts the hold and is a plain status change. Null when it
 *  landed, else why not. */
function ownerMoveRefusal(id: string, status: string): string | null {
  if (status === 'complete' || status === 'cancelled' || status === 'fallen') {
    const r = decide({ workId: id, deciderAgentId: null, verdict: status === 'complete' ? 'owner_done' : 'cancel', reason: `moved to ${status} on the dashboard task board` });
    return r.kind === 'decided' ? null : r.text;
  }
  if (status === 'paused' || status === 'blocked') {
    const held = setHold(id, status, `${status} by the owner on the dashboard`, 'owner');
    return held.ok ? null : held.why;
  }
  if (getTask(id)?.status === status) clearHold(id, 'owner');   // already there: only the hold lifts
  const { result } = setTaskStatusResult(id, status as TrackerStatus, { by: 'owner', actorId: 'user', reason: 'dashboard PUT /tracker/tasks/:id' });
  if (workSettled(result)) return null;
  return isStateConflict(result) ? `the task moved to "${result.actual}" while this request was in flight` : `${result.reason}: ${result.detail}`;
}

// PUT /tasks/:id: update task
trackerRouter.put('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);

  if (!body) {
    return c.json({ ok: false, error: 'Request body is required' }, 400);
  }

  const existing = getTask(id);
  if (!existing) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  // This route fully overwrites the schedule from the body when scheduled_start is set, so the effective
  // unit and days are the body's. Reject a specific_days schedule with an empty or invalid allowlist before
  // touching the row. `!= null` covers undefined (no schedule edit) and null (remove-schedule), neither of
  // which writes days.
  if (body.scheduled_start != null && body.repeat_unit === 'specific_days') {
    const { parseDaysOfWeek } = await import('../../scheduler/engine.js');
    if (!parseDaysOfWeek((body.repeat_days_of_week ?? null) as string | null)) {
      return c.json({
        ok: false,
        error: 'A "specific days" repeat needs at least one weekday selected (e.g. Mon and Wed). With no days selected the task would run once and then stop. Pick the days you want, or use a plain weekly repeat instead.',
      }, 400);
    }
  }

  // A bad schedule in the same Save refuses the whole Save: the priority, status and assignee writes below
  // must not land when the schedule cannot run. Gated on a schedule edit (null is the remove-schedule
  // branch).
  if (body.scheduled_start != null) {
    const scheduleErr = scheduleInputError(body);
    if (scheduleErr) return c.json({ ok: false, error: scheduleErr }, 400);
  }

  try {
    const updates: Record<string, string> = {};
    if (body.status) updates.status = body.status;
    if (body.assignedTo !== undefined) updates.assignedTo = body.assignedTo;
    if (body.priority) updates.priority = body.priority;

    // Dashboard observations go through task_log; a caller-supplied `notes` is routed as a user-observation
    // entry for older dashboard builds.
    if (body.notes) {
      const { writeTaskLog } = await import('../../tracker/task-log.js');
      writeTaskLog({
        taskId: id,
        fromEntity: 'user',
        entryKind: 'observation',
        note: body.notes,
      });
    }

    if (Object.keys(updates).length > 0) {
      // Snapshot the prior status before the write so the transition entry is accurate.
      const prior = getTask(id);
      const fromStatus = prior?.status ?? null;
      const { status: statusUpdate, ...columnUpdates } = updates;
      if (Object.keys(columnUpdates).length > 0) updateTask(id, columnUpdates);
      // A PERSON moving a task is the only reassignment this platform still has (the PM has no such verb),
      // so it is recorded here: who, why, and what the previous assignee was last seen doing. `prior` is the
      // pre-write read.
      if (updates.assignedTo !== undefined && updates.assignedTo !== (prior?.assignedTo ?? null)) {
        recordReassignment({
          taskId: id, actor: 'user', fromAgentId: prior?.assignedTo ?? null,
          toAgentId: updates.assignedTo, reason: 'reassigned by a person through the dashboard',
        });
      }
      if (statusUpdate) {
        const refusal = ownerMoveRefusal(id, statusUpdate);
        if (refusal) {
          return c.json({
            ok: false,
            error: `status change to "${statusUpdate}" was refused, ${refusal}`,
            data: { taskId: id, refusedStatus: statusUpdate, otherUpdatesApplied: Object.keys(columnUpdates) },
          }, 409);
        }
      }
      if (body.status && body.status !== fromStatus && body.status !== 'paused' && body.status !== 'blocked') {   // a hold writes its own entry
        const { writeTaskLog } = await import('../../tracker/task-log.js');
        writeTaskLog({
          taskId: id,
          fromEntity: 'user',
          entryKind: 'transition',
          fromStatus,
          toStatus: body.status,
          actionTaken: 'dashboard PUT /tracker/tasks/:id',
        });
      }
    }

    if (body.scheduled_start !== undefined) {
      if (body.scheduled_start === null) {
        // Remove schedule
        noteUnsettled(setNextRun(id, {
          at: null,
          reason: 'the owner removed the schedule on the dashboard; nothing fires again',
          alongside: {
            scheduled_start: null, repeat_interval: null, repeat_unit: null,
            repeat_end_type: null, repeat_end_value: null, repeat_days_of_week: null,
            anchor_local: null, schedule_status: 'unscheduled',
          },
        }), 'dashboard: schedule cleared on task edit', { taskId: id });
      } else {
        const { calculateNextRun } = await import('../../scheduler/engine.js');
        const existingTask = getTask(id);
        const repeatDaysOfWeek = (body.repeat_days_of_week ?? null) as string | null;
        // anchor_time: use the caller's if given, else preserve the existing anchor (so changing
        // repeat_interval does not reset it), else fall back to scheduled_start.
        const anchorTime = (
          body.anchor_time
          ?? existingTask?.anchorTime
          ?? body.scheduled_start
        ) as string;
        // The row's own zone (`getTask` does not project it): the walk runs on the clock the
        // owner set, not the box's.
        const taskZone = (getDb().prepare('SELECT tz FROM work WHERE id = ?').get(id) as { tz: string | null } | undefined)?.tz ?? null;
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
          tz: taskZone,
        };
        const nextRun = calculateNextRun(taskForCalc) ?? body.scheduled_start;

        // a schedule on a FINISHED task = run it again: reopen + arm land in one unit (or nothing does)
        const armErr = armScheduleOnOwnerSave(id, () => setNextRun(id, {
          at: tsToMs(nextRun),
          reason: 'the owner edited the schedule on the dashboard; the fire time was recomputed',
          alongside: {
            scheduled_start: tsToMs(body.scheduled_start),
            repeat_interval: body.repeat_interval ?? null,
            repeat_unit: body.repeat_unit ?? null,
            repeat_end_type: body.repeat_end_type ?? 'never',
            repeat_end_value: body.repeat_end_value ?? null,
            repeat_days_of_week: repeatDaysOfWeek,
            anchor_local: anchorTime,
            schedule_status: 'waiting',
            is_paused: 0,
          },
        }));
        if (armErr) return c.json({ ok: false, error: armErr, data: { taskId: id } }, 409);
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

// POST /projects/:id/close: bulk-close project and every open task on it
trackerRouter.post('/projects/:id/close', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const project = db.prepare(`SELECT w.id AS id FROM work w WHERE ${projectScope('w')} AND w.id = ?`).get(id);
  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  let body: { status?: string; reason?: string } = {};
  try {
    body = await c.req.json();
  } catch (err) {
    return routeFailure(c, logger, err, { status: 400, message: 'Body must be JSON: { status?: "complete"|"cancelled", reason: "…" }' });
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
    const result = closeProjectAndOpenTasks({ projectId: id, taskStatus: status as 'complete' | 'cancelled', reason });
    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to close project', { error: msg, projectId: id });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// DELETE /projects/:id: delete project and all its tasks
trackerRouter.delete('/projects/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const project = db.prepare(`SELECT w.id AS id FROM work w WHERE ${projectScope('w')} AND w.id = ?`).get(id);
  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  // Get task IDs for cascade
  const taskIds = db.prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.parent_id = ?`).all(id) as Array<{ id: string }>;
  const ids = taskIds.map(t => t.id);

  // Delete child rows for these tasks. An occurrence is a child of a TASK, so under a project it is a
  // grandchild, and `parent_id REFERENCES work(id)` has no cascade: `deleteTrackerRow(project)` removes only
  // the tasks, so the occurrences go first or a task that ever fired would fail the whole transaction on a
  // foreign key.
  if (ids.length > 0) {
    deleteOccurrencesOf(ids);
  }

  // Delete the project and its tasks (children first, inside one transaction).
  deleteTrackerRow(id);

  logger.info('Project deleted', { projectId: id, tasksDeleted: ids.length });
  return c.json({ ok: true, data: { projectId: id, tasksDeleted: ids.length } });
});

// DELETE /tasks/:id: delete a single task
trackerRouter.delete('/tasks/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const task = db.prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(id);
  if (!task) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  // No run cascade is owed here: an occurrence is a child of this task, and `deleteTrackerRow` deletes
  // children and their events in one transaction (under a project they are grandchildren, handled in the
  // route above).
  deleteTrackerRow(id);

  logger.info('Task deleted', { taskId: id });
  return c.json({ ok: true, data: { taskId: id } });
});

export { trackerRouter };

// The version-gap reconcile report: the detail behind the one plain line shown on first boot. It reads the
// durable `config` record rather than re-running the scan, so the report is the same every time it is
// opened.
trackerRouter.get('/reconcile-report', (c) => {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?')
      .get(VERSION_GAP_REPORT_KEY) as { value: string } | undefined;
    return c.json({ ok: true, data: { report: row ? JSON.parse(row.value) : null } });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});
