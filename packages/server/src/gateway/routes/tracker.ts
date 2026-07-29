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
  resolveTaskId,
  formatResolveError,
  setTaskStatus,
} from '../../tracker/schema.js';
import { getDb } from '../../db/connection.js';
import {
  taskScope, projectScope, awaitingUserVerdictExpr, revertCountExpr,
  STATE_TO_STATUS_SQL, type TrackerStatus,
} from '../../work/tracker-view.js';
import {
  upholdClaim, resetRevertCount, recordValidationEscalation, clearUserVerdict,
  patchWork, deleteTrackerRow, deliveryForTaskClose, deliveryForCompletedChildren,
} from '../../work/tracker-store.js';
import { statusToState, tsToMs } from '../../work/tracker-view.js';
import { createLogger } from '../../logger.js';
import { getPrimaryAgentId, getPMAgentId, getDashboardHiddenAgentIds } from '../../config/platform.js';

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
// v2.9.22: the actual hidden-agent set lives in config/platform.ts as
// getDashboardHiddenAgentIds() so the same definition is also reachable
// from non-route code (the auto-create gate in schema.ts uses it).
function hiddenAgentIdSet(): Set<string> {
  return getDashboardHiddenAgentIds();
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

  // v2.9.22: tasks assigned to system agents (PM/Healer/Dreamer) are
  // hidden by default because they're platform mechanics the user
  // shouldn't see in their kanban. BUT if such a task is in dispute
  // (PM has rejected it before, or it's been escalated to user
  // verdict, or it's an auto-created STALEMATE task), surface it so
  // the user can intervene. Otherwise these get stuck in pause/
  // in_progress loops with no user-visible surface to resolve them
  // (production incident 2026-06-07).
  //
  // revertCount and awaitingUserVerdict aren't on the Task shared
  // type, so pull the disputed-IDs in a single side query.
  const disputedSystemTaskIds = new Set<string>();
  if (hidden.size > 0) {
    try {
      const hiddenArr = Array.from(hidden);
      const placeholders = hiddenArr.map(() => '?').join(',');
      const rows = getDb().prepare(
        `SELECT w.id AS id FROM work w
         WHERE ${taskScope('w')} AND w.agent_id IN (${placeholders})
           AND (${revertCountExpr('w')} > 0
                OR ${awaitingUserVerdictExpr('w')} = 1
                OR w.title LIKE 'STALEMATE on %')`,
      ).all(...hiddenArr) as Array<{ id: string }>;
      for (const r of rows) disputedSystemTaskIds.add(r.id);
    } catch (err) {
      logger.warn('disputed-system-task lookup failed; surfacing none', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tasks = all.filter(t => {
    if (t.createdBy && hidden.has(t.createdBy)) return false;
    if (t.assignedTo && hidden.has(t.assignedTo)) {
      if (!disputedSystemTaskIds.has(t.id)) return false;
    }
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

// POST /tasks/:id/observation — user-added observation entry from dashboard (Phase B.0)
trackerRouter.post('/tasks/:id/observation', async (c) => {
  const rawId = c.req.param('id');
  let body: { note?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
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

// POST /tasks/:id/user-validate — user validates a complete/paused/blocked task from the dashboard.
// This is the user-side counterpart to tracker_validate_*. Bypasses PM entirely; user authority is final.
trackerRouter.post('/tasks/:id/user-validate', async (c) => {
  const rawId = c.req.param('id');
  const resolved = resolveTaskId(rawId);
  if (!resolved.ok) {
    return c.json({ ok: false, error: formatResolveError('task', rawId, resolved) }, 404);
  }

  const task = getTask(resolved.id);
  if (!task) return c.json({ ok: false, error: 'Task not found' }, 404);

  const { writeTaskLog } = await import('../../tracker/task-log.js');
  if (!['complete', 'paused', 'blocked'].includes(task.status)) {
    return c.json({ ok: false, error: `task status="${task.status}" cannot be user-validated (only complete/paused/blocked).` }, 400);
  }
  const flagColumn = `${task.status}_validated`;

  // PHASE-2 T8b: the flag is an ADJUDICATION now — the owner is an authority (G8), so their
  // verdict is a row with their name on it rather than a 1 in a column nobody signed.
  upholdClaim(resolved.id, statusToState(task.status), 'owner', 'user', 'user marked validated');
  recordValidationEscalation(resolved.id, 'user', null);

  writeTaskLog({
    taskId: resolved.id,
    fromEntity: 'user',
    entryKind: 'transition',
    fromStatus: task.status,
    toStatus: task.status,
    actionTaken: `user-validate via dashboard (${flagColumn}=1)`,
    reason: 'user marked validated',
  });

  const updated = getTask(resolved.id);
  if (updated) {
    const { broadcast } = await import('../../gateway/ws.js');
    broadcast({ type: 'tracker:task_updated', data: updated });
  }
  return c.json({ ok: true, data: { validated: true } });
});

// GET /tasks/:id/log — structured audit log entries for a task (Phase B.0)
trackerRouter.get('/tasks/:id/log', async (c) => {
  const rawId = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
  const kindsParam = c.req.query('kinds');
  const kinds = kindsParam
    ? (kindsParam.split(',').map((k) => k.trim()).filter(Boolean) as Array<
        'transition' | 'observation' | 'reject' | 'override' | 'evidence' |
        'directive' | 'poke' | 'auto_sweep' | 'smell_flag' |
        'user_verdict_request' | 'user_verdict_applied' | 'legacy_note'
      >)
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

    // Validation outcomes per from_entity (PM rejects vs blesses) over last 7 days.
    const validateOutcomes = db.prepare(`
      SELECT from_entity,
             SUM(CASE WHEN entry_kind = 'reject' THEN 1 ELSE 0 END) as rejects,
             SUM(CASE WHEN entry_kind = 'transition' AND action_taken LIKE '%valid=true%' THEN 1 ELSE 0 END) as validates
      FROM task_log
      WHERE datetime(created_at) > datetime('now', '-7 days')
        AND (entry_kind = 'reject' OR (entry_kind = 'transition' AND action_taken LIKE '%valid=%'))
      GROUP BY from_entity
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
      FROM task_log
      WHERE entry_kind = 'smell_flag'
        AND datetime(created_at) > datetime('now', '-7 days')
      GROUP BY category
    `).all() as Array<{ category: string; count: number }>;

    // Override request rollup (last 7 days).
    const overrideRollup = db.prepare(`
      SELECT status, COUNT(*) as count FROM task_override_requests
      WHERE datetime(created_at) > datetime('now', '-7 days')
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    // Tasks currently elevated: high revert_count or awaiting verdict.
    const elevated = db.prepare(`
      SELECT substr(w.id, 1, 8) as id8, w.title AS title,
             ${STATE_TO_STATUS_SQL('w.state')} AS status,
             ${revertCountExpr('w')} AS revert_count,
             ${awaitingUserVerdictExpr('w')} AS awaiting_user_verdict,
             w.last_smell_flag AS last_smell_flag
      FROM work w
      WHERE ${taskScope('w')}
        AND (${revertCountExpr('w')} >= 2 OR ${awaitingUserVerdictExpr('w')} = 1 OR w.last_smell_flag IS NOT NULL)
      ORDER BY revert_count DESC, w.updated_at DESC
      LIMIT 20
    `).all();

    // Per-model PM-call cost over last 24h (Phase D cost telemetry).
    // audit_log.target stores the model name on model_call rows. PM agent
    // id is config-driven (default 'pm', user-customizable via setup) —
    // don't hardcode a specific user's PM id here.
    const pmCost = db.prepare(`
      SELECT target as modelId,
             COUNT(*) as calls,
             ROUND(COALESCE(SUM(cost), 0), 4) as cost_24h
      FROM audit_log
      WHERE agent_id = ?
        AND action_type = 'model_call'
        AND datetime(created_at) > datetime('now', '-1 day')
      GROUP BY target
    `).all(getPMAgentId());

    return c.json({
      ok: true,
      data: {
        validateOutcomes,
        smellFlags,
        overrideRollup,
        elevated,
        pmCost,
      },
    });
  } catch (err) {
    logger.error('GET /hygiene failed', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'failed to compute hygiene metrics' }, 500);
  }
});

// POST /override-requests/:id/resolve — user (via dashboard) approves or denies an override.
// Mirrors the PM-side tracker_override tool but credits the user as the resolver.
trackerRouter.post('/override-requests/:id/resolve', async (c) => {
  const id = c.req.param('id');
  let body: { approve?: boolean; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
  }
  const approve = body.approve === true;
  const reason = (body.reason ?? '').trim();
  if (!reason) return c.json({ ok: false, error: 'reason is required' }, 400);

  try {
    const { getDb } = await import('../../db/connection.js');
    const db = getDb();
    const req = db.prepare(`
      SELECT id, task_id, requested_by, requested_status, status
      FROM task_override_requests WHERE id = ?
    `).get(id) as { id: string; task_id: string; requested_by: string; requested_status: string; status: string } | undefined;
    if (!req) return c.json({ ok: false, error: 'override request not found' }, 404);
    if (req.status !== 'pending') {
      return c.json({ ok: false, error: `override request is already ${req.status}` }, 400);
    }

    const { writeTaskLog } = await import('../../tracker/task-log.js');
    if (approve) {
      // Override approval is an AUTHORITATIVE decision by the owner, so it is one call:
      // `transition()` files the upheld adjudication in the same transaction as the move
      // (`claim: 'authoritative'`), which is what the three flag columns were imitating.
      const { setTaskStatus } = await import('../../tracker/schema.js');
      const updated = setTaskStatus(req.task_id, req.requested_status as TrackerStatus, {
        by: 'owner', actorId: 'user', claim: 'authoritative',
        reason: `owner approved override request ${id}: ${reason}`,
        resultDeliveryId: req.requested_status === 'complete' ? deliveryForTaskClose(req.task_id) : null,
      });
      if (!updated) return c.json({ ok: false, error: 'task vanished before override could be applied' }, 500);
      resetRevertCount(req.task_id, 'user', `override ${id} approved`);
      clearUserVerdict(req.task_id, 'user', `override ${id} approved`);
      db.prepare(`
        UPDATE task_override_requests
        SET status = 'approved', resolved_by = 'user', resolved_reason = ?, resolved_at = datetime('now')
        WHERE id = ?
      `).run(reason, id);
      writeTaskLog({
        taskId: req.task_id,
        fromEntity: 'user',
        entryKind: 'override',
        toStatus: req.requested_status,
        actionTaken: 'dashboard override(approve=true)',
        reason,
      });
      // D-K: an approved override to 'fallen' can be the transition that
      // empties the project of open tasks; run the fail-open check (idempotent).
      if (req.requested_status === 'fallen') {
        try {
          const { checkProjectCompletion } = await import('../../tracker/tools.js');
          checkProjectCompletion(updated.projectId, 'user:dashboard');
        } catch { /* best-effort */ }
      }
      logger.info('Override approved via dashboard', { taskId: req.task_id, requestId: id });
      return c.json({ ok: true, data: { approved: true } });
    }

    db.prepare(`
      UPDATE task_override_requests
      SET status = 'denied', resolved_by = 'user', resolved_reason = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(reason, id);
    writeTaskLog({
      taskId: req.task_id,
      fromEntity: 'user',
      entryKind: 'override',
      actionTaken: 'dashboard override(approve=false)',
      reason: `denied: ${reason}`,
    });
    // Best-effort A2A notification to the requesting agent.
    try {
      const { deliverA2AMessage } = await import('../../agent/a2a-transport.js');
      const { getPMAgentId } = await import('../../config/platform.js');
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: '',
        requiresResponse: true,
        payload: `Your override request on task ${req.task_id.slice(0, 8)} was denied by the user. Reason: ${reason}. Address the original engine objection and resubmit cleanly.`,
        toAgent: req.requested_by,
        fromAgent: getPMAgentId(),
      });
    } catch { /* best-effort */ }
    logger.info('Override denied via dashboard', { taskId: req.task_id, requestId: id });
    return c.json({ ok: true, data: { approved: false } });
  } catch (err) {
    logger.error('POST /override-requests/:id/resolve failed', { id, error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'failed to resolve override' }, 500);
  }
});

// GET /override-requests — list override requests, optionally filtered by status (Phase B.1)
trackerRouter.get('/override-requests', async (c) => {
  const statusParam = c.req.query('status');
  try {
    const { getDb } = await import('../../db/connection.js');
    const db = getDb();
    const allowed = new Set(['pending', 'approved', 'denied', 'auto_denied']);
    const where = statusParam && allowed.has(statusParam) ? `WHERE r.status = '${statusParam}'` : '';
    const rows = db.prepare(`
      SELECT r.id, r.task_id, r.requested_by, r.requested_status, r.justification,
             r.last_engine_error, r.attempts_attached, r.status, r.resolved_by,
             r.resolved_reason, r.created_at, r.resolved_at,
             t.title as task_title, t.goal as task_goal
      FROM task_override_requests r
      LEFT JOIN work t ON t.id = r.task_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all();
    return c.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('GET /override-requests failed', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'failed to load override requests' }, 500);
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
  // agent-side creator check in tracker_create_task.
  if (body.scheduled_start && body.repeat_unit === 'specific_days') {
    const { parseDaysOfWeek } = await import('../../scheduler/engine.js');
    if (!parseDaysOfWeek((body.repeat_days_of_week ?? null) as string | null)) {
      return c.json({
        ok: false,
        error: 'A "specific days" repeat needs at least one weekday selected (e.g. Mon and Wed). With no days selected the task would run once and then stop. Pick the days you want, or use a plain weekly repeat instead.',
      }, 400);
    }
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

      patchWork(taskId, {
        scheduled_start: tsToMs(body.scheduled_start),
        repeat_interval: body.repeat_interval ?? null,
        repeat_unit: body.repeat_unit ?? null,
        repeat_end_type: body.repeat_end_type ?? 'never',
        repeat_end_value: body.repeat_end_value ?? null,
        repeat_days_of_week: repeatDaysOfWeek,
        anchor_local: anchorTime,
        next_run_at: tsToMs(nextRun),
        schedule_status: 'waiting',
      });
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
      if (statusUpdate) {
        // The owner dragging a card IS the authority (Q5), so the transition carries
        // `claim: 'authoritative'` and files its own adjudication — the three
        // `*_validated = 1` assignments below used to do that by hand.
        setTaskStatus(id, statusUpdate as TrackerStatus, {
          by: 'owner', actorId: 'user', claim: 'authoritative',
          reason: 'dashboard PUT /tracker/tasks/:id',
          resultDeliveryId: statusUpdate === 'complete' ? deliveryForTaskClose(id) : null,
        });
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
        // The uphold rode the transition above (claim: 'authoritative'); the revert count
        // resets here, and only when the task is NOT awaiting the owner's verdict — those
        // have their own resolution path via the user-verdict verb.
        const awaiting = getDb().prepare(
          `SELECT ${awaitingUserVerdictExpr('w')} AS a FROM work w WHERE w.id = ?`,
        ).get(id) as { a: number } | undefined;
        if (awaiting?.a !== 1) resetRevertCount(id, 'user', 'dashboard transition');
        // D-K: a dashboard drag to 'fallen' can be the transition that empties
        // the project of open tasks; run the fail-open check (idempotent).
        // All-complete projects left active still have the Healer's
        // ORPHANED_PROJECT backstop; fallen-containing ones have no backstop,
        // so the needs-attention label must land at transition time.
        if (body.status === 'fallen') {
          // RC-17.5: a drag to 'fallen' on a live schedule must also STOP the
          // schedule, or the scheduler keeps firing it (the due query filters
          // only schedule_status/is_paused, not status). Mirror the tool path.
          try {
            const { terminateLiveScheduleOnFallen } = await import('../../scheduler/runner.js');
            terminateLiveScheduleOnFallen(id, 'the task was marked fallen from the dashboard');
          } catch { /* best-effort */ }
          try {
            const { checkProjectCompletion } = await import('../../tracker/tools.js');
            checkProjectCompletion(existing.projectId, 'user:dashboard');
          } catch { /* best-effort */ }
        }
      }
    }

    // Handle schedule updates
    if (body.scheduled_start !== undefined) {
      const db = getDb();
      if (body.scheduled_start === null) {
        // Remove schedule
        patchWork(id, {
          scheduled_start: null, repeat_interval: null, repeat_unit: null,
          repeat_end_type: null, repeat_end_value: null, repeat_days_of_week: null,
          anchor_local: null, next_run_at: null, schedule_status: 'unscheduled',
        });
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

        patchWork(id, {
          scheduled_start: tsToMs(body.scheduled_start),
          repeat_interval: body.repeat_interval ?? null,
          repeat_unit: body.repeat_unit ?? null,
          repeat_end_type: body.repeat_end_type ?? 'never',
          repeat_end_value: body.repeat_end_value ?? null,
          repeat_days_of_week: repeatDaysOfWeek,
          anchor_local: anchorTime,
          next_run_at: tsToMs(nextRun),
          schedule_status: 'waiting',
          is_paused: 0,
        });
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
      resultDeliveryId: status === 'complete' ? deliveryForCompletedChildren(id) : null,
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

  const project = db.prepare(`SELECT w.id AS id FROM work w WHERE ${projectScope('w')} AND w.id = ?`).get(id);
  if (!project) {
    return c.json({ ok: false, error: 'Project not found' }, 404);
  }

  // Get task IDs for cascade
  const taskIds = db.prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.parent_id = ?`).all(id) as Array<{ id: string }>;
  const ids = taskIds.map(t => t.id);

  // Delete child rows for these tasks
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM task_runs WHERE task_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM poke_log WHERE task_id IN (${ph})`).run(...ids);
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

  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM poke_log WHERE task_id = ?').run(id);
  deleteTrackerRow(id);

  logger.info('Task deleted', { taskId: id });
  return c.json({ ok: true, data: { taskId: id } });
});

export { trackerRouter };
