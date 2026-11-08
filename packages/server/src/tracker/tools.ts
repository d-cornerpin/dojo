// ════════════════════════════════════════════════════════════════════════
// DEAD-CHANNEL DOCTRINE (RC-19 / demolition Phase 0): model-directed text from this
// subsystem rides NOTICE (postAgentNotice, role='user' origin_kind='engine', VISIBLE
// to the model), never role='system' (STRIPPED by the model-context builder). Bare
// role='system' rows here may carry only dashboard/owner-only informational notes or
// an agent's own system prompt, never an imperative the model is expected to ACT on.
// The RC-19 conformance test (agent/v2/__tests__/engine-steer.test.ts) source-scans
// this file for bare role='system' INSERTs carrying imperative model-directed text.
// ════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { taskScope, projectScope, msToText, tsToMs, STATE_TO_STATUS_SQL, scheduleRowColumns, type TrackerStatus, stampColumns, engineScaffoldScope } from '../work/tracker-view.js';
import { workSettled, noteUnsettled } from '../work/store.js';
import { patchWork, setTrackerStatus } from '../work/tracker-store.js';
// SWEEP CORE-2 item 3 — the schedule's fire time has ONE writing module.
import { setNextRun } from '../work/next-run.js';
import { activityScope, PEER_WORK_NOTE } from '../work/peer-origin.js';
import { commitmentPositionLine } from '../work/obligation-memory.js';
import { findTaskOriginChain, renderTaskOriginChain } from './origin-chain.js';
import { engineProofLine } from '../work/done/proof.js';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from './task-stamps.js';
import { createLogger } from '../logger.js';
import { createProject, getProject, createTask, getTask, listTasks, listProjects, updateTask, updateProject, resolveTaskId, resolveProjectId, formatResolveError, setTaskStatus, setTaskStatusResult, broadcastTaskSettled } from './schema.js';
import { ensurePMAgentRunning, noteTransitionForReview } from './pm-agent.js';
import { recordRemediation } from '../work/poke-ladder.js';
import { injectTaskAssignmentNotification } from './notify.js';
import { writeTaskLog, listTaskLog, getRecentObservations } from './task-log.js';
import { checkPlan, planRefusal, renderPlan, tasksFromPlan, explicitTasks, taskPlanMismatch } from '../work/plan.js';   // v3.5 PLAN BEFORE PROJECT
import { planOfProject } from '../work/plan-store.js';
import { applyMeasureToTask, type MeasureReading } from './measure-gate.js';   // v3.5 DONE IS MEASURED
import { normalizeTaskStatus, TERMINAL_STATUS_WORDS } from './task-status-words.js';
import { finishedScheduleRefusal, setsASchedule } from './finished-task-schedule.js';
import { taskReadWithNotes } from './task-notes-view.js';
import { linkLaterInstruction } from './later-instruction.js';
// SWEEP CORE-1 CT2: the deliverable declaration and the steer-to-deliver ladder.
import { declareDeliverableOnSchedule, declaredDeliverableShape, findLiveRecurringTwin, DELIVERABLE_OWING_TASK_KINDS } from '../work/deliverable-declaration.js';
import { calculateNextRun, normalizeDbTimestamp, parseDaysOfWeek, wallToInstant, instantToWall, getBoxTimeZone, type ScheduledTask, type WallClock } from '../scheduler/engine.js';
import { broadcast } from '../gateway/ws.js';
import { isPMAgent } from '../config/platform.js';
// t129 / S5: the ONE reassignment recorder, so the status door's assignee side path leaves
// the same shape of record the two declared reassignment doors already write.
import { taskWriteRefusal } from '../work/row-authority.js';
import { turnContext, getWorkOriginForAgent } from '../agent/turn-context.js';
import { WORK_EDITABLE_TASK_FIELDS } from '../agent/work-verb-schema.js';
import { formatTimeForAgent } from '../services/format-time.js';

const logger = createLogger('tracker-tools');

// Re-exported from the shared helpers so the trackerCreateTask /
// trackerUpdateStatus call sites keep working with their existing usage.
// The canonical implementation lives in agent/tool-helpers.ts.
import { resolveAgentRef as resolveAgentName, compactCountNote } from '../agent/tool-helpers.js';

// ── Notify primary agent of task/project completion ──

// Ticket stamps (2026-07-22): the tracker read surfaces render the engine's
// stamp line from the columns; the live delivery-evidence join stays as
// backfill for rows that predate migration 124.
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

// ── RC-18: local wall-clock schedule input ──
//
// The model's single biggest schedule failure is doing timezone math itself
// (P-2: "9 PM PT" written as a botched UTC offset lands the anchor an hour off).
// Let the model hand us the wall-clock time it means and convert it engine-side
// with the SAME wallToInstant the scheduler uses, so the offset is never the
// model's job. Accepts a tz-less "YYYY-MM-DDTHH:MM[:SS]" (or space separator)
// plus an optional IANA timezone (defaults to the box timezone).
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
    // The regex checks SHAPE, not sense: Feb 31 / month 13 / hour 25 pass it,
    // and wallToInstant normalises the overflow into a day (or hour) nobody
    // asked for. Refuse what the calendar does not have. A time inside a
    // spring-forward gap round-trips to the SAME day (moved forward within
    // it), so it stays accepted — the day, not the hour, is what must return.
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

// RC-18: one-line wall-clock echo + re-call nudge for any schedule write, so the
// wall time the agent (and user) care about is shown next to the canonical UTC
// instant. formatTimeForAgent already renders BOTH the localized form (with tz
// abbreviation) and the UTC ISO, so an agent can never misread an unlabeled ISO.
function scheduleEchoLines(scheduledStartIso: string | null, nextRunIso: string | null): string[] {
  const lines: string[] = [];
  if (scheduledStartIso) {
    lines.push(`Scheduled (local): ${formatTimeForAgent(scheduledStartIso)}`);
  }
  if (nextRunIso) {
    lines.push(`Next run (local): ${formatTimeForAgent(nextRunIso)}`);
  }
  if (scheduledStartIso || nextRunIso) {
    // PHASE-6 T0C-W: the hint is TRUE again, and this is the line that made it worth
    // wiring. T0C had to strip the `local_time` alternative from the success echo on
    // every scheduled create and edit — the most-read line in this file — because the
    // field was declared on no tool and forwarded by no door, so a model that obeyed got
    // the unknown-argument warning and a silently dropped field. Both work verbs now
    // declare it and all three doors forward it, so the cheaper route is offered again.
    lines.push('If this local time is NOT what the user asked for, re-call with the corrected time — either as an ISO 8601 UTC instant, or as local_time="YYYY-MM-DDThh:mm" and let the engine do the timezone conversion.');
  }
  return lines;
}

// A repeat number that cannot step the calendar — zero, negative, fractional,
// NaN — gives `calculateNextRun` nothing to advance by: it returns no next run,
// the scheduler completes the schedule, and the "recurring" task or reminder
// fires once and stops, with no error anywhere. The dashboard route refuses the
// number the same way (`gateway/routes/tracker.ts` `scheduleInputError`); every
// agent door that saves one refuses it here, BEFORE its pairing checks.
// `undefined`/`null` mean "no repeat number set" (or, on an edit, "clear it")
// and are nobody's error here. Coercion matches the dashboard's: "2" reads as 2.
export function repeatNumberError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(num) && Number.isInteger(num) && num >= 1) return null;
  return `Error: repeat_interval="${value}" must be a whole number of 1 or more (for example 1 for "every day"). Zero, negative or fractional numbers cannot repeat; the task would run once and stop.`;
}


// ── trackerCreateProject ──

// Stop-words used by the near-duplicate detector. Common low-information
// words that should not drive a duplicate match by themselves.
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
  /** True when the existing project was opened by the engine's multistep
   * classifier on the agent's most recent user turn (not by the agent
   * calling work_open(kind="project") themselves). */
  engineAutoCreated: boolean;
  /** First in_progress / on_deck task on the existing project, if any, 
   * the natural target for work_update(action="edit"). */
  firstOpenTask: { id: string; title: string } | null;
}

/**
 * Near-duplicate guard with two prongs:
 *
 *   (a) Engine-auto-created override: if the creator has ANY active
 *       engine-opened row (`root_kind='engine_scaffold'` — T8c item 3's
 *       rekey of the prose marker) created in the last 5 minutes,
 *       treat that as a duplicate of whatever
 *       the agent is now trying to create, regardless of title
 *       similarity. The engine just opened a project for this turn;
 *       the agent should edit it, not parallel it. (Without this, the
 *       agent's better name often diverges enough from the engine's
 *       slice-of-prompt name to clear the Jaccard threshold.)
 *
 *   (b) Token-Jaccard fallback for agent-vs-agent dups: ≥ 0.6 overlap,
 *       ≥ 2 shared content tokens, last 60 minutes. Catches the
 *       post-compaction "I forgot I made this project" failure shape.
 */
function findRecentNearDuplicateProject(
  creatorId: string,
  title: string,
): DuplicateMatch | null {
  const db = getDb();

  // (a) P3 rekey onto the P1 spine: an engine scaffold born from the SAME ask
  //     as the creating agent's current turn is THE duplicate, by identity
  //     (source_message_id equality), no clock guessing. The marker+5-minute
  //     window survives only as the pre-spine fallback for rootless rows.
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
  // T8c item 3: the fallback arm matched a PROSE PREFIX on the description; it reads the
  // row's own `root_kind` now. It also stops being project-only — the engine floor opens a
  // parentless TASK, and a `work_open(kind='project')` moments after that task is exactly the
  // parallel-work case this prong exists to steer away from.
  const engineAuto = rootMatch ?? db.prepare(`
    SELECT w.id AS id, w.title AS title, ${msToText('w.opened_at')} AS created_at FROM work w
    WHERE ${engineScaffoldScope('w')} AND w.requester_id = ?
      AND w.state IN ('open', 'claimed')
      AND w.opened_at >= ?
    ORDER BY w.opened_at DESC
    LIMIT 1
  `).get(creatorId, Date.now() - 5 * 60_000) as { id: string; title: string; created_at: string } | undefined;

  if (engineAuto) {
    const createdMs = new Date(engineAuto.created_at.includes('Z') ? engineAuto.created_at : engineAuto.created_at + 'Z').getTime();
    const firstOpen = db.prepare(`
      SELECT w.id AS id, w.title AS title FROM work w
      WHERE ${taskScope('w')} AND w.parent_id = ? AND w.state IN ('claimed', 'on_deck')
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
        WHERE ${taskScope('w')} AND w.parent_id = ? AND w.state IN ('claimed', 'on_deck')
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

    // v3.5 PLAN BEFORE PROJECT: a project opens with the plan its agent wrote (approach, and steps
    // saying what, how at scale and how it will know each is done). The engine checks the parts are
    // there and stores them; it does not judge the content. The tasks are the plan's steps unless the
    // caller passed its own, so a project always has a task for the PM to poke (the old zero-task
    // gate is this gate: a valid plan has at least one step).
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

    // Resolve inline task assignees (name / short id -> full agent id) BEFORE
    // anything is written. tasks.assigned_to carries a FOREIGN KEY to agents(id);
    // the standalone work_open(kind="task") verb resolves refs (below, ~:790) but
    // this inline path passed them through raw, so an agent NAME failed the FK
    // mid-create and stranded an empty project row (2026-07-17 run bmrpkqai2v6:
    // two orphan projects, raw "FOREIGN KEY constraint failed" to the model).
    // Same resolver, same teaching error, and nothing is written on a bad ref.
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

    // Duplicate guard. Catches the most common failure shape: agent gets
    // compacted mid-task, loses the project it already opened, and creates
    // a near-identical one. Agents can override by setting allow_duplicate=true
    // (rare, usually only valid for genuinely independent re-runs).
    const allowDuplicate = args.allow_duplicate === true;
    if (!allowDuplicate) {
      const dup = findRecentNearDuplicateProject(agentId, title);
      if (dup) {
        const shortPid = dup.id.slice(0, 8);
        const firstTaskHint = dup.firstOpenTask
          ? ` First open task: "${dup.firstOpenTask.title}" (id=${dup.firstOpenTask.id.slice(0, 8)}).`
          : '';
        if (dup.engineAutoCreated) {
          // NEXT-WAVE item 4 (absorb, don't refuse): the engine auto-opened this
          // project for the CURRENT user turn (the multi-step classifier does this
          // so the agent doesn't have to remember to call work_open(kind="project")),
          // so the agent's own create is a duplicate of it. The old "Refused:" wall
          // burned turns on rediscovery AND reads to the battery as an engine-
          // refusal signature. Absorb it instead: an OK-shaped no-op that names the
          // existing project + its first task, so the agent just continues in it
          // without a scold.
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

    // Give every inline task a goal. The tasks[] shape historically carried no
    // goal field, so createProject left them goal=NULL, which makes them
    // impossible for PM to validate ("(none recorded)"): PM reverts each
    // completion and the agent re-submits forever (the validation ping-pong the
    // user reported). Mirror work_open(kind="task"): default the goal from the
    // caller-provided goal (if any), else the task's description, else its
    // title. Only fill when empty, never overwrite a real goal.
    const measureLines = result.taskIds.map((id, i) => { const m = opts.taskMeasures?.[i]; return m ? applyMeasureToTask(id, m) : null; });   // v3.5
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

    // Auto-spawn PM agent if not running
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

    // Notify assignees of nested tasks (skips the creator's own tasks).
    // Mirrors trackerCreateTask's notification path so tasks created via
    // create_project don't silently sit waiting for someone to notice.
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

export function trackerCreateTask(agentId: string, args: Record<string, unknown>, opts: { measure?: MeasureReading } = {}): string {
  try {
    const title = args.title as string;
    if (!title) return 'Error: title is required';

    const projectId = args.projectId as string | undefined;
    const description = args.description as string | undefined;
    // Phase B.1: goal is required on every new task (Q6). PM is the supreme
    // authority on whether the work matches; without a goal there is nothing
    // to compare result+evidence against. The engine accepts `goal` (camelCase)
    // or `goal_description` (legacy alias). Empty string is rejected.
    let goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    if (!goal && typeof description === 'string' && description.trim()) {
      // Permissive fallback for now: copy description into goal when caller
      // forgot. Logged so we can see who needs prompt updates. Once every
      // caller is migrated this fallback can be removed and we hard-reject.
      goal = description.trim();
      logger.info('work_open(kind="task"): goal omitted, defaulted from description', { agentId, title }, agentId);
    }
    if (!goal) {
      return 'Error: `goal` is required. One-sentence definition of done that PM will compare result + evidence against. Example: goal="migrate all 12 routes under packages/server/src/gateway/routes/ to the new auth middleware, with each route\'s tests passing".';
    }
    // Default assigned_to to the calling agent if not specified
    // Resolve agent name to ID if a name was passed instead of a UUID
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

    // RC-18: local wall-clock schedule input. When the caller passes local_time
    // (a tz-less wall clock) instead of doing the UTC math itself, convert it
    // engine-side into scheduled_start. Explicit scheduled_start wins if both are
    // given. Anchor defaults to scheduled_start downstream, so we only set the
    // start here.
    let resolvedScheduleZone: string | null = null;
    if (args.local_time !== undefined && args.local_time !== null && args.local_time !== '' && !args.scheduled_start) {
      if (typeof args.local_time !== 'string') {
        return 'Error: local_time must be a string wall-clock time, e.g. "2026-07-16T21:00".';
      }
      const tz = (args.local_timezone ?? args.tz) as string | undefined;
      const resolved = resolveLocalWallClock(args.local_time, typeof tz === 'string' ? tz : undefined);
      if (!resolved.ok) return resolved.error;
      args.scheduled_start = resolved.iso;
      // UX-REPAIR round 2 T13 — KEEP THE ZONE. `resolveLocalWallClock` has always resolved the
      // caller's `local_timezone` correctly and then thrown the answer away: the `alongside`
      // patch below carried scheduled_start / repeat_* / anchor_local and no zone, and
      // `work.tz` was unwritable anyway. So the per-reminder zone contract the tool advertises
      // was silently void and every calendar-unit advance resolved against the process
      // timezone. Recorded here, at the moment the engine knows it.
      resolvedScheduleZone = resolved.zone;
    }

    // 2026-07-03: schedule timestamps must be parseable, checked BEFORE the
    // row is created. An unparseable scheduled_start used to be kept verbatim
    // ("keep original if parse fails") and written into scheduled_start AND
    // next_run_at; the scheduler's `next_run_at <= <now ISO>` string
    // comparison then never matches, so the task sits schedule_status=
    // 'waiting' forever and SILENTLY never fires (observed live via the
    // behavioral harness: work_open(kind="reminder") when="in 2 minutes" produced a
    // reminder that never fired). The engine rejects it at the boundary with
    // a corrective hint; resolving relative phrases is the model's job
    // (get_current_time + offset), per the tool docs it already has.
    for (const field of ['scheduled_start', 'anchor_time']) {
      const value = args[field];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || isNaN(new Date(value).getTime())) {
        return (
          `Error: ${field}="${String(value)}" is not a parseable datetime, so the scheduler could never ` +
          `fire this task (it would wait forever). Resolve relative times yourself: call get_current_time, ` +
          `add the offset (e.g. "in 2 minutes" = current UTC + 2 minutes), and re-call with an ISO 8601 ` +
          `UTC timestamp, e.g. ${field}="2026-07-03T16:38:00Z".`
        );
      }
    }

    // FA-S4: a specific_days schedule needs at least one weekday. An empty or
    // invalid repeat_days_of_week allowlist silently degrades the recurrence
    // into a single fire then complete (calculateNextRun's specific_days walk
    // makes no progress with no allowed day, so next_run_at resolves once and
    // then never again). Reject at the boundary, before the row is created,
    // same fail-loud contract the parseability check above enforces. Only
    // matters when a schedule is actually being written (scheduled_start set).
    if (args.scheduled_start && args.repeat_unit === 'specific_days'
        && !parseDaysOfWeek((args.repeat_days_of_week as string | undefined) ?? null)) {
      return (
        'Error: repeat_unit="specific_days" needs at least one weekday in repeat_days_of_week ' +
        '(comma-separated 0=Sun..6=Sat, e.g. "1,3" for Mon+Wed). With no valid days the task would ' +
        'fire once and then never repeat. Either pass repeat_days_of_week with the days you want, or ' +
        'use repeat_unit="weeks" with repeat_interval=1 for a plain weekly cadence.'
      );
    }

    // Near-duplicate guard (2026-06-02 bug fix). Without this, a hoarding-
    // gate error on file_read/exec can put the agent into a loop where
    // every iteration calls work_open(kind="task") with the same title, 27
    // duplicates landed in one session before this guard. Two prongs,
    // both within a 5-minute window because tasks turn over faster than
    // projects:
    //   (a) Exact-title-match by the same creator + same assignee.
    //   (b) Jaccard ≥ 0.6 on normalised content tokens, ≥ 2 shared tokens.
    // Agent can override with allow_duplicate=true when the dup match is
    // a false positive (e.g. genuinely separate work that shares keywords).
    const allowDuplicate = (args.allow_duplicate as boolean) ?? false;
    if (!allowDuplicate) {
      const db = getDb();
      const exact = db.prepare(`
        SELECT w.id AS id, substr(w.id, 1, 8) as id8 FROM work w
        WHERE ${taskScope('w')} AND w.requester_id = ?
          AND LOWER(w.title) = LOWER(?)
          AND COALESCE(w.assignee_agent, '') = COALESCE(?, '')
          AND w.state IN ('on_deck', 'claimed', 'paused', 'blocked')
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
            AND w.state IN ('on_deck', 'claimed', 'paused', 'blocked')
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

    // ════════════════════════════════════════════════════════════════════════════
    // SWEEP CORE-1 CT2 — THE DUPLICATE **RECURRING** GUARD.
    //
    // From the same 2026-08-07 transcript as the run-completion incident: after the timezone
    // fix the owner recreated his two briefs and never cancelled the old pair, so FOUR
    // schedules were firing where two should. He was told about the same thing twice, every
    // morning, from schedules he had no memory of creating.
    //
    // ── WHY THE GUARD ABOVE COULD NOT HAVE CAUGHT IT, and this is the whole design ──
    // Both prongs above are scoped to `opened_at >= now - 5 minutes`. They exist for a
    // different disease: a tool-error loop minting 27 copies of one task inside one session.
    // His duplicate was created DAYS after its twin, deliberately, by a person who thought he
    // was replacing something. A five-minute window cannot see that and never could.
    //
    // A LIVE RECURRING SCHEDULE IS DIFFERENT IN KIND FROM A TASK ROW: it is a standing
    // instruction that fires for ever. Two of them with the same owner, the same cadence and
    // the same deliverable shape are not "two pieces of work that share a title" — they are one
    // instruction the platform will carry out twice, indefinitely. So this prong has NO TIME
    // WINDOW at all. It asks a different question and it gets a different scope.
    //
    // ── THE THREE THINGS THAT MUST MATCH, each chosen against his actual case ──
    //   same owner      — `requester_id`, the creating agent, as both prongs above use.
    //   same CADENCE    — `repeat_interval` + `repeat_unit` + `repeat_days_of_week`. NOT the
    //                     anchor instant, and that is the load-bearing exclusion: he recreated
    //                     the briefs BECAUSE the anchor was wrong, so the twin he was trying to
    //                     replace has a DIFFERENT anchor by construction. Matching on the
    //                     anchor would have missed his case exactly.
    //   same DELIVERABLE SHAPE — the CT2 declaration (`work/deliverable-declaration.ts`),
    //                     derived from each definition. Two daily `brief` schedules for one
    //                     owner is the shape; a daily brief beside a daily backup is not.
    //
    // Only LIVE schedules count (`schedule_status IN ('waiting','running')`, not paused, not
    // terminal): a stopped schedule fires nothing and refusing against it would block a
    // legitimate re-creation, which is precisely what the owner was trying to do.
    //
    // `allow_duplicate` is honoured with its EXISTING semantics — the same flag, the same
    // meaning ("I know, I meant it"), read once at the top for all three prongs. Nothing about
    // the two prongs above changes.
    // ════════════════════════════════════════════════════════════════════════════
    if (!allowDuplicate && args.repeat_interval) {
      const shape = declaredDeliverableShape({
        kind: args.kind as string | undefined,
        title,
        description: description ?? null,
        goal,
        hasSchedule: true,
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
      // T34: the goal rides the INSERT. It used to be patched on immediately after `createTask`
      // had already broadcast the row, so the announcement frame was stale about the goal on
      // every creation through this door — the same defect as the schedule columns, one column
      // over. A row is announced complete, or it is announced twice.
      goal,
    });
    const measureSet = opts.measure ? applyMeasureToTask(taskId, opts.measure) : null;   // v3.5: kept on every later return

    // T34: the view `createTask` just put on the wire. Everything below this line — the on_deck
    // transition, the fire time, the group — changes the row AFTER that frame, so the settle
    // frame at the end compares against this one and corrects the wire if the row moved.
    const announced = getTask(taskId);

    // Status reconciliation. v2.8.x rule: 'on_deck' is reserved for
    // tasks with a FUTURE scheduled_start (the scheduler owns the
    // transition to 'in_progress' at fire time). Anything else lands
    // in 'in_progress' immediately so the assigned agent and the PM
    // keep seeing it as work to do, sitting in 'on_deck' without a
    // schedule was the failure mode where agents created multi-task
    // projects, worked the first one, and never returned to the rest.
    // The schema default (set in createTask above) is now 'in_progress'
    // for all rows; we only override to 'on_deck' here when a future
    // schedule justifies it.
    let scheduledStart = args.scheduled_start as string | undefined;
    if (scheduledStart) {
      // Parseability was validated before the row was created (above); this
      // just normalizes to ISO so every downstream comparison is consistent.
      const parsed = new Date(scheduledStart);
      if (!isNaN(parsed.getTime())) scheduledStart = parsed.toISOString();
    }
    // hasFutureSchedule is true only when scheduled_start is in the
    // future (past-dated scheduled_start counts as "fire ASAP" and lands
    // in_progress immediately), OR when repeat_interval is set (recurring
    // tasks always go through the scheduler).
    const scheduledStartIsFuture = !!(
      scheduledStart && new Date(scheduledStart).getTime() > Date.now()
    );
    const hasFutureSchedule = scheduledStartIsFuture || !!args.repeat_interval;
    if (hasFutureSchedule) {
      try {
        noteUnsettled(setTrackerStatus(taskId, 'on_deck', { by: 'agent', actorId: agentId, reason: 'scheduled for later; the scheduler owns the move to in_progress at fire time' }), 'work_open: scheduled for later', { taskId });
      } catch { /* ignore */ }
    }

    // Auto-spawn PM agent if not running
    try {
      ensurePMAgentRunning();
    } catch (err) {
      logger.warn('Failed to ensure PM agent is running', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // Handle scheduling
    if (scheduledStart) {
      const db = getDb();
      const repeatInterval = args.repeat_interval as number | undefined;
      const repeatUnit = args.repeat_unit as string | undefined;
      const repeatEndType = (args.repeat_end_type as string | undefined) ?? 'never';
      const repeatEndValue = args.repeat_end_value as string | undefined;
      // v2.5.2, specific_days uses an explicit day-of-week allowlist.
      // Already normalized to CSV-of-ints by the tool dispatcher.
      const repeatDaysOfWeek = args.repeat_days_of_week as string | undefined;
      // v2.5.45, anchor_time defaults to scheduled_start, normalizing
      // wall-clock alignment for all future recurring runs. Caller can
      // override (e.g. agent setting "anchor at 06:00 even though I'm
      // creating this at 14:23").
      let anchorTime = args.anchor_time as string | undefined;
      if (anchorTime) {
        // Validated parseable at the top of this function; normalize to ISO.
        const parsed = new Date(anchorTime);
        if (!isNaN(parsed.getTime())) anchorTime = parsed.toISOString();
      } else if (repeatInterval) {
        anchorTime = scheduledStart;
      }

      const taskForCalc = {
        id: taskId,
        scheduled_start: scheduledStart,
        repeat_interval: repeatInterval ?? null,
        repeat_unit: repeatUnit ?? null,
        repeat_end_type: repeatEndType,
        repeat_end_value: repeatEndValue ?? null,
        run_count: 0,
        is_paused: 0,
        last_run_at: null,
        next_run_at: null,
        schedule_status: 'waiting',
        repeat_days_of_week: repeatDaysOfWeek ?? null,
        anchor_time: anchorTime ?? null,
        // T13: the row's own zone reaches the very first advance too, not only later ones.
        tz: resolvedScheduleZone,
      };
      const nextRun = calculateNextRun(taskForCalc) ?? scheduledStart;

      noteUnsettled(setNextRun(taskId, {
        at: tsToMs(nextRun),
        reason: 'a schedule was created; this is its first fire time',
        alongside: {
          scheduled_start: tsToMs(scheduledStart), repeat_interval: repeatInterval ?? null,
          repeat_unit: repeatUnit ?? null, repeat_end_type: repeatEndType,
          repeat_end_value: repeatEndValue ?? null, repeat_days_of_week: repeatDaysOfWeek ?? null,
          anchor_local: anchorTime ?? null, schedule_status: 'waiting',
          // T13: the declared per-reminder zone, persisted. NULL when the caller named none —
          // and NULL means the box timezone, which is byte-identically today's behaviour.
          tz: resolvedScheduleZone,
        },
      }), 'trackerCreateTask: schedule recorded', { taskId });

      // SWEEP CORE-1 CT2 — DECLARE WHAT THIS SCHEDULE OWES A PERSON, ONCE, HERE.
      // After the schedule columns, because "is this scheduled at all" is one of the inputs.
      // Idempotent and never overriding a caller who named the kind. Its runs will not be
      // recordable as complete without a message the person actually received.
      declareDeliverableOnSchedule(taskId);
    }

    // Handle group assignment (validated: an unknown group id would otherwise
    // surface as a raw FK error the model cannot act on)
    const assignedToGroup = args.assigned_to_group as string | undefined;
    if (assignedToGroup) {
      const groupRow = getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(assignedToGroup);
      if (!groupRow) {
        // T34: this path still created and settled a row, so the wire owes the truth about it
        // before we hand the model its error.
        broadcastTaskSettled(taskId, announced);
        return `Error: agent group '${assignedToGroup}' does not exist. The task was created assigned to you; use work_update(action="edit") to reassign once you have a valid group id.`;
      }
      noteUnsettled(patchWork(taskId, { assigned_to_group: assignedToGroup, assignee_agent: null }), 'trackerCreateTask: assigned to a group', { taskId });
    }

    // T34: every write to this row is done. If the row moved since it was announced — a future
    // schedule settles it `on_deck` with a fire time, and the goal lands after the insert — the
    // wire hears the settled row now, so the LAST frame for this id equals the stored row. A
    // creation that settled nothing sends nothing (the announcement was already true).
    broadcastTaskSettled(taskId, announced);

    const parts = [
      `[OK] task_id=${taskId} | title=${title}`,
      ``,
      `Task created successfully.`,
    ];
    if (measureSet) parts.push(measureSet);
    if (projectId) parts.push(`Project: ${projectId}`);
    if (assignedTo) parts.push(`Assigned to: ${assignedTo}`);
    if (assignedToGroup) parts.push(`Assigned to group: ${assignedToGroup}`);
    if (priority) parts.push(`Priority: ${priority}`);
    if (scheduledStart) {
      // RC-18: echo the wall-clock (with tz + canonical UTC) instead of a raw ISO,
      // and show the computed next run, so the anchor the user cares about is
      // visible and any timezone mistake is caught before it fires.
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

// ── reminderCreate ──
//
// Thin wrapper around trackerCreateTask that handles the "user asked for
// a reminder" intent. The agent calls this with `what` (required) and
// `when` (optional). If `when` is missing, returns an ASK_USER
// instruction so the agent loops back, asks the user, and re-fires with
// the resolved ISO time. Otherwise creates a tracker task with
// kind='reminder' and the supplied schedule, the scheduler then fires
// it with the reminder-flavored template (see scheduler/runner.ts).

export function reminderCreate(agentId: string, args: Record<string, unknown>): string {
  const what = (args.what as string | undefined)?.trim();
  if (!what) return 'Error: `what` is required (the reminder text).';

  const when = (args.when as string | undefined)?.trim();
  // RC-18: a local wall-clock (local_time) is an accepted alternative to `when`;
  // the engine converts it to the anchor instant, so the model never does UTC math.
  const localTime = (args.local_time as string | undefined)?.trim();
  if (!when && !localTime) {
    return (
      'ASK_USER: This reminder needs a time. Ask the person you are talking to when they would like to be ' +
      'reminded ("in 5 minutes", "tomorrow at 8am", "every Monday at 9am"). ' +
      // PHASE-6 T0C-W: the wall-clock alternative is offered again — declared on
      // work_open and forwarded by this door since this task. See scheduleEchoLines.
      'Once they answer, call get_current_time to anchor relative times and re-call ' +
      'work_open(kind="reminder") with `when` set to the resolved ISO 8601 datetime, ' +
      'or with local_time="YYYY-MM-DDThh:mm" if they named a plain clock time. ' +
      'Do NOT create the reminder yet.'
    );
  }

  // 2026-07-03: same boundary validation trackerCreateTask enforces, but with
  // a `when`-flavored message (that is the arg the caller actually used). An
  // unparseable `when` used to flow into next_run_at verbatim and the reminder
  // silently never fired (behavioral harness caught when="in 2 minutes").
  if (when && isNaN(new Date(when).getTime())) {
    return (
      `Error: when="${when}" is not a parseable datetime, so this reminder would never fire. ` +
      `Resolve the relative time yourself: call get_current_time, add the offset ` +
      `(e.g. "in 2 minutes" = current UTC + 2 minutes), then re-call work_open(kind="reminder") with an ` +
      // PHASE-6 T0C-W: the alternative is reachable again — declared and forwarded.
      `ISO 8601 UTC timestamp, e.g. when="2026-07-03T16:38:00Z". ` +
      `Or pass local_time="YYYY-MM-DDThh:mm" and let the engine resolve the zone.`
    );
  }

  // Title is for the kanban, keep short and recognizable.
  const titleSnippet = what.length > 60 ? what.slice(0, 57).trimEnd() + '…' : what;

  return trackerCreateTask(agentId, {
    title: `Reminder: ${titleSnippet}`,
    description: what,
    kind: 'reminder',
    scheduled_start: when,
    // RC-18: forward the wall-clock inputs; trackerCreateTask converts local_time
    // to scheduled_start engine-side when scheduled_start (`when`) is absent.
    local_time: localTime,
    local_timezone: args.local_timezone,
    tz: args.tz,
    // Caller may pass repeat params through for recurring reminders
    // ("every Monday at 9am"). Same shape as work_open(kind="task").
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
    // t193: the `assigned_to` side door is GONE (it moved work with no cause or ownership check). Moving
    // is `:reassign`'s, under the row-authority cause rule. A status call carrying `assigned_to` is now
    // refused at the tool door by the per-operation argument check (test-2 rank 3, `WORK_OP_READS`),
    // which replaced the one-off guard that stood here; this writer never reads an assignee.
    const priority = args.priority as string | undefined;

    if (!status && !priority) {
      return 'Error: at least one of status or priority must be provided';
    }

    { const no = taskWriteRefusal(agentId, taskId, 'change the status of'); if (no) return no; }   // t193 (dec 3): only the task's holder, its creator, the PM and the main agent change it.
    // The prior status, for the task_log transition entry below (the row has moved once it is written).
    const db = getDb();
    const taskRow = db.prepare(`SELECT title, ${STATE_TO_STATUS_SQL('state')} as prior_status FROM work WHERE id = ?`).get(taskId) as { title: string; prior_status: string } | undefined;
    const priorStatus = taskRow?.prior_status ?? null;

    // v2.10.1, idempotency check. When the agent calls
    // work_update(action="status") with a status that the task is already at,
    // do nothing and tell the agent clearly. Pre-fix the call still ran
    // the full update + emitted "[OK] Task updated" + sent the success
    // notification, which read to the agent as "I did real work" and
    // encouraged re-closing already-complete tasks based on stale
    // scheduler triggers still in its context window
    // (production incident 2026-06-08: agent close-loop on already-
    // complete recurring emails). Skip only when status is the only
    // requested change; if the call also changes assignedTo or
    // priority, fall through to the normal update so those land.
    if (
      status &&
      !priority &&
      priorStatus === status
    ) {
      // t151 (D): the call may still carry a note. The status is unchanged, the words are not nothing:
      // record them exactly as `work_note` does (an observation by this agent) and say so. A note is a
      // record on the task, not progress on it (the PM's ladder does not read it as movement).
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

    // v2.8.x rule: 'on_deck' is reserved for tasks with a FUTURE
    // scheduled_start (the scheduler owns the transition to 'in_progress'
    // at fire time). Anything else belongs in 'in_progress' so the work
    // stays visible to the assigned agent and the PM. Refuse explicit
    // moves to 'on_deck' on tasks without a future schedule so agents
    // don't accidentally park work in the "waiting for never" bucket, 
    // the failure mode being addressed is the agent creating tasks,
    // working one, and forgetting the rest.
    if (status === 'on_deck' && !isPMAgent(agentId)) {
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

    // Pass resume_at through for timed pauses
    const resumeAt = args.resume_at as string | undefined;
    if (status === 'paused' && resumeAt) {
      updates.pausedUntil = resumeAt;
    }

    // PM is the overseer. Its proactive transitions skip the worker-targeted
    // hard gates below. The audit trail still logs from_entity='pm', and
    // the validate_*/override tools are the structured PM paths.
    const callerIsPM = isPMAgent(agentId);

    // ── Pause-reason engine pre-check (v2.7.18) ──
    // Pausing without a real wait condition was the most common gaming
    // pattern: agents marked tasks paused just to silence PM pokes. The
    // engine refuses empty/short notes here; PM validates the SUBSTANCE of
    // the reason on its next tick (see pause_validated column + the
    // work_validate(action="validate") tool).
    if (status === 'paused' && !callerIsPM) {
      const pauseNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      const MIN_PAUSE_NOTES_LEN = 15;
      if (pauseNotes.length < MIN_PAUSE_NOTES_LEN) {
        return (
          `Error: paused tasks require a clear reason in \`notes\` (minimum ${MIN_PAUSE_NOTES_LEN} characters). ` +
          `\`notes\` must name the specific external trigger you're waiting on - for example: ` +
          `"waiting for user to reboot ESP board", "waiting for vendor to send tracking number". ` +
          `If you're stuck and don't know what to do, that's NOT a paused condition - use \`status="blocked"\` ` +
          `with the real reason so the user knows. If you're just done with the task, hand it in with \`work_update(action="hand_in")\`. ` +
          `Pausing without a real reason will be reverted by the PM agent on its next tick.`
        );
      }
      // Anti-gaming sniff: catch phrases that signal the agent is hiding
      // from PM rather than waiting on a real condition. PM still gets the
      // final say, but we may as well refuse the obvious cases at the door.
      const lower = pauseNotes.toLowerCase();
      const gamingSignals = ['pm keeps', 'pm is', 'silence pm', 'stop the pm', 'nagging', 'stop poking', 'stop the poke'];
      const matched = gamingSignals.find(s => lower.includes(s));
      if (matched) {
        return (
          `Error: this pause reason ("${pauseNotes.slice(0, 100)}") reads as an attempt to silence the PM, not a real wait condition. ` +
          `If you're stuck, use \`status="blocked"\` with the real reason. ` +
          `If you actually have a user-facing question, ask the person you are talking to first then re-pause with a concrete "waiting for X" reason.`
        );
      }
    }

    if (status === 'blocked' && !callerIsPM) {
      const blockedNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      if (blockedNotes.length < 15) {
        return 'Error: status="blocked" requires a clear reason in `notes` (minimum 15 characters). '
          + 'Name the specific obstacle (e.g. "need API key for service X", "external service Y is returning 500s"). '
          + 'If you are paused waiting for the user to do something, use status="paused" with notes naming the wait condition instead.';
      }
    }

    // PHASE-2 T8b: the column half and the STATE half are two calls now, because they are
    // two different things. `updateTask` patches; `setTaskStatusResult` is `transition()`
    // and hands back the gate's verdict so a refusal can be steered on instead of read as
    // "the task vanished".
    const { status: statusUpdate, ...columnUpdates } = updates as Record<string, unknown>;

    let task = Object.keys(columnUpdates).length > 0
      ? updateTask(taskId, columnUpdates)
      : getTask(taskId);

    if (statusUpdate) {
      const sr = setTaskStatusResult(taskId, statusUpdate as TrackerStatus, {
        by: callerIsPM ? 'pm' : 'agent', actorId: agentId,
        reason: `work_update(action="status") -> ${String(statusUpdate)}`,
        pausedUntilMs: updates.pausedUntil !== undefined ? tsToMs(updates.pausedUntil as string | null) : undefined,
        // The tool path is the one that stops the schedule with the status (updateTask's
        // own rule); the engine's ball-is-with-the-owner pause deliberately does not.
        syncSchedulePause: true,
        userQuote: typeof args.user_quote === 'string' ? args.user_quote : null,
      });
      if (!workSettled(sr.result)) {
        return `Refused: the status of ${taskId} did not change (${sr.result.detail}).`;
      }
      task = sr.task;
    }

    if (!task) {
      // We already resolved taskId above, so the id existed at resolve time.
      // A null return from updateTask now means one of two rare things:
      //   1. Another agent deleted the task between resolve and update
      //   2. The task was deleted between the UPDATE and the SELECT
      // Either way, the task genuinely no longer exists, not a prefix mismatch.
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // Phase B.0: write the transition + any supplied notes to task_log.
    // tasks.notes is now read-only legacy (Q7), new code does not append to it.
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
        // Event-driven PM wake: buffer + 10s debounce, then runPMReview.
        // Smell detector also fires inside noteTransitionForReview.
        noteTransitionForReview(taskId, status);
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
    if (task.status === 'paused' && task.pausedUntil) {
      parts.push(`Auto-resumes: ${formatTimeForAgent(task.pausedUntil)} (will restore to "${task.statusBeforePause ?? 'on_deck'}")`);
    } else if (task.status === 'paused') {
      parts.push('Paused indefinitely, must be resumed manually.');
    }

    linkLaterInstruction(agentId, taskId);
    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerUpdateStatus failed', { error: msg }, agentId);
    return `Error updating task: ${msg}`;
  }
}

// ── trackerAddNotes ──
//
// Phase B.0: writes an observation entry to task_log instead of appending to
// the legacy tasks.notes column. Call signature is unchanged so agents do
// not need to relearn.

export function trackerAddNotes(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

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

// C27: trackerEditNotes + trackerClearNotes (dead v2.8.0 stubs that always
// returned an Error directive) were DELETED along with their tool defs; the old
// tool names are now tombstone aliases (tools/aliases.ts).

// ── trackerEditTask ──
// Edit any structural field on a task, title, description, dependencies,
// step ordering, schedule. This is the catch-all editor; status changes still
// go through trackerUpdateStatus (because completing a task has notification
// + project-rollup side-effects), and the schedule pause/resume pair stays on
// trackerPauseSchedule / trackerResumeSchedule (because those write a reason
// and notify the PM differently).
//
// Everything else lives here. If a future field is added to the tasks table,
// the rule of thumb is: "does setting it have a side-effect beyond the row
// update?" If no, add it to this tool. If yes, give it its own tool.

export function trackerEditTask(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    { const no = taskWriteRefusal(agentId, taskId, 'edit'); if (no) return no; }   // t193 (dec 3): editors only — holder, creator, PM, main agent.
    // RC-18: local wall-clock schedule input on edit too. Convert local_time to
    // scheduled_start engine-side before the field reads below. Explicit
    // scheduled_start wins if both are given.
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

    // PHASE-6 T0A: the supplied-field check and the refusal's `Editable:` list are keyed
    // by ONE declaration (`WORK_EDITABLE_TASK_FIELDS` — its header carries the defect).
    // Keys are the advertised names, values are the locals above (the actual reads), so
    // the map is a join between the two rather than a second copy of either.
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
    // The repeat number must be able to step the calendar (same refusal as
    // the two work_open doors) — but only when one is being SET: `null` is
    // the supported way to clear a repeat, and stays allowed through here.
    if (repeatInterval !== undefined && repeatInterval !== null) {
      const repeatNumErr = repeatNumberError(repeatInterval);
      if (repeatNumErr) return repeatNumErr;
    }

    // Recurring-schedule integrity gate (same shape as work_open(kind="task")'s): the edit path is
    // the OTHER way to produce a partial schedule (add repeat_interval with no repeat_unit, or
    // strip the unit). Compute the EFFECTIVE post-edit values and reject before applying.
    const isScheduleEdit =
      scheduledStart !== undefined ||
      repeatInterval !== undefined ||
      repeatUnit !== undefined;
    if (isScheduleEdit) {
      const current = getDb().prepare(`
        SELECT ${msToText('scheduled_start')} AS scheduled_start, repeat_interval, repeat_unit
          FROM work WHERE id = ?
      `).get(taskId) as { scheduled_start: string | null; repeat_interval: number | null; repeat_unit: string | null } | undefined;
      const VALID_REPEAT_UNITS = new Set([
        'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days',
      ]);
      const effScheduledStart = scheduledStart === undefined
        ? current?.scheduled_start ?? null
        : (scheduledStart ?? null);
      const effInterval = repeatInterval === undefined
        ? current?.repeat_interval ?? null
        : (repeatInterval ?? null);
      const effUnit = repeatUnit === undefined
        ? current?.repeat_unit ?? null
        : (repeatUnit ?? null);
      const effHasInterval = effInterval !== null && effInterval !== undefined;
      const effHasUnit = effUnit !== null && effUnit !== undefined && effUnit !== '';
      // Catch invalid unit first so a typo like "weekly" produces a
      // corrective hint instead of a misleading missing-interval message.
      if (effHasUnit && !VALID_REPEAT_UNITS.has(effUnit as string)) {
        return `Error: repeat_unit="${effUnit}" is not a valid unit. Valid values: minutes, hours, days, weeks, months, years, weekdays, specific_days. Common mistakes: "weekly" → repeat_unit="weeks"; "daily" → repeat_unit="days".`;
      }
      if (effHasInterval && !effHasUnit) {
        return 'Error: this edit would leave the task with repeat_interval set but no repeat_unit. The task would fire at most once. Either set repeat_unit (one of: minutes, hours, days, weeks, months, years, weekdays, specific_days), or clear repeat_interval (pass null) to turn off recurrence.';
      }
      if (effHasUnit && !effHasInterval && effUnit !== 'specific_days') {
        return `Error: this edit would leave the task with repeat_unit="${effUnit}" but no repeat_interval. The scheduler can't compute the next run. Either set repeat_interval (e.g. 1 for "every ${effUnit!.replace(/s$/, '')}"), or clear repeat_unit to turn off recurrence.`;
      }
      if ((effHasInterval || effHasUnit) && !effScheduledStart) {
        return 'Error: this edit would leave the task with recurring fields set but no scheduled_start. The scheduler has no anchor for the first run. Either set scheduled_start to an ISO 8601 timestamp, or clear repeat_interval and repeat_unit to turn off recurrence.';
      }
    }

    // FA-S4: reject an effective specific_days schedule with an empty
    // day-of-week allowlist. specific_days + no valid days silently degrades
    // to a single fire then complete (calculateNextRun's specific_days walk
    // can't advance without an allowed day). This runs whenever the edit could
    // change the effective unit OR the day list, including the days-only edit
    // (repeat_days_of_week -> [] / null) the schedule-integrity gate above does
    // not cover because it only triggers on scheduled_start/interval/unit
    // changes. Mirrors the fail-loud creator check in trackerCreateTask.
    if (repeatUnit !== undefined || repeatDaysOfWeek !== undefined) {
      const cur = getDb().prepare(
        'SELECT repeat_unit, repeat_days_of_week FROM work WHERE id = ?',
      ).get(taskId) as { repeat_unit: string | null; repeat_days_of_week: string | null } | undefined;
      const effUnit = repeatUnit === undefined ? (cur?.repeat_unit ?? null) : (repeatUnit ?? null);
      const effDays = repeatDaysOfWeek === undefined ? (cur?.repeat_days_of_week ?? null) : (repeatDaysOfWeek ?? null);
      if (effUnit === 'specific_days' && !parseDaysOfWeek(effDays)) {
        return (
          'Error: repeat_unit="specific_days" needs at least one weekday in repeat_days_of_week ' +
          '(comma-separated 0=Sun..6=Sat, e.g. "1,3" for Mon+Wed). This edit would leave it with no ' +
          'valid days, so the task would fire once and then never repeat. Either pass repeat_days_of_week ' +
          'with the days you want, or switch repeat_unit (e.g. "weeks" with repeat_interval=1 for a plain ' +
          'weekly cadence).'
        );
      }
    }

    // Phase B.1: goal edits are special. PM watches for goalpost-narrowing
    // mid-work. We log both old and new with a diff, so PM can see history
    // when validating later.
    if (goal !== undefined) {
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

    // ── RC-16: task content (title/description) edits are audited AND guarded ──
    // Snapshot title/description/original_description BEFORE the update so we can
    // (a) write a task_log audit entry for content edits, the same discipline
    // goal edits already get above, and (b) enforce the exact-revert guard. Two
    // structural defects made P-1 (a silent description revert) possible and
    // invisible: any agent could rewrite any task's description with no guard,
    // and description/title edits were NOT task_log-audited (only goal edits).
    const contentSnapshot = (title !== undefined || description !== undefined)
      ? getDb().prepare('SELECT title, description, original_description FROM work WHERE id = ?')
          .get(taskId) as { title: string | null; description: string | null; original_description: string | null } | undefined
      : undefined;

    // Exact-revert guard (RC-16): restoring `description` to a value that is
    // byte-identical to the immutable `original_description`, while the current
    // description has already been edited away from it (a later edit exists),
    // requires an explicit revert_to_original=true. This blocks the silent
    // "restore the stale original over a legitimate later edit" write (P-1)
    // without preventing an intentional, acknowledged revert.
    if (description !== undefined && description !== null && description !== '' && contentSnapshot) {
      const orig = contentSnapshot.original_description;
      const cur = contentSnapshot.description;
      const isByteIdenticalToOriginal = orig !== null && description === orig;
      const laterEditExists = cur !== orig; // current diverged from the original ask
      if (isByteIdenticalToOriginal && laterEditExists && args.revert_to_original !== true) {
        return (
          `Error: this edit restores the description to the task's ORIGINAL text byte-for-byte, over a later edit that changed it. ` +
          `That is usually an accidental revert of intended work (a stale copy overwriting the current description). ` +
          // PHASE-6 T0C-W: the escape hatch is REACHABLE and this line names it again.
          // T0C had to strike it: the refusal told the model to re-call with
          // `revert_to_original=true` while the flag was declared on no tool, so a model
          // that obeyed got the unknown-argument warning, the flag dropped, and the
          // identical refusal back — a loop the guard itself created. `work_update` now
          // declares it and the edit door forwards it. The GUARD IS UNCHANGED: without
          // the flag this refusal still fires, which is the whole point of an
          // acknowledgement rather than an option.
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
    if (scheduledStart !== undefined) {
      // Normalize to UTC ISO so downstream scheduling code doesn't trip on
      // a local-time string, same handling as trackerCreateTask.
      if (scheduledStart === null || scheduledStart === '') {
        updates.scheduledStart = null;
      } else {
        try {
          const parsed = new Date(scheduledStart);
          updates.scheduledStart = isNaN(parsed.getTime()) ? scheduledStart : parsed.toISOString();
        } catch {
          updates.scheduledStart = scheduledStart;
        }
        // A moved start moves the anchor too (create does the same): the old anchor would keep the
        // old time of day and could put the next run before the new start. An explicit anchor_time
        // in the same call is read below and wins.
        if (anchorTime === undefined) updates.anchorTime = updates.scheduledStart;
      }
    }
    if (repeatInterval !== undefined) updates.repeatInterval = repeatInterval;
    if (repeatUnit !== undefined) updates.repeatUnit = repeatUnit;
    if (repeatEndType !== undefined) updates.repeatEndType = repeatEndType;
    if (repeatEndValue !== undefined) updates.repeatEndValue = repeatEndValue;
    if (repeatDaysOfWeek !== undefined) updates.repeatDaysOfWeek = repeatDaysOfWeek;
    if (anchorTime !== undefined) {
      if (anchorTime === null || anchorTime === '') {
        updates.anchorTime = null;
      } else {
        try {
          const parsed = new Date(anchorTime);
          updates.anchorTime = isNaN(parsed.getTime()) ? anchorTime : parsed.toISOString();
        } catch {
          updates.anchorTime = anchorTime;
        }
      }
    }
    if (priority !== undefined) updates.priority = priority;
    if (notes !== undefined) updates.notes = notes;

    // A goal-only edit has already written its change above (the goal went
    // through the attribute door with its own observation), so `updates` is
    // empty here. An empty patch is the door's `no_change`/`empty-patch`, which
    // updateTask() reports exactly like a vanished row — calling it on this path
    // would answer "was deleted" about the row we just updated. Read the row
    // back instead; the deleted answer stays reserved for a row truly gone.
    const task = Object.keys(updates).length === 0 ? getTask(taskId) : updateTask(taskId, updates);
    if (!task) {
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // RC-16: audit title/description content edits in task_log, the same
    // discipline goal edits get above. Only logging goal edits is exactly what
    // made P-1 (a description revert) invisible; content edits now leave the same
    // before/after trail so a reviewer / PM can see who changed the user-facing
    // task text and to what.
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

    // v2.5.3, if any schedule field changed, recompute next_run_at so the
    // scheduler picks up the edit. Without this, agents could change the
    // recurrence (interval, unit, day-of-week list, end conditions) but the
    // task would still fire at the old cadence until the next natural run.
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
          // Only set schedule_status to 'waiting' if there is a future run.
          // calculateNextRun returns null for completed/non-recurring tasks
          // that have already fired, in that case leave whatever status was
          // there (typically 'completed' or 'idle').
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
        // Non-fatal: the row update succeeded; only the recompute failed.
        // Log it so we notice, but don't fail the edit.
        logger.warn('trackerEditTask: schedule recompute failed', {
          taskId,
          error: recalcErr instanceof Error ? recalcErr.message : String(recalcErr),
        }, agentId);
      }
    }

    const changed: string[] = [];
    for (const k of Object.keys(updates)) changed.push(k);
    // The goal-only edit changed the goal; `updates` never names it because it
    // was written above, with its own observation. Name it on the reply.
    if (changed.length === 0 && goal !== undefined) changed.push('goal');

    const editParts = [
      `[OK] task_id=${task.id}`,
      ``,
      `Task updated: ${task.title}`,
      `Fields changed: ${changed.join(', ')}`,
    ];
    // RC-18: if the schedule changed, echo the wall-clock anchor + next run so a
    // timezone mistake is caught before the next fire.
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

// ══════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T49 — A REJECTION IS VISIBLE WHEREVER THE ROW IS (round-12 S4).
//
// The reply told the owner the notes-reorg deliverables "were delivered". The row's ledger
// had said the opposite for a day: event 24599, `entry_kind='reject'`, complete → blocked,
// "No summary file was ever delivered …". The agent ACTED on that rejection when it landed;
// what failed is every LATER turn, because neither surface it reads carried the ruling or the
// pause reason — `list` renders Blocked/Paused rows title-only and `get` renders a State line
// with no adjudication at all. With no surface saying otherwise, stale self-narration was the
// only account of the row on offer.
//
// Both halves below print THE ROW'S OWN RECORDED WORDS, truncated. The engine authors no
// sentence about the work and classifies no prose: it takes the newest ledger entry that has
// words and quotes a prefix of it. Both are tool-RESULT text, in no prompt surface, so this
// moves 0 cached prefix bytes.
// ══════════════════════════════════════════════════════════════════════════════════════

/** The row's own words, flattened to one line and cut. The `...` marker is the same one this
 *  file already uses when it truncates a description on a verbose list row. */
function recordedClause(text: string | null | undefined, max: number): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}...` : flat;
}

/** (a) The one clause a Blocked/Paused board row carries: the newest thing anyone WROTE about
 *  it. `getRecentObservations` is the EXISTING reader for that set of kinds (observation /
 *  directive / reject / legacy_note) — no new query, no new vocabulary, no new event. Spine
 *  `transition` reasons are deliberately outside that set: on an agent-moved row the reason is
 *  this tool's own echo of the call that moved it (`work_update(action="status") -> paused`),
 *  which tells a later turn nothing the row does not already say in its status. */
function recordedStopReason(taskId: string): string | null {
  for (const e of getRecentObservations(taskId, 5)) {
    const clause = recordedClause(e.note ?? e.reason, 140);
    if (clause) return `      ^ recorded reason: ${clause}`;
  }
  return null;
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

// ── trackerGetStatus ──

export function trackerGetStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string | undefined;
    const rawProjectId = args.projectId as string | undefined;

    // The dispatcher in agent/tools.ts passes the same input as BOTH
    // taskId and projectId to let either side succeed. Try to resolve
    // the task first; if that fails, fall through and try the project
    // (but don't surface the task's not_found error if the project
    // resolves).
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
        // The origin chain, in the agent's own view (2026-07-22 owner ruling:
        // the point of the identity work is that the AGENT can discern where a
        // task came from and connect it to its conversation and prompt).
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
        // RC-18: surface the schedule so the description's prose time ("9 PM PT")
        // and the actual anchor are visible side by side (P-2 was invisible
        // because get_status never showed the schedule). Wall-clock + UTC via
        // formatTimeForAgent so the time can't be misread.
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
        // 2026-07-22 production incident: the status READ is where the re-work
        // spiral started. The read renders the ticket's STAMPS (engine-observed
        // state) plus live step facts; the delivery-evidence join backfills
        // rows that predate the stamp columns.
        {
          const st = getTaskStampFields(task.id);
          if (st) {
            const steps = renderStepFacts(st);
            parts.push(`State: ${renderTaskStamps(st)}${steps ? ` | ${steps}` : ''}`);
          }
        }
        // T49(b): the adjudication belongs beside the state, because they answer the same
        // question and the state line alone is what the S4 reply read as permission.
        {
          const ruling = lastPMRulingLine(task.id);
          if (ruling) parts.push(ruling);
        }
        if (task.status === 'in_progress') {
          // Only what the engine can count (`engineProofLine`), never a bare reply: it may be the start ack.
          const evLine = engineProofLine(task.id);
          if (evLine) {
            parts.push(
              // Review round 2: facts, not close-coaching (product law, "Finishing, not closing").
              `\n[ENGINE RECORD: this task's work appears ALREADY DELIVERED, ${evLine}. ` +
              `Do NOT redo or re-deliver what was already delivered.]`
            );
          }
        }

        return taskReadWithNotes(task.id, agentId, parts.join('\n'), args.offset);   // t169: the task's own notes close the page
      }
      // Task resolution failed, if we also have a projectId (usually the
      // same string), try the project branch below before reporting.
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

// ── trackerListActive ──

export function trackerListActive(agentId: string, args: Record<string, unknown>): string {
  try {
    const scope = args.scope as 'tasks' | 'projects' | 'all' | undefined ?? 'all';
    const filterAssignedTo = args.assignedTo as string | undefined;
    const filterStatus = args.status as string | undefined;
    // PHASE-6 T0C-W: the tracker layer takes the DECLARED enum value rather than a new
    // internal boolean. A private option name here (`overdue: true`) would be a
    // handler-read parameter no tool declares — the exact class T0C's read census exists
    // to catch — and it would have needed a ruling to excuse it. Speaking `filter` keeps
    // one vocabulary from the wire to the query and leaves the census with nothing to
    // forgive.
    const overdue = args.filter === 'overdue';
    const verbose = args.verbose as boolean | undefined;
    const parts: string[] = [];
    let totalShown = 0;

    // Helper: format one task row. In verbose mode, append the description
    // line. In compact mode, just title + assignee + priority.
    const taskRow = (t: { id: string; title: string; assignedTo: string | null; assignedToName: string | null; priority: string; description: string | null }) => {
      const assignee = t.assignedTo ? ` [${t.assignedToName ?? t.assignedTo}]` : ' [unassigned]';
      const head = `  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`;
      if (verbose && t.description) {
        const desc = t.description.length > 200 ? t.description.slice(0, 200) + '...' : t.description;
        return `${head}\n    → ${desc}`;
      }
      return head;
    };

    // T49(a): a STOPPED row states why in its own recorded words. Title-only is how a
    // rejection and a wait both read as "still on the board, nothing to say" — and the S4
    // reply, a day after the PM rejected the close, said the work "were delivered".
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
      // PHASE-6 T0C-W: `filter:"overdue"` was on `work_update`'s declared enum for months
      // with no branch behind it — it fell through to the unfiltered list, so an agent
      // asking for overdue work got the whole board and no sign its filter was ignored.
      // The set is `dueScope()`'s, the same declaration the scheduler's due query answers
      // from; the HEADING NAMES THE FILTER so an empty answer reads as "nothing is
      // overdue" rather than as a filter that did nothing.
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
          // T49(a): filtering to blocked/paused renders the SAME rows as the sections below,
          // so this arm carries the same clause. A door that answers differently depending on
          // which arm reached it is the blind spot this task closes, one arm over.
          const rows = filtered as Array<Parameters<typeof taskRow>[0]>;
          parts.push(...(filterStatus === 'blocked' || filterStatus === 'paused'
            ? stoppedRows(rows) : rows.map((t) => taskRow(t))));
          totalShown += filtered.length;
        } else {
          parts.push(`No ${filterStatus} tasks.`);
        }
      } else {
        const taskFilter = filterAssignedTo ? { assignedTo: filterAssignedTo } : undefined;
        const inProgress = listTasks({ status: 'in_progress', ...taskFilter });
        const pending = listTasks({ status: 'on_deck', ...taskFilter });
        const blocked = listTasks({ status: 'blocked', ...taskFilter });

        if (inProgress.length > 0) {
          parts.push('');
          parts.push(`In Progress Tasks (${inProgress.length}):`);
          for (const t of inProgress) {
            parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
            // 2026-07-22: origin + STAMPS in-band on every list read, so the
            // agent connects the task to its conversation and knows its state
            // without guessing (the re-work spiral started at a status read
            // that repeated the lying in_progress).
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

        if (inProgress.length === 0 && pending.length === 0 && blocked.length === 0) {
          parts.push('');
          parts.push('No active tasks.');
        }
      }
    }

    // ── HARNESS-LEARNINGS HL6 — THE BOARD-READ DOOR ANSWERS THE QUESTION IT WAS ASKED ──
    // This tool lists tasks and projects. It has never listed commitments, and W8's driven
    // replay is what that costs: the model asked the board, was told "No active tasks.", and
    // asserted three dead commitments four seconds later. One line, from the one reader that
    // owns "what does the spine say is owed" (`work/obligation-memory.ts`), said at the
    // moment the model is actually checking. It is a return value, so it moves no cached
    // prefix bytes.
    const commitmentPosition = commitmentPositionLine(agentId);
    if (commitmentPosition) {
      parts.push('');
      parts.push(commitmentPosition);
    }

    // Trailer: always tell the agent how to drill in. In compact mode also
    // mention verbose=true.
    if (totalShown > 0) {
      parts.push('');
      if (verbose) {
        parts.push('Tip: work_update(action="get", id="<task_id>") for notes, depends_on, schedule, and full description.');
      } else {
        parts.push(`${compactCountNote(totalShown, 'task/project row')}. For full detail on one: work_update(action="get", id=<task_or_project_id>). For descriptions on every result: re-call work_update(action="list") with verbose=true.`);
      }
    }

    // ── UX-REPAIR ROUND 13 T60 — THE DECISION-MOMENT POINTER ────────────────────────────
    // This door answers "what is open RIGHT NOW". Round-13 S4 asked it "what happened
    // today", read the three open rows it returned, and answered "Quiet day so far …
    // nothing else changed on the tracker" over 57 rows opened AND closed in that window.
    // The list was not wrong; it was a different question, and nothing said so at the
    // moment the model was choosing what to trust.
    //
    // It rides HERE, unconditionally — including the empty board, which is precisely the
    // shape that produces the guess (an empty NOW reads as an empty DAY). Return value, so
    // it moves no cached prefix byte; it is the same lane and the same reasoning as the HL6
    // commitment line above.
    parts.push('');
    parts.push(ACTIVITY_POINTER);

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerListActive failed', { error: msg }, agentId);
    return `Error listing active items: ${msg}`;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// ── trackerActivity — UX-REPAIR ROUND 13 T60 ────────────────────────────────────────────
//
// ── WHAT WAS MISSING, AND IT WAS NOT DATA ───────────────────────────────────────────────
// Round-13 S4 (catalog §8.2–8.6): the owner asked what had happened today. The turn made
// ONE read — `work_update(action="list")` — and wrote "Quiet day so far … nothing else
// changed on the tracker." The recorder's independent count of the identical window: 57 work
// rows OPENED and 57 CLOSED, 283 `work_events`, 142 deliveries, a delegated project run end
// to end and PM-validated. Both sentences are marked UNBACKED.
//
// The list door answered its own question correctly (3 rows open now). The finding is that
// "what is open" and "what changed over a window" are DIFFERENT QUANTITIES and only the
// first had a door anywhere on the platform. The window's data was never missing:
// `work.opened_at` / `work.closed_at`, `work_events.created_at`, `adjudications.created_at`
// and `deliveries.created_at` are all timestamped and all were already on that box. The model
// guessed because honesty was structurally impossible, which is the class this closes.
//
// ── CENSUS ROW, AND THE COLLISION ARGUED (mission rule: no new mechanism without one) ────
// This is a READ-ONLY EXTENSION of the tracker door — a fifth reader over ledgers that four
// existing readers already query, no new table, no new column, no new event kind, no write
// path of any sort (pinned by a test that counts rows before and after).
//   • vs `action="list"`  — NOW versus a WINDOW. They cannot answer each other, and each
//     names its own scope in its own output, so a reader can never mistake one for the
//     other. The list door gains one pointer sentence at the decision moment; this door's
//     closing line points back. Two surfaces, two jobs, each saying which it is.
//   • vs `action="get"`   — one row in full versus every row's shape over a window.
//   • vs the HL5/T44 snapshot lane — that is OPEN COMMITMENTS, complete, injected. This is
//     history, pulled, and never injected: it costs a prefix byte only if the agent asks.
//
// ── THE WINDOW: DEFERRED BY T60, SPENT BY T65 ───────────────────────────────────────────
// T60 shipped this door with the window as a RENDERER argument and the wire covering the
// LOCAL DAY only. Its recorded reason: a declared `hours`/`since` property moves the cached
// tools prefix, and reading one UNDECLARED is worse than not offering it — the engine's own
// unknown-argument census would tell the model the arg "was silently ignored" while this
// function acted on it (`agent/tools/index.ts`), and a door that contradicts the engine's
// warning about itself is not a door. Its own closing words: "widening it to the wire is one
// declared property on the next affordable prefix re-bless."
//
// ROUND-14 S2 PRICED THE DEFERRAL. The owner asked what had happened "since yesterday
// morning"; the door covered today; 61 ledger rows sat outside it; the reply disclosed none of
// them. So T65 spends it: `hours` is DECLARED on `work_update` (definitions.ts carries the
// re-blessing note), the door forwards it through `activityWindowStart` below, and the output
// goes on stating the window it actually measured — which is what lets a model check its own
// arithmetic instead of trusting it. The action enum was NOT touched, so the golden delta is
// exactly one property.
//
// ── HONESTY IDIOM ───────────────────────────────────────────────────────────────────────
// Counts first and complete; notable rows titled; the rest COUNTED behind an elision line
// that restates the whole number — `memory/recall-lane.ts`'s snapshot rule ("an elision is
// never silent"), because an activity report that silently truncated would reproduce the
// exact defect it exists to close. Tool-result lane, engine-authored, agent-facing: it
// composes nothing for the user and judges no prose (OR2 and the classification ban both
// untouched — every line below is a COUNT or a stored title).
// ════════════════════════════════════════════════════════════════════════════════════════

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

/** Local midnight in the box's own zone, as epoch ms. The scheduler's zone rules, reused —
 *  a second wall-clock implementation here is exactly the duplicate-mechanism disease. */
function localMidnightMs(nowMs: number): number {
  const tz = getBoxTimeZone();
  const w = instantToWall(nowMs, tz);
  return wallToInstant({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0, second: 0 }, tz).getTime();
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The id as something the agent can actually pass back to `action="get"`.
 *  The list door slices 8 characters because every row it shows is a bare UUID. This door
 *  reports the WHOLE board — `ask:<uuid>` and `piece:ask:<uuid>:<uuid>` rows included — and
 *  8 characters of those is `ask:f30b` / `piece:as`, which resolves to nothing. A truncated
 *  id that cannot be looked up is worse than a long one, so namespaced ids print in full. */
const activityRowId = (id: string): string => (id.includes(':') ? id : id.slice(0, 8));

/**
 * T65 — THE WIRE'S `hours` AS THE RENDERER'S WINDOW START, or `undefined` for the default.
 *
 * Every unusable value resolves to the DEFAULT window rather than to a guess, and the caller
 * is not left wondering which it got: the report states the window it measured on its first
 * line, so a refused `hours` is visible in the answer itself.
 *
 * The only bound is a real one, not an invented ceiling (#14): a window cannot begin before
 * time was counted, so an `hours` that reaches back past the epoch is not a window. Nothing
 * here caps how far back a legitimate question may look.
 */
export function activityWindowStart(hours: unknown, nowMs: number = Date.now()): number | undefined {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return undefined;
  const start = nowMs - hours * 3_600_000;
  return start >= 0 ? start : undefined;
}

/**
 * The window's own ledger, rendered. `sinceMs` defaults to local midnight; the wire's own
 * window arrives through `activityWindowStart` (T65).
 */
export function trackerActivity(
  agentId: string,
  args: Record<string, unknown>,
  sinceMs?: number,
): string {
  try {
    const db = getDb();
    const nowMs = Date.now();
    const { forPerson, own } = activityScope(agentId, turnContext(agentId)?.turnNumber);   // t174: see work/peer-origin.ts
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

    // ── SCHEDULED RUNS THAT FIRED. The S4 reply asserted "Nothing scheduled fired today"
    //    from a read that reports no fire history at all; it happened to be true. ──
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
    //    • `outcome = 'delivered'` — the ledger also carries `failed`, `suppressed`, `held`
    //      and `owner_closed` rows. A count that swept those in would report attempts and
    //      the owner's own close receipt as things that reached him, which is the exact
    //      class of overclaim this door exists to end. `agent/v2/__tests__/owner-close-
    //      receipt.test.ts` walks every production reader of this table for this filter.
    //    • `channel <> 'a2a'` — a peer agent is not a person.
    //    • `created_at` is a UTC datetime STRING here, not epoch ms, so the bound is
    //      rendered in that shape. ──
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
        // The elision is never silent (the HL5 snapshot's rule): the number above is still
        // the truth, and this says which part of it is on the page.
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

// ── trackerCompleteStep ──

// ── trackerEditProject ──
//
// Rename / re-describe a project. Until now, projects literally had no
// editable title, only status and currentPhase could be changed. Added
// so the PM agent can rename engine-auto-created projects (the multistep
// classifier names them with a slice of the user prompt; PM rewrites
// both project and first task to clean names on its next turn).

export function trackerEditProject(agentId: string, args: Record<string, unknown>): string {
  const rawProjectId = (args.project_id ?? args.projectId) as string | undefined;
  if (!rawProjectId) return 'Error: project_id is required.';

  const resolved = resolveProjectId(rawProjectId, agentId);
  if (!resolved.ok) return formatResolveError('project', rawProjectId, resolved);
  const projectId = resolved.id;

  { const no = taskWriteRefusal(agentId, projectId, 'edit'); if (no) return no; }   // t193 (dec 3): the same editors as a task.
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
    // T8c item 3: the marker-preservation guard is GONE, and it is gone because the thing it
    // defended no longer lives in editable prose. It existed because on 2026-07-17 a PM
    // description rewrite stripped the `ENGINE_AUTO_MARKER` prefix and the scaffold stopped
    // reading as engine-created; the fix was to silently re-prefix every rewrite. The fact is
    // `root_kind` now — stamped at creation, not on any tool surface, so no edit can reach it.
    // requirement preserved: an engine-opened row keeps reading as engine-opened however its
    // description is rewritten. That is now true by construction rather than by a guard that
    // had to remember to fire.
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

// ── trackerCloseProject ──
//
// One call to close a whole project AND every open task on it. The use case
// is "I abandoned this project / it duplicates something else / scope
// changed, just close it out cleanly." Without this tool, agents either
// leave tasks stranded forever in on_deck or have to loop calling
// work_update(action="status") one task at a time.

// ── trackerValidatePause (v2.7.18) ──
//
// PM-only tool. For each paused task with pause_validated=0, PM judges
// whether the pause is a real wait condition or gaming.
//
// On valid=true: pause_validated=1; task stays paused; PM stops surfacing
// the task as an UNVALIDATED_PAUSE issue.
//
// On valid=false: task is reverted to in_progress, the assigned agent
// gets a directive via send_to_agent explaining why their pause was
// rejected and what to do instead.

const REDRIVE_LATER = ' The directive could not be delivered just now (it is logged); the task is back in play and the PM sweep re-drives it on its schedule.';

// ── trackerRetask ──
//
// PM-only forward-leaning verb. Use when an agent's outcome on a task is
// wrong (work skipped, channel wrong, evidence missing, claim doesn't
// match goal) and you want them to redo it with specific guidance, 
// instead of just confirming a pause or rejecting a complete.
//
// Works from any status except 'cancelled'. Resets validation flags so
// the engine treats the next pass as fresh. Increments revert_count
// (this is functionally a PM revert). Delivers the directive over A2A
// to the assigned agent. May trigger stalemate if PM and agent are
// ping-ponging the same task.
//
// Required: directive >= 30 chars so PM can't fire a one-liner.

export async function trackerRetask(
  pmAgentId: string,
  args: { task_id: string; directive: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

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
  ).get(taskId) as { id: string; title: string; state: string; status: string; assigned_to: string | null; goal: string | null } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status === 'cancelled') {
    return `Error: task "${task.title}" (${taskId}) is cancelled. Cancelled tasks cannot be retasked. Create a new task instead.`;
  }
  if (task.state === 'handed_in') {   // delivered work is decided, never regenerated over
    return `Error: task "${task.title}" (${taskId.slice(0, 8)}) is handed in and waits for a decision. Decide it instead: open its proof, then work_validate(action="decide", task_id="${taskId}", verdict="approve" or "send_back", reason).`;
  }
  if (!task.assigned_to) {
    return `Error: task "${task.title}" (${taskId}) has no assigned agent, so there is nobody to retask. The PM does not move tasks (owner ruling): tell the main agent so it can give the task a holder.`;
  }

  const targetStatus = args.target_status ?? 'in_progress';
  const ALLOWED_TARGETS = new Set(['in_progress', 'on_deck']);
  if (!ALLOWED_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed for retask. Use 'in_progress' (default) or 'on_deck'.`;
  }

  // Through `transition()` so is_paused / pause fields reset with the state.
  const updated = setTaskStatus(taskId, targetStatus as TrackerStatus, {
    by: 'pm', actorId: pmAgentId,
    reason: `PM retask: ${directive.slice(0, 200)}`,
  });
  if (!updated) return `Error: task ${taskId} was deleted before retask could land.`;

  // Retask is a remediation: the PM is sending the agent back to redo the
  // work, which starts a fresh escalation cycle. Re-arm the ladder so it climbs
  // from nudge(1) if this task stalls again. Marking at a remediation event
  // (never mid-cycle) keeps the cross-restart poke dedup intact.
  recordRemediation(taskId, pmAgentId, `PM retask: ${directive.slice(0, 120)}`);

  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'directive',
    fromStatus: task.status,
    toStatus: targetStatus,
    actionTaken: 'work_validate(action="retask")',
    reason: directive,
  });

  // Deliver the PM's directive to the assigned agent as a system-injected
  // user turn (same transport as validate_pause's reject path). Fire-
  // and-forget; PM has already moved the status.
  let redriven = true;
  try {
    const { redriveWithoutReply } = await import('../agent/agent-notice.js');
    const body =
      `PM retask on "${task.title}" (${taskId.slice(0, 8)}). Task is back to ${targetStatus}.\n\n` +
      `PM directive: ${directive}\n\n` +
      `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
      `Do the work the directive describes. Don't just acknowledge; do the thing.`;
    // t143 round 3 (I2): a directive, not a question — it wakes the agent and owes the PM no reply.
    redriven = await redriveWithoutReply({ toAgentId: task.assigned_to, fromAgentId: pmAgentId, content: body, taskId });
  } catch (err) {
    redriven = false;
    logger.warn('Failed to deliver retask directive to agent', {
      taskId, assignedTo: task.assigned_to,
      error: err instanceof Error ? err.message : String(err),
    }, pmAgentId);
  }

  logger.info('Task retasked by PM', { taskId, pmAgentId, targetStatus, directiveLength: directive.length }, pmAgentId);
  return (
    `[OK] Retasked "${task.title}" (${taskId}) from ${task.status} to ${targetStatus}. ` +
    (redriven ? `Directive delivered to ${task.assigned_to}.` : `Directive NOT delivered to ${task.assigned_to}.${REDRIVE_LATER}`)
  );
}

// ── trackerPauseSchedule ──

export function trackerPauseSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  { const no = taskWriteRefusal(agentId, taskId, 'change the schedule of'); if (no) return no; }   // t193 (dec 3): a schedule is part of the task; the task's editors change it.

  const db = getDb();
  const task = db.prepare(`SELECT w.id AS id, w.title AS title, w.schedule_status AS schedule_status, w.parent_id AS project_id FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(taskId) as { id: string; title: string; schedule_status: string; project_id: string } | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before pause could be applied.`;
  if (task.schedule_status === 'unscheduled') {
    return (
      `Refused: work_schedule(action="pause") is for recurring/scheduled tasks only, "${task.title}" has no schedule. ` +
      `For a one-shot task: if the work is done, or cannot be done, hand it in: work_update(action="hand_in", task_id="${task.id}", outcome, proof, note). ` +
      `If you're stuck, call work_update(action="status", ..., status="blocked", notes="why"). ` +
      `Pausing a one-shot task without a resume_at strands it: it sits in the Paused column, can\'t be completed without unpausing, and the PM stops watching it.`
    );
  }

  noteUnsettled(setTrackerStatus(taskId, 'paused', { by: 'agent', actorId: agentId, reason: 'schedule paused by the assigned agent' }), 'schedule paused by the assigned agent', { taskId });
  noteUnsettled(patchWork(taskId, { is_paused: 1, schedule_status: 'paused' }), 'trackerPauseSchedule: schedule paused', { taskId });
  const freshSchedPaused = getTask(taskId);
  if (freshSchedPaused) broadcast({ type: 'tracker:task_updated', data: freshSchedPaused });
  logger.info('Schedule paused', { taskId }, agentId);
  return `Schedule paused for "${task.title}". Status set to "paused", stale detection and PM monitoring will ignore it until resumed.`;
}

// ── trackerResumeSchedule ──

export function trackerResumeSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  { const no = taskWriteRefusal(agentId, taskId, 'change the schedule of'); if (no) return no; }   // t193 (dec 3): a schedule is part of the task; the task's editors change it.
  const db = getDb();
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before resume could be applied.`;
  { const no = finishedScheduleRefusal(taskId, String(task.title ?? 'this task'), 'resumed'); if (no) return no; }

  
  const scheduledTask = {
    id: task.id as string,
    scheduled_start: task.scheduled_start as string | null,
    repeat_interval: task.repeat_interval as number | null,
    repeat_unit: task.repeat_unit as string | null,
    repeat_end_type: task.repeat_end_type as string | null,
    repeat_end_value: task.repeat_end_value as string | null,
    run_count: (task.run_count as number) ?? 0,
    is_paused: 0, // pretend unpaused for calculation
    last_run_at: task.last_run_at as string | null,
    next_run_at: null,
    schedule_status: 'waiting',
    repeat_days_of_week: task.repeat_days_of_week as string | null,
    anchor_time: task.anchor_time as string | null,
    tz: task.tz as string | null,
  };

  const nextRun = calculateNextRun(scheduledTask);
  // missed_runs_paused_at = NULL: an explicit resume also disarms the D12
  // engine fallback for a pause the missed-runs detector set.
  noteUnsettled(setTrackerStatus(taskId, 'on_deck', { by: 'agent', actorId: agentId, reason: 'schedule resumed; waiting for the next run' }), 'schedule resumed', { taskId });
  noteUnsettled(setNextRun(taskId, {
    at: tsToMs(nextRun),
    alongside: { is_paused: 0, schedule_status: 'waiting', missed_runs_paused_at: null },
    reason: 'the schedule was resumed by the agent; walked to the next anchor',
  }), 'trackerResumeSchedule: schedule resumed', { taskId });
  const freshResumed = getTask(taskId);
  if (freshResumed) broadcast({ type: 'tracker:task_updated', data: freshResumed });

  logger.info('Schedule resumed', { taskId, nextRun }, agentId);
  return `Schedule resumed for "${task.title as string}". Next run: ${nextRun ?? 'none'}`;
}

// ── trackerResolveMissedRuns (v2.5.45) ──
// Called by the assigned agent after the scheduler fires a "missed runs"
// alert. Three actions: run_now, skip, pause. See the alert text in
// runner.ts / alertMissedRuns for the semantics.

export function trackerResolveMissedRuns(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = (args.task_id ?? args.taskId) as string | undefined;
  if (!rawTaskId) return 'Error: task_id is required.';
  const action = args.action as string | undefined;
  if (!action || !['run_now', 'skip', 'pause'].includes(action)) {
    return 'Error: action must be one of: "run_now", "skip", "pause".';
  }

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  { const no = taskWriteRefusal(agentId, taskId, 'change the schedule of'); if (no) return no; }   // t193 (dec 3): a schedule is part of the task; the task's editors change it.
  const db = getDb();
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} no longer exists.`;
  const title = (task.title as string) ?? '(untitled)';
  if (action !== 'pause') { const no = finishedScheduleRefusal(taskId, title, action === 'skip' ? 'skipped ahead' : 'started now'); if (no) return no; }
  if (action === 'pause') {
    // Already paused by the alert handler; confirm and exit. D12: clear
    // missed_runs_paused_at so the engine's auto-skip fallback stands down.
    // The agent explicitly chose to keep the task paused, and the model
    // tool takes precedence over the fallback when called first.
    if (task.missed_runs_paused_at != null) noteUnsettled(patchWork(taskId, { missed_runs_paused_at: null }), 'trackerResolveMissedRuns: missed-run pause cleared', { taskId });
    logger.info('Missed-runs resolved: pause', { taskId }, agentId);
    return `OK: task "${title}" stays paused. The user can resume it from the dashboard, or you can later call work_schedule(action="resume").`;
  }

  if (action === 'skip') {
    // Compute next future anchor (strictly > now). calculateNextRun
    // already does this when fed an unpaused snapshot, its inner loop
    // walks the anchor forward until it lands in the future.
    const scheduledTask: ScheduledTask = {
      id: task.id as string,
      scheduled_start: task.scheduled_start as string | null,
      repeat_interval: task.repeat_interval as number | null,
      repeat_unit: task.repeat_unit as string | null,
      repeat_end_type: task.repeat_end_type as string | null,
      repeat_end_value: task.repeat_end_value as string | null,
      run_count: (task.run_count as number) ?? 0,
      is_paused: 0,
      last_run_at: new Date().toISOString(), // pretend a run just happened, so the loop skips current slot
      next_run_at: null,
      schedule_status: 'waiting',
      repeat_days_of_week: task.repeat_days_of_week as string | null,
      anchor_time: task.anchor_time as string | null,
      tz: task.tz as string | null,
    };
    const nextRun = calculateNextRun(scheduledTask);
    if (!nextRun) {
      // End conditions reached or anchor unset, leave paused.
      return `Could not compute a next-run for "${title}" (likely past repeat_end_value or anchor missing). Task stays paused; investigate manually.`;
    }
    noteUnsettled(setTrackerStatus(taskId, 'on_deck', { by: 'agent', actorId: agentId, reason: 'missed runs skipped; back on the schedule' }), 'missed runs skipped', { taskId });
    noteUnsettled(setNextRun(taskId, {
      at: tsToMs(nextRun),
      alongside: { is_paused: 0, schedule_status: 'waiting', missed_runs_paused_at: null },
      reason: 'the agent resolved missed runs as SKIP; walked to the next future anchor',
    }), 'trackerResolveMissedRuns: missed runs skipped', { taskId });
    logger.info('Missed-runs resolved: skip', { taskId, nextRun }, agentId);
    return `OK: task "${title}" unpaused. All missed slots skipped. Next run: ${nextRun}.`;
  }

  // action === 'run_now': fire one catch-up run immediately. Set
  // next_run_at to now so the next scheduler tick picks it up. After
  // that run completes, onTaskRunComplete will compute the natural
  // next anchor and the task resumes its normal cadence.
  const nowIso = new Date().toISOString();
  noteUnsettled(setTrackerStatus(taskId, 'on_deck', { by: 'agent', actorId: agentId, reason: 'catch-up run requested; back on the schedule now' }), 'catch-up run requested', { taskId });
  // ⚠ ONE OF THE TWO INSTANTS IN THE PRODUCT THAT DOES NOT COME FROM `calculateNextRun`, and
  // it is declared as such in `work/next-run.ts`: the owner asked for ONE catch-up run, so the
  // fire time is NOW by request rather than by cadence. `onTaskRunComplete` recomputes the
  // natural anchor once that run closes.
  noteUnsettled(setNextRun(taskId, {
    at: tsToMs(nowIso),
    alongside: { is_paused: 0, schedule_status: 'waiting', missed_runs_paused_at: null },
    reason: 'the agent resolved missed runs as RUN_NOW; one catch-up run fires on the next tick',
  }), 'trackerResolveMissedRuns: catch-up run scheduled now', { taskId });
  logger.info('Missed-runs resolved: run_now', { taskId }, agentId);
  return `OK: task "${title}" unpaused and scheduled to fire on the next scheduler tick (within ~1 minute). Schedule resumes on its normal anchor after this run completes.`;
}

