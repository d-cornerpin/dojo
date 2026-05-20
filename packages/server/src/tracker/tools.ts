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
  addTaskNotes,
  resolveTaskId,
  resolveProjectId,
  formatResolveError,
  closeProjectAndOpenTasks,
} from './schema.js';
import { ensurePMAgentRunning } from './pm-agent.js';
import { injectTaskAssignmentNotification } from './notify.js';
import { calculateNextRun, type ScheduledTask } from '../scheduler/engine.js';
import { onTaskRunComplete } from '../scheduler/runner.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, isPrimaryAgent, getOwnerName } from '../config/platform.js';
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

        const ownerName = getOwnerName();
        // Force-notify the primary agent even if they spawned the completing agent
        notifyPrimaryAgent(
          `Project "${project.title}" is complete! All ${tasks.length} tasks finished.\n\nResults:\n${summary}\n\nPlease review the results and let ${ownerName} know. If you spawned agent groups for this project, clean them up with delete_group(group_id, terminate_members=true).`,
          callingAgentId,
          true, // force notify even if primary agent triggered
        );

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
      assignedTo?: string;
      priority?: 'high' | 'normal' | 'low';
      stepNumber?: number;
      dependsOn?: string[];
      phase?: number;
    }> | undefined;

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

    // Status reconciliation against the schema default (createTask sets a
    // self-assigned task to 'in_progress' automatically). v2.3.13:
    //   - hasSchedule → force back to 'on_deck' so the scheduler owns the
    //     transition to in_progress at fire time. Without this override
    //     scheduled self-assigned tasks were landing in_progress
    //     immediately, silently bypassing the scheduler.
    //   - no schedule + assigned to someone else → bump to in_progress
    //     (schema default for that case is on_deck).
    //   - no schedule + self-assigned → leave the schema default alone.
    let scheduledStart = args.scheduled_start as string | undefined;
    if (scheduledStart) {
      try {
        const parsed = new Date(scheduledStart);
        if (!isNaN(parsed.getTime())) {
          scheduledStart = parsed.toISOString();
        }
      } catch { /* keep original if parse fails */ }
    }
    const hasSchedule = !!(scheduledStart || args.repeat_interval);
    if (hasSchedule) {
      try {
        updateTask(taskId, { status: 'on_deck' });
      } catch { /* ignore */ }
    } else if (assignedTo && assignedTo !== agentId) {
      try {
        updateTask(taskId, { status: 'in_progress' });
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
    if (assignedTo && !hasSchedule) {
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

    // Check if this is a scheduled recurring task
    const db = getDb();
    const taskRow = db.prepare('SELECT schedule_status, repeat_interval FROM tasks WHERE id = ?').get(taskId) as { schedule_status: string; repeat_interval: number | null } | undefined;
    const isScheduledRecurring = taskRow && taskRow.schedule_status !== 'unscheduled' && taskRow.repeat_interval;

    const updates: Record<string, string | null> = {};
    if (status) updates.status = status;
    if (assignedTo) updates.assignedTo = assignedTo;
    if (priority) updates.priority = priority;

    // Pass resume_at through for timed pauses
    const resumeAt = args.resume_at as string | undefined;
    if (status === 'paused' && resumeAt) {
      updates.pausedUntil = resumeAt;
    }

    // For recurring tasks being marked complete
    if (status === 'complete' && isScheduledRecurring) {
      const notes = args.notes as string | undefined;
      const completeAllRuns = (args.complete_all_runs as boolean) ?? false;

      if (completeAllRuns) {
        // Agent says ALL work is done — stop the entire repeat cycle immediately
        // This handles the case where an agent completed multiple iterations internally
        db.prepare("UPDATE tasks SET status = 'complete', schedule_status = 'completed', is_paused = 1, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
        db.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = ? WHERE task_id = ? AND status = 'running'").run(notes ?? 'All runs completed by agent', taskId);
        const updatedTask = getTask(taskId)!;
        notifyPrimaryAgent(
          `Recurring task "${updatedTask.title}" fully completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId} (all runs done).${notes ? ` Notes: ${notes}` : ''}`,
          agentId,
        );
        checkProjectCompletion(updatedTask.projectId, agentId);
        return `Recurring task "${updatedTask.title}" fully completed. Schedule stopped. All runs marked done.`;
      }

      // Normal path: complete the current run, let onTaskRunComplete decide about next run
      onTaskRunComplete(taskId, 'complete', notes ?? '');
      const updatedTask = getTask(taskId)!;

      const nextRunFmt = updatedTask.nextRunAt ? formatTimeForAgent(updatedTask.nextRunAt) : null;
      notifyPrimaryAgent(
        `Task "${updatedTask.title}" run completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId}. Run ${updatedTask.runCount}${nextRunFmt ? `, next run: ${nextRunFmt}` : ' (no more runs)'}.${notes ? ` Notes: ${notes}` : ''}`,
        agentId,
      );

      if (!updatedTask.nextRunAt) {
        updateTask(taskId, { status: 'complete' });
        checkProjectCompletion(updatedTask.projectId, agentId);
      }

      const parts = [
        `Run completed for recurring task.`,
        `Task: ${updatedTask.title} (${updatedTask.id})`,
        `Runs completed: ${updatedTask.runCount}`,
        nextRunFmt ? `Next run: ${nextRunFmt}` : 'All runs finished — task complete.',
      ];
      return parts.join('\n');
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

    // Notify primary agent when a task completes
    if (status === 'complete') {
      const notes = args.notes as string | undefined;
      notifyPrimaryAgent(
        `Task "${task.title}" completed by ${task.assignedToName ?? task.assignedTo ?? agentId}.${notes ? ` Notes: ${notes}` : ''}`,
        agentId,
      );
      // Handle one-time scheduled task completion
      try {
        onTaskRunComplete(taskId, 'complete', notes ?? '');
      } catch { /* not a scheduled task */ }
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

export function trackerAddNotes(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    const notes = args.notes as string;
    if (!notes) return 'Error: notes is required';

    addTaskNotes(taskId, notes);

    return `[OK] task_id=${taskId}\n\nNotes added successfully.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerAddNotes failed', { error: msg }, agentId);
    return `Error adding notes: ${msg}`;
  }
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

    const editableKeys = [
      title, description, dependsOn, stepNumber, phase,
      scheduledStart, repeatInterval, repeatUnit, repeatEndType, repeatEndValue,
      repeatDaysOfWeek, anchorTime,
      priority, notes,
    ];
    if (editableKeys.every(v => v === undefined)) {
      return 'Error: at least one editable field must be provided. Editable: title, description, depends_on, step_number, phase, scheduled_start, repeat_interval, repeat_unit, repeat_end_type, repeat_end_value, repeat_days_of_week, anchor_time, priority, notes. (For status changes use tracker_update_status; for assignee changes use tracker_reassign_task; for pause/resume use tracker_pause_schedule.)';
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
    logger.info('Schedule paused and task marked complete', { taskId }, agentId);
    checkProjectCompletion(task.project_id, agentId);
    return `Schedule stopped and task "${task.title}" marked complete.`;
  }

  db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'paused', status = 'paused', updated_at = datetime('now') WHERE id = ?").run(taskId);
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
