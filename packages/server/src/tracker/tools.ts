// Model-directed text from this subsystem rides postAgentNotice (a user-role engine row the model sees),
// never a bare role='system' row, which the model-context builder strips. Bare system rows here may carry
// only dashboard/owner-only notes, never an imperative the model is expected to act on.
import { getDb } from '../db/connection.js';
import { taskScope, projectScope, msToText, tsToMs, STATE_TO_STATUS_SQL, scheduleRowColumns, type TrackerStatus, stampColumns, engineScaffoldScope } from '../work/tracker-view.js';
import { workSettled, noteUnsettled, ownerHoldStands, OWNER_HOLD_REFUSAL } from '../work/store.js';
import { patchWork, setTrackerStatus } from '../work/tracker-store.js';
import { setNextRun } from '../work/next-run.js';
import { activityScope, PEER_WORK_NOTE } from '../work/peer-origin.js';
import { commitmentPositionLine } from '../work/obligation-memory.js';
import { findTaskOriginChain, renderTaskOriginChain } from './origin-chain.js';
import { engineProofLine } from '../work/done/proof.js';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from './task-stamps.js';
import { createLogger } from '../logger.js';
import { createProject, getProject, createTask, getTask, listTasks, listProjects, updateTask, updateProject, resolveTaskId, resolveProjectId, formatResolveError, setTaskStatusResult, broadcastTaskSettled } from './schema.js';
import { ensurePMAgentRunning } from './pm-agent.js';
import { injectTaskAssignmentNotification } from './notify.js';
import { writeTaskLog } from './task-log.js';
import { checkPlan, planRefusal, renderPlan, tasksFromPlan, explicitTasks, taskPlanMismatch } from '../work/plan.js';
import { planOfProject } from '../work/plan-store.js';
import { applyMeasureToTask, type MeasureReading } from './measure-gate.js';
import { normalizeTaskStatus, TERMINAL_STATUS_WORDS } from './task-status-words.js';
import { finishedScheduleRefusal, setsASchedule } from './finished-task-schedule.js';
import { taskReadWithNotes } from './task-notes-view.js';
import { linkLaterInstruction } from './later-instruction.js';
import { declareDeliverableOnSchedule, declaredDeliverableShape, findLiveRecurringTwin, DELIVERABLE_OWING_TASK_KINDS } from '../work/deliverable-declaration.js';
import { calculateNextRun, scheduledTaskFromRow, normalizeDbTimestamp, parseDaysOfWeek, wallToInstant, instantToWall, getBoxTimeZone, type WallClock } from '../scheduler/engine.js';
import { broadcast } from '../gateway/ws.js';
import { isPMAgent, isPrimaryAgent } from '../config/platform.js';
import { taskWriteRefusal, standardEditRefusal, escalationPointer } from '../work/row-authority.js';
import { turnContext, getWorkOriginForAgent } from '../agent/turn-context.js';
import { WORK_EDITABLE_TASK_FIELDS } from '../agent/work-verb-schema.js';
import { formatTimeForAgent } from '../services/format-time.js';
import { setHold, clearHold, ownerAskedToLift, holdOf, workingExpr } from '../work/done/hold.js';

const logger = createLogger('tracker-tools');

import { resolveAgentRef as resolveAgentName, compactCountNote } from '../agent/tool-helpers.js';


// The tracker read surfaces render the engine's stamp line from these columns; the live delivery-evidence
// join backfills rows that have no stamps.
function getTaskStampFields(taskId: string): TaskStampFields | null {
  try {
    return getDb().prepare(
      `SELECT w.id AS id, ${stampColumns('w')},
              w.step_number AS step_number, w.total_steps AS total_steps,
              w.parent_id AS project_id
         FROM work w WHERE w.id = ?`,
    ).get(taskId) as TaskStampFields | null;
  } catch {
    return null;
  }
}

// Local wall-clock schedule input. The model hands over the wall-clock time it means and the engine
// converts it with the scheduler's own wallToInstant, so the UTC offset is never the model's job. Accepts a
// tz-less "YYYY-MM-DDTHH:MM[:SS]" (or space separator) plus an optional IANA timezone (default: the box
// timezone).
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
export function resolveLocalWallClock(
  localTime: string,
  tz?: string,
): { ok: true; iso: string; zone: string } | { ok: false; error: string } {
  const m = WALL_CLOCK_RE.exec(localTime.trim());
  if (!m) {
    return {
      ok: false,
      error:
        `Error: local_time="${localTime}" must be a wall-clock time with NO timezone offset, in the form ` +
        `"YYYY-MM-DDThh:mm" or "YYYY-MM-DD hh:mm[:ss]" (24-hour), e.g. "2026-07-16T21:00" for 9 PM. ` +
        `The engine converts it to the correct instant for the box timezone, do NOT do the UTC math yourself. ` +
        `Pass local_timezone (IANA, e.g. "America/Los_Angeles") if it should be resolved in a specific zone.`,
    };
  }
  const zone = tz && tz.trim() ? tz.trim() : getBoxTimeZone();
  const wall: WallClock = {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: m[6] ? Number(m[6]) : 0,
  };
  try {
    const instant = wallToInstant(wall, zone);
    if (isNaN(instant.getTime())) {
      return { ok: false, error: `Error: local_time="${localTime}" in timezone "${zone}" did not resolve to a valid instant.` };
    }
    // The regex checks shape, not sense: Feb 31 or hour 25 would be normalised into a day nobody asked for.
    // A time inside a spring-forward gap still round-trips to the same day, so it stays accepted.
    const back = instantToWall(instant.getTime(), zone);
    if (
      wall.hour > 23 || wall.minute > 59 || wall.second > 59 ||
      back.year !== wall.year || back.month !== wall.month || back.day !== wall.day
    ) {
      return { ok: false, error: `Error: local_time="${localTime}" is not a real date or clock time (check the month, day and hour). Nothing was scheduled; re-call with a real local_time.` };
    }
    return { ok: true, iso: instant.toISOString(), zone };
  } catch (err) {
    return { ok: false, error: `Error: could not resolve local_time="${localTime}" in timezone "${zone}": ${err instanceof Error ? err.message : String(err)}.` };
  }
}

// One-line wall-clock echo for any schedule write, so the local time sits beside the canonical UTC instant;
// formatTimeForAgent renders both forms.
function scheduleEchoLines(scheduledStartIso: string | null, nextRunIso: string | null): string[] {
  const lines: string[] = [];
  if (scheduledStartIso) {
    lines.push(`Scheduled (local): ${formatTimeForAgent(scheduledStartIso)}`);
  }
  if (nextRunIso) {
    lines.push(`Next run (local): ${formatTimeForAgent(nextRunIso)}`);
  }
  if (scheduledStartIso || nextRunIso) {
    // The cheaper local_time route is offered because both work verbs declare it and all three doors
    // forward it.
    lines.push('If this local time is NOT what the user asked for, re-call with the corrected time — either as an ISO 8601 UTC instant, or as local_time="YYYY-MM-DDThh:mm" and let the engine do the timezone conversion.');
  }
  return lines;
}

// The one reading of a time the model gave: what `new Date` reads, so a time with no offset is box-local.
const modelTimeMs = (v: unknown): number | null => {
  const ms = typeof v === 'string' && v !== '' ? new Date(v).getTime() : NaN;
  return Number.isNaN(ms) ? null : ms;
};

const REPEAT_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days'];
const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

// Why a schedule could never run, in one plain sentence, or null when it can. It judges the values the row
// holds after the write: `changes` over `current` (a new anchor is read from `changes` only). The agent
// doors and the dashboard's routes all ask this one check before they write.
export function scheduleError(changes: Record<string, unknown>, current: Record<string, unknown> = {}): string | null {
  const s: Record<string, unknown> = { ...current, anchor_time: undefined };
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) s[k] = v;
  for (const time of [s.scheduled_start, s.anchor_time]) {
    if (isSet(time) && modelTimeMs(time) === null) return `The time "${String(time)}" cannot be read as a date, so the schedule could never run.`;
  }
  const interval = s.repeat_interval;
  const unit = isSet(s.repeat_unit) ? String(s.repeat_unit) : null;
  const num = typeof interval === 'number' ? interval : Number(interval);
  if (isSet(interval) && !(Number.isInteger(num) && num >= 1)) {
    return `The repeat interval "${String(interval)}" must be a whole number of 1 or more; zero, negative or fractional numbers cannot repeat.`;
  }
  if (unit && !REPEAT_UNITS.includes(unit)) return `The repeat unit "${unit}" is not one of: ${REPEAT_UNITS.join(', ')} ("weekly" is every 1 weeks).`;
  if (isSet(interval) && !unit) return 'A repeat interval needs a repeat unit, or the task would run once and never again.';
  if (unit && !isSet(interval) && unit !== 'specific_days') return `A repeat unit of "${unit}" needs a repeat interval (for example 1, for every ${unit.replace(/s$/, '')}).`;
  if (unit === 'specific_days' && !parseDaysOfWeek(isSet(s.repeat_days_of_week) ? String(s.repeat_days_of_week) : null)) {
    return 'A "specific days" repeat needs at least one weekday, or the task would run once and never repeat.';
  }
  if (unit && !isSet(s.scheduled_start)) return 'A repeating schedule needs a first run time, or it never runs.';
  return null;
}

// The agent doors' form of the schedule refusal: the plain sentence, then how a model fixes it.
function toolScheduleError(changes: Record<string, unknown>, current?: Record<string, unknown>): string | null {
  const why = scheduleError(changes, current);
  return why && `Error: ${why} Nothing was saved. Give a time as scheduled_start, an ISO 8601 UTC timestamp (call `
    + 'get_current_time to resolve "tomorrow" or "in 2 hours"), or as local_time="YYYY-MM-DDThh:mm"; a reminder\'s first time is `when`; '
    + 'a repeat is repeat_interval with repeat_unit. If you do not know when it should run, ask the person you are talking to.';
}

// A task given to a group is held by one of its live members: an idle one first, then the least loaded.
export function groupMember(groupId: string): { ok: true; id: string } | { ok: false; error: string } {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(groupId)) {
    return { ok: false, error: `Error: agent group '${groupId}' does not exist. Nothing was assigned.` };
  }
  const member = db.prepare(`
    SELECT id FROM agents
    WHERE group_id = ? AND status IN ('idle', 'working') AND classification != 'sensei'
    ORDER BY
      CASE status WHEN 'idle' THEN 0 ELSE 1 END,
      (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.agent_id = agents.id AND ${workingExpr('w')}) ASC
    LIMIT 1
  `).get(groupId) as { id: string } | undefined;
  return member
    ? { ok: true, id: member.id }
    : { ok: false, error: `Error: nobody in agent group '${groupId}' is free to take work (its members are shut down or parked). Nothing was assigned; give it to a named agent instead.` };
}


// ── trackerCreateProject ──

// Low-information words that must not drive a near-duplicate match on their own.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'by', 'from', 'is', 'as', 'at', 'be', 'this', 'that', 'these', 'those',
  'project', 'task', 'work', 'plan', 'review', 'new',
]);

function normalizeTitle(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

interface DuplicateMatch {
  id: string;
  title: string;
  createdMinutesAgo: number;
  /** True when the existing project was opened by the engine on the agent's most recent user turn (not by the
   * agent calling work_open(kind="project") themselves). */
  engineAutoCreated: boolean;
  /** First in_progress / on_deck task on the existing project, if any, 
   * the natural target for work_update(action="edit"). */
  firstOpenTask: { id: string; title: string } | null;
}

/**
 * Near-duplicate guard with two prongs: (a) an engine-opened scaffold row for the same ask (same source
 * message, else created in the last 5 minutes), which the agent should edit rather than parallel whatever
 * the title similarity; (b) a token-Jaccard fallback for agent-vs-agent duplicates (>= 0.6 overlap, >= 2
 * shared content tokens, last 60 minutes).
 */
function findRecentNearDuplicateProject(
  creatorId: string,
  title: string,
): DuplicateMatch | null {
  const db = getDb();

  // (a) An engine scaffold born from the same ask as the creating agent's current turn is the duplicate by
  //     identity (source_message_id); the 5-minute window below is only the fallback for rootless rows.
  const turnRoot = turnContext(creatorId)?.root ?? null;
  const rootMatch = turnRoot?.sourceMessageId ? db.prepare(`
    SELECT w.id AS id, w.title AS title, ${msToText('w.opened_at')} AS created_at FROM work w
    WHERE ${projectScope('w')} AND w.requester_id = ?
      AND w.state = 'open'
      AND w.origin_kind = 'engine_scaffold'
      AND w.source_message_id = ?
    ORDER BY w.opened_at DESC
    LIMIT 1
  `).get(creatorId, turnRoot.sourceMessageId) as { id: string; title: string; created_at: string } | undefined : undefined;
  // The fallback reads the row's own root_kind and covers parentless tasks too: the engine floor opens a
  // task, and a project opened right after it is the parallel work this prong steers away from.
  const engineAuto = rootMatch ?? db.prepare(`
    SELECT w.id AS id, w.title AS title, ${msToText('w.opened_at')} AS created_at FROM work w
    WHERE ${engineScaffoldScope('w')} AND w.requester_id = ?
      AND ${workingExpr('w', true)}
      AND w.opened_at >= ?
    ORDER BY w.opened_at DESC
    LIMIT 1
  `).get(creatorId, Date.now() - 5 * 60_000) as { id: string; title: string; created_at: string } | undefined;

  if (engineAuto) {
    const createdMs = new Date(engineAuto.created_at.includes('Z') ? engineAuto.created_at : engineAuto.created_at + 'Z').getTime();
    const firstOpen = db.prepare(`
      SELECT w.id AS id, w.title AS title FROM work w
      WHERE ${taskScope('w')} AND w.parent_id = ? AND ${workingExpr('w', true)}
      ORDER BY w.step_number ASC NULLS LAST, w.opened_at ASC
      LIMIT 1
    `).get(engineAuto.id) as { id: string; title: string } | undefined;
    return {
      id: engineAuto.id,
      title: engineAuto.title,
      createdMinutesAgo: Math.max(1, Math.round((Date.now() - createdMs) / 60000)),
      engineAutoCreated: true,
      firstOpenTask: firstOpen ?? null,
    };
  }

  // (b) Jaccard fallback for agent-created near-dups.
  const recent = db.prepare(`
    SELECT w.id AS id, w.title AS title, ${msToText('w.opened_at')} AS created_at FROM work w
    WHERE ${projectScope('w')} AND w.requester_id = ?
      AND w.state = 'open'
      AND w.opened_at >= ?
    ORDER BY w.opened_at DESC
    LIMIT 20
  `).all(creatorId, Date.now() - 60 * 60_000) as Array<{ id: string; title: string; created_at: string }>;

  if (recent.length === 0) return null;

  const newTokens = normalizeTitle(title);
  if (newTokens.length === 0) return null;
  const newSet = new Set(newTokens);

  for (const row of recent) {
    const oldTokens = normalizeTitle(row.title);
    if (oldTokens.length === 0) continue;
    const oldSet = new Set(oldTokens);

    const intersection = new Set([...newSet].filter(w => oldSet.has(w)));
    if (intersection.size < 2) continue;

    const union = new Set([...newSet, ...oldSet]);
    const jaccard = intersection.size / union.size;
    if (jaccard >= 0.6) {
      const createdMs = new Date(row.created_at.includes('Z') ? row.created_at : row.created_at + 'Z').getTime();
      const firstOpen = db.prepare(`
        SELECT w.id AS id, w.title AS title FROM work w
        WHERE ${taskScope('w')} AND w.parent_id = ? AND ${workingExpr('w', true)}
        ORDER BY w.step_number ASC NULLS LAST, w.opened_at ASC
        LIMIT 1
      `).get(row.id) as { id: string; title: string } | undefined;
      return {
        id: row.id,
        title: row.title,
        createdMinutesAgo: Math.max(1, Math.round((Date.now() - createdMs) / 60000)),
        engineAutoCreated: false,
        firstOpenTask: firstOpen ?? null,
      };
    }
  }
  return null;
}

export function trackerCreateProject(agentId: string, args: Record<string, unknown>, opts: { taskMeasures?: Array<MeasureReading | undefined>; scaleFacts?: string } = {}): string {
  try {
    const title = args.title as string;
    if (!title) return 'Error: title is required';

    const level = typeof args.level === 'number' ? args.level : 1;

    // A project opens with the plan its agent wrote (approach, and steps saying what, how at scale and how
    // done is known). The engine checks the parts are present and stores them without judging content.
    // Tasks are the plan's steps unless the caller passed its own, so a project always has a task for the
    // PM to poke.
    const planned = checkPlan(args.plan);
    const scale = opts.scaleFacts ? `\n\n${opts.scaleFacts}` : '';   // what the agent's tools do in one call, in front of it as it plans
    if (!planned.ok) return planRefusal(planned.error) + scale;
    const plan = planned.plan;
    const description = renderPlan(plan);
    const given = explicitTasks(args.tasks as Array<{ title: string; description?: string; goal?: string; assignedTo?: string; priority?: 'high' | 'normal' | 'low'; stepNumber?: number; dependsOn?: string[]; phase?: number }> | undefined);
    const mismatch = given ? taskPlanMismatch(given.length, plan) : null;
    if (mismatch) return planRefusal(mismatch) + scale;
    // Task i IS plan step i+1 (the board shows a task its own step), whatever step number the caller put on it.
    const tasksInput: NonNullable<typeof given> = given
      ? given.map((t, i) => ({ ...t, stepNumber: i + 1, description: t.description ?? plan.steps[i].how, goal: t.goal ?? plan.steps[i].done }))
      : tasksFromPlan(plan);

    // Resolve inline task assignees (name or short id -> full agent id) before anything is written:
    // assigned_to has a foreign key to agents(id), so a raw name would fail mid-create and strand an empty
    // project row. Same resolver and teaching error as the standalone work_open(kind="task") verb.
    for (const t of tasksInput) {
      const raw = t as Record<string, unknown>;
      const ref = (typeof raw.assignedTo === 'string' && raw.assignedTo) ||
                  (typeof raw.assigned_to === 'string' && raw.assigned_to) || '';
      if (ref.trim().length > 0) {
        const r = resolveAgentName(ref);
        if (!r.ok) return r.error;
        t.assignedTo = r.id;
      }
    }

    // Duplicate guard for an agent that lost its project to compaction and creates a near-identical one.
    // allow_duplicate=true overrides it (genuinely independent re-runs).
    const allowDuplicate = args.allow_duplicate === true;
    if (!allowDuplicate) {
      const dup = findRecentNearDuplicateProject(agentId, title);
      if (dup) {
        const shortPid = dup.id.slice(0, 8);
        const firstTaskHint = dup.firstOpenTask
          ? ` First open task: "${dup.firstOpenTask.title}" (id=${dup.firstOpenTask.id.slice(0, 8)}).`
          : '';
        if (dup.engineAutoCreated) {
          // The engine auto-opened this project for the current user turn, so the agent's own create
          // duplicates it. Answer with an OK-shaped no-op naming the existing project and its first task,
          // so the agent continues in it instead of being refused.
          return (
            `[OK] Already tracked, no new project created. The engine auto-opened project "${dup.title}" (id=${shortPid}) for this request, so you don't need to create one, keep going in it.${firstTaskHint} ` +
            `Continue inside it: work_update(action="edit", task_id=<id>, title=..., description=...) to refine the first task, ` +
            `work_open(kind="task", project_id="${shortPid}", title=..., step_number=..., assigned_to=...) to add more steps. ` +
            `(If you genuinely need a separate, unrelated project, retry with allow_duplicate=true.)`
          );
        }
        return (
          `Refused: project "${dup.title}" (id=${shortPid}) was already created by you ${dup.createdMinutesAgo} minute(s) ago and is still active, the new title "${title}" looks like a near-duplicate.${firstTaskHint} ` +
          `Use the existing project: work_update(action="get", id="${shortPid}") to see current tasks, work_update(action="edit") to rename/rescope a task, work_open(kind="task", project_id="${shortPid}", ...) to add new steps. ` +
          `If this really is unrelated work that happens to share keywords, retry with allow_duplicate=true.`
        );
      }
    }

    const result = createProject({
      origin: getWorkOriginForAgent(agentId, 'model'),
      title,
      description,
      level,
      createdBy: agentId,
      tasks: tasksInput,
      plan,
    });

    // Give every inline task a goal (PM cannot validate a task with none): the caller's goal, else the
    // task's description, else its title. Only fills when empty, never overwrites a real goal.
    const measureLines = result.taskIds.map((id, i) => { const m = opts.taskMeasures?.[i]; return m ? applyMeasureToTask(id, m, { setBy: agentId, atOpen: true }) : null; });
    for (let i = 0; i < result.taskIds.length; i++) {
      const id = result.taskIds[i];
      const t = getTask(id);
      if (!t) continue;
      const provided = typeof tasksInput?.[i]?.goal === 'string' ? (tasksInput[i].goal as string).trim() : '';
      const goal = provided || (t.description ? t.description.trim() : '') || (t.title ? t.title.trim() : '');
      if (!goal) continue;
      try {
        if (!t.goal) noteUnsettled(patchWork(id, { goal }, { touch: false }), 'trackerCreateProject: goal backfilled onto an existing project', { taskId: id });
      } catch (err) {
        logger.warn('Failed to default goal on inline project task (non-fatal)', { taskId: id, error: err instanceof Error ? err.message : String(err) }, agentId);
      }
    }

    try {
      ensurePMAgentRunning();
    } catch (err) {
      logger.warn('Failed to ensure PM agent is running', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    let taskSummary = '';
    if (result.taskIds.length > 0) {
      const taskLines = result.taskIds.map((id, i) => {
        const t = getTask(id);
        const step = t?.stepNumber !== null ? ` (step ${t?.stepNumber})` : '';
        const status = t?.status ?? 'on_deck';
        return `  ${i + 1}. "${t?.title ?? 'Unknown'}", ID: ${id}${step} [${status}]${measureLines[i] ? ` ${measureLines[i]}` : ''}`;
      });
      taskSummary = `\nTasks (${result.taskIds.length}):\n${taskLines.join('\n')}`;
    }

    // Notify assignees of nested tasks (skips the creator's own), as trackerCreateTask does.
    for (const taskId of result.taskIds) {
      const t = getTask(taskId);
      if (!t || !t.assignedTo) continue;
      // Skip tasks with a future scheduled_start, scheduler handles those
      if (t.scheduledStart) {
        const scheduledMs = new Date(t.scheduledStart.includes('Z') ? t.scheduledStart : t.scheduledStart + 'Z').getTime();
        if (scheduledMs > Date.now()) continue;
      }
      injectTaskAssignmentNotification({
        assignedAgentId: t.assignedTo,
        creatorAgentId: agentId,
        taskId,
        title: t.title,
        description: t.description ?? null,
        projectId: result.projectId,
        priority: t.priority ?? null,
      });
    }

    return `[OK] project_id=${result.projectId} | title=${title}\n\nProject created successfully.\n\n${description}${taskSummary}${scale}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCreateProject failed', { error: msg }, agentId);
    return `Error creating project: ${msg}`;
  }
}

// ── trackerCreateTask ──

export async function trackerCreateTask(agentId: string, args: Record<string, unknown>, opts: { measure?: MeasureReading } = {}): Promise<string> {
  try {
    const title = args.title as string;
    if (!title) return 'Error: title is required';

    const projectId = args.projectId as string | undefined;
    const description = args.description as string | undefined;
    // Goal is required on every new task: PM compares result and evidence against it. Accepts `goal` or the
    // legacy alias `goal_description`; an empty string is rejected.
    let goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    if (!goal && typeof description === 'string' && description.trim()) {
      // A goal the caller omitted defaults to the description (logged).
      goal = description.trim();
      logger.info('work_open(kind="task"): goal omitted, defaulted from description', { agentId, title }, agentId);
    }
    if (!goal) {
      return 'Error: `goal` is required. One-sentence definition of done that PM will compare result + evidence against. Example: goal="migrate all 12 routes under packages/server/src/gateway/routes/ to the new auth middleware, with each route\'s tests passing".';
    }
    // Default assigned_to to the calling agent; an agent name is resolved to its id.
    let assignedTo = (args.assignedTo as string | undefined) ?? agentId;
    if (assignedTo) {
      const r = resolveAgentName(assignedTo);
      if (!r.ok) return r.error;
      assignedTo = r.id;
    }
    if (projectId) {
      const projectRow = getDb().prepare(`SELECT 1 FROM work w WHERE ${projectScope('w')} AND w.id = ?`).get(projectId);
      if (!projectRow) {
        return `Error: project '${projectId}' does not exist (it may have been deleted or completed). Call work_update(action="list") to see current projects, or omit projectId to start a fresh one.`;
      }
    }
    const priority = args.priority as 'high' | 'normal' | 'low' | undefined;
    const stepNumber = args.stepNumber as number | undefined;
    const dependsOn = args.dependsOn as string[] | undefined;
    const phase = args.phase as number | undefined;

    // local_time (a tz-less wall clock) is converted engine-side into scheduled_start; an explicit
    // scheduled_start wins if both are given. The anchor defaults to scheduled_start downstream, so only
    // the start is set here.
    let resolvedScheduleZone: string | null = null;
    if (args.local_time !== undefined && args.local_time !== null && args.local_time !== '' && !args.scheduled_start) {
      if (typeof args.local_time !== 'string') {
        return 'Error: local_time must be a string wall-clock time, e.g. "2026-07-16T21:00".';
      }
      const tz = (args.local_timezone ?? args.tz) as string | undefined;
      const resolved = resolveLocalWallClock(args.local_time, typeof tz === 'string' ? tz : undefined);
      if (!resolved.ok) return resolved.error;
      args.scheduled_start = resolved.iso;
      // Keep the resolved zone so the per-reminder zone the tool advertises is recorded with the row;
      // otherwise calendar-unit advances would resolve against the process timezone.
      resolvedScheduleZone = resolved.zone;
    }

    { const no = toolScheduleError(args); if (no) return no; }
    if (args.assigned_to_group) {
      const member = groupMember(String(args.assigned_to_group));
      if (!member.ok) return member.error;
      assignedTo = member.id;
    }

    // Near-duplicate guard for tool-error loops that re-create the same task. Both prongs use a 5-minute
    // window: (a) exact title by the same creator and assignee; (b) Jaccard >= 0.6 on normalised content
    // tokens with at least 2 shared. allow_duplicate=true overrides a false positive.
    const allowDuplicate = (args.allow_duplicate as boolean) ?? false;
    if (!allowDuplicate) {
      const db = getDb();
      const exact = db.prepare(`
        SELECT w.id AS id, substr(w.id, 1, 8) as id8 FROM work w
        WHERE ${taskScope('w')} AND w.requester_id = ?
          AND LOWER(w.title) = LOWER(?)
          AND COALESCE(w.assignee_agent, '') = COALESCE(?, '')
          AND ${workingExpr('w', true)}
          AND w.opened_at >= ?
        ORDER BY w.opened_at DESC
        LIMIT 1
      `).get(agentId, title, assignedTo ?? null, Date.now() - 5 * 60_000) as { id: string; id8: string } | undefined;
      if (exact) {
        return (
          `Error: a task with this exact title was created by you in the last 5 minutes (id=${exact.id8}, assigned to the same agent). ` +
          `If you meant to update that task, call work_update(action="status") / work_update(action="edit") on id=${exact.id8}. ` +
          `If this is genuinely separate work that happens to share a title, re-call with allow_duplicate=true.`
        );
      }

      const newTokens = normalizeTitle(title);
      if (newTokens.length >= 2) {
        const newSet = new Set(newTokens);
        const recent = db.prepare(`
          SELECT w.id AS id, w.title AS title, substr(w.id, 1, 8) as id8 FROM work w
          WHERE ${taskScope('w')} AND w.requester_id = ?
            AND ${workingExpr('w', true)}
            AND w.opened_at >= ?
          ORDER BY w.opened_at DESC
          LIMIT 20
        `).all(agentId, Date.now() - 5 * 60_000) as Array<{ id: string; title: string; id8: string }>;
        for (const row of recent) {
          const oldTokens = normalizeTitle(row.title);
          if (oldTokens.length < 2) continue;
          const oldSet = new Set(oldTokens);
          const intersection = new Set([...newSet].filter(w => oldSet.has(w)));
          if (intersection.size < 2) continue;
          const union = new Set([...newSet, ...oldSet]);
          const jaccard = intersection.size / union.size;
          if (jaccard >= 0.6) {
            return (
              `Error: a near-duplicate task "${row.title}" (id=${row.id8}) was created by you in the last 5 minutes (token-overlap ${(jaccard * 100).toFixed(0)}%). ` +
              `If you meant to update that task, call work_update(action="status") / work_update(action="edit") on id=${row.id8}. ` +
              `If this is genuinely separate work, re-call with allow_duplicate=true.`
            );
          }
        }
      }
    }

    // Duplicate recurring guard. Unlike the prongs above it has NO time window: a live recurring schedule
    // is a standing instruction, so two with the same owner, cadence and deliverable shape would be carried
    // out twice indefinitely. Cadence is repeat_interval + repeat_unit + repeat_days_of_week, deliberately
    // not the anchor (a recreated twin usually has a different one). The deliverable shape comes from the
    // declaration in work/deliverable-declaration.ts. Only live schedules count, so replacing a stopped one
    // stays allowed. allow_duplicate overrides it, the same flag as the prongs above.
    let judged: Awaited<ReturnType<typeof declaredDeliverableShape>> | undefined;
    if (!allowDuplicate && args.repeat_interval) {
      const shape = judged = await declaredDeliverableShape({
        kind: args.kind as string | undefined,
        title,
        description: description ?? null,
        goal,
        hasSchedule: true,
        agentId,
      });
      if (shape && DELIVERABLE_OWING_TASK_KINDS.includes(shape.shape)) {
        const twin = findLiveRecurringTwin({
          creatorId: agentId,
          shape: shape.shape,
          repeatInterval: (args.repeat_interval as number | undefined) ?? null,
          repeatUnit: (args.repeat_unit as string | undefined) ?? null,
          repeatDaysOfWeek: (args.repeat_days_of_week as string | undefined) ?? null,
        });
        if (twin) {
          const id8 = twin.id.slice(0, 8);
          const nextRun = twin.nextRunAt ? new Date(twin.nextRunAt).toISOString() : null;
          return (
            `Error: a recurring "${shape.shape}" on this exact schedule already exists and is still live: `
            + `"${twin.title ?? twin.id}" (id=${id8}${nextRun ? `, next run ${nextRun}` : ''}). `
            + `Creating this one would deliver the same thing twice, every time, for ever.\n\n`
            + `If you are FIXING the existing one (wrong time, wrong wording, wrong timezone), edit it: `
            + `work_update(action="edit") on id=${id8}. If you are REPLACING it, stop the old one first: `
            + `work_schedule(action="pause") or work_update(action="status", status="cancelled") on id=${id8}, `
            + `then create this. If you genuinely want both to fire, re-call with allow_duplicate=true.`
          );
        }
      }
    }

    const taskId = createTask({
      origin: getWorkOriginForAgent(agentId, (args.kind as string | undefined) === 'reminder' ? 'reminder' : 'model'),
      projectId,
      title,
      description,
      assignedTo,
      createdBy: agentId,
      priority,
      stepNumber,
      dependsOn,
      phase,
      kind: args.kind as string | undefined,
      // The goal rides the INSERT so the announcement frame is complete rather than patched after the
      // broadcast.
      goal,
    });
    const measureSet = opts.measure ? applyMeasureToTask(taskId, opts.measure, { setBy: agentId, atOpen: true }) : null;

    // The view createTask put on the wire. Later writes (on_deck transition, fire time, group) change the
    // row after it, so the settle frame at the end compares against this one and corrects the wire if the
    // row moved.
    const announced = getTask(taskId);

    // 'on_deck' is reserved for tasks with a future scheduled_start (the scheduler moves them to
    // in_progress at fire time); everything else lands in_progress so the assignee and PM keep seeing it as
    // work to do. The schema default is in_progress, overridden to on_deck only when a future schedule
    // justifies it.
    let scheduledStart = args.scheduled_start as string | undefined;
    if (scheduledStart) {
      // Parseability was validated before the row was created; this normalizes to ISO.
      const parsed = new Date(scheduledStart);
      if (!isNaN(parsed.getTime())) scheduledStart = parsed.toISOString();
    }
    // True only when scheduled_start is in the future (a past one means fire ASAP and lands in_progress) or
    // repeat_interval is set (recurring tasks always go through the scheduler).
    const scheduledStartIsFuture = !!(
      scheduledStart && new Date(scheduledStart).getTime() > Date.now()
    );
    const hasFutureSchedule = scheduledStartIsFuture || !!args.repeat_interval;
    if (hasFutureSchedule) {
      try {
        noteUnsettled(setTrackerStatus(taskId, 'on_deck', { by: 'agent', actorId: agentId, reason: 'scheduled for later; the scheduler owns the move to in_progress at fire time' }), 'work_open: scheduled for later', { taskId });
      } catch { /* ignore */ }
    }

    try {
      ensurePMAgentRunning();
    } catch (err) {
      logger.warn('Failed to ensure PM agent is running', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    if (scheduledStart) {
      const repeatInterval = args.repeat_interval as number | undefined;
      const repeatUnit = args.repeat_unit as string | undefined;
      const repeatEndType = (args.repeat_end_type as string | undefined) ?? 'never';
      const repeatEndValue = args.repeat_end_value as string | undefined;
      // specific_days uses an explicit day-of-week allowlist, already normalized to CSV-of-ints by the
      // dispatcher.
      const repeatDaysOfWeek = args.repeat_days_of_week as string | undefined;
      // anchor_time defaults to scheduled_start (wall-clock alignment of recurring runs); the caller may
      // override it, e.g. anchor at 06:00 though the task is created at 14:23.
      let anchorTime = args.anchor_time as string | undefined;
      if (anchorTime) {
        const parsed = new Date(anchorTime);
        if (!isNaN(parsed.getTime())) anchorTime = parsed.toISOString();
      } else if (repeatInterval) {
        anchorTime = scheduledStart;
      }

      // The row's own zone reaches the very first advance too.
      const nextRun = calculateNextRun(scheduledTaskFromRow({
        id: taskId, scheduled_start: scheduledStart, repeat_interval: repeatInterval ?? null, repeat_unit: repeatUnit ?? null,
        repeat_end_type: repeatEndType, repeat_end_value: repeatEndValue ?? null, repeat_days_of_week: repeatDaysOfWeek ?? null,
        anchor_time: anchorTime ?? null, tz: resolvedScheduleZone, schedule_status: 'waiting',
      })) ?? scheduledStart;

      noteUnsettled(setNextRun(taskId, {
        at: tsToMs(nextRun),
        reason: 'a schedule was created; this is its first fire time',
        alongside: {
          scheduled_start: tsToMs(scheduledStart), repeat_interval: repeatInterval ?? null,
          repeat_unit: repeatUnit ?? null, repeat_end_type: repeatEndType,
          repeat_end_value: repeatEndValue ?? null, repeat_days_of_week: repeatDaysOfWeek ?? null,
          anchor_local: anchorTime ?? null, schedule_status: 'waiting',
          // The declared per-reminder zone, persisted; NULL means the box timezone.
          tz: resolvedScheduleZone,
        },
      }), 'trackerCreateTask: schedule recorded', { taskId });

      // Declare what this schedule owes a person, once, after the schedule columns (whether it is scheduled
      // is an input). Idempotent and never overrides a caller who named the kind. Its runs cannot be
      // recorded complete without a message the person actually received.
      await declareDeliverableOnSchedule(taskId, judged);
    }

    // Every write to this row is done: if it moved since it was announced, the wire hears the settled row
    // now, so the last frame for this id equals the stored row. A creation that settled nothing sends
    // nothing.
    broadcastTaskSettled(taskId, announced);

    const parts = [
      `[OK] task_id=${taskId} | title=${title}`,
      ``,
      `Task created successfully.`,
    ];
    if (measureSet) parts.push(measureSet);
    if (projectId) parts.push(`Project: ${projectId}`);
    if (assignedTo) parts.push(`Assigned to: ${assignedTo}${args.assigned_to_group ? ` (picked from group ${String(args.assigned_to_group)})` : ''}`);
    if (priority) parts.push(`Priority: ${priority}`);
    if (scheduledStart) {
      // Echo the wall-clock (with tz and canonical UTC) and the computed next run, so a timezone mistake is
      // caught before it fires.
      const createdTask = getTask(taskId);
      for (const line of scheduleEchoLines(scheduledStart, createdTask?.nextRunAt ?? null)) {
        parts.push(line);
      }
    }

    // Notify assigned agent about the new task (unless they created it themselves,
    // or it's a scheduled task, the scheduler handles those).
    if (assignedTo && !hasFutureSchedule) {
      injectTaskAssignmentNotification({
        assignedAgentId: assignedTo,
        creatorAgentId: agentId,
        taskId,
        title,
        description: description ?? null,
        projectId: projectId ?? null,
        priority: priority ?? null,
      });
    }

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCreateTask failed', { error: msg }, agentId);
    return `Error creating task: ${msg}`;
  }
}

// Thin wrapper over trackerCreateTask for "the user asked for a reminder". With no `when` it returns an
// ASK_USER instruction so the agent asks the user and re-fires; otherwise it creates a kind='reminder' task
// with the supplied schedule, which the scheduler fires with the reminder template (scheduler/runner.ts).
export async function reminderCreate(agentId: string, args: Record<string, unknown>): Promise<string> {
  const what = (args.what as string | undefined)?.trim();
  if (!what) return 'Error: `what` is required (the reminder text).';

  const when = (args.when as string | undefined)?.trim();
  // A local wall-clock (local_time) is accepted in place of `when`; the engine converts it, so the model
  // never does UTC math.
  const localTime = (args.local_time as string | undefined)?.trim();
  if (!when && !localTime) {
    return (
      'ASK_USER: This reminder needs a time. Ask the person you are talking to when they would like to be ' +
      'reminded ("in 5 minutes", "tomorrow at 8am", "every Monday at 9am"). ' +
      'Once they answer, call get_current_time to anchor relative times and re-call ' +
      'work_open(kind="reminder") with `when` set to the resolved ISO 8601 datetime, ' +
      'or with local_time="YYYY-MM-DDThh:mm" if they named a plain clock time. ' +
      'Do NOT create the reminder yet.'
    );
  }

  const titleSnippet = what.length > 60 ? what.slice(0, 57).trimEnd() + '…' : what;

  return trackerCreateTask(agentId, {
    title: `Reminder: ${titleSnippet}`,
    description: what,
    kind: 'reminder',
    scheduled_start: when,
    // Forward the wall-clock inputs; trackerCreateTask converts local_time when scheduled_start (`when`) is
    // absent.
    local_time: localTime,
    local_timezone: args.local_timezone,
    tz: args.tz,
    repeat_interval: args.repeat_interval,
    repeat_unit: args.repeat_unit,
    repeat_end_type: args.repeat_end_type,
    repeat_end_value: args.repeat_end_value,
    repeat_days_of_week: args.repeat_days_of_week,
    anchor_time: args.anchor_time,
  });
}

// ── trackerUpdateStatus ──

export function trackerUpdateStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    // A weak model's word for a status maps to the canonical one; anything else is refused with guidance.
    // Finishing is not a status: it is a hand-in, routed at the tool door (`work-verbs.ts`).
    const rawStatus = args.status as string | undefined;
    let status: string | undefined = rawStatus;
    if (rawStatus !== undefined) {
      const mapped = normalizeTaskStatus(rawStatus);
      if (!mapped || TERMINAL_STATUS_WORDS.has(mapped)) {
        return `Error: "${rawStatus}" is not a status you can set. Use one of: on_deck, in_progress, paused, blocked. Finished or can't-be-done work is handed in: work_update(action="hand_in").`;
      }
      status = mapped;
    }
    // A status call carries no assignee: moving work is :reassign's, under the row-authority cause rule,
    // and the tool door refuses an assigned_to here (WORK_OP_READS); this writer never reads one.
    const priority = args.priority as string | undefined;

    if (!status && !priority) {
      return 'Error: at least one of status or priority must be provided';
    }

    { const no = taskWriteRefusal(agentId, taskId, 'change the status of'); if (no) return no; }   // only the task's holder, its creator, the PM and the main agent change it.
    // The prior status, for the task_log transition entry below (the row has moved once it is written).
    const db = getDb();
    const taskRow = db.prepare(`SELECT title, repeat_interval, ${STATE_TO_STATUS_SQL('state')} as prior_status FROM work WHERE id = ?`).get(taskId) as { title: string; repeat_interval: number | null; prior_status: string } | undefined;
    const priorStatus = holdOf(taskId)?.kind ?? taskRow?.prior_status ?? null;
    const liftsOwnerHold = !!status && ownerHoldStands(taskId, false);
    if (liftsOwnerHold && !ownerAskedToLift(agentId, args.user_quote)) {
      return `Refused: ${OWNER_HOLD_REFUSAL} ${escalationPointer(agentId)}`;
    }
    const lifted = liftsOwnerHold ? '\nThe owner\'s hold on it is lifted.' : '';

    // Idempotency: a status call naming the status the task is already at changes nothing and says so, so
    // it is not read as real work. Only when status is the sole requested change; a call that also changes
    // priority falls through to the normal update.
    if (
      status &&
      !priority &&
      priorStatus === status
    ) {
      // The status is unchanged but the call may carry a note: record it as work_note does (an observation
      // by this agent) and say so. A note is a record on the task, not progress (the PM's ladder ignores
      // it).
      const sameStatusNote = typeof args.notes === 'string' ? args.notes.trim() : '';
      if (sameStatusNote.length > 0) {
        writeTaskLog({
          taskId,
          fromEntity: isPMAgent(agentId) ? 'pm' : `agent:${agentId}`,
          entryKind: 'observation',
          note: sameStatusNote,
          actionTaken: `notes attached (status already ${status})`,
        });
      }
      return (
        `[NO-OP] task_id=${taskId} | status=${status}, already at this status, no change made` +
        `${sameStatusNote.length > 0 ? '; your note was recorded on the task' : ''}.\n\n` +
        `Task: ${taskRow?.title ?? '(unknown title)'}`
      );
    }

    const updates: Record<string, string | null> = {};
    if (status) updates.status = status;
    if (priority) updates.priority = priority;

    // 'on_deck' is reserved for tasks with a future scheduled_start (the scheduler owns the move to
    // in_progress). Explicit moves to 'on_deck' on tasks without one are refused so work is not parked
    // where nothing wakes it; the PM and the main agent may park work anywhere.
    if (status === 'on_deck' && !isPMAgent(agentId) && !isPrimaryAgent(agentId)) {
      const sched = db.prepare(
        `SELECT ${msToText('scheduled_start')} AS scheduled_start, repeat_interval, ${msToText('next_run_at')} AS next_run_at FROM work WHERE id = ?`
      ).get(taskId) as { scheduled_start: string | null; repeat_interval: number | null; next_run_at: string | null } | undefined;
      const nowMs = Date.now();
      const futureScheduledStart = !!(
        sched?.scheduled_start && new Date(normalizeDbTimestamp(sched.scheduled_start)).getTime() > nowMs
      );
      const futureNextRun = !!(
        sched?.next_run_at && new Date(normalizeDbTimestamp(sched.next_run_at)).getTime() > nowMs
      );
      const isRecurring = !!sched?.repeat_interval;
      if (!futureScheduledStart && !futureNextRun && !isRecurring) {
        return (
          `Error: status="on_deck" is reserved for tasks with a FUTURE scheduled_start ` +
          `(or a recurring schedule). This task has no future schedule, so it belongs in ` +
          `"in_progress" until you actively work it. If you want to park it for later, ` +
          `set a scheduled_start with work_update(action="edit") first, then move to on_deck. ` +
          `If you're done, hand it in with work_update(action="hand_in"). If you're waiting on the user, use ` +
          `status="paused" with notes naming what you're waiting for.`
        );
      }
    }

    const callerIsPM = isPMAgent(agentId);

    // Paused and blocked are holds: the task stays Working and still finishes by a hand-in.
    const hold = status === 'paused' || status === 'blocked' ? status : null;
    const holdReason = typeof args.notes === 'string' ? args.notes.trim() : '';
    const resumeAt = hold === 'paused' ? modelTimeMs(args.resume_at) : null;
    if (hold && holdReason.length < 15) {
      return `Error: status="${hold}" requires a clear reason in \`notes\` (minimum 15 characters): `
        + (hold === 'paused' ? 'name what you are waiting for (e.g. "waiting for the vendor to send the tracking number").'
          : 'name the obstacle (e.g. "need API key for service X").');
    }
    // "Pause it until Monday" on a repeating task is its schedule's pause (a hold would not stop the next
    // run); a pause with no resume time holds only the run being worked.
    if (hold === 'paused' && taskRow?.repeat_interval && isSet(args.resume_at)) {
      const paused = trackerPauseSchedule(agentId, { taskId, resume_at: args.resume_at, reason: holdReason });
      if (priority && paused.startsWith('Schedule paused')) updateTask(taskId, { priority });
      return paused;
    }
    if (hold) {
      const held = setHold(taskId, hold, holdReason, agentId, resumeAt, args.user_quote);
      if (!held.ok) return `Refused: ${taskId} was not put on hold (${held.why}).`;
    } else if (status && status === taskRow?.prior_status) {
      clearHold(taskId, agentId);   // already there: only the hold lifts (a move lifts it in transition())
    }

    // The column patch and the state change are separate calls: setTaskStatusResult is transition() and
    // returns the gate's verdict, so a refusal can be steered on instead of read as "the task vanished".
    const { status: statusUpdate, ...columnUpdates } = updates as Record<string, unknown>;

    let task = Object.keys(columnUpdates).length > 0
      ? updateTask(taskId, columnUpdates)
      : getTask(taskId);

    if (hold) {
      if (task && !priority) broadcast({ type: 'tracker:task_updated', data: task });
      linkLaterInstruction(agentId, taskId);
      return `[OK] task_id=${taskId} | status=${task?.status ?? 'in_progress'}, ${hold}: ${holdReason}\n\n`
        + `Task held: ${taskRow?.title ?? taskId}. It is still yours: hand it in when it is finished or cannot be done.${lifted}`
        + (resumeAt ? `\nAuto-resumes: ${formatTimeForAgent(resumeAt)}` : '');
    }

    if (statusUpdate) {
      if (liftsOwnerHold) clearHold(taskId, agentId, args.user_quote);   // the move below refuses an owner-held row
      const sr = setTaskStatusResult(taskId, statusUpdate as TrackerStatus, {
        by: callerIsPM ? 'pm' : 'agent', actorId: agentId,
        reason: `work_update(action="status") -> ${String(statusUpdate)}`,
        userQuote: isPrimaryAgent(agentId) && typeof args.user_quote === 'string' ? args.user_quote : null,
      });
      if (!workSettled(sr.result)) {
        return `Refused: the status of ${taskId} did not change (${sr.result.detail}).`;
      }
      task = sr.task;
    }

    if (!task) {
      // taskId resolved above, so a null here means the task was deleted between resolve and update (or
      // between the UPDATE and the SELECT): it no longer exists, not a prefix mismatch.
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // Write the transition and any supplied notes to task_log; tasks.notes is read-only legacy.
    {
      const fromEntity = isPMAgent(agentId)
        ? 'pm'
        : `agent:${agentId}`;

      if (status && status !== priorStatus) {
        writeTaskLog({
          taskId,
          fromEntity,
          entryKind: 'transition',
          fromStatus: priorStatus,
          toStatus: status,
          actionTaken: 'work_update(action="status")',
        });
      }
      const persistNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      if (persistNotes.length > 0) {
        writeTaskLog({
          taskId,
          fromEntity,
          entryKind: 'observation',
          note: persistNotes,
          actionTaken: status ? `notes attached to status=${status}` : 'notes attached',
        });
      }
    }

    const parts = [
      `[OK] task_id=${task.id} | status=${task.status}`,
      ``,
      `Task updated: ${task.title}`,
    ];
    if (task.assignedTo) parts.push(`Assigned to: ${task.assignedToName ?? task.assignedTo}`);
    parts.push(`Priority: ${task.priority}`);

    linkLaterInstruction(agentId, taskId);
    return parts.join('\n') + lifted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerUpdateStatus failed', { error: msg }, agentId);
    return `Error updating task: ${msg}`;
  }
}

// Writes an observation entry to task_log (tasks.notes is read-only legacy).

export function trackerAddNotes(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    const project = resolved.ok ? null : resolveProjectId(rawTaskId, agentId);
    if (!resolved.ok && !project?.ok) return formatResolveError('task', rawTaskId, resolved);
    if (project?.ok && !isPMAgent(agentId) && !isPrimaryAgent(agentId)) {
      return "Refused: a project's notes are written by the project manager or the main agent.";
    }
    const taskId = resolved.ok ? resolved.id : project?.ok ? project.id : rawTaskId;

    const notes = args.notes as string;
    if (!notes) return 'Error: notes is required';

    const fromEntity = isPMAgent(agentId) ? 'pm' : `agent:${agentId}`;
    writeTaskLog({
      taskId,
      fromEntity,
      entryKind: 'observation',
      note: notes,
    });

    linkLaterInstruction(agentId, taskId);
    return `[OK] task_id=${taskId}\n\nObservation appended to the task's audit trail.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerAddNotes failed', { error: msg }, agentId);
    return `Error adding notes: ${msg}`;
  }
}


// Edits any structural field on a task: title, description, dependencies, step order, schedule. Status
// changes stay on trackerUpdateStatus (completion has notification and project-rollup side effects) and
// schedule pause/resume on trackerPauseSchedule / trackerResumeSchedule (they write a reason and notify the
// PM). A new tasks-table field belongs here unless setting it has a side effect beyond the row update.

export function trackerEditTask(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    { const no = taskWriteRefusal(agentId, taskId, 'edit'); if (no) return no; }   // editors only: holder, creator, PM, main agent.
    // local_time converts to scheduled_start engine-side before the field reads below; an explicit
    // scheduled_start wins.
    let editedScheduleZone: string | null = null;
    if (args.local_time !== undefined && args.local_time !== null && args.local_time !== ''
        && args.scheduledStart === undefined && args.scheduled_start === undefined) {
      if (typeof args.local_time !== 'string') {
        return 'Error: local_time must be a string wall-clock time, e.g. "2026-07-16T21:00".';
      }
      const tz = (args.local_timezone ?? args.tz) as string | undefined;
      const resolvedWall = resolveLocalWallClock(args.local_time, typeof tz === 'string' ? tz : undefined);
      if (!resolvedWall.ok) return resolvedWall.error;
      args.scheduled_start = resolvedWall.iso;
      editedScheduleZone = resolvedWall.zone;
    }

    const title = args.title as string | undefined;
    const description = args.description as string | undefined;
    const dependsOn = args.dependsOn ?? args.depends_on;
    const stepNumber = (args.stepNumber ?? args.step_number) as number | null | undefined;
    const phase = args.phase as number | null | undefined;
    const scheduledStart = (args.scheduledStart ?? args.scheduled_start) as string | null | undefined;
    const repeatInterval = (args.repeatInterval ?? args.repeat_interval) as number | null | undefined;
    const repeatUnit = (args.repeatUnit ?? args.repeat_unit) as string | null | undefined;
    const repeatEndType = (args.repeatEndType ?? args.repeat_end_type) as string | null | undefined;
    const repeatEndValue = (args.repeatEndValue ?? args.repeat_end_value) as string | null | undefined;
    const repeatDaysOfWeek = (args.repeatDaysOfWeek ?? args.repeat_days_of_week) as string | null | undefined;
    const anchorTime = (args.anchorTime ?? args.anchor_time) as string | null | undefined;
    const priority = args.priority as string | undefined;
    const notes = args.notes as string | undefined;
    const goal = args.goal as string | undefined;

    // The supplied-field check and the refusal's `Editable:` list are keyed by one declaration
    // (WORK_EDITABLE_TASK_FIELDS): keys are the advertised names, values the locals above, so this map
    // joins them.
    const editableValues: Record<string, unknown> = {
      title, description, goal, depends_on: dependsOn, step_number: stepNumber, phase,
      scheduled_start: scheduledStart, repeat_interval: repeatInterval, repeat_unit: repeatUnit,
      repeat_end_type: repeatEndType, repeat_end_value: repeatEndValue,
      repeat_days_of_week: repeatDaysOfWeek, anchor_time: anchorTime,
      priority, notes,
    };
    if (WORK_EDITABLE_TASK_FIELDS.every(f => editableValues[f] === undefined)) {
      return `Error: at least one editable field must be provided. Editable: ${WORK_EDITABLE_TASK_FIELDS.join(', ')}. (For status changes use work_update(action="status"); for assignee changes use work_update(action="reassign"); for pause/resume use work_schedule(action="pause").)`;
    }

    if (setsASchedule([scheduledStart, repeatInterval, repeatUnit, repeatEndType, repeatEndValue, repeatDaysOfWeek, anchorTime])) { const no = finishedScheduleRefusal(taskId, getTask(taskId)?.title ?? 'this task', 'changed'); if (no) return no; }
    // The schedule check runs on the values the row will hold once the edit lands; only a new anchor is read.
    const edited = { scheduled_start: scheduledStart, repeat_interval: repeatInterval, repeat_unit: repeatUnit, repeat_days_of_week: repeatDaysOfWeek, anchor_time: anchorTime };
    if (Object.values(edited).some((v) => v !== undefined)) {
      const current = getDb().prepare(
        `SELECT ${msToText('scheduled_start')} AS scheduled_start, repeat_interval, repeat_unit, repeat_days_of_week FROM work WHERE id = ?`,
      ).get(taskId) as Record<string, unknown> | undefined;
      const no = toolScheduleError(edited, current);
      if (no) return no;
    }

    // Goal edits are special: PM watches for goalpost-narrowing, so both old and new are logged with a
    // diff.
    if (goal !== undefined) {
      const refused = standardEditRefusal(agentId, taskId, { goal });
      if (refused) return refused;
      const goalTrimmed = goal.trim();
      if (!goalTrimmed) {
        return 'Error: goal cannot be empty. To edit other fields without changing goal, omit goal from the args.';
      }
      try {
        const priorGoal = getDb().prepare(`SELECT goal FROM work WHERE id = ?`).get(taskId) as { goal: string | null } | undefined;
        noteUnsettled(patchWork(taskId, { goal: goalTrimmed }), 'trackerEditTask: goal changed', { taskId });
        writeTaskLog({
          taskId,
          fromEntity: isPMAgent(agentId) ? 'pm' : `agent:${agentId}`,
          entryKind: 'observation',
          actionTaken: 'goal_edited',
          note: `BEFORE: ${priorGoal?.goal ?? '(none)'} -- AFTER: ${goalTrimmed}`,
        });
      } catch (err) {
        logger.warn('goal edit persist failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Snapshot title/description/original_description before the update, to (a) write a task_log audit
    // entry for content edits, as goal edits get above, and (b) enforce the exact-revert guard.
    const contentSnapshot = (title !== undefined || description !== undefined)
      ? getDb().prepare('SELECT title, description, original_description FROM work WHERE id = ?')
          .get(taskId) as { title: string | null; description: string | null; original_description: string | null } | undefined
      : undefined;

    // Exact-revert guard: restoring description to a value byte-identical to the immutable
    // original_description, after a later edit moved it away, requires an explicit revert_to_original=true.
    // This blocks silently restoring a stale original over a legitimate later edit while allowing an
    // acknowledged revert.
    if (description !== undefined && description !== null && description !== '' && contentSnapshot) {
      const orig = contentSnapshot.original_description;
      const cur = contentSnapshot.description;
      const isByteIdenticalToOriginal = orig !== null && description === orig;
      const laterEditExists = cur !== orig; // current diverged from the original ask
      if (isByteIdenticalToOriginal && laterEditExists && args.revert_to_original !== true) {
        return (
          `Error: this edit restores the description to the task's ORIGINAL text byte-for-byte, over a later edit that changed it. ` +
          `That is usually an accidental revert of intended work (a stale copy overwriting the current description). ` +
          // The escape hatch is named here and is reachable: work_update declares revert_to_original and
          // the edit door forwards it. Without the flag this refusal still fires.
          `If you really mean to roll the description back, re-call with revert_to_original=true.`
        );
      }
    }

    const updates: Parameters<typeof updateTask>[1] = {};
    if (title !== undefined) {
      if (!title.trim()) return 'Error: title cannot be empty';
      updates.title = title.trim();
    }
    if (description !== undefined) {
      updates.description = description === '' ? null : description;
    }
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn)) return 'Error: depends_on must be an array of task IDs (or [] to clear)';
      updates.dependsOn = dependsOn as string[];
    }
    if (stepNumber !== undefined) updates.stepNumber = stepNumber;
    if (phase !== undefined) updates.phase = phase;
    // Times were checked readable above; they are stored as UTC ISO.
    const isoOf = (t: string | null): string | null => (t ? new Date(t).toISOString() : null);
    if (scheduledStart !== undefined) {
      updates.scheduledStart = isoOf(scheduledStart);
      // A moved start moves the anchor too (create does the same): the old anchor would keep the old time
      // of day and could put the next run before the new start. An explicit anchor_time below wins.
      if (scheduledStart && anchorTime === undefined) updates.anchorTime = updates.scheduledStart;
    }
    if (repeatInterval !== undefined) updates.repeatInterval = repeatInterval;
    if (repeatUnit !== undefined) updates.repeatUnit = repeatUnit;
    if (repeatEndType !== undefined) updates.repeatEndType = repeatEndType;
    if (repeatEndValue !== undefined) updates.repeatEndValue = repeatEndValue;
    if (repeatDaysOfWeek !== undefined) updates.repeatDaysOfWeek = repeatDaysOfWeek;
    if (anchorTime !== undefined) updates.anchorTime = isoOf(anchorTime);
    if (priority !== undefined) updates.priority = priority;
    if (notes !== undefined) updates.notes = notes;

    // A goal-only edit already wrote its change (through the attribute door, with its own observation), so
    // `updates` is empty. updateTask() reports an empty patch like a vanished row, so read the row back
    // instead; "deleted" stays reserved for a row truly gone.
    const task = Object.keys(updates).length === 0 ? getTask(taskId) : updateTask(taskId, updates);
    if (!task) {
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // Audit title/description content edits in task_log with a before/after trail, as goal edits get above.
    if (contentSnapshot) {
      const contentEditor = isPMAgent(agentId) ? 'pm' : `agent:${agentId}`;
      if (title !== undefined && title.trim() !== (contentSnapshot.title ?? '')) {
        writeTaskLog({
          taskId,
          fromEntity: contentEditor,
          entryKind: 'observation',
          actionTaken: 'title_edited',
          note: `BEFORE: ${contentSnapshot.title ?? '(none)'} -- AFTER: ${title.trim()}`,
        });
      }
      if (description !== undefined) {
        const newDesc = description === '' ? null : description;
        if (newDesc !== (contentSnapshot.description ?? null)) {
          writeTaskLog({
            taskId,
            fromEntity: contentEditor,
            entryKind: 'observation',
            actionTaken: args.revert_to_original === true ? 'description_edited (revert_to_original)' : 'description_edited',
            note: `BEFORE: ${contentSnapshot.description ?? '(none)'} -- AFTER: ${newDesc ?? '(cleared)'}`,
          });
        }
      }
    }

    // If any schedule field changed, recompute next_run_at so the scheduler follows the edit instead of the
    // old cadence.
    const scheduleChanged = (
      scheduledStart !== undefined ||
      repeatInterval !== undefined ||
      repeatUnit !== undefined ||
      repeatEndType !== undefined ||
      repeatEndValue !== undefined ||
      repeatDaysOfWeek !== undefined ||
      anchorTime !== undefined
    );
    // Record the zone the new time was resolved in BEFORE the recompute, so the recompute's own
    // read of `tz` already sees it (the create door does the same).
    if (editedScheduleZone !== null) {
      noteUnsettled(patchWork(taskId, { tz: editedScheduleZone }, { touch: false }), 'trackerEditTask: schedule zone recorded', { taskId });
    }
    if (scheduleChanged) {
      try {
        const db = getDb();
        const row = db.prepare(`
          SELECT id, ${msToText('scheduled_start')} AS scheduled_start, repeat_interval, repeat_unit,
                 repeat_end_type, repeat_end_value, repeat_days_of_week,
                 anchor_local AS anchor_time, tz,
                 attempts AS run_count, is_paused, ${msToText('last_run_at')} AS last_run_at,
                 ${msToText('next_run_at')} AS next_run_at, schedule_status
          FROM work WHERE id = ?
        `).get(taskId) as {
          id: string;
          scheduled_start: string | null;
          repeat_interval: number | null;
          repeat_unit: string | null;
          repeat_end_type: string | null;
          repeat_end_value: string | null;
          repeat_days_of_week: string | null;
          anchor_time: string | null;
          tz: string | null;
          run_count: number;
          is_paused: number;
          last_run_at: string | null;
          next_run_at: string | null;
          schedule_status: string;
        } | undefined;
        if (row) {
          const nextRun = calculateNextRun(row);
          // Only set schedule_status to 'waiting' when there is a future run: calculateNextRun returns null
          // for completed or non-recurring tasks that already fired, and their status stays as it was.
          if (nextRun) {
            noteUnsettled(setNextRun(taskId, {
              at: tsToMs(nextRun), alongside: { schedule_status: 'waiting' },
              reason: 'a schedule field was edited, so the next fire time was recomputed',
            }), 'trackerEditTask: next run recomputed', { taskId });
          } else if (row.scheduled_start === null) {
            // Schedule was cleared entirely, drop next_run_at too.
            noteUnsettled(setNextRun(taskId, {
              at: null, alongside: { schedule_status: 'idle' },
              reason: 'the schedule was cleared, so there is no next fire time',
            }), 'trackerEditTask: schedule cleared', { taskId });
          }
        }
      } catch (recalcErr) {
        // Non-fatal: the row update succeeded and only the recompute failed, so log it and keep the edit.
        logger.warn('trackerEditTask: schedule recompute failed', {
          taskId,
          error: recalcErr instanceof Error ? recalcErr.message : String(recalcErr),
        }, agentId);
      }
    }

    const changed: string[] = [];
    for (const k of Object.keys(updates)) changed.push(k);
    // The goal was written above with its own observation, so `updates` never names it; name it on the
    // reply.
    if (changed.length === 0 && goal !== undefined) changed.push('goal');

    const editParts = [
      `[OK] task_id=${task.id}`,
      ``,
      `Task updated: ${task.title}`,
      `Fields changed: ${changed.join(', ')}`,
    ];
    // If the schedule changed, echo the wall-clock anchor and next run so a timezone mistake is caught
    // before the next fire.
    if (scheduleChanged) {
      const fresh = getTask(taskId);
      for (const line of scheduleEchoLines(fresh?.scheduledStart ?? null, fresh?.nextRunAt ?? null)) {
        editParts.push(line);
      }
    }
    linkLaterInstruction(agentId, taskId);
    return editParts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerEditTask failed', { error: msg }, agentId);
    return `Error editing task: ${msg}`;
  }
}

// A rejection must be visible wherever the row is. `list` and `get` print the row's own recorded words (the
// hold's reason, the newest send-back ruling), truncated: the engine authors no sentence about the work and
// classifies no prose. Both are tool-result text, outside any prompt surface, so they move no cached prefix
// bytes.

/** The row's own words, flattened to one line and cut with a `...` marker. */
function recordedClause(text: string | null | undefined, max: number): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}...` : flat;
}

/** (a) Why a held row is held: the hold's own reason. */
function recordedStopReason(taskId: string): string | null {
  const hold = holdOf(taskId);
  const clause = recordedClause(hold?.reason, 140);
  return hold && clause ? `      ^ ${hold.kind}: ${clause}` : null;
}

/** (b) The newest decision, shown while it is a send-back: the worker reads why its hand-in came back. */
function lastPMRulingLine(taskId: string): string | null {
  const e = getDb().prepare(
    "SELECT payload FROM work_events WHERE work_id = ? AND kind = 'decided' ORDER BY id DESC LIMIT 1",
  ).get(taskId) as { payload: string } | undefined;
  const d = e ? JSON.parse(e.payload) as { verdict?: string; reason?: string } : null;
  const clause = d?.verdict === 'send_back' ? recordedClause(d.reason, 300) : null;
  return clause ? `Last decision: SENT BACK, ${clause}` : null;
}


export function trackerGetStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string | undefined;
    const rawProjectId = args.projectId as string | undefined;

    // The dispatcher in agent/tools/cat/tracker.ts passes the same input as both taskId and projectId so
    // either side can succeed: resolve the task first, then fall through to the project without surfacing
    // the task's not_found.
    if (rawTaskId) {
      const taskResolved = resolveTaskId(rawTaskId, agentId);
      if (taskResolved.ok) {
        const task = getTask(taskResolved.id);
        if (!task) return `Error: Task ${taskResolved.id} was deleted before it could be read.`;

        const parts = [
          `[OK] task_id=${task.id} | status=${task.status} | priority=${task.priority}`,
          ``,
          `Task: ${task.title}`,
        ];
        if (task.projectId) {
          const statusDb = getDb();
          const proj = statusDb.prepare('SELECT title FROM work WHERE id = ?').get(task.projectId) as { title: string } | undefined;
          parts.push(`Project: ${proj?.title ?? task.projectId}`);
        }
        if (task.assignedTo) parts.push(`Assigned to: ${task.assignedToName ?? task.assignedTo}`);
        if (task.hold) parts.push(`${task.hold === 'paused' ? 'Paused' : 'Blocked'}: ${task.holdReason ?? ''}`);
        // The origin chain, in the agent's own view, so it can connect a task to its conversation and
        // prompt.
        {
          const origin = findTaskOriginChain(task.id);
          if (origin) parts.push(`Origin: ${renderTaskOriginChain(origin)}`);
        }
        if (task.description) parts.push(`Description: ${task.description}`);
        if (task.stepNumber !== null) parts.push(`Step: ${task.stepNumber}${task.totalSteps ? ` of ${task.totalSteps}` : ''}`);
        if (task.dependsOn.length > 0) {
          const depNames = task.dependsOn.map(depId => {
            const dep = getTask(depId);
            return dep ? dep.title : depId;
          });
          parts.push(`Depends on: ${depNames.join(', ')}`);
        }
        // Surface the schedule so the description's prose time and the actual anchor are visible side by
        // side (wall-clock plus UTC, so the time cannot be misread).
        if (task.scheduleStatus && task.scheduleStatus !== 'unscheduled') {
          const cadence = task.repeatInterval && task.repeatUnit
            ? `every ${task.repeatInterval} ${task.repeatUnit}`
            : 'one-time';
          parts.push(`Schedule: ${cadence} | status=${task.scheduleStatus}${task.isPaused ? ' (paused)' : ''}`);
          if (task.scheduledStart) parts.push(`  Anchor: ${formatTimeForAgent(task.scheduledStart)}`);
          parts.push(`  Next run: ${task.nextRunAt ? formatTimeForAgent(task.nextRunAt) : 'none scheduled'}`);
          if (task.runCount) parts.push(`  Runs completed: ${task.runCount}`);
        }
        if (task.notes) parts.push(`\nNotes:\n${task.notes}`);
        parts.push(`Created: ${task.createdAt}`);
        parts.push(`Updated: ${task.updatedAt}`);
        if (task.completedAt) parts.push(`Completed: ${task.completedAt}`);
        // Render the task's stamps (engine-observed state) plus live step facts; the delivery-evidence
        // join backfills rows that predate the stamp columns.
        {
          const st = getTaskStampFields(task.id);
          if (st) {
            const steps = renderStepFacts(st);
            parts.push(`State: ${renderTaskStamps(st)}${steps ? ` | ${steps}` : ''}`);
          }
        }
        // The adjudication belongs beside the state: they answer the same question.
        {
          const ruling = lastPMRulingLine(task.id);
          if (ruling) parts.push(ruling);
        }
        if (task.status === 'in_progress') {
          // Only what the engine can count (`engineProofLine`), never a bare reply: it may be the start ack.
          const evLine = engineProofLine(task.id);
          if (evLine) {
            parts.push(
              // Facts only, no close-coaching.
              `\n[ENGINE RECORD: this task's work appears ALREADY DELIVERED, ${evLine}. ` +
              `Do NOT redo or re-deliver what was already delivered.]`
            );
          }
        }

        return taskReadWithNotes(task.id, agentId, parts.join('\n'), args.offset);   // the task's own notes close the page
      }
      if (!rawProjectId) {
        return formatResolveError('task', rawTaskId, taskResolved);
      }
    }

    if (rawProjectId) {
      const projectResolved = resolveProjectId(rawProjectId, agentId);
      if (!projectResolved.ok) {
        return formatResolveError('project', rawProjectId, projectResolved);
      }
      const project = getProject(projectResolved.id);
      if (!project) return `Error: Project ${projectResolved.id} was deleted before it could be read.`;

      const parts = [
        `[OK] project_id=${project.id} | status=${project.status} | phase=${project.currentPhase}/${project.phaseCount}`,
        ``,
        `Project: ${project.title}`,
        `Level: ${project.level}`,
        ...((p) => (p ? ['', renderPlan(p)] : []))(planOfProject(project.id)),
        '',
        `Task Summary:`,
        `  On Deck: ${project.taskCounts.pending}`,
        `  In Progress: ${project.taskCounts.inProgress}`,
        `  Handed in: ${project.taskCounts.handedIn}`,
        `  Sent back: ${project.taskCounts.sentBack}`,
        `  Complete: ${project.taskCounts.complete}`,
        `  Blocked: ${project.taskCounts.blocked}`,
        `  Fallen: ${project.taskCounts.failed}`,
      ];

      if (project.tasks.length > 0) {
        parts.push('');
        parts.push('Tasks:');
        for (const task of project.tasks) {
          const assignee = task.assignedTo ? ` [${task.assignedTo}]` : '';
          const step = task.stepNumber !== null ? `#${task.stepNumber} ` : '';
          parts.push(`  ${step}[${task.status}] ${task.title}${assignee} (${task.priority})`);
        }
      }

      return parts.join('\n');
    }

    return 'Error: either taskId or projectId is required';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerGetStatus failed', { error: msg }, agentId);
    return `Error getting status: ${msg}`;
  }
}


export function trackerListActive(agentId: string, args: Record<string, unknown>): string {
  try {
    const scope = args.scope as 'tasks' | 'projects' | 'all' | undefined ?? 'all';
    const filterAssignedTo = args.assignedTo as string | undefined;
    const filterStatus = args.status as string | undefined;
    // The tracker layer takes the declared `filter` enum value rather than a private boolean, so one
    // vocabulary runs from the wire to the query and no handler reads a parameter no tool declares.
    const overdue = args.filter === 'overdue';
    const verbose = args.verbose as boolean | undefined;
    const parts: string[] = [];
    let totalShown = 0;

    const taskRow = (t: { id: string; title: string; assignedTo: string | null; assignedToName: string | null; priority: string; description: string | null }) => {
      const assignee = t.assignedTo ? ` [${t.assignedToName ?? t.assignedTo}]` : ' [unassigned]';
      const head = `  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`;
      if (verbose && t.description) {
        const desc = t.description.length > 200 ? t.description.slice(0, 200) + '...' : t.description;
        return `${head}\n    → ${desc}`;
      }
      return head;
    };

    // A stopped row states why in its own recorded words; a title-only row reads as "still on the board,
    // nothing to say".
    const stoppedRows = (rows: Array<Parameters<typeof taskRow>[0]>): string[] =>
      rows.flatMap((t) => {
        const why = recordedStopReason(t.id);
        return why ? [taskRow(t), why] : [taskRow(t)];
      });

    if (scope === 'projects' || scope === 'all') {
      const projects = listProjects({ status: 'active' });
      if (projects.length > 0) {
        parts.push(`Active Projects (${projects.length}):`);
        for (const p of projects) {
          parts.push(`  [${p.id.slice(0, 8)}] ${p.title} (phase ${p.currentPhase}/${p.phaseCount})`);
        }
        totalShown += projects.length;
      } else {
        parts.push('No active projects.');
      }
    }

    if (scope === 'tasks' || scope === 'all') {
      // filter:"overdue" lists dueScope()'s set (the declaration the scheduler's due query also answers
      // from); the heading names the filter so an empty answer reads as "nothing is overdue", not as an
      // ignored filter.
      if (overdue) {
        const late = listTasks({ overdue: true, assignedTo: filterAssignedTo });
        if (late.length > 0) {
          parts.push(`Overdue Tasks (${late.length}) — scheduled to run, still waiting:`);
          for (const t of late) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          totalShown += late.length;
        } else {
          parts.push('No overdue tasks: nothing scheduled has come due without firing.');
        }
      } else if (filterStatus) {
        const filtered = listTasks({ status: filterStatus, assignedTo: filterAssignedTo });
        if (filtered.length > 0) {
          parts.push(`${filterStatus.replace('_', ' ')} Tasks (${filtered.length}):`);
          // Filtering to blocked/paused renders the same rows as the sections below, so it carries the same
          // clause.
          const rows = filtered as Array<Parameters<typeof taskRow>[0]>;
          parts.push(...(filterStatus === 'blocked' || filterStatus === 'paused'
            ? stoppedRows(rows) : rows.map((t) => taskRow(t))));
          totalShown += filtered.length;
        } else {
          parts.push(`No ${filterStatus} tasks.`);
        }
      } else {
        const taskFilter = filterAssignedTo ? { assignedTo: filterAssignedTo } : undefined;
        const inProgress = listTasks({ status: 'in_progress', ...taskFilter }).filter((t) => !t.hold);
        const pending = listTasks({ status: 'on_deck', ...taskFilter }).filter((t) => !t.hold);
        const blocked = listTasks({ status: 'blocked', ...taskFilter });

        if (inProgress.length > 0) {
          parts.push('');
          parts.push(`In Progress Tasks (${inProgress.length}):`);
          for (const t of inProgress) {
            parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
            // Origin and stamps in-band on every list read, so the agent connects the task to its
            // conversation and knows its state without guessing.
            const tid = (t as { id: string }).id;
            const origin = findTaskOriginChain(tid);
            if (origin) parts.push(`      ^ origin: ${renderTaskOriginChain(origin)}`);
            const st = getTaskStampFields(tid);
            if (st) {
              const steps = renderStepFacts(st);
              parts.push(`      ^ state: ${renderTaskStamps(st)}${steps ? ` | ${steps}` : ''}`);
            }
            {
              const rec = engineProofLine(tid);
              if (rec) {
                parts.push(`      ^ ENGINE RECORD: appears already delivered (${rec}); do not redo it.`);
              }
            }
          }
          totalShown += inProgress.length;
        }
        if (pending.length > 0) {
          parts.push('');
          parts.push(`On Deck Tasks (${pending.length}):`);
          for (const t of pending.slice(0, 10)) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          if (pending.length > 10) parts.push(`  ... and ${pending.length - 10} more`);
          totalShown += Math.min(pending.length, 10);
        }
        if (blocked.length > 0) {
          parts.push('');
          parts.push(`Blocked Tasks (${blocked.length}):`);
          parts.push(...stoppedRows(blocked as Array<Parameters<typeof taskRow>[0]>));
          totalShown += blocked.length;
        }

        const paused = listTasks({ status: 'paused', ...taskFilter });
        if (paused.length > 0) {
          parts.push('');
          parts.push(`Paused Tasks (${paused.length}):`);
          parts.push(...stoppedRows(paused as Array<Parameters<typeof taskRow>[0]>));
          totalShown += paused.length;
        }

        if (inProgress.length === 0 && pending.length === 0 && blocked.length === 0 && paused.length === 0) {
          parts.push('');
          parts.push('No active tasks.');
        }
      }
    }

    // This tool lists tasks and projects, not commitments, so an empty board must not read as "nothing
    // owed": one line from the reader that owns that question (work/obligation-memory.ts). A return value,
    // so it moves no cached prefix bytes.
    const commitmentPosition = commitmentPositionLine(agentId);
    if (commitmentPosition) {
      parts.push('');
      parts.push(commitmentPosition);
    }

    if (totalShown > 0) {
      parts.push('');
      if (verbose) {
        parts.push('Tip: work_update(action="get", id="<task_id>") for notes, depends_on, schedule, and full description.');
      } else {
        parts.push(`${compactCountNote(totalShown, 'task/project row')}. For full detail on one: work_update(action="get", id=<task_or_project_id>). For descriptions on every result: re-call work_update(action="list") with verbose=true.`);
      }
    }

    // Decision-moment pointer: this door answers "what is open right now", not "what happened over a
    // window". It rides here unconditionally, including the empty board (an empty now reads as an empty
    // day), and as a return value it moves no cached prefix bytes.
    parts.push('');
    parts.push(ACTIVITY_POINTER);

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerListActive failed', { error: msg }, agentId);
    return `Error listing active items: ${msg}`;
  }
}

// trackerActivity: the window's own ledger, a read-only extension of the tracker door. "What is open"
// (list) and "what changed over a window" are different quantities; this answers the second from
// timestamped ledgers that already exist (work.opened_at/closed_at, work_events, adjudications,
// deliveries). It adds no table, column, event kind or write path.
//
// Counts come first and complete; notable rows are titled and the rest counted behind an elision line that
// restates the whole number, so the report never silently truncates. `hours` is declared on work_update and
// forwarded through activityWindowStart; the output states the window it actually measured. Tool-result
// lane, engine-authored, agent-facing, never injected into a prompt: every line is a count or a stored
// title.

/** The list door's decision-moment pointer at the tracker's other read. One sentence,
 *  exported so the test that pins "the list is otherwise byte-identical" can subtract it. */
export const ACTIVITY_POINTER =
  'For what CHANGED over a window rather than what is open right now — rows opened and '
  + 'closed, schedules that fired, what reached a person — call work_update(action="activity"). '
  + 'This list is a snapshot of the present and carries no history.';

/** How many rows the report titles before it starts counting instead. */
const ACTIVITY_ROW_CAP = 8;

interface ActivityRow {
  id: string;
  kind: string;
  title: string | null;
  state: string;
  opened_at: number;
  closed_at: number | null;
}

/** Local midnight in the box's own zone, as epoch ms, using the scheduler's zone rules. */
function localMidnightMs(nowMs: number): number {
  const tz = getBoxTimeZone();
  const w = instantToWall(nowMs, tz);
  return wallToInstant({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0, second: 0 }, tz).getTime();
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The id as something the agent can pass back to `action="get"`. The list door slices 8 characters, but
 * this door also reports namespaced rows (`ask:<uuid>`, `piece:ask:...`) whose 8-character prefix resolves
 * to nothing, so those print in full.
 */
const activityRowId = (id: string): string => (id.includes(':') ? id : id.slice(0, 8));

/**
 * The wire's `hours` as the report's window start, or `undefined` for the default window. Every unusable
 * value resolves to the default (the report states the window it measured on its first line). The only
 * bound is that a window cannot begin before the epoch; nothing caps how far back a legitimate question may
 * look.
 */
export function activityWindowStart(hours: unknown, nowMs: number = Date.now()): number | undefined {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return undefined;
  const start = nowMs - hours * 3_600_000;
  return start >= 0 ? start : undefined;
}

/**
 * The window's own ledger, rendered. `sinceMs` defaults to local midnight; the wire's own window arrives
 * through `activityWindowStart`.
 */
export function trackerActivity(
  agentId: string,
  args: Record<string, unknown>,
  sinceMs?: number,
): string {
  try {
    const db = getDb();
    const nowMs = Date.now();
    const { forPerson, own } = activityScope(agentId, turnContext(agentId)?.turnNumber);   // see work/peer-origin.ts
    const since = sinceMs ?? localMidnightMs(nowMs);
    const verbose = args.verbose === true;
    const rowCap = verbose ? ACTIVITY_ROW_CAP * 3 : ACTIVITY_ROW_CAP;

    const windowLabel = sinceMs === undefined
      ? `since local midnight (${formatTimeForAgent(new Date(since))})`
      : `since ${formatTimeForAgent(new Date(since))}`;

    // ── OPENED, by kind ──
    const openedRows = db.prepare(
      `SELECT kind, COUNT(*) AS n FROM work
        WHERE agent_id = ? AND opened_at >= ? AND opened_at <= ?${own('work')}
        GROUP BY kind ORDER BY n DESC, kind ASC`,
    ).all(agentId, since, nowMs) as Array<{ kind: string; n: number }>;
    const openedTotal = openedRows.reduce((a, r) => a + r.n, 0);

    // ── CLOSED, by terminal outcome. The spine's own CHECK makes `closed_at` and a terminal
    //    state one fact, so this cannot count a row that did not actually finish. ──
    const closedRows = db.prepare(
      `SELECT state, COUNT(*) AS n FROM work
        WHERE agent_id = ? AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?${own('work')}
        GROUP BY state ORDER BY n DESC, state ASC`,
    ).all(agentId, since, nowMs) as Array<{ state: string; n: number }>;
    const closedTotal = closedRows.reduce((a, r) => a + r.n, 0);

    // ── SCHEDULED RUNS THAT FIRED. ──
    const fired = (db.prepare(
      `SELECT COUNT(*) AS n FROM work_events e JOIN work w ON w.id = e.work_id
        WHERE w.agent_id = ? AND e.kind IN ('occurrence_fired','occurrence_released')
          AND e.created_at >= ? AND e.created_at <= ?${own('w')}`,
    ).get(agentId, since, nowMs) as { n: number }).n;

    // ── PM RULINGS in the window, from the adjudication rows themselves. ──
    const rulings = db.prepare(
      `SELECT a.verdict AS verdict, COUNT(*) AS n FROM adjudications a JOIN work w ON w.id = a.work_id
        WHERE w.agent_id = ? AND a.created_at >= ? AND a.created_at <= ?${own('w')}
        GROUP BY a.verdict ORDER BY a.verdict ASC`,
    ).all(agentId, since, nowMs) as Array<{ verdict: string; n: number }>;

    // ── WHAT REACHED A PERSON. Three narrowings, each load-bearing:
    //    • `outcome = 'delivered'`: the ledger also carries failed, suppressed, held and owner_closed rows,
    //      and counting those would report attempts and the owner's own close receipt as reaching him
    //      (agent/v2/__tests__/owner-close-receipt.test.ts walks every production reader for this filter).
    //    • `channel <> 'a2a'`: a peer agent is not a person.
    //    • `created_at` is a UTC datetime string here, not epoch ms, so the bound is rendered that way. ──
    const sinceText = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
    const deliveries = db.prepare(
      `SELECT channel, COUNT(*) AS n FROM deliveries
        WHERE agent_id = ? AND outcome = 'delivered' AND channel <> 'a2a' AND created_at >= ?
        GROUP BY channel ORDER BY n DESC, channel ASC`,
    ).all(agentId, sinceText) as Array<{ channel: string; n: number }>;
    const deliveredTotal = deliveries.reduce((a, r) => a + r.n, 0);

    const parts: string[] = [];
    parts.push(`Activity ${windowLabel} — the work ledger's own record, every kind of row on your board (asks, tasks, projects, commitments, scheduled occurrences).`);
    if (forPerson) parts.push(PEER_WORK_NOTE);
    parts.push('');

    if (openedTotal === 0 && closedTotal === 0 && fired === 0 && deliveredTotal === 0) {
      parts.push(
        `For this window nothing is recorded: 0 rows opened, 0 rows closed, 0 scheduled runs fired, `
        + `0 deliveries reached anyone. That is the ledger's complete answer for the window, not a sample of it.`,
      );
      parts.push('');
      parts.push('For what is open RIGHT NOW (which this does not report): work_update(action="list").');
      return parts.join('\n');
    }

    parts.push(openedTotal === 0
      ? 'Opened (0): nothing was opened in this window.'
      : `Opened (${openedTotal}): ${openedRows.map((r) => plural(r.n, r.kind)).join(', ')}`);
    parts.push(closedTotal === 0
      ? 'Closed (0): nothing reached a terminal state in this window.'
      : `Closed (${closedTotal}): ${closedRows.map((r) => `${r.n} ${r.state}`).join(', ')}`);
    parts.push(`Scheduled runs fired: ${fired}`);
    if (rulings.length > 0) {
      parts.push(`PM rulings: ${rulings.map((r) => `${r.n} ${r.verdict}`).join(', ')}`);
    }
    parts.push(deliveredTotal === 0
      ? 'Delivered to people (0): nothing you sent reached a person in this window.'
      : `Delivered to people (${deliveredTotal}): ${deliveries.map((d) => `${d.channel} ${d.n}`).join(', ')}`);

    // ── THE ROWS THEMSELVES, newest movement first, capped and counted. ──
    const rows = db.prepare(
      `SELECT id, kind, title, state, opened_at, closed_at FROM work
        WHERE agent_id = ?
          AND ((opened_at >= ? AND opened_at <= ?) OR (closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?))${own('work')}
        ORDER BY COALESCE(closed_at, opened_at) DESC, id ASC
        LIMIT ?`,
    ).all(agentId, since, nowMs, since, nowMs, rowCap) as ActivityRow[];
    const touched = (db.prepare(
      `SELECT COUNT(*) AS n FROM work
        WHERE agent_id = ?
          AND ((opened_at >= ? AND opened_at <= ?) OR (closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?))${own('work')}`,
    ).get(agentId, since, nowMs, since, nowMs, ) as { n: number }).n;

    if (rows.length > 0) {
      parts.push('');
      parts.push(`Rows that moved (${rows.length} of ${touched} listed, most recent movement first):`);
      for (const r of rows) {
        const title = r.title && r.title.trim() ? r.title.trim() : '(no title)';
        const opened = r.opened_at >= since ? 'opened' : 'opened before this window';
        const closed = r.closed_at !== null && r.closed_at >= since ? `, ${r.state}` : '';
        parts.push(`  [${activityRowId(r.id)}] ${r.kind}: ${title} — ${opened}${closed}`);
      }
      const hidden = touched - rows.length;
      if (hidden > 0) {
        // The elision is never silent: the number above is the complete figure, and this says which part is
        // listed.
        parts.push(`  … and ${plural(hidden, 'more row')} not listed here — the ${touched} above is the complete number for this window${verbose ? '' : ' (re-call with verbose=true for more rows)'}.`);
      }
    }

    parts.push('');
    parts.push('These counts are complete for the window stated above; rows not listed are counted, not missing. For what is open RIGHT NOW (which this does not report): work_update(action="list").');
    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerActivity failed', { error: msg }, agentId);
    return `Error reading activity: ${msg}`;
  }
}


// Renames or re-describes a project, so the PM agent can rename a project the engine opened.

export function trackerEditProject(agentId: string, args: Record<string, unknown>): string {
  const rawProjectId = (args.project_id ?? args.projectId) as string | undefined;
  if (!rawProjectId) return 'Error: project_id is required.';

  const resolved = resolveProjectId(rawProjectId, agentId);
  if (!resolved.ok) return formatResolveError('project', rawProjectId, resolved);
  const projectId = resolved.id;

  { const no = taskWriteRefusal(agentId, projectId, 'edit'); if (no) return no; }   // the same editors as a task.
  const title = args.title as string | undefined;
  const description = args.description as string | null | undefined;

  if (title === undefined && description === undefined) {
    return 'Error: at least one of title or description must be provided.';
  }

  const project = getProject(projectId);
  if (!project) return `Error: Project ${projectId} was deleted before edit could be applied.`;

  const updates: Parameters<typeof updateProject>[1] = {};
  if (title !== undefined) {
    const trimmed = title.trim();
    if (trimmed.length === 0) return 'Error: title cannot be empty.';
    updates.title = trimmed.slice(0, 200);
  }
  if (description !== undefined) {
    const next = description === null || description === '' ? null : String(description);
    // No marker-preservation guard is needed: the engine-opened fact lives in root_kind, stamped at
    // creation and on no tool surface, so no description rewrite can strip it.
    updates.description = next;
  }

  try {
    updateProject(projectId, updates);
    const fields = Object.keys(updates).join(', ');
    return `[OK] project_id=${projectId}\n\nProject updated. Fields changed: ${fields}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerEditProject failed', { projectId, error: msg }, agentId);
    return `Error editing project: ${msg}`;
  }
}

// Closes a whole project and every open task on it in one call (abandoned, duplicate or rescoped project),
// so agents do not strand tasks in on_deck or loop work_update(action="status") task by task.

const REDRIVE_LATER = ' The directive could not be delivered just now (it is logged); the task is back in play and the PM sweep re-drives it on its schedule.';

// PM or main agent: an open task's worker is told to redo it with a directive (at least 30 characters). Refused on a
// cancelled task, a handed-in one (that is decided instead) and one with no worker. Moves the task to in_progress
// or on_deck through `transition()`, logs the directive on its trail, and wakes the worker with it, owing no reply.

export async function trackerRetask(
  pmAgentId: string,
  args: { task_id: string; directive: string; target_status?: string; user_quote?: unknown },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const isPM = isPMAgent(pmAgentId);
  const sender = isPM ? 'PM' : 'main agent';

  const directive = (args.directive ?? '').trim();
  if (directive.length < 30) {
    return 'Error: directive must be at least 30 characters. Tell the agent concretely what they did wrong and what to do instead (e.g. "you posted the brief in chat but the task specifies email delivery; please call send_email with the same content to user@example.com").';
  }

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(
    `SELECT w.id AS id, w.title AS title, w.state AS state, ${STATE_TO_STATUS_SQL('w.state')} AS status,
            w.agent_id AS assigned_to, w.goal AS goal
       FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
  ).get(taskId) as { id: string; title: string; state: string; status: string; assigned_to: string; goal: string | null } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status === 'cancelled') {
    return `Error: task "${task.title}" (${taskId}) is cancelled. Cancelled tasks cannot be retasked. Create a new task instead.`;
  }
  if (task.state === 'handed_in') {   // delivered work is decided, never regenerated over
    return `Error: task "${task.title}" (${taskId.slice(0, 8)}) is handed in and waits for a decision. Decide it instead: open its proof, then work_validate(action="decide", task_id="${taskId}", verdict="approve" or "send_back", reason).`;
  }

  const targetStatus = args.target_status ?? 'in_progress';
  const ALLOWED_TARGETS = new Set(['in_progress', 'on_deck']);
  if (!ALLOWED_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed for retask. Use 'in_progress' (default) or 'on_deck'.`;
  }

  // A retask lifts any hold but the owner's (the sender's verdict that the wait is not real), then moves through `transition()`.
  if (!clearHold(taskId, pmAgentId, args.user_quote) && ownerHoldStands(taskId, false)) {
    return `Refused: ${OWNER_HOLD_REFUSAL} ${escalationPointer(pmAgentId)}`;
  }
  const sr = setTaskStatusResult(taskId, targetStatus as TrackerStatus, {
    by: isPM ? 'pm' : 'agent', actorId: pmAgentId,
    reason: `${sender} retask: ${directive.slice(0, 200)}`,
    userQuote: typeof args.user_quote === 'string' ? args.user_quote : null,
  });
  if (!workSettled(sr.result)) return `Refused: the status of ${taskId} did not change (${sr.result.detail}).`;
  if (!sr.task) return `Error: task ${taskId} was deleted before retask could land.`;

  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  const worker = fresh?.assignedTo ?? task.assigned_to;

  writeTaskLog({
    taskId,
    fromEntity: isPM ? 'pm' : `agent:${pmAgentId}`,
    entryKind: 'directive',
    fromStatus: task.status,
    toStatus: targetStatus,
    actionTaken: 'work_validate(action="retask")',
    reason: directive,
  });

  // Deliver the directive to the assigned agent as an engine event plus a wake; the status has already
  // moved, so a failed delivery only adds the re-drive note to the reply.
  let redriven = true;
  try {
    const { redriveWithoutReply } = await import('../agent/agent-notice.js');
    const body =
      `${sender} retask on "${task.title}" (${taskId.slice(0, 8)}). Task is back to ${targetStatus}.\n\n` +
      `${sender} directive: ${directive}\n\n` +
      `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
      `Do the work the directive describes. Don't just acknowledge; do the thing.`;
    // A directive, not a question: it wakes the agent and owes the sender no reply.
    redriven = await redriveWithoutReply({ toAgentId: worker, fromAgentId: pmAgentId, content: body, taskId });
  } catch (err) {
    redriven = false;
    logger.warn('Failed to deliver retask directive to agent', {
      taskId, assignedTo: worker,
      error: err instanceof Error ? err.message : String(err),
    }, pmAgentId);
  }

  logger.info('Task retasked', { taskId, pmAgentId, targetStatus, directiveLength: directive.length }, pmAgentId);
  return (
    `[OK] Retasked "${task.title}" (${taskId}) from ${task.status} to ${targetStatus}. ` +
    (redriven ? `Directive delivered to ${worker}.` : `Directive NOT delivered to ${worker}.${REDRIVE_LATER}`)
  );
}


export function trackerPauseSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  { const no = taskWriteRefusal(agentId, taskId, 'change the schedule of'); if (no) return no; }   // a schedule is part of the task; the task's editors change it.

  const db = getDb();
  const task = db.prepare(`SELECT w.id AS id, w.title AS title, w.schedule_status AS schedule_status, w.parent_id AS project_id FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(taskId) as { id: string; title: string; schedule_status: string; project_id: string } | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before pause could be applied.`;
  if (task.schedule_status === 'unscheduled') {
    return (
      `Refused: work_schedule(action="pause") is for recurring/scheduled tasks only, "${task.title}" has no schedule. ` +
      `For a one-shot task: if the work is done, or cannot be done, hand it in: work_update(action="hand_in", task_id="${task.id}", outcome, proof, note). ` +
      `If you're stuck, call work_update(action="status", ..., status="blocked", notes="why"). ` +
      `A one-shot task waiting on someone is put on hold instead: work_update(action="status", status="paused", notes="what you are waiting for").`
    );
  }

  const until = modelTimeMs(args.resume_at);
  if (isSet(args.resume_at) && until === null) return `Error: resume_at="${String(args.resume_at)}" is not a parseable datetime. Nothing was paused; re-call with an ISO 8601 time.`;
  if (isSet(args.reason)) writeTaskLog({ taskId, fromEntity: isPMAgent(agentId) ? 'pm' : `agent:${agentId}`, entryKind: 'observation', actionTaken: 'schedule paused', note: String(args.reason) });
  noteUnsettled(patchWork(taskId, { is_paused: 1, schedule_status: 'paused', paused_until: until }), 'trackerPauseSchedule: schedule paused', { taskId });
  const freshSchedPaused = getTask(taskId);
  if (freshSchedPaused) broadcast({ type: 'tracker:task_updated', data: freshSchedPaused });
  logger.info('Schedule paused', { taskId, until }, agentId);
  return `Schedule paused for "${task.title}". ${until ? `It resumes by itself at ${formatTimeForAgent(until)}.` : 'It does not fire until it is resumed.'}`;
}

/** Resume a paused schedule onto its next occurrence after now (slots passed while paused never fire). */
export function resumeSchedule(taskId: string, reason: string): string | null {
  const task = getDb().prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return null;
  const nextRun = calculateNextRun(scheduledTaskFromRow(task, {
    is_paused: 0, next_run_at: null, schedule_status: 'waiting',
    last_run_at: task.repeat_interval ? new Date().toISOString() : task.last_run_at as string | null,
  }));
  // An explicit resume also clears any resume time.
  noteUnsettled(setNextRun(taskId, {
    at: tsToMs(nextRun), reason,
    alongside: { is_paused: nextRun ? 0 : 1, schedule_status: nextRun ? 'waiting' : 'completed', paused_until: null },
  }), 'schedule resumed', { taskId });
  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  return nextRun;
}


export function trackerResumeSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  { const no = taskWriteRefusal(agentId, taskId, 'change the schedule of'); if (no) return no; }   // a schedule is part of the task; the task's editors change it.
  const db = getDb();
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before resume could be applied.`;
  { const no = finishedScheduleRefusal(taskId, String(task.title ?? 'this task'), 'resumed'); if (no) return no; }
  const nextRun = resumeSchedule(taskId, 'the schedule was resumed by the agent; walked to the next anchor');
  logger.info('Schedule resumed', { taskId, nextRun }, agentId);
  return `Schedule resumed for "${task.title as string}". Next run: ${nextRun ?? 'none'}`;
}

