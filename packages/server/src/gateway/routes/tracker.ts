import { Hono } from 'hono';
import { createProject, getProject, listProjects, createTask, getTask, listTasksPage, updateTask, closeProjectAndOpenTasks, resolveTaskId, formatResolveError, setTaskStatusResult, broadcastTaskSettled } from '../../tracker/schema.js';
import { getDb } from '../../db/connection.js';
import {
  taskScope, projectScope, revertCountExpr,
  STATE_TO_STATUS_SQL, type TrackerStatus,
} from '../../work/tracker-view.js';
// SWEEP CORE-2 item 3 — the schedule's fire time has ONE writing module.
import { setNextRun } from '../../work/next-run.js';
import { armScheduleOnOwnerSave } from '../../tracker/finished-task-schedule.js';
import { VERSION_GAP_REPORT_KEY } from '../../tracker/version-gap-reconcile.js';
import { workSettled, isStateConflict, noteUnsettled } from '../../work/store.js';
import { deleteTrackerRow } from '../../work/tracker-store.js';
import { decide, type Verdict } from '../../work/done/decide.js';
import { tsToMs } from '../../work/tracker-view.js';
import { deleteOccurrencesOf } from '../../work/occurrences.js';
import { recordReassignment } from '../../tracker/assignee-patience.js';
import { createLogger } from '../../logger.js';
import type { TaskLogEntryKind } from '../../tracker/task-log.js';
import { getPrimaryAgentId, getPMAgentId, getDashboardHiddenAgentIds } from '../../config/platform.js';
import { routeFailure } from './route-failure.js';

const logger = createLogger('tracker-routes');
const trackerRouter = new Hono();

// ── Dashboard-only system-agent filter ──
//
// Projects/tasks owned by internal sensei agents (Dreamer's nightly
// vault cycles, the PM's bookkeeping, Healer's injury triage) are
// engine artifacts the user never asked for and shouldn't see in
// their kanban. Filtered out of the dashboard list endpoints by
// default; agent-side tools (work_update(action="list"), the PM agent's
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
// v2.9.22: the actual hidden-agent set lives in config/platform.ts as
// getDashboardHiddenAgentIds() so the same definition is also reachable
// from non-route code (the auto-create gate in schema.ts uses it).
function hiddenAgentIdSet(): Set<string> {
  return getDashboardHiddenAgentIds();
}

// The repeat units a schedule may name — the engine's accepted set; the
// dashboard's dropdown is a subset of it.
const REPEAT_UNITS = new Set([
  'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days',
]);

// A plain-words reason the schedule the dashboard sent cannot run, or null when it can.
// The check is about the INPUT, not the run: a start the engine cannot parse, an interval
// that is not a whole number of at least 1, a unit the form never offers, or an interval
// and a unit given without the other. Each of these would otherwise land as a "waiting"
// schedule that never fires, so it is refused before the first write.
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

// ── Tasks ──

// GET /tasks: list tasks with filters (hides internal sensei tasks). Re-review 2 (S4): the finished ones are
// paged (`closedBefore` + `closedBeforeId` for the page before; `closedHasOlder` says one exists).
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

  // Re-review 2 (S4): paged. The live tasks come whole on the first page; the finished ones a page at a
  // time, newest closed first, with the cursor of the oldest one the caller holds for the page before.
  const closedBefore = c.req.query('closedBefore');
  const closedBeforeId = c.req.query('closedBeforeId');
  // v2.9.22: tasks of the system agents (PM/Healer/Dreamer) are platform mechanics the owner should not
  // see on the board, so they are hidden by default; one in dispute (thrown back, awaiting the owner's
  // verdict, or a STALEMATE task) stays visible so he can intervene (production incident 2026-06-07).
  // Re-review 3 (M3): the hiding happens in the page's own query, before the page is cut, so a page of
  // hidden tasks can never stall the "show older" cursor. ?includeSystem=true shows them all.
  const page = listTasksPage(Object.keys(filter).length > 0 ? filter : undefined, {
    ...(closedBefore && closedBeforeId ? { before: { at: closedBefore, id: closedBeforeId } } : {}),
    ...(includeSystem ? {} : { hideAgentIds: hiddenAgentIdSet() }),
  });
  return c.json({ ok: true, data: page.tasks, closedHasOlder: page.closedHasOlder });
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

// POST /tasks/:id/observation — user-added observation entry from dashboard (Phase B.0)
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

// GET /tasks/:id/log — structured audit log entries for a task (Phase B.0)
trackerRouter.get('/tasks/:id/log', async (c) => {
  const rawId = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
  const kindsParam = c.req.query('kinds');
  // PHASE-2 T10G: the vocabulary has ONE owner (`TaskLogEntryKind`) instead of being restated
  // here. The inline copy had already drifted — it was missing the two verdict kinds the trail
  // now names — which is the same two-declarations-of-one-list problem this phase exists to end.
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

// GET /hygiene — Phase D: tracker hygiene + telemetry summary.
// Aggregates validate rates by entity, smell-flag frequency, override counts,
// revert counts, and recent gaming signals. Dashboard renders this as a panel.
trackerRouter.get('/hygiene', async (c) => {
  try {
    const { getDb } = await import('../../db/connection.js');
    const db = getDb();

    // Validation outcomes per adjudicator (rejects vs blesses) over the last 7 days.
    // PHASE-2 T10G: read from `adjudications`, the verdict record itself. The old statement
    // inferred these rates by string-matching `action_taken LIKE '%valid=true%'` on trail rows
    // labelled `transition` — the mislabel RULING 10 named (migration `146` has the numbers).
    const validateOutcomes = db.prepare(`
      SELECT by_agent AS from_entity,
             SUM(CASE WHEN verdict = 'rejected' THEN 1 ELSE 0 END) as rejects,
             SUM(CASE WHEN verdict = 'upheld' THEN 1 ELSE 0 END) as validates
      FROM adjudications
      WHERE created_at > (unixepoch('now') - 7 * 86400) * 1000
      GROUP BY by_agent
    `).all() as Array<{ from_entity: string; rejects: number; validates: number }>;

    // Smell flag counts by reason category (rough cluster) over last 7 days.
    const smellFlags = db.prepare(`
      SELECT
        CASE
          WHEN reason LIKE '%poke%' THEN 'poke-dodge'
          WHEN reason LIKE '%thrash%' THEN 'pause-resume thrash'
          ELSE 'other'
        END as category,
        COUNT(*) as count
      FROM (SELECT json_extract(payload, '$.reason') AS reason FROM work_events
             WHERE kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'smell_flag'
               AND created_at > (unixepoch('now') - 7 * 86400) * 1000)
      GROUP BY category
    `).all() as Array<{ category: string; count: number }>;

    // Tasks currently elevated: high revert_count or awaiting verdict.
    const elevated = db.prepare(`
      SELECT substr(w.id, 1, 8) as id8, w.title AS title,
             ${STATE_TO_STATUS_SQL('w.state')} AS status,
             ${revertCountExpr('w')} AS revert_count,
             w.last_smell_flag AS last_smell_flag
      FROM work w
      WHERE ${taskScope('w')}
        AND (${revertCountExpr('w')} >= 2 OR w.last_smell_flag IS NOT NULL)
      ORDER BY revert_count DESC, w.updated_at DESC
      LIMIT 20
    `).all();

    // Per-model PM-call cost over last 24h (Phase D cost telemetry).
    // audit_log.target stores the model name on model_call rows. PM agent
    // id is config-driven (default 'pm', user-customizable via setup) —
    // don't hardcode a specific user's PM id here.
    //
    // THE COMPARISON IS AGAINST THE RAW COLUMN, NOT A FUNCTION OF IT (t112, 2026-10-05).
    // This read used to ask `datetime(created_at) > datetime('now','-1 day')`. Wrapping the
    // indexed column makes that leg NON-SARGABLE: `idx_audit_log_agent_created
    // (agent_id, created_at)` can seek the agent, then SQLite evaluates `datetime()` on every
    // one of that agent's rows instead of seeking into a 24h window of them — so the cost
    // grows with the PM's whole history rather than with one day of it. MEASURED by
    // `db/__tests__/the-hot-audit-reads-take-their-index.test.ts` on a 200,000-row fixture:
    // 13.6-18.5 ms/call wrapped against ~0 sargable, and the plan loses `created_at>?`.
    //
    // The wrapper bought nothing. Every one of the seven writers that INSERT into this table
    // supplies `datetime('now')`, i.e. `YYYY-MM-DD HH:MM:SS`, which is already
    // lexicographically ordered — so a direct text compare against a bound in that same
    // format answers the identical question. That identity is asserted, not assumed: the
    // clause file above runs both spellings over the fixture and requires equal rows.
    const pmCost = db.prepare(`
      SELECT target as modelId,
             COUNT(*) as calls,
             ROUND(COALESCE(SUM(cost), 0), 4) as cost_24h
      FROM audit_log
      WHERE agent_id = ?
        AND action_type = 'model_call'
        AND created_at > datetime('now', '-1 day')
      GROUP BY target
    `).all(getPMAgentId());

    return c.json({
      ok: true,
      data: {
        validateOutcomes,
        smellFlags,
        elevated,
        pmCost,
      },
    });
  } catch (err) {
    logger.error('GET /hygiene failed', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'failed to compute hygiene metrics' }, 500);
  }
});


// POST /tasks — create standalone task
trackerRouter.post('/tasks', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.title !== 'string') {
    return c.json({ ok: false, error: 'title (string) is required' }, 400);
  }

  // FA-S4: reject a specific_days schedule with an empty/invalid day allowlist
  // BEFORE the row is created, so a config error fails loudly instead of
  // silently degrading to a single fire then complete (the scheduler's
  // specific_days walk can't advance with no allowed weekday). Only matters
  // when a schedule is actually written (scheduled_start present). Mirrors the
  // agent-side creator check in work_open(kind="task").
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
      // Same FK reason as POST /projects above — 'dashboard' isn't an agent.
      createdBy: getPrimaryAgentId(),
      priority: body.priority ?? undefined,
      stepNumber: body.stepNumber ?? undefined,
      dependsOn: body.dependsOn ?? undefined,
      phase: body.phase ?? undefined,
    });

    // T34: the view `createTask` just broadcast. The schedule below lands AFTER it, so the
    // settle frame at the end of this handler compares against this one — same seam, same
    // staleness, same fix as the agent's `work_open` door.
    const announced = getTask(taskId);

    // Handle scheduling if provided
    if (body.scheduled_start) {
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

      // SWEEP CORE-1 CT2 — AND THIS IS THE DOOR THE OWNER'S OWN BRIEFS COME THROUGH.
      // It has no `kind` field and never has, which is exactly why the deliverable declaration
      // is DERIVED from the task's definition here rather than asked for as a parameter: a
      // requirement that only the tool door can express would leave every schedule the owner
      // creates himself permanently undeclared, and that is the population his 2026-08-07
      // incident came from. Same call, same rules, same audit row as the tool door.
      const { declareDeliverableOnSchedule } = await import('../../work/deliverable-declaration.js');
      declareDeliverableOnSchedule(taskId);
    }

    // T34: the LAST frame for this id must equal the stored row. No-op when nothing settled.
    broadcastTaskSettled(taskId, announced);

    const task = getTask(taskId);
    return c.json({ ok: true, data: task }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to create task', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** The owner moving a card: a close or a cancel is his decision (`work/done/decide.ts`); any other
 *  move is a plain status change. Null when it landed, else why not. */
function ownerMoveRefusal(id: string, status: TrackerStatus): string | null {
  if (status === 'complete' || status === 'cancelled' || status === 'fallen') {
    const r = decide({ workId: id, deciderAgentId: null, verdict: status === 'complete' ? 'owner_done' : 'cancel', reason: `moved to ${status} on the dashboard task board` });
    return r.kind === 'decided' ? null : r.text;
  }
  const { result } = setTaskStatusResult(id, status, { by: 'owner', actorId: 'user', reason: 'dashboard PUT /tracker/tasks/:id' });
  if (workSettled(result)) return null;
  return isStateConflict(result) ? `the task moved to "${result.actual}" while this request was in flight` : `${result.reason}: ${result.detail}`;
}

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

  // FA-S4: this route fully overwrites the schedule from the body when
  // scheduled_start is set, so the effective unit/days are exactly the body's.
  // Reject a specific_days schedule with an empty/invalid day allowlist before
  // touching the row, so it fails loudly instead of degrading to a single fire
  // then complete. `!= null` covers both undefined (no schedule edit) and null
  // (the remove-schedule branch), neither of which writes specific_days.
  if (body.scheduled_start != null && body.repeat_unit === 'specific_days') {
    const { parseDaysOfWeek } = await import('../../scheduler/engine.js');
    if (!parseDaysOfWeek((body.repeat_days_of_week ?? null) as string | null)) {
      return c.json({
        ok: false,
        error: 'A "specific days" repeat needs at least one weekday selected (e.g. Mon and Wed). With no days selected the task would run once and then stop. Pick the days you want, or use a plain weekly repeat instead.',
      }, 400);
    }
  }

  // A bad schedule in the same Save must refuse the whole Save — the priority,
  // status and assignee writes below must not land when the schedule cannot run.
  // Gated on a schedule edit: null is the remove-schedule branch and is valid on its own.
  if (body.scheduled_start != null) {
    const scheduleErr = scheduleInputError(body);
    if (scheduleErr) return c.json({ ok: false, error: scheduleErr }, 400);
  }

  try {
    const updates: Record<string, string> = {};
    if (body.status) updates.status = body.status;
    if (body.assignedTo !== undefined) updates.assignedTo = body.assignedTo;
    if (body.priority) updates.priority = body.priority;

    // Phase B.0: dashboard observations go through task_log, not the
    // legacy tasks.notes column. Caller can still pass `notes` and we
    // route it as a user-observation entry for back-compat with older
    // dashboard builds.
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
      // Snapshot prior status BEFORE updateTask so the transition entry
      // is accurate. User dashboard transitions auto-validate the new
      // status (user is the ultimate authority — Q5).
      const prior = getTask(id);
      const fromStatus = prior?.status ?? null;
      const { status: statusUpdate, ...columnUpdates } = updates;
      if (Object.keys(columnUpdates).length > 0) updateTask(id, columnUpdates);
      // t90 D1: a PERSON moving a task is the only reassignment this platform still has — the PM
      // lost the verb entirely (owner ruling 2026-10-02) — so this is where it gets recorded: who,
      // why, and what the previous assignee was last seen doing, the half nobody can reconstruct
      // afterwards. `prior` above is the pre-write read; no second query.
      if (updates.assignedTo !== undefined && updates.assignedTo !== (prior?.assignedTo ?? null)) {
        recordReassignment({
          taskId: id, actor: 'user', fromAgentId: prior?.assignedTo ?? null,
          toAgentId: updates.assignedTo, reason: 'reassigned by a person through the dashboard',
        });
      }
      if (statusUpdate) {
        const refusal = ownerMoveRefusal(id, statusUpdate as TrackerStatus);
        if (refusal) {
          return c.json({
            ok: false,
            error: `status change to "${statusUpdate}" was refused, ${refusal}`,
            data: { taskId: id, refusedStatus: statusUpdate, otherUpdatesApplied: Object.keys(columnUpdates) },
          }, 409);
        }
      }
      if (body.status && body.status !== fromStatus) {
        const { writeTaskLog } = await import('../../tracker/task-log.js');
        writeTaskLog({
          taskId: id,
          fromEntity: 'user',
          entryKind: 'transition',
          fromStatus,
          toStatus: body.status,
          actionTaken: 'dashboard PUT /tracker/tasks/:id',
        });
        if (body.status === 'fallen' || body.status === 'cancelled') {
          // RC-17.5: a drag to a terminal column on a live schedule must also STOP the
          // schedule, or the scheduler keeps firing it (the due query filters
          // only schedule_status/is_paused, not status). Mirror the tool path.
          try {
            const { terminateLiveScheduleOnFallen } = await import('../../scheduler/runner.js');
            if (body.status === 'cancelled') {
              terminateLiveScheduleOnFallen(id, 'the task was cancelled from the dashboard', 'schedule terminated on cancel');
            } else {
              terminateLiveScheduleOnFallen(id, 'the task was marked fallen from the dashboard');
            }
          } catch { /* best-effort */ }
          // 2c: the project roll-up runs at the decision.
        }
      }
    }

    // Handle schedule updates
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
        // v2.5.45 — anchor_time. If caller provides one, use it. If not,
        // preserve the existing anchor on edit (so changing repeat_interval
        // doesn't reset the anchor). Falls back to scheduled_start only
        // when neither is set.
        const anchorTime = (
          body.anchor_time
          ?? existingTask?.anchorTime
          ?? body.scheduled_start
        ) as string;
        // The row's own zone (`getTask` does not project it) — the walk runs on the clock the
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

// POST /projects/:id/close — bulk-close project and every open task on it
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

// DELETE /projects/:id — delete project and all its tasks
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

  // Delete child rows for these tasks.
  // PHASE-2 T10F — AND THIS SITE WAS ALREADY BROKEN, which the absorption exposed rather
  // than caused. `deleteTrackerRow(project)` deletes the project's CHILDREN (the tasks); an
  // occurrence is a child of a TASK, so it is a GRANDCHILD, and `parent_id REFERENCES
  // work(id)` has no cascade. Since T8c2 started writing occurrence rows, deleting a project
  // whose task had ever fired would fail the whole transaction on a foreign key. Removing
  // the grandchildren first is what the old per-run delete line was doing by accident, and
  // now it is done on purpose. Logged as its own defect in DOJO-ISSUES-LOG.md.
  if (ids.length > 0) {
    deleteOccurrencesOf(ids);
  }

  // Delete the project and its tasks (children first, inside one transaction).
  deleteTrackerRow(id);

  logger.info('Project deleted', { projectId: id, tasksDeleted: ids.length });
  return c.json({ ok: true, data: { projectId: id, tasksDeleted: ids.length } });
});

// DELETE /tasks/:id — delete a single task
trackerRouter.delete('/tasks/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const task = db.prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(id);
  if (!task) {
    return c.json({ ok: false, error: 'Task not found' }, 404);
  }

  // PHASE-2 T10F: no separate run cascade is owed here — an occurrence is a CHILD of this
  // task, and `deleteTrackerRow` already deletes children and their events in one
  // transaction. (The project route above is different: there the occurrences are
  // grandchildren, which nothing was removing.)
  deleteTrackerRow(id);

  logger.info('Task deleted', { taskId: id });
  return c.json({ ok: true, data: { taskId: id } });
});

export { trackerRouter };

// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 3 — THE VERSION-GAP RECONCILE REPORT, so the ONE plain line has somewhere
// to point. The owner's requirement is *"ONE plain line on first boot with the detail in a
// report he can open"*; the line goes to the primary (OR2, the 2026-07-30 ruling) and this is
// the detail. It reads the durable `config` record rather than re-running the scan, because a
// report that recomputes itself is a different report every time you open it.
// ════════════════════════════════════════════════════════════════════════════════════════
trackerRouter.get('/reconcile-report', (c) => {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?')
      .get(VERSION_GAP_REPORT_KEY) as { value: string } | undefined;
    return c.json({ ok: true, data: { report: row ? JSON.parse(row.value) : null } });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});
