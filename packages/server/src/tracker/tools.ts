import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import {
  createProject,
  getProject,
  createTask,
  getTask,
  listTasks,
  listProjects,
  updateTask,
  updateProject,
  resolveTaskId,
  resolveProjectId,
  formatResolveError,
  closeProjectAndOpenTasks,
} from './schema.js';
import { ensurePMAgentRunning, noteTransitionForReview } from './pm-agent.js';
import { injectTaskAssignmentNotification } from './notify.js';
import { writeTaskLog } from './task-log.js';
import { calculateNextRun, type ScheduledTask } from '../scheduler/engine.js';
import { onTaskRunComplete } from '../scheduler/runner.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, isPrimaryAgent, getOwnerName, isPMAgent } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { formatTimeForAgent } from '../services/format-time.js';

const logger = createLogger('tracker-tools');

// Re-exported from the shared helpers so the trackerCreateTask /
// trackerUpdateStatus call sites keep working with their existing usage.
// The canonical implementation lives in agent/tool-helpers.ts.
import { resolveAgentRef as resolveAgentName } from '../agent/tool-helpers.js';

// ── Notify primary agent of task/project completion ──

function notifyPrimaryAgent(message: string, callingAgentId: string, forceNotify = false): void {
  const primaryId = getPrimaryAgentId();
  // Don't notify if the primary agent is the one completing the task (unless forced)
  if (isPrimaryAgent(callingAgentId) && !forceNotify) return;

  try {
    const db = getDb();
    const msgId = uuidv4();
    // Store as 'system' role -- informational, does NOT need a response.
    // The primary agent will see it in context on its next turn.
    // We do NOT call handleMessage here -- task updates are informational,
    // not conversations that require a reply. This prevents the primary
    // agent from waking up and responding to every sub-agent status change.
    const content = `[SOURCE: TRACKER TASK UPDATE — automated status update, not a message from the user] ${message}`;
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(msgId, primaryId, content);

    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: msgId,
        agentId: primaryId,
        role: 'system' as const,
        content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch { /* best-effort */ }
}

function checkProjectCompletion(projectId: string | null, callingAgentId: string): void {
  if (!projectId) return;
  try {
    const db = getDb();
    const remaining = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE project_id = ? AND status NOT IN ('complete', 'fallen')
    `).get(projectId) as { count: number };

    if (remaining.count === 0) {
      const project = db.prepare('SELECT title, status FROM projects WHERE id = ?').get(projectId) as { title: string; status: string } | undefined;
      if (project && project.status !== 'complete') {
        // Mark project as complete
        db.prepare("UPDATE projects SET status = 'complete', updated_at = datetime('now') WHERE id = ?").run(projectId);

        // Get all task results for a summary
        const tasks = db.prepare(`
          SELECT title, status, notes FROM tasks WHERE project_id = ? ORDER BY step_number ASC, created_at ASC
        `).all(projectId) as Array<{ title: string; status: string; notes: string | null }>;

        const summary = tasks.map(t => `- ${t.title}: ${t.status}${t.notes ? ` — ${t.notes.split('\n').pop()}` : ''}`).join('\n');

        // v2.7.2 — fixes the duplicate-final-answer failure shape:
        //
        //   1. forceNotify dropped from true → the default false. When the
        //      PRIMARY agent itself completes the final task, they don't
        //      need a separate "project complete!" message — they just made
        //      the action that completed it and their own response wraps
        //      up the work. The notification was firing mid-turn, getting
        //      pulled into their next context iteration, and prompting a
        //      duplicate tracker_update_status + redundant "Done" wrap-up.
        //
        //      Sub-agent completing the last task still notifies primary,
        //      because callingAgentId != primaryId and the function's
        //      built-in isPrimaryAgent check lets it through.
        //
        //   2. Text rewritten to be a pure status record, not an
        //      instruction. The old text said "Please review the results
        //      and let David know" which the model interpreted as a fresh
        //      assignment and kept working. The new text contains no
        //      verbs aimed at the reader — it's just the completion fact.
        const completionLine = `[tracker:project_complete] "${project.title}" — ${tasks.length} task${tasks.length === 1 ? '' : 's'} closed.\n${summary}`;
        notifyPrimaryAgent(completionLine, callingAgentId);

        logger.info('Project completed', { projectId, title: project.title, taskCount: tasks.length });

        broadcast({
          type: 'tracker:project_updated',
          data: { id: projectId, title: project.title, status: 'complete' },
        } as never);
      }
    }
  } catch (err) {
    logger.error('checkProjectCompletion failed', { projectId, error: err instanceof Error ? err.message : String(err) });
  }
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

// Mirror of ENGINE_AUTO_MARKER in classifiers/multistep.ts. Duplicated
// here rather than imported to avoid a cross-package import path through
// the v2 classifier dir for a one-string constant.
const ENGINE_AUTO_MARKER = '[engine:multistep] ';

interface DuplicateMatch {
  id: string;
  title: string;
  createdMinutesAgo: number;
  /** True when the existing project was opened by the engine's multistep
   * classifier on the agent's most recent user turn (not by the agent
   * calling tracker_create_project themselves). */
  engineAutoCreated: boolean;
  /** First in_progress / on_deck task on the existing project, if any —
   * the natural target for tracker_edit_task. */
  firstOpenTask: { id: string; title: string } | null;
}

/**
 * Near-duplicate guard with two prongs:
 *
 *   (a) Engine-auto-created override: if the creator has ANY active
 *       project with the ENGINE_AUTO_MARKER in its description created
 *       in the last 5 minutes, treat that as a duplicate of whatever
 *       the agent is now trying to create — regardless of title
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

  // (a) Engine-auto-created in the last 5 minutes — short window so we
  //     only catch the same-turn case, not a stale auto-project from
  //     half an hour ago that the agent has already moved past.
  const engineAuto = db.prepare(`
    SELECT id, title, created_at FROM projects
    WHERE created_by = ?
      AND status = 'active'
      AND description LIKE ? || '%'
      AND datetime(created_at) >= datetime('now', '-5 minutes')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(creatorId, ENGINE_AUTO_MARKER) as { id: string; title: string; created_at: string } | undefined;

  if (engineAuto) {
    const createdMs = new Date(engineAuto.created_at.includes('Z') ? engineAuto.created_at : engineAuto.created_at + 'Z').getTime();
    const firstOpen = db.prepare(`
      SELECT id, title FROM tasks
      WHERE project_id = ? AND status IN ('in_progress', 'on_deck')
      ORDER BY step_number ASC NULLS LAST, created_at ASC
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
    SELECT id, title, created_at FROM projects
    WHERE created_by = ?
      AND status = 'active'
      AND datetime(created_at) >= datetime('now', '-60 minutes')
    ORDER BY created_at DESC
    LIMIT 20
  `).all(creatorId) as Array<{ id: string; title: string; created_at: string }>;

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
        SELECT id, title FROM tasks
        WHERE project_id = ? AND status IN ('in_progress', 'on_deck')
        ORDER BY step_number ASC NULLS LAST, created_at ASC
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

export function trackerCreateProject(agentId: string, args: Record<string, unknown>): string {
  try {
    const title = args.title as string;
    if (!title) return 'Error: title is required';

    const description = args.description as string | undefined;
    const level = typeof args.level === 'number' ? args.level : 1;

    const tasksInput = args.tasks as Array<{
      title: string;
      description?: string;
      goal?: string;
      assignedTo?: string;
      priority?: 'high' | 'normal' | 'low';
      stepNumber?: number;
      dependsOn?: string[];
      phase?: number;
    }> | undefined;

    // Hard engine gate (2026-06-03 bug fix): a project MUST be opened
    // with at least one task. Agents were creating projects without any
    // task — leaving the project sitting open with nothing to do, PM
    // pokes piling up, and no recovery path. The fix is at the engine,
    // not in the prompt: refuse the create if `tasks` is missing or
    // empty. The agent can always add more tasks later with
    // tracker_create_task once the work shape clarifies.
    if (!tasksInput || tasksInput.length === 0 || !tasksInput.some((t) => typeof t.title === 'string' && t.title.trim().length > 0)) {
      return (
        `Error: tracker_create_project requires at least one task. ` +
        `Open it like this:\n` +
        `  tracker_create_project(\n` +
        `    title: "...",\n` +
        `    level: 1,\n` +
        `    tasks: [{ title: "<the first concrete thing you'll do>", assigned_to: "${agentId}" }]\n` +
        `  )\n\n` +
        `If you don't know every step upfront, that's fine — just put down the FIRST one (e.g. "scope the deliverable", ` +
        `"draft the outline", "pull source data"). Add more tasks incrementally with tracker_create_task as the shape clarifies. ` +
        `A project with zero tasks is a stuck project — PM has no row to poke, you have nothing to mark complete, ` +
        `and the tracker can't tell whether the work is done.`
      );
    }

    // Duplicate guard. Catches the most common failure shape: agent gets
    // compacted mid-task, loses the project it already opened, and creates
    // a near-identical one. Agents can override by setting allow_duplicate=true
    // (rare — usually only valid for genuinely independent re-runs).
    const allowDuplicate = args.allow_duplicate === true;
    if (!allowDuplicate) {
      const dup = findRecentNearDuplicateProject(agentId, title);
      if (dup) {
        const shortPid = dup.id.slice(0, 8);
        const firstTaskHint = dup.firstOpenTask
          ? ` First open task: "${dup.firstOpenTask.title}" (id=${dup.firstOpenTask.id.slice(0, 8)}).`
          : '';
        if (dup.engineAutoCreated) {
          // Engine just auto-opened this project for the user's current
          // turn. Steer the agent toward editing/extending it rather than
          // building a parallel project.
          return (
            `Refused: the engine already auto-opened project "${dup.title}" (id=${shortPid}) for this user turn — that's what the multi-step classifier does when a prompt looks like multi-step work, so you don't have to remember to call tracker_create_project yourself.${firstTaskHint} ` +
            `Work WITHIN that project instead of creating a parallel one:\n` +
            `  • tracker_edit_task(task_id=<id>, title=..., description=...) — rename / re-scope the auto-created first task to fit what you'd actually do first.\n` +
            `  • tracker_create_task(project_id="${shortPid}", title=..., step_number=..., assigned_to=...) — add the additional steps.\n` +
            `  • tracker_close_project(project_id="${shortPid}", status="cancelled", reason="...") — only if the classifier got it wrong and there's no useful project to do.\n` +
            `If you genuinely need a separate, unrelated project right now, retry with allow_duplicate=true.`
          );
        }
        return (
          `Refused: project "${dup.title}" (id=${shortPid}) was already created by you ${dup.createdMinutesAgo} minute(s) ago and is still active — the new title "${title}" looks like a near-duplicate.${firstTaskHint} ` +
          `Use the existing project: tracker_get_status(id="${shortPid}") to see current tasks, tracker_edit_task to rename/rescope a task, tracker_create_task(project_id="${shortPid}", ...) to add new steps, or tracker_close_project(project_id="${shortPid}", status="cancelled", reason="...") if it was a mistake. ` +
          `If this really is unrelated work that happens to share keywords, retry with allow_duplicate=true.`
        );
      }
    }

    const result = createProject({
      title,
      description,
      level,
      createdBy: agentId,
      tasks: tasksInput,
    });

    // Give every inline task a goal. The tasks[] shape historically carried no
    // goal field, so createProject left them goal=NULL — which makes them
    // impossible for PM to validate ("(none recorded)"): PM reverts each
    // completion and the agent re-submits forever (the validation ping-pong the
    // user reported). Mirror tracker_create_task: default the goal from the
    // caller-provided goal (if any), else the task's description, else its
    // title. Only fill when empty — never overwrite a real goal.
    for (let i = 0; i < result.taskIds.length; i++) {
      const id = result.taskIds[i];
      const t = getTask(id);
      if (!t) continue;
      const provided = typeof tasksInput?.[i]?.goal === 'string' ? (tasksInput[i].goal as string).trim() : '';
      const goal = provided || (t.description ? t.description.trim() : '') || (t.title ? t.title.trim() : '');
      if (!goal) continue;
      try {
        getDb().prepare(`UPDATE tasks SET goal = ? WHERE id = ? AND (goal IS NULL OR goal = '')`).run(goal, id);
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
        return `  ${i + 1}. "${t?.title ?? 'Unknown'}" — ID: ${id}${step} [${status}]`;
      });
      taskSummary = `\nTasks (${result.taskIds.length}):\n${taskLines.join('\n')}`;
    }

    // Notify assignees of nested tasks (skips the creator's own tasks).
    // Mirrors trackerCreateTask's notification path so tasks created via
    // create_project don't silently sit waiting for someone to notice.
    for (const taskId of result.taskIds) {
      const t = getTask(taskId);
      if (!t || !t.assignedTo) continue;
      // Skip tasks with a future scheduled_start — scheduler handles those
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

    return `[OK] project_id=${result.projectId} | title=${title}\n\nProject created successfully.${taskSummary}\n\nUse tracker_complete_step(task_id="<full task ID>") to mark steps complete.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCreateProject failed', { error: msg }, agentId);
    return `Error creating project: ${msg}`;
  }
}

// ── trackerCreateTask ──

export function trackerCreateTask(agentId: string, args: Record<string, unknown>): string {
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
      logger.info('tracker_create_task: goal omitted, defaulted from description', { agentId, title }, agentId);
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
    const priority = args.priority as 'high' | 'normal' | 'low' | undefined;
    const stepNumber = args.stepNumber as number | undefined;
    const dependsOn = args.dependsOn as string[] | undefined;
    const phase = args.phase as number | undefined;

    // Near-duplicate guard (2026-06-02 bug fix). Without this, a hoarding-
    // gate error on file_read/exec can put the agent into a loop where
    // every iteration calls tracker_create_task with the same title — 27
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
        SELECT id, substr(id, 1, 8) as id8 FROM tasks
        WHERE created_by = ?
          AND LOWER(title) = LOWER(?)
          AND COALESCE(assigned_to, '') = COALESCE(?, '')
          AND status IN ('on_deck', 'in_progress', 'paused', 'blocked')
          AND datetime(created_at) >= datetime('now', '-5 minutes')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(agentId, title, assignedTo ?? null) as { id: string; id8: string } | undefined;
      if (exact) {
        return (
          `Error: a task with this exact title was created by you in the last 5 minutes (id=${exact.id8}, assigned to the same agent). ` +
          `If you meant to update that task, call tracker_update_status / tracker_edit_task on id=${exact.id8}. ` +
          `If this is genuinely separate work that happens to share a title, re-call with allow_duplicate=true.`
        );
      }

      const newTokens = normalizeTitle(title);
      if (newTokens.length >= 2) {
        const newSet = new Set(newTokens);
        const recent = db.prepare(`
          SELECT id, title, substr(id, 1, 8) as id8 FROM tasks
          WHERE created_by = ?
            AND status IN ('on_deck', 'in_progress', 'paused', 'blocked')
            AND datetime(created_at) >= datetime('now', '-5 minutes')
          ORDER BY created_at DESC
          LIMIT 20
        `).all(agentId) as Array<{ id: string; title: string; id8: string }>;
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
              `If you meant to update that task, call tracker_update_status / tracker_edit_task on id=${row.id8}. ` +
              `If this is genuinely separate work, re-call with allow_duplicate=true.`
            );
          }
        }
      }
    }

    const taskId = createTask({
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
    });

    // Persist the goal onto the new row. (createTask itself only writes the
    // legacy columns; adding goal as an extra parameter would force every
    // call site to update. Cleaner to set it here.)
    try {
      getDb().prepare(`UPDATE tasks SET goal = ? WHERE id = ?`).run(goal, taskId);
    } catch (err) {
      logger.warn('Failed to persist goal on new task (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }

    // Status reconciliation. v2.8.x rule: 'on_deck' is reserved for
    // tasks with a FUTURE scheduled_start (the scheduler owns the
    // transition to 'in_progress' at fire time). Anything else lands
    // in 'in_progress' immediately so the assigned agent and the PM
    // keep seeing it as work to do — sitting in 'on_deck' without a
    // schedule was the failure mode where agents created multi-task
    // projects, worked the first one, and never returned to the rest.
    // The schema default (set in createTask above) is now 'in_progress'
    // for all rows; we only override to 'on_deck' here when a future
    // schedule justifies it.
    let scheduledStart = args.scheduled_start as string | undefined;
    if (scheduledStart) {
      try {
        const parsed = new Date(scheduledStart);
        if (!isNaN(parsed.getTime())) {
          scheduledStart = parsed.toISOString();
        }
      } catch { /* keep original if parse fails */ }
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
        updateTask(taskId, { status: 'on_deck' });
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
      // v2.5.2 — specific_days uses an explicit day-of-week allowlist.
      // Already normalized to CSV-of-ints by the tool dispatcher.
      const repeatDaysOfWeek = args.repeat_days_of_week as string | undefined;
      // v2.5.45 — anchor_time defaults to scheduled_start, normalizing
      // wall-clock alignment for all future recurring runs. Caller can
      // override (e.g. agent setting "anchor at 06:00 even though I'm
      // creating this at 14:23").
      let anchorTime = args.anchor_time as string | undefined;
      if (anchorTime) {
        try {
          const parsed = new Date(anchorTime);
          if (!isNaN(parsed.getTime())) anchorTime = parsed.toISOString();
        } catch { /* keep original */ }
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
      };
      const nextRun = calculateNextRun(taskForCalc) ?? scheduledStart;

      db.prepare(`
        UPDATE tasks SET
          scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
          repeat_end_type = ?, repeat_end_value = ?,
          repeat_days_of_week = ?, anchor_time = ?,
          next_run_at = ?, schedule_status = 'waiting',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(scheduledStart, repeatInterval ?? null, repeatUnit ?? null, repeatEndType, repeatEndValue ?? null, repeatDaysOfWeek ?? null, anchorTime ?? null, nextRun, taskId);
    }

    // Handle group assignment
    const assignedToGroup = args.assigned_to_group as string | undefined;
    if (assignedToGroup) {
      const db = getDb();
      db.prepare("UPDATE tasks SET assigned_to_group = ?, assigned_to = NULL, updated_at = datetime('now') WHERE id = ?").run(assignedToGroup, taskId);
    }

    const parts = [
      `[OK] task_id=${taskId} | title=${title}`,
      ``,
      `Task created successfully.`,
    ];
    if (projectId) parts.push(`Project: ${projectId}`);
    if (assignedTo) parts.push(`Assigned to: ${assignedTo}`);
    if (assignedToGroup) parts.push(`Assigned to group: ${assignedToGroup}`);
    if (priority) parts.push(`Priority: ${priority}`);
    if (scheduledStart) parts.push(`Scheduled: ${scheduledStart}`);

    // Notify assigned agent about the new task (unless they created it themselves,
    // or it's a scheduled task — the scheduler handles those).
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
// kind='reminder' and the supplied schedule — the scheduler then fires
// it with the reminder-flavored template (see scheduler/runner.ts).

export function reminderCreate(agentId: string, args: Record<string, unknown>): string {
  const what = (args.what as string | undefined)?.trim();
  if (!what) return 'Error: `what` is required (the reminder text).';

  const when = (args.when as string | undefined)?.trim();
  if (!when) {
    return (
      'ASK_USER: This reminder needs a time. Ask the user when they would like to be ' +
      'reminded ("in 5 minutes", "tomorrow at 8am", "every Monday at 9am"). ' +
      'Once they answer, call get_current_time to anchor relative times, then re-call ' +
      'reminder_create with `when` set to the resolved ISO 8601 datetime. ' +
      'Do NOT create the reminder yet.'
    );
  }

  // Title is for the kanban — keep short and recognizable.
  const titleSnippet = what.length > 60 ? what.slice(0, 57).trimEnd() + '…' : what;

  return trackerCreateTask(agentId, {
    title: `Reminder: ${titleSnippet}`,
    description: what,
    kind: 'reminder',
    scheduled_start: when,
    // Caller may pass repeat params through for recurring reminders
    // ("every Monday at 9am"). Same shape as tracker_create_task.
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

    const resolved = resolveTaskId(rawTaskId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    const status = args.status as string | undefined;
    let assignedTo = args.assignedTo as string | undefined;
    if (assignedTo) {
      const r = resolveAgentName(assignedTo);
      if (!r.ok) return r.error;
      assignedTo = r.id;
    }
    const priority = args.priority as string | undefined;

    if (!status && !assignedTo && !priority) {
      return 'Error: at least one of status, assignedTo, or priority must be provided';
    }

    // Check if this is a scheduled recurring task. Also snapshot the prior
    // status so we can emit a task_log transition entry below with the
    // accurate from→to pair (we cannot read it AFTER updateTask, the row
    // already moved by then).
    const db = getDb();
    const taskRow = db.prepare('SELECT title, schedule_status, repeat_interval, status as prior_status FROM tasks WHERE id = ?').get(taskId) as { title: string; schedule_status: string; repeat_interval: number | null; prior_status: string } | undefined;
    const isScheduledRecurring = taskRow && taskRow.schedule_status !== 'unscheduled' && taskRow.repeat_interval;
    const priorStatus = taskRow?.prior_status ?? null;

    // v2.10.1 — idempotency check. When the agent calls
    // tracker_update_status with a status that the task is already at,
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
      !assignedTo &&
      !priority &&
      priorStatus === status &&
      // For recurring per-run completion, "complete" is a real
      // transition every run even when the row currently reads
      // complete (the prior run's terminal state). Let the normal
      // path handle it so the scheduler advances.
      !(status === 'complete' && isScheduledRecurring)
    ) {
      return (
        `[NO-OP] task_id=${taskId} | status=${status} — already at this status, no change made.\n\n` +
        `Task: ${taskRow?.title ?? '(unknown title)'}\n\n` +
        `If a scheduler trigger for this task is showing in your recent context but the task is already ${status}, that is a STALE trigger left over from when the run actually fired — the scheduler is NOT re-firing it. Skip it silently and move on; you do not need to "re-close" already-closed work.`
      );
    }

    const updates: Record<string, string | null> = {};
    if (status) updates.status = status;
    if (assignedTo) updates.assignedTo = assignedTo;
    if (priority) updates.priority = priority;

    // v2.8.x rule: 'on_deck' is reserved for tasks with a FUTURE
    // scheduled_start (the scheduler owns the transition to 'in_progress'
    // at fire time). Anything else belongs in 'in_progress' so the work
    // stays visible to the assigned agent and the PM. Refuse explicit
    // moves to 'on_deck' on tasks without a future schedule so agents
    // don't accidentally park work in the "waiting for never" bucket —
    // the failure mode being addressed is the agent creating tasks,
    // working one, and forgetting the rest.
    if (status === 'on_deck' && !isPMAgent(agentId)) {
      const sched = db.prepare(
        'SELECT scheduled_start, repeat_interval, next_run_at FROM tasks WHERE id = ?'
      ).get(taskId) as { scheduled_start: string | null; repeat_interval: number | null; next_run_at: string | null } | undefined;
      const nowMs = Date.now();
      const futureScheduledStart = !!(
        sched?.scheduled_start && new Date(sched.scheduled_start).getTime() > nowMs
      );
      const futureNextRun = !!(
        sched?.next_run_at && new Date(sched.next_run_at).getTime() > nowMs
      );
      const isRecurring = !!sched?.repeat_interval;
      if (!futureScheduledStart && !futureNextRun && !isRecurring) {
        return (
          `Error: status="on_deck" is reserved for tasks with a FUTURE scheduled_start ` +
          `(or a recurring schedule). This task has no future schedule, so it belongs in ` +
          `"in_progress" until you actively work it. If you want to park it for later, ` +
          `set a scheduled_start with tracker_edit_task first, then move to on_deck. ` +
          `If you're done, use status="complete". If you're waiting on the user, use ` +
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
    // tracker_validate_pause tool).
    if (status === 'paused' && !callerIsPM) {
      const pauseNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      const MIN_PAUSE_NOTES_LEN = 15;
      if (pauseNotes.length < MIN_PAUSE_NOTES_LEN) {
        return (
          `Error: paused tasks require a clear reason in \`notes\` (minimum ${MIN_PAUSE_NOTES_LEN} characters). ` +
          `\`notes\` must name the specific external trigger you're waiting on - for example: ` +
          `"waiting for user to reboot ESP board", "waiting for vendor to send tracking number". ` +
          `If you're stuck and don't know what to do, that's NOT a paused condition - use \`status="blocked"\` ` +
          `with the real reason so the user knows. If you're just done with the task, use \`status="complete"\`. ` +
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
          `If you actually have a user-facing question, ask the user first then re-pause with a concrete "waiting for X" reason.`
        );
      }
    }

    // ── Phase B.1: complete engine hard gate ──
    // Structure only. Engine never inspects evidence content; that is PM's job.
    if (status === 'complete' && !callerIsPM) {
      const result = typeof args.result === 'string' ? args.result.trim() : '';
      const evidence = Array.isArray(args.evidence) ? args.evidence : null;
      if (!result) {
        const breaker = noteHardGateRejection(taskId, agentId, 'missing result field on complete');
        return (
          `Error: status="complete" requires a non-empty \`result\` field describing what was done. ` +
          `Example call: tracker_update_status(task_id="${taskId}", status="complete", result="migrated 12 routes to new auth middleware", evidence=[{kind:"file_modified", claim:"12 routes updated", pointer:"packages/server/src/gateway/routes/"}, {kind:"tool_call_ref", claim:"18 file_edit calls completed"}]).` +
          breaker
        );
      }
      if (!evidence || evidence.length === 0) {
        const breaker = noteHardGateRejection(taskId, agentId, 'missing or empty evidence array on complete');
        return (
          `Error: status="complete" requires \`evidence\` as a non-empty array. Each entry must be {kind, claim, pointer?}. ` +
          `Supported kinds (text-only, PM-readable): claim, file_modified, file_read, tool_call_ref, output_paste, external_action, quote. ` +
          `Example: evidence=[{kind:"file_modified", claim:"updated 12 routes", pointer:"packages/server/src/gateway/routes/"}, {kind:"tool_call_ref", claim:"18 file_edit calls succeeded"}].` +
          breaker
        );
      }
      // Each entry must be an object with non-empty `kind` and `claim`.
      for (let i = 0; i < evidence.length; i++) {
        const e = evidence[i] as Record<string, unknown> | null;
        if (!e || typeof e !== 'object') {
          const breaker = noteHardGateRejection(taskId, agentId, `evidence[${i}] is not an object`);
          return `Error: evidence[${i}] must be an object with {kind, claim, pointer?}, got ${typeof e}.${breaker}`;
        }
        const kind = typeof e.kind === 'string' ? e.kind.trim() : '';
        const claim = typeof e.claim === 'string' ? e.claim.trim() : '';
        if (!kind || !claim) {
          const breaker = noteHardGateRejection(taskId, agentId, `evidence[${i}] missing kind or claim`);
          return `Error: evidence[${i}] must have both \`kind\` (string) and \`claim\` (string). Got kind="${kind}", claim length=${claim.length}.${breaker}`;
        }
      }
      // Persist result + evidence on the task row for PM to read.
      try {
        db.prepare(`UPDATE tasks SET result = ?, evidence_json = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(result, JSON.stringify(evidence), taskId);
      } catch (err) {
        logger.warn('Failed to persist result/evidence on complete (non-fatal)', {
          taskId, error: err instanceof Error ? err.message : String(err),
        });
      }
      // Clear circuit-breaker tracking — the hard gate accepted.
      clearHardGateBreaker(taskId, agentId);
    }

    // ── Phase B.1: blocked engine hard gate ──
    if (status === 'blocked' && !callerIsPM) {
      const blockedNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      const MIN_BLOCKED_NOTES_LEN = 15;
      if (blockedNotes.length < MIN_BLOCKED_NOTES_LEN) {
        const breaker = noteHardGateRejection(taskId, agentId, 'missing or short blocked reason');
        return (
          `Error: status="blocked" requires a clear reason in \`notes\` (minimum ${MIN_BLOCKED_NOTES_LEN} characters). ` +
          `Name the specific obstacle (e.g. "need API key for service X", "external service Y is returning 500s"). ` +
          `If you are paused waiting for the user to do something, use status="paused" with notes naming the wait condition instead.` +
          breaker
        );
      }
      clearHardGateBreaker(taskId, agentId);
    }

    // For recurring tasks being marked complete with complete_all_runs=true,
    // the agent is asserting that NO further runs are needed. Stop the
    // schedule immediately and bypass per-run PM validation — this is the
    // "I did them all internally, please close the loop" path.
    if (status === 'complete' && isScheduledRecurring && (args.complete_all_runs as boolean) === true) {
      const notes = args.notes as string | undefined;
      db.prepare("UPDATE tasks SET status = 'complete', schedule_status = 'completed', is_paused = 1, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
      db.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = ? WHERE task_id = ? AND status = 'running'").run(notes ?? 'All runs completed by agent', taskId);
      const updatedTask = getTask(taskId)!;
      broadcast({ type: 'tracker:task_updated', data: updatedTask });
      notifyPrimaryAgent(
        `Recurring task "${updatedTask.title}" fully completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId} (all runs done).${notes ? ` Notes: ${notes}` : ''}`,
        agentId,
      );
      checkProjectCompletion(updatedTask.projectId, agentId);
      return `Recurring task "${updatedTask.title}" fully completed. Schedule stopped. All runs marked done.`;
    }

    // Recurring per-run complete (non-terminal): advance the schedule
    // immediately so the wall-clock anchor is preserved. PM validation
    // happens as an async audit on task_log but does NOT gate the next
    // fire — late validation must never lose a scheduled run. The hard
    // gate above already validated result+evidence presence, so we have
    // a clean record to archive.
    //
    // Detection: probe calculateNextRun with run_count+1. If it would
    // return null, this run is the TERMINAL close and we hold for the PM's
    // validation (matches one-shot complete semantics — final state needs
    // the same review discipline).
    if (status === 'complete' && isScheduledRecurring) {
      const detail = db.prepare(`
        SELECT scheduled_start, repeat_interval, repeat_unit, repeat_end_type,
               repeat_end_value, repeat_days_of_week, anchor_time, run_count,
               is_paused, last_run_at, next_run_at, schedule_status
        FROM tasks WHERE id = ?
      `).get(taskId) as {
        scheduled_start: string | null; repeat_interval: number | null;
        repeat_unit: string | null; repeat_end_type: string | null;
        repeat_end_value: string | null; repeat_days_of_week: string | null;
        anchor_time: string | null; run_count: number; is_paused: number;
        last_run_at: string | null; next_run_at: string | null; schedule_status: string;
      } | undefined;

      const wouldBeTerminal = (() => {
        if (!detail) return false;
        const probe: ScheduledTask = {
          id: taskId,
          scheduled_start: detail.scheduled_start,
          repeat_interval: detail.repeat_interval,
          repeat_unit: detail.repeat_unit,
          repeat_end_type: detail.repeat_end_type,
          repeat_end_value: detail.repeat_end_value,
          repeat_days_of_week: detail.repeat_days_of_week,
          anchor_time: detail.anchor_time,
          run_count: detail.run_count + 1,
          is_paused: detail.is_paused,
          last_run_at: new Date().toISOString(),
          next_run_at: detail.next_run_at,
          schedule_status: detail.schedule_status,
        };
        return calculateNextRun(probe) === null;
      })();

      if (!wouldBeTerminal) {
        // Non-terminal recurring per-run: archive result+evidence to
        // task_log for audit and advance the schedule immediately.
        const runResult = typeof args.result === 'string' ? args.result.trim() : '';
        const evidenceJson = Array.isArray(args.evidence) ? JSON.stringify(args.evidence) : null;
        try {
          writeTaskLog({
            taskId,
            fromEntity: `agent:${agentId}`,
            entryKind: 'transition',
            fromStatus: 'in_progress',
            toStatus: 'on_deck',
            actionTaken: `recurring per-run complete (run #${detail!.run_count + 1})`,
            reason: runResult || null,
            note: runResult || null,
            evidenceJson,
          });
        } catch (err) {
          logger.warn('Failed to archive recurring per-run to task_log (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
        }
        // Clear result/evidence on the task row so the next fire starts
        // from scratch — the per-run record lives in task_log.
        db.prepare(`UPDATE tasks SET result = NULL, evidence_json = NULL WHERE id = ?`).run(taskId);
        // Advance the schedule (fire-and-forget — same pattern the
        // generic complete handler uses below).
        const notes = args.notes as string | undefined;
        onTaskRunComplete(taskId, 'complete', notes ?? '').catch(err => {
          logger.warn('onTaskRunComplete failed during recurring per-run advance (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
        });
        const updatedTask = getTask(taskId)!;
        const nextRunFmt = updatedTask.nextRunAt ? formatTimeForAgent(updatedTask.nextRunAt) : null;
        notifyPrimaryAgent(
          `Recurring run completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId}: "${updatedTask.title}". Run ${updatedTask.runCount}${nextRunFmt ? `, next: ${nextRunFmt}` : ''}.${notes ? ` Notes: ${notes}` : ''}`,
          agentId,
        );
        return [
          `Run completed for recurring task.`,
          `Task: ${updatedTask.title} (${updatedTask.id})`,
          `Runs completed: ${updatedTask.runCount}`,
          nextRunFmt ? `Next run: ${nextRunFmt}` : 'No further runs scheduled.',
        ].join('\n');
      }
      // Terminal recurring complete: fall through to the standard complete
      // flow. The hard gate persists result/evidence, status flips to
      // 'complete', complete_validated stays 0, and the PM's terminal-close
      // validation runs against this final state. checkProjectCompletion
      // and dep cascades fire when the PM validates.
    }

    const task = updateTask(taskId, updates);

    if (!task) {
      // We already resolved taskId above, so the id existed at resolve time.
      // A null return from updateTask now means one of two rare things:
      //   1. Another agent deleted the task between resolve and update
      //   2. The task was deleted between the UPDATE and the SELECT
      // Either way, the task genuinely no longer exists — not a prefix mismatch.
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // Phase B.0: write the transition + any supplied notes to task_log.
    // tasks.notes is now read-only legacy (Q7) — new code does not append to it.
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
          actionTaken: 'tracker_update_status',
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

    // Notify primary agent when a task completes
    if (status === 'complete') {
      const notes = args.notes as string | undefined;
      notifyPrimaryAgent(
        `Task "${task.title}" completed by ${task.assignedToName ?? task.assignedTo ?? agentId}.${notes ? ` Notes: ${notes}` : ''}`,
        agentId,
      );
      // Handle one-time scheduled task completion. Recurring tasks are
      // gated out — their per-run advance happens only after the PM
      // validates this run via tracker_validate_complete. Calling
      // onTaskRunComplete here would silently advance the schedule and
      // bypass PM review (the bug v2.8.2 fixes).
      if (!isScheduledRecurring) {
        try {
          onTaskRunComplete(taskId, 'complete', notes ?? '');
        } catch { /* not a scheduled task */ }
      }
      checkProjectCompletion(task.projectId, agentId);
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
      parts.push('Paused indefinitely — must be resumed manually.');
    }

    // Apprentice safety net: if an apprentice just marked their OWN primary task
    // 'complete' via tracker_update_status, they almost certainly meant to finalize
    // their work. tracker_update_status alone leaves them idle — their parent will
    // never get the structured completion notification. Nudge them to call
    // complete_task on the next turn.
    if (status === 'complete') {
      const agentRow = db.prepare('SELECT classification, task_id FROM agents WHERE id = ?').get(agentId) as { classification: string; task_id: string | null } | undefined;
      if (agentRow && agentRow.classification === 'apprentice' && agentRow.task_id === taskId) {
        parts.push('');
        parts.push('[REMINDER] You just marked your own assigned task complete, but you have NOT finalized your work. tracker_update_status alone does not terminate you or notify your parent. Call complete_task(status="complete", summary="<your result>") on your next turn to wrap up properly.');
      }
    }

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

    const resolved = resolveTaskId(rawTaskId);
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

    return `[OK] task_id=${taskId}\n\nObservation appended to task_log.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerAddNotes failed', { error: msg }, agentId);
    return `Error adding notes: ${msg}`;
  }
}

// ── trackerEditNotes (deprecated v2.8.0) ──
//
// Phase B.0 makes the task_log append-only by design (audit trail).
// Mutating past entries breaks the audit guarantees. The tool stays in the
// registry for one release so existing prompts do not 404; returns a
// directive instead of doing the edit. Removed in Phase C.
export function trackerEditNotes(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string | undefined;
  const taskFragment = rawTaskId ? ` (task ${rawTaskId.slice(0, 8)})` : '';
  logger.info('trackerEditNotes called against deprecated tool', { agentId }, agentId);
  return (
    `Error: tracker_edit_notes is deprecated as of v2.8.0${taskFragment}. ` +
    `Task notes are now an append-only audit log (task_log). To correct a ` +
    `prior entry, write a new observation that supersedes it via ` +
    `tracker_add_notes(taskId, notes="Correction to my earlier note: <new info>"). ` +
    `The original entry stays in the log for the audit trail.`
  );
}

// ── trackerClearNotes (deprecated v2.8.0) ──
//
// Same deprecation rationale as trackerEditNotes. The task_log is the
// audit trail; wiping it would defeat the point. Returns a directive
// instead of clearing.
export function trackerClearNotes(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string | undefined;
  const taskFragment = rawTaskId ? ` (task ${rawTaskId.slice(0, 8)})` : '';
  logger.info('trackerClearNotes called against deprecated tool', { agentId }, agentId);
  return (
    `Error: tracker_clear_notes is deprecated as of v2.8.0${taskFragment}. ` +
    `Task notes are now an append-only audit log (task_log) and cannot be ` +
    `wiped. If a prior entry is obsolete, write a new observation that says ` +
    `so via tracker_add_notes(taskId, notes="The prior entries are stale: <why>").`
  );
}

// ── trackerEditTask ──
// Edit any structural field on a task — title, description, dependencies,
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

    const resolved = resolveTaskId(rawTaskId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

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

    const editableKeys = [
      title, description, dependsOn, stepNumber, phase,
      scheduledStart, repeatInterval, repeatUnit, repeatEndType, repeatEndValue,
      repeatDaysOfWeek, anchorTime,
      priority, notes, goal,
    ];
    if (editableKeys.every(v => v === undefined)) {
      return 'Error: at least one editable field must be provided. Editable: title, description, goal, depends_on, step_number, phase, scheduled_start, repeat_interval, repeat_unit, repeat_end_type, repeat_end_value, repeat_days_of_week, anchor_time, priority, notes. (For status changes use tracker_update_status; for assignee changes use tracker_reassign_task; for pause/resume use tracker_pause_schedule.)';
    }

    // Recurring-schedule integrity gate. Same shape as the gate in
    // tracker_create_task's dispatch — the edit path is the OTHER way to
    // produce a partial schedule (e.g. add repeat_interval to a row that
    // had no repeat_unit, or strip repeat_unit while leaving
    // repeat_interval set). Compute the EFFECTIVE post-edit values and
    // reject before applying the update so the agent gets clear feedback.
    const isScheduleEdit =
      scheduledStart !== undefined ||
      repeatInterval !== undefined ||
      repeatUnit !== undefined;
    if (isScheduleEdit) {
      const current = getDb().prepare(`
        SELECT scheduled_start, repeat_interval, repeat_unit FROM tasks WHERE id = ?
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

    // Phase B.1: goal edits are special. PM watches for goalpost-narrowing
    // mid-work. We log both old and new with a diff, so PM can see history
    // when validating later.
    if (goal !== undefined) {
      const goalTrimmed = goal.trim();
      if (!goalTrimmed) {
        return 'Error: goal cannot be empty. To edit other fields without changing goal, omit goal from the args.';
      }
      try {
        const priorGoal = getDb().prepare(`SELECT goal FROM tasks WHERE id = ?`).get(taskId) as { goal: string | null } | undefined;
        getDb().prepare(`UPDATE tasks SET goal = ?, updated_at = datetime('now') WHERE id = ?`).run(goalTrimmed, taskId);
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
      // a local-time string — same handling as trackerCreateTask.
      if (scheduledStart === null || scheduledStart === '') {
        updates.scheduledStart = null;
      } else {
        try {
          const parsed = new Date(scheduledStart);
          updates.scheduledStart = isNaN(parsed.getTime()) ? scheduledStart : parsed.toISOString();
        } catch {
          updates.scheduledStart = scheduledStart;
        }
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

    const task = updateTask(taskId, updates);
    if (!task) {
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // v2.5.3 — if any schedule field changed, recompute next_run_at so the
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
    if (scheduleChanged) {
      try {
        const db = getDb();
        const row = db.prepare(`
          SELECT id, scheduled_start, repeat_interval, repeat_unit,
                 repeat_end_type, repeat_end_value, repeat_days_of_week,
                 anchor_time,
                 run_count, is_paused, last_run_at, next_run_at, schedule_status
          FROM tasks WHERE id = ?
        `).get(taskId) as {
          id: string;
          scheduled_start: string | null;
          repeat_interval: number | null;
          repeat_unit: string | null;
          repeat_end_type: string | null;
          repeat_end_value: string | null;
          repeat_days_of_week: string | null;
          anchor_time: string | null;
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
          // that have already fired — in that case leave whatever status was
          // there (typically 'completed' or 'idle').
          if (nextRun) {
            db.prepare(`
              UPDATE tasks
              SET next_run_at = ?, schedule_status = 'waiting', updated_at = datetime('now')
              WHERE id = ?
            `).run(nextRun, taskId);
          } else if (row.scheduled_start === null) {
            // Schedule was cleared entirely — drop next_run_at too.
            db.prepare(`
              UPDATE tasks
              SET next_run_at = NULL, schedule_status = 'idle', updated_at = datetime('now')
              WHERE id = ?
            `).run(taskId);
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

    return [
      `[OK] task_id=${task.id}`,
      ``,
      `Task updated: ${task.title}`,
      `Fields changed: ${changed.join(', ')}`,
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerEditTask failed', { error: msg }, agentId);
    return `Error editing task: ${msg}`;
  }
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
      const taskResolved = resolveTaskId(rawTaskId);
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
          const proj = statusDb.prepare('SELECT title FROM projects WHERE id = ?').get(task.projectId) as { title: string } | undefined;
          parts.push(`Project: ${proj?.title ?? task.projectId}`);
        }
        if (task.assignedTo) parts.push(`Assigned to: ${task.assignedToName ?? task.assignedTo}`);
        if (task.description) parts.push(`Description: ${task.description}`);
        if (task.stepNumber !== null) parts.push(`Step: ${task.stepNumber}${task.totalSteps ? ` of ${task.totalSteps}` : ''}`);
        if (task.dependsOn.length > 0) {
          const depNames = task.dependsOn.map(depId => {
            const dep = getTask(depId);
            return dep ? dep.title : depId;
          });
          parts.push(`Depends on: ${depNames.join(', ')}`);
        }
        if (task.notes) parts.push(`\nNotes:\n${task.notes}`);
        parts.push(`Created: ${task.createdAt}`);
        parts.push(`Updated: ${task.updatedAt}`);
        if (task.completedAt) parts.push(`Completed: ${task.completedAt}`);

        return parts.join('\n');
      }
      // Task resolution failed — if we also have a projectId (usually the
      // same string), try the project branch below before reporting.
      if (!rawProjectId) {
        return formatResolveError('task', rawTaskId, taskResolved);
      }
    }

    if (rawProjectId) {
      const projectResolved = resolveProjectId(rawProjectId);
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
      if (filterStatus) {
        const filtered = listTasks({ status: filterStatus, assignedTo: filterAssignedTo });
        if (filtered.length > 0) {
          parts.push(`${filterStatus.replace('_', ' ')} Tasks (${filtered.length}):`);
          for (const t of filtered) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
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
          for (const t of inProgress) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
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
          for (const t of blocked) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          totalShown += blocked.length;
        }

        const paused = listTasks({ status: 'paused', ...taskFilter });
        if (paused.length > 0) {
          parts.push('');
          parts.push(`Paused Tasks (${paused.length}):`);
          for (const t of paused) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          totalShown += paused.length;
        }

        if (inProgress.length === 0 && pending.length === 0 && blocked.length === 0) {
          parts.push('');
          parts.push('No active tasks.');
        }
      }
    }

    // Trailer: always tell the agent how to drill in. In compact mode also
    // mention verbose=true.
    if (totalShown > 0) {
      parts.push('');
      if (verbose) {
        parts.push('Tip: tracker_get_status(id="<task_id>") for notes, depends_on, schedule, and full description.');
      } else {
        parts.push(`${totalShown} task/project row${totalShown === 1 ? '' : 's'} shown (compact). For full detail on one: tracker_get_status(id=<task_or_project_id>). For descriptions on every result: re-call tracker_list_active with verbose=true.`);
      }
    }

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerListActive failed', { error: msg }, agentId);
    return `Error listing active items: ${msg}`;
  }
}

// ── trackerCompleteStep ──

export function trackerCompleteStep(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = (args.taskId as string) ?? (args.task_id as string);
    if (!rawTaskId) return 'Error: task_id is required';

    const resolved = resolveTaskId(rawTaskId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    const notes = args.notes as string | undefined;
    const db = getDb();

    // Get the completed task
    const task = getTask(taskId);
    if (!task) return `Error: Task ${taskId} was deleted before completion could be recorded.`;

    // Guard: don't complete a paused task — it was intentionally put on hold
    if (task.status === 'paused') {
      return `Error: Task "${task.title}" is paused. It cannot be completed while paused. Unpause it first (tracker_update_status with status="in_progress") or ask ${getOwnerName()} for instructions.`;
    }

    // Mark current task as complete
    updateTask(taskId, { status: 'complete', notes: notes ? `[Completed] ${notes}` : '[Completed]' });

    let nextTaskInfo = '';

    // Find and start the next step in the same project
    if (task.projectId && task.stepNumber !== null) {
      const nextStep = db.prepare(`
        SELECT id, title, step_number FROM tasks
        WHERE project_id = ? AND step_number > ? AND status = 'on_deck'
        ORDER BY step_number ASC
        LIMIT 1
      `).get(task.projectId, task.stepNumber) as { id: string; title: string; step_number: number } | undefined;

      if (nextStep) {
        updateTask(nextStep.id, { status: 'in_progress' });
        nextTaskInfo = `\nNext step started: "${nextStep.title}" (${nextStep.id}) — step ${nextStep.step_number}, now in_progress.`;
      } else {
        // Check if all tasks in this project are now complete
        const remaining = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND status NOT IN ('complete', 'fallen')
        `).get(task.projectId) as { count: number };

        if (remaining.count === 0) {
          db.prepare(`
            UPDATE projects SET status = 'complete', completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
          `).run(task.projectId);
          nextTaskInfo = '\nAll steps complete — project marked as complete!';
        } else {
          nextTaskInfo = `\nNo next sequential step found. ${remaining.count} task(s) remaining in project.`;
        }
      }
    }

    // Notify primary agent of step completion
    notifyPrimaryAgent(
      `Step completed: "${task.title}"${nextTaskInfo}`,
      agentId,
    );
    // Check project-level completion
    checkProjectCompletion(task.projectId, agentId);

    logger.info('Step completed', { taskId, nextTaskInfo: nextTaskInfo.trim() }, agentId);
    return `[OK] task_id=${taskId} | status=complete\n\nStep completed: "${task.title}".${nextTaskInfo}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCompleteStep failed', { error: msg }, agentId);
    return `Error completing step: ${msg}`;
  }
}

// ── trackerEditProject ──
//
// Rename / re-describe a project. Until now, projects literally had no
// editable title — only status and currentPhase could be changed. Added
// so the PM agent can rename engine-auto-created projects (the multistep
// classifier names them with a slice of the user prompt; PM rewrites
// both project and first task to clean names on its next turn).

export function trackerEditProject(agentId: string, args: Record<string, unknown>): string {
  const rawProjectId = (args.project_id ?? args.projectId) as string | undefined;
  if (!rawProjectId) return 'Error: project_id is required.';

  const resolved = resolveProjectId(rawProjectId);
  if (!resolved.ok) return formatResolveError('project', rawProjectId, resolved);
  const projectId = resolved.id;

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
    updates.description = description === null || description === '' ? null : String(description);
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
// tracker_update_status one task at a time.

export function trackerCloseProject(agentId: string, args: Record<string, unknown>): string {
  const rawProjectId = (args.project_id ?? args.projectId) as string | undefined;
  if (!rawProjectId) return 'Error: project_id is required.';

  const resolved = resolveProjectId(rawProjectId);
  if (!resolved.ok) return formatResolveError('project', rawProjectId, resolved);
  const projectId = resolved.id;

  // Default to status='cancelled' — most calls to this tool are clean-up of
  // abandoned/duplicated projects rather than "we actually finished it."
  // Agents who really did finish all the work should pass status='complete'.
  const rawStatus = (args.status as string | undefined)?.toLowerCase() ?? 'cancelled';
  if (rawStatus !== 'complete' && rawStatus !== 'cancelled') {
    return 'Error: status must be either "complete" (all work was actually done) or "cancelled" (abandoned / duplicated / scope changed).';
  }
  const status = rawStatus as 'complete' | 'cancelled';

  const reason = (args.reason as string | undefined)?.trim();
  if (!reason || reason.length < 4) {
    return 'Error: reason is required (a short sentence on why this project is being closed — will be appended to every task as a note for the audit trail).';
  }

  const project = getProject(projectId);
  if (!project) return `Error: Project ${projectId} was deleted before close could be applied.`;

  try {
    const result = closeProjectAndOpenTasks({
      projectId,
      closingAgentId: agentId,
      taskStatus: status,
      projectStatus: status,
      reason,
    });
    notifyPrimaryAgent(
      `Project "${project.title}" was bulk-closed by ${agentId} (status=${status}). ${result.tasksClosed} open task(s) closed; ${result.alreadyClosed} were already terminal. Reason: ${reason}`,
      agentId,
    );
    return [
      `[OK] project_id=${projectId} | status=${status}`,
      ``,
      `Project "${project.title}" closed.`,
      `Tasks closed by this call: ${result.tasksClosed}`,
      `Tasks already in a terminal state (skipped): ${result.alreadyClosed}`,
      `Reason recorded on each closed task: ${reason}`,
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCloseProject failed', { projectId, error: msg }, agentId);
    return `Error closing project: ${msg}`;
  }
}

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

export async function trackerValidatePause(
  pmAgentId: string,
  args: { task_id: string; valid: boolean; reject_reason?: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(
    "SELECT id, title, status, assigned_to, notes, pause_validated, goal FROM tasks WHERE id = ?",
  ).get(taskId) as { id: string; title: string; status: string; assigned_to: string | null; notes: string | null; pause_validated: number; goal: string | null } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status !== 'paused') {
    return `Error: task "${task.title}" (${taskId}) is currently status="${task.status}", not "paused". Nothing to validate.`;
  }

  if (args.valid) {
    db.prepare("UPDATE tasks SET pause_validated = 1, updated_at = datetime('now') WHERE id = ?").run(taskId);
    writeTaskLog({
      taskId,
      fromEntity: 'pm',
      entryKind: 'transition',
      fromStatus: 'paused',
      toStatus: 'paused',
      actionTaken: 'tracker_validate_pause(valid=true)',
      reason: 'PM blessed the pause as legitimate',
    });
    // Real-time dashboard sync: the validate-success path bypasses
    // updateTask() and writes the validation flag via direct SQL, so
    // we have to broadcast manually for the bug icon to clear without
    // a manual refresh.
    const fresh = getTask(taskId);
    if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
    logger.info('Pause validated by PM', { taskId, pmAgentId }, pmAgentId);
    return `[OK] Pause validated on "${task.title}" (${taskId}). PM will leave this task alone until the agent un-pauses it.`;
  }

  // Reject path. Revert to PM-chosen target_status (default in_progress) and notify the assigned agent.
  const rejectReason = (args.reject_reason ?? '').trim();
  if (!rejectReason) {
    return 'Error: reject_reason is required when valid=false. One-sentence explanation for the agent (e.g. "no specific wait condition; you never actually asked the user anything").';
  }
  const targetStatus = args.target_status ?? 'in_progress';
  const ALLOWED_TARGETS = new Set(['in_progress', 'on_deck', 'blocked']);
  if (!ALLOWED_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed for a pause rejection. Use 'in_progress' (default), 'on_deck', or 'blocked'.`;
  }

  // Use updateTask so is_paused gets cleared and pause fields reset.
  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before pause-reject could land.`;
  // Increment revert_count and log the reject + transition.
  db.prepare(`UPDATE tasks SET revert_count = revert_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  // updateTask already broadcast with the status flip, but revert_count
  // moved after that broadcast — re-broadcast so the dashboard's copy
  // matches the row.
  const freshPauseReject = getTask(taskId);
  if (freshPauseReject) broadcast({ type: 'tracker:task_updated', data: freshPauseReject });
  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'reject',
    fromStatus: 'paused',
    toStatus: targetStatus,
    actionTaken: 'tracker_validate_pause(valid=false)',
    reason: rejectReason,
  });
  // Check whether revert_count just crossed the stalemate threshold.
  await maybeTriggerStalemate(taskId, pmAgentId);

  // Direct A2A message to the assigned agent so they see the rejection on
  // their next turn. Fire-and-forget; if delivery fails, log and continue -
  // PM has done its part by reverting the status.
  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `Your pause on "${task.title}" (${taskId.slice(0, 8)}) was lifted back to in_progress — PM didn't see a real wait condition. This is a routine check, not a penalty.\n\n` +
        `PM's reason: ${rejectReason}\n\n` +
        `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
        `Pick one and move: (a) finish the work and mark complete with result + evidence, (b) mark blocked with the real obstacle if you can't proceed, (c) ask the user a specific question and re-pause naming what you're waiting for. Don't re-pause with the same notes — PM will reject again.`;
      const { v4: uuidv4 } = await import('uuid');
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: uuidv4(),
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: pmAgentId,
      });
    } catch (err) {
      logger.warn('Failed to send pause-rejection notice to agent', {
        taskId, assignedTo: task.assigned_to,
        error: err instanceof Error ? err.message : String(err),
      }, pmAgentId);
    }
  }

  logger.info('Pause rejected by PM', { taskId, pmAgentId, rejectReason }, pmAgentId);
  return (
    `[OK] Pause rejected on "${task.title}" (${taskId}). Task reverted to in_progress. ` +
    `Rejection reason recorded: "${rejectReason}". ` +
    `${task.assigned_to ? `Notified ${task.assigned_to} via send_to_agent.` : 'Task has no assigned agent to notify.'}`
  );
}

// ── trackerRetask ──
//
// PM-only forward-leaning verb. Use when an agent's outcome on a task is
// wrong (work skipped, channel wrong, evidence missing, claim doesn't
// match goal) and you want them to redo it with specific guidance —
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
    return 'Error: directive must be at least 30 characters. Tell the agent concretely what they did wrong and what to do instead (e.g. "you posted the brief in chat but the task specifies email delivery; please call send_email with the same content to david@cornerp.in").';
  }

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(
    "SELECT id, title, status, assigned_to, goal FROM tasks WHERE id = ?",
  ).get(taskId) as { id: string; title: string; status: string; assigned_to: string | null; goal: string | null } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status === 'cancelled') {
    return `Error: task "${task.title}" (${taskId}) is cancelled. Cancelled tasks cannot be retasked. Create a new task instead.`;
  }
  if (!task.assigned_to) {
    return `Error: task "${task.title}" (${taskId}) has no assigned agent. Use tracker_reassign_task first, then retask.`;
  }

  const targetStatus = args.target_status ?? 'in_progress';
  const ALLOWED_TARGETS = new Set(['in_progress', 'on_deck']);
  if (!ALLOWED_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed for retask. Use 'in_progress' (default) or 'on_deck'.`;
  }

  // Drive status through updateTask so is_paused / pause fields reset
  // correctly when retasking out of paused.
  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before retask could land.`;

  // Reset validation flags so engine and PM treat the next pass as
  // fresh, and bump revert_count (a retask is a PM revert of the
  // agent's outcome). Done in one statement.
  db.prepare(`
    UPDATE tasks
    SET pause_validated = 0,
        complete_validated = 0,
        blocked_validated = 0,
        revert_count = revert_count + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);

  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'directive',
    fromStatus: task.status,
    toStatus: targetStatus,
    actionTaken: 'tracker_retask',
    reason: directive,
  });

  await maybeTriggerStalemate(taskId, pmAgentId);

  // Deliver the PM's directive to the assigned agent as a system-injected
  // user turn (same transport as validate_pause's reject path). Fire-
  // and-forget; PM has already moved the status.
  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    const body =
      `PM retask on "${task.title}" (${taskId.slice(0, 8)}). Task is back to ${targetStatus}.\n\n` +
      `PM directive: ${directive}\n\n` +
      `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
      `Do the work the directive describes, then close out (tracker_update_status with status="complete", a clear result, and evidence pointing at the concrete artifact — file path, message id, tool_call_ref, etc.). Don't just acknowledge; do the thing.`;
    const { v4: uuidv4 } = await import('uuid');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: uuidv4(),
      requiresResponse: true,
      payload: body,
      toAgent: task.assigned_to,
      fromAgent: pmAgentId,
    });
  } catch (err) {
    logger.warn('Failed to deliver retask directive to agent', {
      taskId, assignedTo: task.assigned_to,
      error: err instanceof Error ? err.message : String(err),
    }, pmAgentId);
  }

  logger.info('Task retasked by PM', { taskId, pmAgentId, targetStatus, directiveLength: directive.length }, pmAgentId);
  return (
    `[OK] Retasked "${task.title}" (${taskId}) from ${task.status} to ${targetStatus}. ` +
    `Directive delivered to ${task.assigned_to}. revert_count incremented.`
  );
}

// ── trackerPauseSchedule ──

export function trackerPauseSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const markComplete = (args.mark_complete as boolean) ?? false;

  const db = getDb();
  const task = db.prepare('SELECT id, title, schedule_status, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; title: string; schedule_status: string; project_id: string } | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before pause could be applied.`;
  if (task.schedule_status === 'unscheduled') {
    return (
      `Refused: tracker_pause_schedule is for recurring/scheduled tasks only — "${task.title}" has no schedule. ` +
      `For a one-shot task: if the work is DONE, call tracker_update_status(task_id="${task.id}", status="complete"). ` +
      `If you're stuck, call tracker_update_status(..., status="blocked", notes="why"). ` +
      `If the task is no longer needed, call tracker_update_status(..., status="paused", resume_at="<ISO datetime>") to pause until a specific time, or — if you want it cleanly off the active board — tracker_close_project for whole-project cleanup. ` +
      `Pausing a one-shot task without a resume_at strands it: it sits in the Paused column, can\'t be completed without unpausing, and the PM stops watching it.`
    );
  }

  if (markComplete) {
    // Stop the schedule AND mark the task as complete (terminal state)
    db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'completed', status = 'complete', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
    db.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = 'Schedule stopped and marked complete' WHERE task_id = ? AND status = 'running'").run(taskId);
    const freshSchedDone = getTask(taskId);
    if (freshSchedDone) broadcast({ type: 'tracker:task_updated', data: freshSchedDone });
    logger.info('Schedule paused and task marked complete', { taskId }, agentId);
    checkProjectCompletion(task.project_id, agentId);
    return `Schedule stopped and task "${task.title}" marked complete.`;
  }

  db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'paused', status = 'paused', updated_at = datetime('now') WHERE id = ?").run(taskId);
  const freshSchedPaused = getTask(taskId);
  if (freshSchedPaused) broadcast({ type: 'tracker:task_updated', data: freshSchedPaused });
  logger.info('Schedule paused', { taskId }, agentId);
  return `Schedule paused for "${task.title}". Status set to "paused" — stale detection and PM monitoring will ignore it until resumed.`;
}

// ── trackerResumeSchedule ──

export function trackerResumeSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before resume could be applied.`;

  
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
    anchor_time: task.anchor_time as string | null,
  };

  const nextRun = calculateNextRun(scheduledTask);
  db.prepare("UPDATE tasks SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck', next_run_at = ?, updated_at = datetime('now') WHERE id = ?").run(nextRun, taskId);
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

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} no longer exists.`;
  const title = (task.title as string) ?? '(untitled)';

  if (action === 'pause') {
    // Already paused by the alert handler; just confirm and exit. No
    // state change needed beyond what alertMissedRuns already did.
    logger.info('Missed-runs resolved: pause', { taskId }, agentId);
    return `OK: task "${title}" stays paused. The user can resume it from the dashboard, or you can later call tracker_resume_schedule.`;
  }

  if (action === 'skip') {
    // Compute next future anchor (strictly > now). calculateNextRun
    // already does this when fed an unpaused snapshot — its inner loop
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
    };
    const nextRun = calculateNextRun(scheduledTask);
    if (!nextRun) {
      // End conditions reached or anchor unset — leave paused.
      return `Could not compute a next-run for "${title}" (likely past repeat_end_value or anchor missing). Task stays paused; investigate manually.`;
    }
    db.prepare(`
      UPDATE tasks
      SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck',
          next_run_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextRun, taskId);
    logger.info('Missed-runs resolved: skip', { taskId, nextRun }, agentId);
    return `OK: task "${title}" unpaused. All missed slots skipped. Next run: ${nextRun}.`;
  }

  // action === 'run_now': fire one catch-up run immediately. Set
  // next_run_at to now so the next scheduler tick picks it up. After
  // that run completes, onTaskRunComplete will compute the natural
  // next anchor and the task resumes its normal cadence.
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck',
        next_run_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nowIso, taskId);
  logger.info('Missed-runs resolved: run_now', { taskId }, agentId);
  return `OK: task "${title}" unpaused and scheduled to fire on the next scheduler tick (within ~1 minute). Schedule resumes on its normal anchor after this run completes.`;
}

/**
 * tracker_apply_user_validation — used by the primary agent when the user
 * replies to a "[VALIDATION CHECK]" system message in chat. The user is
 * telling us whether work that's been sitting unvalidated is actually
 * done or not.
 *
 * Args:
 *   - task_id: the task being validated
 *   - validated: true if user confirmed it's actually done; false to revert
 *   - user_quote: the user's exact reply for audit
 *   - feedback: optional feedback to relay to the assigned agent when
 *     validated=false (e.g. "no, the script didn't actually run; rerun it")
 *
 * On validated=true: flips the matching *_validated flag to 1, logs as
 * from_entity='user' via primary, clears the bug icon. Mirrors the
 * dashboard /user-validate endpoint.
 *
 * On validated=false: reverts to in_progress, increments revert_count,
 * appends feedback as an observation entry, A2A-pings the assigned agent
 * with the feedback. The assigned agent picks up where they left off.
 */
export async function trackerApplyUserValidation(
  callerAgentId: string,
  args: { task_id: string; validated: boolean; user_quote: string; feedback?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const userQuote = (args.user_quote ?? '').trim();
  if (!userQuote) return 'Error: user_quote is required (the user\'s exact reply, for the audit trail).';

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status, assigned_to, complete_validated, pause_validated, blocked_validated
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; assigned_to: string | null;
    complete_validated: number; pause_validated: number; blocked_validated: number;
  } | undefined;
  if (!task) return `Error: task ${taskId} not found.`;

  let flagColumn: 'complete_validated' | 'pause_validated' | 'blocked_validated' | null = null;
  if (task.status === 'complete') flagColumn = 'complete_validated';
  else if (task.status === 'paused') flagColumn = 'pause_validated';
  else if (task.status === 'blocked') flagColumn = 'blocked_validated';
  if (!flagColumn) {
    return `Error: task "${task.title}" (${taskId.slice(0, 8)}) is currently status="${task.status}". User-validation only applies to complete/paused/blocked.`;
  }

  if (args.validated) {
    db.prepare(`UPDATE tasks SET ${flagColumn} = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
    // Real-time sync after direct SQL flag-set.
    const freshUserValid = getTask(taskId);
    if (freshUserValid) broadcast({ type: 'tracker:task_updated', data: freshUserValid });
    writeTaskLog({
      taskId,
      fromEntity: 'user',
      entryKind: 'transition',
      fromStatus: task.status,
      toStatus: task.status,
      actionTaken: `apply_user_validation via ${callerAgentId} (${flagColumn}=1)`,
      reason: 'user confirmed in chat reply',
      note: userQuote,
    });
    logger.info('User validation applied via chat reply', { taskId, callerAgentId, flagColumn }, callerAgentId);
    return `[OK] task "${task.title}" (${taskId.slice(0, 8)}) marked validated by user (${flagColumn}=1). Bug icon cleared.`;
  }

  // Reject path: revert to in_progress, add feedback as observation, ping the assigned agent.
  const feedback = (args.feedback ?? '').trim();
  const updated = updateTask(taskId, { status: 'in_progress' });
  if (!updated) return `Error: task ${taskId} was deleted before user-revert could land.`;
  db.prepare(`UPDATE tasks SET revert_count = revert_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  const freshUserReject = getTask(taskId);
  if (freshUserReject) broadcast({ type: 'tracker:task_updated', data: freshUserReject });

  writeTaskLog({
    taskId,
    fromEntity: 'user',
    entryKind: 'reject',
    fromStatus: task.status,
    toStatus: 'in_progress',
    actionTaken: `apply_user_validation via ${callerAgentId} (validated=false)`,
    reason: feedback || 'user said work was not actually done',
    note: userQuote,
  });

  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `User reviewed task "${task.title}" (${taskId.slice(0, 8)}) and said it is NOT actually ${task.status}. ` +
        `User's reply: "${userQuote}". ` +
        (feedback ? `Feedback to address: ${feedback}. ` : '') +
        `Task is back to in_progress. Address the feedback, then resubmit with proper result + evidence.`;
      await deliverA2AMessage({
        intent: 'ASSIGN',
        threadId: '',
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: callerAgentId,
      });
    } catch (err) {
      logger.warn('apply_user_validation: A2A delivery to assigned agent failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info('User reverted via chat reply', { taskId, callerAgentId, hasFeedback: feedback.length > 0 }, callerAgentId);
  return `[OK] task "${task.title}" (${taskId.slice(0, 8)}) reverted to in_progress. Assigned agent (${task.assigned_to ?? 'unassigned'}) notified with the feedback.`;
}

// ──────────────────────────────────────────────────────────────────────
// Phase B.1: validation + override + user-verdict tools
// ──────────────────────────────────────────────────────────────────────

const USER_VERDICT_THRESHOLDS: Record<string, number> = {
  high: 2,
  normal: 3,
  low: 5,
};

const ALLOWED_REJECT_TARGETS = new Set(['in_progress', 'on_deck', 'blocked']);

// Hard-gate circuit-breaker. Counts consecutive engine hard-gate
// rejections per (task, agent). After HARD_GATE_BREAKER_LIMIT, the
// engine auto-queues an OVERRIDE_REQUEST on the agent's behalf and the
// thrashing stops. In-memory is fine: a server restart resets all
// counters and the agent gets fresh chances. Phase B.1.
const HARD_GATE_BREAKER_LIMIT = 3;
interface BreakerState {
  count: number;
  reasons: string[];
  firstAt: number;
}
const hardGateBreaker = new Map<string, BreakerState>();
function breakerKey(taskId: string, agentId: string): string {
  return `${taskId}::${agentId}`;
}
/**
 * Record one hard-gate rejection. Returns a suffix string to append to
 * the agent-facing error. After the limit hits, the suffix tells the
 * agent the engine queued an override on their behalf.
 */
function noteHardGateRejection(taskId: string, agentId: string, reason: string): string {
  const key = breakerKey(taskId, agentId);
  const prev = hardGateBreaker.get(key);
  const next: BreakerState = prev
    ? { count: prev.count + 1, reasons: [...prev.reasons, reason].slice(-HARD_GATE_BREAKER_LIMIT), firstAt: prev.firstAt }
    : { count: 1, reasons: [reason], firstAt: Date.now() };
  hardGateBreaker.set(key, next);

  if (next.count >= HARD_GATE_BREAKER_LIMIT) {
    // Auto-queue an OVERRIDE_REQUEST on the agent's behalf.
    try {
      const justification =
        `Engine hard-gate circuit-breaker auto-fired after ${next.count} consecutive same-task hard-gate rejections by ${agentId}. ` +
        `Last reasons (most recent first): ${next.reasons.slice().reverse().join(' | ')}. ` +
        `Either the agent is misinterpreting the schema or the engine is wrong; PM should decide.`;
      const db = getDb();
      const existing = db.prepare(`
        SELECT id FROM task_override_requests
        WHERE task_id = ? AND requested_by = ? AND status = 'pending'
        LIMIT 1
      `).get(taskId, agentId) as { id: string } | undefined;
      if (!existing) {
        const id = uuidv4();
        db.prepare(`
          INSERT INTO task_override_requests
            (id, task_id, requested_by, requested_status, justification, last_engine_error, attempts_attached, status, created_at)
          VALUES (?, ?, ?, 'complete', ?, ?, ?, 'pending', datetime('now'))
        `).run(id, taskId, agentId, justification, reason, next.count);
        writeTaskLog({
          taskId,
          fromEntity: 'engine',
          entryKind: 'override',
          actionTaken: 'hard-gate circuit-breaker auto-fired',
          reason: justification,
        });
        logger.warn('Hard-gate circuit-breaker fired', { taskId, agentId, count: next.count }, agentId);
      }
    } catch (err) {
      logger.warn('Circuit-breaker auto-override queue failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
    // Reset after firing so the agent doesn't loop on the breaker too.
    hardGateBreaker.delete(key);
    return ` (Circuit-breaker: engine queued an OVERRIDE_REQUEST on your behalf after ${HARD_GATE_BREAKER_LIMIT} consecutive hard-gate rejections on this task. Stop retrying; wait for PM to resolve.)`;
  }
  return ` (Attempt ${next.count}/${HARD_GATE_BREAKER_LIMIT} before circuit-breaker auto-queues an override.)`;
}
/**
 * Reset the breaker for a (task, agent) pair. Called when the hard gate
 * accepts a transition — the agent is back in a good state.
 */
function clearHardGateBreaker(taskId: string, agentId: string): void {
  hardGateBreaker.delete(breakerKey(taskId, agentId));
}

/**
 * Helper: after PM rejects a transition, see if revert_count has reached
 * the per-priority stalemate threshold. If so, flip awaiting_user_verdict
 * and dispatch a directive A2A to the assigned agent telling them to
 * call tracker_request_user_verdict.
 */
async function maybeTriggerStalemate(taskId: string, pmAgentId: string): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, title, status, priority, assigned_to, revert_count, awaiting_user_verdict
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; priority: string;
    assigned_to: string | null; revert_count: number; awaiting_user_verdict: number;
  } | undefined;
  if (!row) return;
  if (row.awaiting_user_verdict === 1) return;
  const threshold = USER_VERDICT_THRESHOLDS[row.priority] ?? USER_VERDICT_THRESHOLDS.normal;
  if (row.revert_count < threshold) return;

  db.prepare(`
    UPDATE tasks
    SET awaiting_user_verdict = 1,
        user_verdict_requested_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);

  writeTaskLog({
    taskId,
    fromEntity: 'engine',
    entryKind: 'user_verdict_request',
    actionTaken: 'awaiting_user_verdict set',
    reason: `stalemate after ${row.revert_count} reverts (priority=${row.priority}, threshold=${threshold})`,
  });

  logger.warn('Stalemate triggered: awaiting_user_verdict set', {
    taskId, priority: row.priority, revertCount: row.revert_count, threshold,
  }, pmAgentId);

  if (!row.assigned_to) return;
  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    const directive =
      `STALEMATE on task "${row.title}" (${taskId.slice(0, 8)}). ` +
      `Your submissions have been rejected ${row.revert_count} times (priority=${row.priority}, threshold=${threshold}). ` +
      `Call tracker_request_user_verdict with task_id="${taskId}", status_requested="<the status you believe is correct>", ` +
      `agent_summary="<one-paragraph recap of what you did>", and ` +
      `pm_rejection_summary="<one-paragraph recap of PM's stated objections>". ` +
      `The user will make the final call. While awaiting_user_verdict=1 the PM will leave this task alone, do not retry the rejected transition.`;
    await deliverA2AMessage({
      intent: 'ASSIGN',
      threadId: '',
      requiresResponse: true,
      payload: directive,
      toAgent: row.assigned_to,
      fromAgent: pmAgentId,
    });
  } catch (err) {
    logger.warn('Stalemate directive A2A delivery failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * tracker_validate_complete — PM-only.
 *
 * Mirrors trackerValidatePause. On valid=true, complete_validated=1
 * fires, the dependency cascade runs, and (for recurring tasks) the
 * per-run archive-and-reset path takes over instead of terminal close.
 * On valid=false, the task reverts to target_status (default
 * in_progress), revert_count++, directive A2A goes to the assigned
 * agent, maybeTriggerStalemate fires if the threshold is hit.
 */
export async function trackerValidateComplete(
  pmAgentId: string,
  args: { task_id: string; valid: boolean; reject_reason?: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status, assigned_to, priority, project_id, repeat_interval,
           next_run_at, complete_validated, result, evidence_json, goal
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; assigned_to: string | null;
    priority: string; project_id: string | null; repeat_interval: number | null;
    next_run_at: string | null; complete_validated: number;
    result: string | null; evidence_json: string | null; goal: string | null;
  } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status !== 'complete') {
    return `Error: task "${task.title}" (${taskId}) is currently status="${task.status}", not "complete". Nothing to validate.`;
  }
  if (task.complete_validated === 1) {
    return `Error: task "${task.title}" (${taskId}) is already complete_validated=1. No-op.`;
  }

  // Phase B.1: if there is a pending OVERRIDE_REQUEST on this task, the
  // agent has explicitly asked PM to make a judgment call. Validating the
  // underlying close without resolving the override leaves the override
  // queue stale and bypasses the structured ask. Refuse and direct PM to
  // tracker_override(override_request_id=..., approve=true|false).
  const pendingOverride = db.prepare(`
    SELECT id FROM task_override_requests
    WHERE task_id = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(taskId) as { id: string } | undefined;
  if (pendingOverride) {
    return (
      `Error: task "${task.title}" (${taskId.slice(0, 8)}) has a pending OVERRIDE_REQUEST (id=${pendingOverride.id.slice(0, 8)}). ` +
      `Resolve that first via tracker_override(override_request_id="${pendingOverride.id}", approve=true|false, reason="..."). ` +
      `Validating directly here would leave the override queue stale.`
    );
  }

  if (args.valid) {
    // Recurring-task branch: archive this run's result/evidence, then let
    // the scheduler's onTaskRunComplete decide whether to advance the
    // schedule (more runs) or close terminal. Previously this branch
    // used `task.next_run_at === null` to detect terminal, but the
    // scheduler doesn't null next_run_at on terminal close — so the
    // detection misfired and the PM mis-routed terminal closes through
    // the per-run reset, leaving inconsistent state. Now we just run
    // the same advance the scheduler would and observe the outcome.
    const isRecurring = task.repeat_interval !== null;

    if (isRecurring) {
      // Archive this run's result/evidence to task_log BEFORE clearing
      // them — preserves the per-run history.
      writeTaskLog({
        taskId,
        fromEntity: 'pm',
        entryKind: 'transition',
        fromStatus: 'complete',
        toStatus: 'pending-advance',
        actionTaken: `tracker_validate_complete(valid=true) — recurring per-run`,
        reason: 'PM blessed this run',
        note: task.result,
        evidenceJson: task.evidence_json,
      });
      // Clear result/evidence so the next run starts fresh.
      db.prepare(`UPDATE tasks SET result = NULL, evidence_json = NULL, updated_at = datetime('now') WHERE id = ?`).run(taskId);
      // Advance the schedule. onTaskRunComplete:
      //   - marks the running task_run row complete
      //   - increments run_count
      //   - calls calculateNextRun
      //   - sets status=on_deck + schedule_status=waiting (more runs), OR
      //     status=complete + schedule_status=completed (terminal)
      try {
        const { onTaskRunComplete } = await import('../scheduler/runner.js');
        await onTaskRunComplete(taskId, 'complete', '(PM validated this run)');
      } catch (err) {
        logger.warn('onTaskRunComplete failed during recurring validate (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
      }
      // Read back and decide which return path applies.
      const after = getTask(taskId);
      if (!after) {
        return `Error: task ${taskId} disappeared during recurring validate.`;
      }
      const wasTerminal = after.scheduleStatus === 'completed' || after.status === 'complete';
      if (wasTerminal) {
        // Terminal close: flip complete_validated=1, run dep cascade.
        db.prepare(`UPDATE tasks SET complete_validated = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
        const final = getTask(taskId);
        if (final) broadcast({ type: 'tracker:task_updated', data: final });
        try {
          const { checkDependencies } = await import('./pm-agent.js');
          checkDependencies(taskId);
        } catch (err) {
          logger.warn('checkDependencies failed after terminal recurring validate (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
        }
        try {
          checkProjectCompletion(task.project_id, pmAgentId);
        } catch { /* best-effort */ }
        logger.info('Recurring task terminal close validated by PM', { taskId, pmAgentId }, pmAgentId);
        return `[OK] Final run validated on "${task.title}" (${taskId.slice(0, 8)}). Recurring task closed terminal.`;
      }
      // Per-run advance: next run will need its own validation.
      const fresh = getTask(taskId);
      if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
      logger.info('Per-run validation success — schedule advanced', { taskId, pmAgentId, runCount: after.runCount, nextRunAt: after.nextRunAt }, pmAgentId);
      return `[OK] Per-run validation success on "${task.title}" (${taskId.slice(0, 8)}). Schedule advanced to next run at ${after.nextRunAt ?? '(unknown)'}.`;
    }

    // Terminal close path: flip complete_validated=1, run dep cascade, notify parent.
    db.prepare(`UPDATE tasks SET complete_validated = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
    // Real-time sync: complete_validated=1 cleared via direct SQL, not updateTask.
    const freshTerminal = getTask(taskId);
    if (freshTerminal) broadcast({ type: 'tracker:task_updated', data: freshTerminal });
    writeTaskLog({
      taskId,
      fromEntity: 'pm',
      entryKind: 'transition',
      fromStatus: 'complete',
      toStatus: 'complete',
      actionTaken: 'tracker_validate_complete(valid=true) — terminal',
      reason: 'PM blessed the complete',
    });
    try {
      const { checkDependencies } = await import('./pm-agent.js');
      checkDependencies(taskId);
    } catch (err) {
      logger.warn('checkDependencies failed after validate_complete (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
    // Project rollup if every sibling on the project is also validated-complete or terminal.
    try {
      checkProjectCompletion(task.project_id, pmAgentId);
    } catch { /* best-effort */ }

    logger.info('Complete validated by PM', { taskId, pmAgentId }, pmAgentId);
    return `[OK] Complete validated on "${task.title}" (${taskId}). Dependency cascade fired. Parent notified.`;
  }

  // Reject path.
  const rejectReason = (args.reject_reason ?? '').trim();
  if (!rejectReason) {
    return 'Error: reject_reason is required when valid=false. One-sentence directive for the agent (e.g. "evidence does not show field-15 was migrated; finish that field and resubmit").';
  }
  const targetStatus = args.target_status ?? 'in_progress';
  if (!ALLOWED_REJECT_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed. Use 'in_progress' (default), 'on_deck', or 'blocked'.`;
  }

  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before complete-reject could land.`;
  // Clear stale result/evidence on revert so the agent can resubmit cleanly.
  db.prepare(`
    UPDATE tasks
    SET revert_count = revert_count + 1,
        result = NULL,
        evidence_json = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);
  // updateTask broadcast with stale result/evidence/revert_count above —
  // re-broadcast so the dashboard's evidence panel reflects the cleared
  // state.
  const freshCompleteReject = getTask(taskId);
  if (freshCompleteReject) broadcast({ type: 'tracker:task_updated', data: freshCompleteReject });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'reject',
    fromStatus: 'complete',
    toStatus: targetStatus,
    actionTaken: 'tracker_validate_complete(valid=false)',
    reason: rejectReason,
  });

  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `Your complete on "${task.title}" (${taskId.slice(0, 8)}) was reverted to ${targetStatus} for a recheck — this is a routine PM check, not a penalty.\n\n` +
        `PM's reason: ${rejectReason}\n\n` +
        `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
        `To close this out: address what PM flagged, then call tracker_update_status(status='complete') again with a clear result + evidence pointing at the concrete work (file paths, tool_call_ref, output paste, external_action). You don't have to redo work that's already done — just fix the gap PM named. PM validates fast when the evidence matches the goal. revert_count=${(updated as { revertCount?: number }).revertCount ?? '(incremented)'}.`;
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: '',
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: pmAgentId,
      });
    } catch (err) {
      logger.warn('Reject directive A2A delivery failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await maybeTriggerStalemate(taskId, pmAgentId);

  logger.info('Complete rejected by PM', { taskId, pmAgentId, rejectReason, targetStatus }, pmAgentId);
  return `[OK] Complete rejected on "${task.title}" (${taskId}). Task reverted to "${targetStatus}". Reason logged: "${rejectReason}". ${task.assigned_to ? `Notified ${task.assigned_to} via send_to_agent.` : ''}`;
}

/**
 * tracker_validate_blocked — PM-only. Mirror of validate_complete for the
 * blocked transition. Bless or revert.
 */
export async function trackerValidateBlocked(
  pmAgentId: string,
  args: { task_id: string; valid: boolean; reject_reason?: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status, assigned_to, priority, blocked_validated, goal
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; assigned_to: string | null;
    priority: string; blocked_validated: number; goal: string | null;
  } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status !== 'blocked') {
    return `Error: task "${task.title}" (${taskId}) is currently status="${task.status}", not "blocked". Nothing to validate.`;
  }
  if (task.blocked_validated === 1) {
    return `Error: task "${task.title}" (${taskId}) is already blocked_validated=1. No-op.`;
  }

  if (args.valid) {
    db.prepare(`UPDATE tasks SET blocked_validated = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
    // Real-time sync: blocked_validated flag set via direct SQL.
    const freshBlocked = getTask(taskId);
    if (freshBlocked) broadcast({ type: 'tracker:task_updated', data: freshBlocked });
    writeTaskLog({
      taskId,
      fromEntity: 'pm',
      entryKind: 'transition',
      fromStatus: 'blocked',
      toStatus: 'blocked',
      actionTaken: 'tracker_validate_blocked(valid=true)',
      reason: 'PM blessed the block as real',
    });
    notifyPrimaryAgent(
      `Block validated on task "${task.title}" (${taskId.slice(0, 8)}). Real obstacle, surface to user or unblock manually.`,
      pmAgentId,
      true, // forceNotify even if PM is primary (it's not, but be safe)
    );
    logger.info('Block validated by PM', { taskId, pmAgentId }, pmAgentId);
    return `[OK] Block validated on "${task.title}" (${taskId}). Primary notified to investigate or unblock.`;
  }

  const rejectReason = (args.reject_reason ?? '').trim();
  if (!rejectReason) {
    return 'Error: reject_reason is required when valid=false. One-sentence directive (e.g. "you have not actually asked the user, do that first" or "this is a workaround not a block").';
  }
  const targetStatus = args.target_status ?? 'in_progress';
  if (!ALLOWED_REJECT_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed. Use 'in_progress' (default), 'on_deck', or 'blocked'.`;
  }

  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before block-reject could land.`;
  db.prepare(`UPDATE tasks SET revert_count = revert_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  // Re-broadcast so revert_count reaches the dashboard.
  const freshBlockReject = getTask(taskId);
  if (freshBlockReject) broadcast({ type: 'tracker:task_updated', data: freshBlockReject });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'reject',
    fromStatus: 'blocked',
    toStatus: targetStatus,
    actionTaken: 'tracker_validate_blocked(valid=false)',
    reason: rejectReason,
  });

  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `Your block on "${task.title}" (${taskId.slice(0, 8)}) was reverted to ${targetStatus} — PM didn't see a real obstacle. Routine check, not a penalty.\n\n` +
        `PM's reason: ${rejectReason}\n\n` +
        `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
        `Address what PM flagged, then either complete with result + evidence, or re-block with a clearer reason naming the specific obstacle. Don't re-block with the same notes — PM will reject again.`;
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: '',
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: pmAgentId,
      });
    } catch (err) {
      logger.warn('Block reject directive A2A delivery failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await maybeTriggerStalemate(taskId, pmAgentId);

  logger.info('Block rejected by PM', { taskId, pmAgentId, rejectReason, targetStatus }, pmAgentId);
  return `[OK] Block rejected on "${task.title}" (${taskId}). Task reverted to "${targetStatus}".`;
}

/**
 * tracker_request_override — agent-side. Queues a request for PM (or
 * the user via dashboard) to manually force a status change that the
 * engine's hard gate refused, or that the agent thinks should land
 * despite a PM rejection.
 *
 * Rate limit: at most one pending request per (task, agent). A second
 * call while one is still pending returns an error referencing the
 * prior request id.
 *
 * Also called by the engine when the hard-gate circuit-breaker fires
 * (3 consecutive same-task hard-gate rejections by the same agent).
 */
export function trackerRequestOverride(
  agentId: string,
  args: { task_id: string; requested_status: string; justification: string },
): string {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const requestedStatus = (args.requested_status ?? '').trim();
  if (!requestedStatus) return 'Error: requested_status is required.';

  const justification = (args.justification ?? '').trim();
  if (justification.length < 30) {
    return 'Error: justification must be at least 30 characters. Explain in one sentence why the engine was wrong or why PM should reconsider (e.g. "tool_call id from 3 days ago, audit log rotated, artifact at /tmp/foo.sh still exists and was created by the call").';
  }

  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM task_override_requests
    WHERE task_id = ? AND requested_by = ? AND status = 'pending'
    LIMIT 1
  `).get(taskId, agentId) as { id: string } | undefined;
  if (existing) {
    return `Error: you already have a pending override request on this task (id=${existing.id.slice(0, 8)}). Wait for PM to resolve it before requesting again.`;
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO task_override_requests
      (id, task_id, requested_by, requested_status, justification, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).run(id, taskId, agentId, requestedStatus, justification);

  writeTaskLog({
    taskId,
    fromEntity: `agent:${agentId}`,
    entryKind: 'override',
    actionTaken: 'tracker_request_override',
    reason: justification,
    toStatus: requestedStatus,
  });

  logger.info('Override request queued', { taskId, agentId, requestedStatus, requestId: id }, agentId);
  return `[OK] override request queued (id=${id.slice(0, 8)}). PM will review on next tick. If no resolution within 12 hours the request auto-denies.`;
}

/**
 * tracker_override — PM-only. Resolves a queued OVERRIDE_REQUEST by
 * either approving (force the requested status through, bypassing the
 * engine hard gate) or denying (the engine was right; notify the
 * agent).
 *
 * Distinct from PM bare tracker_update_status: bare update_status is
 * proactive PM action with no pending request. Override resolves an
 * explicit ask.
 */
export async function trackerOverride(
  pmAgentId: string,
  args: { override_request_id: string; approve: boolean; reason: string },
): Promise<string> {
  const requestId = (args.override_request_id ?? '').trim();
  if (!requestId) return 'Error: override_request_id is required.';

  const reason = (args.reason ?? '').trim();
  if (!reason) return 'Error: reason is required (one sentence on why you approved or denied).';

  const db = getDb();
  const req = db.prepare(`
    SELECT id, task_id, requested_by, requested_status, justification, status
    FROM task_override_requests WHERE id = ? OR id LIKE ?
    LIMIT 1
  `).get(requestId, `${requestId}%`) as {
    id: string; task_id: string; requested_by: string;
    requested_status: string; justification: string; status: string;
  } | undefined;

  if (!req) return `Error: override request ${requestId} not found.`;
  if (req.status !== 'pending') {
    return `Error: override request ${req.id.slice(0, 8)} is already ${req.status}, cannot resolve again.`;
  }

  if (args.approve) {
    // Force the status through (bypass engine hard gate).
    const updated = updateTask(req.task_id, { status: req.requested_status });
    if (!updated) return `Error: task ${req.task_id} was deleted before override approval could land.`;
    // Override approval is authoritative: set the matching *_validated
    // flag so PM doesn't re-surface this row as unvalidated. Clear
    // revert_count and awaiting_user_verdict too.
    db.prepare(`
      UPDATE tasks
      SET revert_count = 0,
          awaiting_user_verdict = 0,
          user_verdict_requested_at = NULL,
          complete_validated = CASE WHEN ? = 'complete' THEN 1 ELSE complete_validated END,
          pause_validated = CASE WHEN ? = 'paused' THEN 1 ELSE pause_validated END,
          blocked_validated = CASE WHEN ? = 'blocked' THEN 1 ELSE blocked_validated END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.requested_status, req.requested_status, req.requested_status, req.task_id);
    // updateTask broadcast above with only the status flip — re-broadcast
    // so revert_count=0 and the matching *_validated flag reach the dashboard.
    const freshOverride = getTask(req.task_id);
    if (freshOverride) broadcast({ type: 'tracker:task_updated', data: freshOverride });
    db.prepare(`
      UPDATE task_override_requests
      SET status = 'approved', resolved_by = ?, resolved_reason = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(pmAgentId, reason, req.id);

    writeTaskLog({
      taskId: req.task_id,
      fromEntity: 'pm',
      entryKind: 'override',
      toStatus: req.requested_status,
      actionTaken: 'tracker_override(approve=true)',
      reason,
    });

    logger.info('Override approved by PM', { taskId: req.task_id, pmAgentId, requestId: req.id }, pmAgentId);
    return `[OK] override approved. Task ${req.task_id.slice(0, 8)} forced to "${req.requested_status}". Reason: ${reason}.`;
  }

  // Deny path: leave the task where it is, notify the agent.
  db.prepare(`
    UPDATE task_override_requests
    SET status = 'denied', resolved_by = ?, resolved_reason = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(pmAgentId, reason, req.id);
  writeTaskLog({
    taskId: req.task_id,
    fromEntity: 'pm',
    entryKind: 'override',
    actionTaken: 'tracker_override(approve=false)',
    reason: `denied: ${reason}`,
  });
  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: '',
      requiresResponse: true,
      payload: `Your override request on task ${req.task_id.slice(0, 8)} was denied by the PM. Reason: ${reason}. The engine's original objection stands; address it and resubmit cleanly.`,
      toAgent: req.requested_by,
      fromAgent: pmAgentId,
    });
  } catch (err) {
    logger.warn('Override deny notification failed (non-fatal)', { taskId: req.task_id, error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('Override denied by PM', { taskId: req.task_id, pmAgentId, requestId: req.id }, pmAgentId);
  return `[OK] override denied. Task left as-is. Agent notified.`;
}

/**
 * tracker_request_user_verdict — assigned-agent-side, only callable
 * while awaiting_user_verdict=1. Composes a user-facing message
 * describing the stalemate and routes it.
 */
export async function trackerRequestUserVerdict(
  agentId: string,
  args: { task_id: string; status_requested: string; agent_summary: string; pm_rejection_summary: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const statusRequested = (args.status_requested ?? '').trim();
  if (!statusRequested) return 'Error: status_requested is required (the status you believe is correct).';
  const agentSummary = (args.agent_summary ?? '').trim();
  if (agentSummary.length < 30) return 'Error: agent_summary must be at least 30 characters (a one-paragraph recap of what you did).';
  const pmRejectionSummary = (args.pm_rejection_summary ?? '').trim();
  if (pmRejectionSummary.length < 20) return 'Error: pm_rejection_summary must be at least 20 characters (one-paragraph recap of PM\'s stated objections).';

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, assigned_to, goal, awaiting_user_verdict
    FROM tasks WHERE id = ?
  `).get(taskId) as { id: string; title: string; assigned_to: string | null; goal: string | null; awaiting_user_verdict: number } | undefined;
  if (!task) return `Error: task ${taskId} not found.`;
  if (task.awaiting_user_verdict !== 1) {
    return `Error: task ${taskId.slice(0, 8)} is not awaiting_user_verdict. This tool is only callable when the engine has flagged a stalemate.`;
  }
  if (task.assigned_to !== agentId) {
    return `Error: only the assigned agent (${task.assigned_to}) can request a user verdict on this task.`;
  }

  const userMessage =
    `Task "${task.title}" has stalled. Asking for your verdict.\n\n` +
    `Goal: ${task.goal ?? '(no goal recorded)'}\n\n` +
    `What I did: ${agentSummary}\n\n` +
    `PM rejected because: ${pmRejectionSummary}\n\n` +
    `My request: mark this "${statusRequested}". ` +
    `Your reply is the final call. ` +
    `Options: "complete" / "send it back" / "blocked" / "paused" / "I don't care, you decide".`;

  writeTaskLog({
    taskId,
    fromEntity: `agent:${agentId}`,
    entryKind: 'user_verdict_request',
    actionTaken: 'tracker_request_user_verdict composed and routed',
    note: userMessage,
    toStatus: statusRequested,
  });

  // Routing: if the assigned agent is the primary, the message goes
  // straight into the user chat via notifyPrimaryAgent (forceNotify=true).
  // Otherwise relay via A2A to the primary agent.
  try {
    if (isPrimaryAgent(agentId)) {
      // Use the existing primary notification path. notifyPrimaryAgent
      // suppresses self-notifications by default; forceNotify=true wakes
      // the primary's chat for the user.
      notifyPrimaryAgent(`[user verdict requested] ${userMessage}`, agentId, true);
    } else {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const relayPayload =
        `Please relay to David: a stalemate has been flagged on task "${task.title}" (${taskId.slice(0, 8)}) ` +
        `assigned to me (${agentId}). The user verdict request follows. Show this verbatim to David in chat and ` +
        `then call tracker_apply_user_verdict(task_id="${taskId}", status="<david's choice>", user_quote="<his exact reply>") on my behalf.\n\n` +
        userMessage;
      await deliverA2AMessage({
        intent: 'ASSIGN',
        threadId: '',
        requiresResponse: true,
        payload: relayPayload,
        toAgent: getPrimaryAgentId(),
        fromAgent: agentId,
      });
    }
  } catch (err) {
    logger.warn('User verdict request routing failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('User verdict requested', { taskId, agentId, statusRequested }, agentId);
  return `[OK] user verdict requested on task ${taskId.slice(0, 8)}. The user will reply. While awaiting, do not retry the rejected transition.`;
}

/**
 * tracker_apply_user_verdict — the receiving agent (primary if relayed,
 * assigned agent if it owns the user chat) calls this with the user's
 * reply to land the final decision.
 */
export async function trackerApplyUserVerdict(
  agentId: string,
  args: { task_id: string; status: string; user_quote: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const status = (args.status ?? '').trim();
  if (!status) return 'Error: status is required (the status the user chose).';
  const userQuote = (args.user_quote ?? '').trim();
  if (!userQuote) return 'Error: user_quote is required (the user\'s exact reply, for audit).';

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status as current_status, awaiting_user_verdict, project_id
    FROM tasks WHERE id = ?
  `).get(taskId) as { id: string; title: string; current_status: string; awaiting_user_verdict: number; project_id: string | null } | undefined;
  if (!task) return `Error: task ${taskId} not found.`;
  if (task.awaiting_user_verdict !== 1) {
    return `Error: task ${taskId.slice(0, 8)} is not awaiting_user_verdict. Apply only works on stalemate-flagged tasks.`;
  }

  // Force the status, clear the stalemate flag, validate immediately
  // (user is the ultimate authority). updateTask handles is_paused etc.
  const updated = updateTask(taskId, { status });
  if (!updated) return `Error: task ${taskId} was deleted before user verdict could land.`;

  db.prepare(`
    UPDATE tasks
    SET awaiting_user_verdict = 0,
        user_verdict_requested_at = NULL,
        revert_count = 0,
        complete_validated = CASE WHEN ? = 'complete' THEN 1 ELSE complete_validated END,
        blocked_validated = CASE WHEN ? = 'blocked' THEN 1 ELSE blocked_validated END,
        pause_validated = CASE WHEN ? = 'paused' THEN 1 ELSE pause_validated END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, status, status, taskId);
  // updateTask broadcast the status flip above — re-broadcast so the
  // dashboard sees the validated flag flip and the stalemate clear.
  const freshUserVerdict = getTask(taskId);
  if (freshUserVerdict) broadcast({ type: 'tracker:task_updated', data: freshUserVerdict });

  writeTaskLog({
    taskId,
    fromEntity: 'user',
    entryKind: 'user_verdict_applied',
    fromStatus: task.current_status,
    toStatus: status,
    actionTaken: `applied via ${agentId}`,
    reason: 'user verdict',
    note: userQuote,
  });

  // Cascade if user chose 'complete'.
  if (status === 'complete') {
    try {
      const { checkDependencies } = await import('./pm-agent.js');
      checkDependencies(taskId);
    } catch { /* best-effort */ }
    try {
      checkProjectCompletion(task.project_id, agentId);
    } catch { /* best-effort */ }
  }

  logger.info('User verdict applied', { taskId, agentId, status }, agentId);
  return `[OK] user verdict applied on "${task.title}" (${taskId.slice(0, 8)}). Status="${status}". Quote logged. Stalemate cleared.`;
}
