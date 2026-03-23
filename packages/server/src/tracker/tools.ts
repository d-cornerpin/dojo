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
  addTaskNotes,
} from './schema.js';
import { ensurePMAgentRunning } from './pm-agent.js';
import { calculateNextRun } from '../scheduler/engine.js';
import { onTaskRunComplete } from '../scheduler/runner.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, isPrimaryAgent, getOwnerName } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';

const logger = createLogger('tracker-tools');

// ── Notify primary agent of task/project completion ──

function notifyPrimaryAgent(message: string, callingAgentId: string, forceNotify = false): void {
  const primaryId = getPrimaryAgentId();
  // Don't notify if the primary agent is the one completing the task (unless forced)
  if (isPrimaryAgent(callingAgentId) && !forceNotify) return;

  try {
    const db = getDb();
    const msgId = uuidv4();
    const content = `[Task Update] ${message}`;
    db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(msgId, primaryId, content);

    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: msgId,
        agentId: primaryId,
        role: 'user' as const,
        content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    // Wake up the primary agent's runtime so it actually processes this message
    const runtime = getAgentRuntime();
    runtime.handleMessage(primaryId, content).catch(err => {
      logger.error('Failed to wake primary agent for task notification', {
        error: err instanceof Error ? err.message : String(err),
      });
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
        // Force-notify Kevin even if he's the one who spawned the completing agent
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

    return `Project created successfully.\nProject ID: ${result.projectId}\nTitle: ${title}${taskSummary}\n\nUse tracker_complete_step(task_id="<full task ID>") to mark steps complete.`;
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
    const assignedTo = (args.assignedTo as string | undefined) ?? agentId;
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
    });

    // Auto-set to in_progress if assigned to an agent and not scheduled
    const scheduledStart = args.scheduled_start as string | undefined;
    if (assignedTo && !scheduledStart) {
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
      };
      const nextRun = calculateNextRun(taskForCalc) ?? scheduledStart;

      db.prepare(`
        UPDATE tasks SET
          scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
          repeat_end_type = ?, repeat_end_value = ?,
          next_run_at = ?, schedule_status = 'waiting',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(scheduledStart, repeatInterval ?? null, repeatUnit ?? null, repeatEndType, repeatEndValue ?? null, nextRun, taskId);
    }

    // Handle group assignment
    const assignedToGroup = args.assigned_to_group as string | undefined;
    if (assignedToGroup) {
      const db = getDb();
      db.prepare("UPDATE tasks SET assigned_to_group = ?, assigned_to = NULL, updated_at = datetime('now') WHERE id = ?").run(assignedToGroup, taskId);
    }

    const parts = [
      `Task created successfully.`,
      `Task ID: ${taskId}`,
      `Title: ${title}`,
    ];
    if (projectId) parts.push(`Project: ${projectId}`);
    if (assignedTo) parts.push(`Assigned to: ${assignedTo}`);
    if (assignedToGroup) parts.push(`Assigned to group: ${assignedToGroup}`);
    if (priority) parts.push(`Priority: ${priority}`);
    if (scheduledStart) parts.push(`Scheduled: ${scheduledStart}`);

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCreateTask failed', { error: msg }, agentId);
    return `Error creating task: ${msg}`;
  }
}

// ── trackerUpdateStatus ──

export function trackerUpdateStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const taskId = args.taskId as string;
    if (!taskId) return 'Error: taskId is required';

    const status = args.status as string | undefined;
    const assignedTo = args.assignedTo as string | undefined;
    const priority = args.priority as string | undefined;

    if (!status && !assignedTo && !priority) {
      return 'Error: at least one of status, assignedTo, or priority must be provided';
    }

    // Check if this is a scheduled recurring task
    const db = getDb();
    const taskRow = db.prepare('SELECT schedule_status, repeat_interval FROM tasks WHERE id = ?').get(taskId) as { schedule_status: string; repeat_interval: number | null } | undefined;
    const isScheduledRecurring = taskRow && taskRow.schedule_status !== 'unscheduled' && taskRow.repeat_interval;

    const updates: Record<string, string> = {};
    if (status) updates.status = status;
    if (assignedTo) updates.assignedTo = assignedTo;
    if (priority) updates.priority = priority;

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

      notifyPrimaryAgent(
        `Task "${updatedTask.title}" run completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId}. Run ${updatedTask.runCount}${updatedTask.nextRunAt ? `, next run: ${new Date(updatedTask.nextRunAt).toLocaleString()}` : ' (no more runs)'}.${notes ? ` Notes: ${notes}` : ''}`,
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
        updatedTask.nextRunAt ? `Next run: ${new Date(updatedTask.nextRunAt).toLocaleString()}` : 'All runs finished — task complete.',
      ];
      return parts.join('\n');
    }

    const task = updateTask(taskId, updates);

    if (!task) {
      return `Task ${taskId} was deleted while being updated.`;
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
      `Task updated successfully.`,
      `Task: ${task.title} (${task.id})`,
      `Status: ${task.status}`,
    ];
    if (task.assignedTo) parts.push(`Assigned to: ${task.assignedToName ?? task.assignedTo}`);
    parts.push(`Priority: ${task.priority}`);

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
    const taskId = args.taskId as string;
    if (!taskId) return 'Error: taskId is required';

    const notes = args.notes as string;
    if (!notes) return 'Error: notes is required';

    addTaskNotes(taskId, notes);

    return `Notes added to task ${taskId}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerAddNotes failed', { error: msg }, agentId);
    return `Error adding notes: ${msg}`;
  }
}

// ── trackerGetStatus ──

export function trackerGetStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const taskId = args.taskId as string | undefined;
    const projectId = args.projectId as string | undefined;

    if (taskId) {
      const task = getTask(taskId);
      if (!task) return `Task not found: ${taskId}`;

      const parts = [
        `Task: ${task.title}`,
        `ID: ${task.id}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
      ];
      if (task.projectId) parts.push(`Project: ${task.projectId}`);
      if (task.assignedTo) parts.push(`Assigned to: ${task.assignedTo}`);
      if (task.description) parts.push(`Description: ${task.description}`);
      if (task.stepNumber !== null) parts.push(`Step: ${task.stepNumber}${task.totalSteps ? ` of ${task.totalSteps}` : ''}`);
      if (task.dependsOn.length > 0) parts.push(`Depends on: ${task.dependsOn.join(', ')}`);
      if (task.notes) parts.push(`\nNotes:\n${task.notes}`);
      parts.push(`Created: ${task.createdAt}`);
      parts.push(`Updated: ${task.updatedAt}`);
      if (task.completedAt) parts.push(`Completed: ${task.completedAt}`);

      return parts.join('\n');
    }

    if (projectId) {
      const project = getProject(projectId);
      if (!project) return `Project not found: ${projectId}`;

      const parts = [
        `Project: ${project.title}`,
        `ID: ${project.id}`,
        `Status: ${project.status}`,
        `Phase: ${project.currentPhase}/${project.phaseCount}`,
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
    const parts: string[] = [];

    if (scope === 'projects' || scope === 'all') {
      const projects = listProjects({ status: 'active' });
      if (projects.length > 0) {
        parts.push(`Active Projects (${projects.length}):`);
        for (const p of projects) {
          parts.push(`  [${p.id.slice(0, 8)}] ${p.title} (phase ${p.currentPhase}/${p.phaseCount})`);
        }
      } else {
        parts.push('No active projects.');
      }
    }

    if (scope === 'tasks' || scope === 'all') {
      const inProgress = listTasks({ status: 'in_progress' });
      const pending = listTasks({ status: 'on_deck' });
      const blocked = listTasks({ status: 'blocked' });

      if (inProgress.length > 0) {
        parts.push('');
        parts.push(`In Progress Tasks (${inProgress.length}):`);
        for (const t of inProgress) {
          const assignee = t.assignedTo ? ` [${t.assignedTo}]` : ' [unassigned]';
          parts.push(`  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`);
        }
      }

      if (pending.length > 0) {
        parts.push('');
        parts.push(`On Deck Tasks (${pending.length}):`);
        for (const t of pending.slice(0, 10)) {
          const assignee = t.assignedTo ? ` [${t.assignedTo}]` : ' [unassigned]';
          parts.push(`  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`);
        }
        if (pending.length > 10) {
          parts.push(`  ... and ${pending.length - 10} more`);
        }
      }

      if (blocked.length > 0) {
        parts.push('');
        parts.push(`Blocked Tasks (${blocked.length}):`);
        for (const t of blocked) {
          const assignee = t.assignedTo ? ` [${t.assignedTo}]` : ' [unassigned]';
          parts.push(`  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`);
        }
      }

      if (inProgress.length === 0 && pending.length === 0 && blocked.length === 0) {
        parts.push('');
        parts.push('No active tasks.');
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
    const taskId = args.taskId as string ?? args.task_id as string;
    if (!taskId) return 'Error: task_id is required';

    const notes = args.notes as string | undefined;
    const db = getDb();

    // Get the completed task
    const task = getTask(taskId);
    if (!task) return `Error: Task ${taskId} not found`;

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
    return `Step completed: "${task.title}" marked as complete.${nextTaskInfo}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCompleteStep failed', { error: msg }, agentId);
    return `Error completing step: ${msg}`;
  }
}

// ── trackerPauseSchedule ──

export function trackerPauseSchedule(agentId: string, args: Record<string, unknown>): string {
  const taskId = args.taskId as string;
  if (!taskId) return 'Error: taskId is required';
  const markComplete = (args.mark_complete as boolean) ?? false;

  const db = getDb();
  const task = db.prepare('SELECT id, title, schedule_status, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; title: string; schedule_status: string; project_id: string } | undefined;
  if (!task) return `Error: Task not found: ${taskId}`;
  if (task.schedule_status === 'unscheduled') return `Error: Task "${task.title}" is not scheduled`;

  if (markComplete) {
    // Stop the schedule AND mark the task as complete (terminal state)
    db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'completed', status = 'complete', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
    db.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = 'Schedule stopped and marked complete' WHERE task_id = ? AND status = 'running'").run(taskId);
    logger.info('Schedule paused and task marked complete', { taskId }, agentId);
    checkProjectCompletion(task.project_id, agentId);
    return `Schedule stopped and task "${task.title}" marked complete.`;
  }

  db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'paused', updated_at = datetime('now') WHERE id = ?").run(taskId);
  logger.info('Schedule paused', { taskId }, agentId);
  return `Schedule paused for "${task.title}". It won't run again until resumed. NOTE: Task is still in "on_deck" status — if the work is already done, use mark_complete: true to finalize it.`;
}

// ── trackerResumeSchedule ──

export function trackerResumeSchedule(agentId: string, args: Record<string, unknown>): string {
  const taskId = args.taskId as string;
  if (!taskId) return 'Error: taskId is required';

  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task not found: ${taskId}`;

  
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
  };

  const nextRun = calculateNextRun(scheduledTask);
  db.prepare("UPDATE tasks SET is_paused = 0, schedule_status = 'waiting', next_run_at = ?, updated_at = datetime('now') WHERE id = ?").run(nextRun, taskId);

  logger.info('Schedule resumed', { taskId, nextRun }, agentId);
  return `Schedule resumed for "${task.title as string}". Next run: ${nextRun ?? 'none'}`;
}
