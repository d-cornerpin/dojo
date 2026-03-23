// ════════════════════════════════════════
// Task Scheduler Runner (Phase 6)
// Checks for due tasks and triggers execution
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { calculateNextRun, type ScheduledTask } from './engine.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { getPrimaryAgentId, getPMAgentId } from '../config/platform.js';

const logger = createLogger('scheduler');

// ── Pick available agent from group ──

export function pickAvailableAgentFromGroup(groupId: string): string | null {
  const db = getDb();
  const agents = db.prepare(`
    SELECT id FROM agents
    WHERE group_id = ? AND status IN ('idle', 'working') AND classification != 'sensei'
    ORDER BY
      CASE status WHEN 'idle' THEN 0 ELSE 1 END,
      (SELECT COUNT(*) FROM tasks WHERE assigned_to = agents.id AND status = 'in_progress') ASC
  `).all(groupId) as Array<{ id: string }>;

  return agents.length > 0 ? agents[0].id : null;
}

// ── Check and trigger due tasks ──

export async function checkScheduledTasks(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  // ── Orphan cleanup: tasks stuck in 'running' whose assigned agent is terminated ──
  cleanupOrphanedRuns();

  const dueTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE next_run_at <= ?
      AND schedule_status = 'waiting'
      AND is_paused = 0
    ORDER BY next_run_at ASC
  `).all(now) as Array<Record<string, unknown>>;

  if (dueTasks.length === 0) return;

  logger.info(`Scheduler: ${dueTasks.length} task(s) due`, { count: dueTasks.length });

  for (const taskRow of dueTasks) {
    const taskId = taskRow.id as string;
    const runCount = (taskRow.run_count as number) ?? 0;
    const runNumber = runCount + 1;

    // Check dependencies — skip if any dependency isn't complete
    const dependsOnRaw = taskRow.depends_on as string | null;
    if (dependsOnRaw) {
      try {
        const deps = JSON.parse(dependsOnRaw) as string[];
        if (deps.length > 0) {
          const incomplete = deps.filter(depId => {
            const dep = db.prepare('SELECT status FROM tasks WHERE id = ?').get(depId) as { status: string } | undefined;
            return !dep || dep.status !== 'complete';
          });
          if (incomplete.length > 0) {
            logger.info('Scheduler: task has unmet dependencies, skipping', { taskId, incomplete });
            // Push next_run_at forward by 30 seconds so we re-check soon
            db.prepare("UPDATE tasks SET next_run_at = datetime('now', '+30 seconds') WHERE id = ?").run(taskId);
            continue;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    const runId = uuidv4();

    // 1. Create run instance
    db.prepare(`
      INSERT INTO task_runs (id, task_id, run_number, scheduled_for, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
    `).run(runId, taskId, runNumber, taskRow.next_run_at as string);

    // 2. Determine who runs it
    let assignedAgent = taskRow.assigned_to as string | null;
    const assignedGroup = taskRow.assigned_to_group as string | null;

    if (assignedGroup && !assignedAgent) {
      assignedAgent = pickAvailableAgentFromGroup(assignedGroup);
      if (!assignedAgent) {
        // No agent available — notify primary agent
        const primaryId = getPrimaryAgentId();
        const groupName = (db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(assignedGroup) as { name: string } | undefined)?.name ?? assignedGroup;
        sendAgentMessage(getPMAgentId(), primaryId, 'status',
          `No available agents in group "${groupName}" for scheduled task "${taskRow.title}". Task run #${runNumber} skipped.`, {
            taskId, runId, event: 'no_agent_available',
          });
        // Mark run as skipped
        db.prepare("UPDATE task_runs SET status = 'skipped', error = 'No available agent in group' WHERE id = ?").run(runId);
        continue;
      }
    }

    if (!assignedAgent) {
      assignedAgent = getPrimaryAgentId();
    }

    // Check if assigned agent is alive — if terminated, reassign to primary
    const agentStatus = db.prepare('SELECT status FROM agents WHERE id = ?').get(assignedAgent) as { status: string } | undefined;
    if (!agentStatus || agentStatus.status === 'terminated') {
      logger.warn('Scheduler: assigned agent is terminated, reassigning to primary', { taskId, assignedAgent });
      assignedAgent = getPrimaryAgentId();
    }

    // 3. Update task status
    db.prepare(`
      UPDATE tasks SET schedule_status = 'running', last_run_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(now, taskId);

    // 4. Update run instance
    db.prepare(`
      UPDATE task_runs SET status = 'running', started_at = ?, assigned_to = ? WHERE id = ?
    `).run(now, assignedAgent, runId);

    // 5. Trigger execution
    const taskTitle = taskRow.title as string;
    const taskDesc = taskRow.description as string | null;
    const totalRuns = taskRow.repeat_end_value ? ` of ${taskRow.repeat_end_value}` : '';
    const message = `[Scheduled Task — Run #${runNumber}${totalRuns}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nIMPORTANT: Execute this task ONCE for this run only. Do NOT loop or repeat internally — the scheduler handles repetition. When this single run is finished, call tracker_update_status with task_id="${taskId}" and status="complete".`;

    // Inject as user message and trigger runtime
    const msgId = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(msgId, assignedAgent, `[${getPMAgentId()} — Scheduler] ${message}`);

    broadcast({
      type: 'chat:message',
      agentId: assignedAgent,
      message: {
        id: msgId,
        agentId: assignedAgent,
        role: 'user' as const,
        content: `[${getPMAgentId()} — Scheduler] ${message}`,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    // Trigger agent runtime
    const runtime = getAgentRuntime();
    runtime.handleMessage(assignedAgent, message).catch(err => {
      logger.error('Scheduler: failed to trigger agent', {
        taskId, runId, assignedAgent,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    broadcast({ type: 'task:run_started', data: { taskId, runId, agentId: assignedAgent } } as never);

    logger.info('Scheduler: task triggered', { taskId, taskTitle, runId, runNumber, assignedAgent });
  }
}

// ── Called when a task run completes ──

export async function onTaskRunComplete(taskId: string, status: string, summary: string): Promise<void> {
  const db = getDb();

  // Find the latest running run for this task
  const run = db.prepare(`
    SELECT * FROM task_runs WHERE task_id = ? AND status = 'running' ORDER BY run_number DESC LIMIT 1
  `).get(taskId) as Record<string, unknown> | undefined;

  if (!run) {
    // No active run — might be a non-scheduled task, just return
    return;
  }

  const runId = run.id as string;
  const now = new Date().toISOString();

  // Update run
  db.prepare(`
    UPDATE task_runs SET status = ?, completed_at = ?, result_summary = ? WHERE id = ?
  `).run(status, now, summary, runId);

  // Update task run count
  db.prepare('UPDATE tasks SET run_count = run_count + 1, updated_at = datetime(\'now\') WHERE id = ?').run(taskId);

  // Get updated task
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
  const scheduledTask: ScheduledTask = {
    id: task.id as string,
    scheduled_start: task.scheduled_start as string | null,
    repeat_interval: task.repeat_interval as number | null,
    repeat_unit: task.repeat_unit as string | null,
    repeat_end_type: task.repeat_end_type as string | null,
    repeat_end_value: task.repeat_end_value as string | null,
    run_count: (task.run_count as number) ?? 0,
    is_paused: (task.is_paused as number) ?? 0,
    last_run_at: now,
    next_run_at: task.next_run_at as string | null,
    schedule_status: task.schedule_status as string,
  };

  const nextRun = calculateNextRun(scheduledTask);

  if (nextRun) {
    // Recurring: set next run, go back to waiting, reset task status to on_deck
    db.prepare(`
      UPDATE tasks SET next_run_at = ?, schedule_status = 'waiting', status = 'on_deck', last_run_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(nextRun, now, taskId);
  } else {
    // No more runs: mark everything as completed
    db.prepare(`
      UPDATE tasks SET schedule_status = 'completed', status = 'complete', last_run_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(now, taskId);
  }

  // Broadcast the run completion event
  broadcast({ type: 'task:run_complete', data: { taskId, runId, status, nextRun } } as never);

  // Also broadcast the task update so the kanban card moves
  try {
    const { getTask } = await import('../tracker/schema.js');
    const updatedTask = getTask(taskId);
    if (updatedTask) {
      broadcast({ type: 'tracker:task_updated', data: updatedTask } as never);
    }
  } catch { /* ignore */ }

  logger.info('Scheduler: run completed', { taskId, runId, status, nextRun });
}

// ── Orphan cleanup ──

/**
 * Find task_runs stuck in 'running' whose assigned agent is terminated.
 * Auto-complete them so the task can move on (or finish if it was the last run).
 */
function cleanupOrphanedRuns(): void {
  const db = getDb();

  const orphans = db.prepare(`
    SELECT tr.id as run_id, tr.task_id, tr.assigned_to
    FROM task_runs tr
    LEFT JOIN agents a ON a.id = tr.assigned_to
    WHERE tr.status = 'running'
      AND (a.status = 'terminated' OR a.id IS NULL)
  `).all() as Array<{ run_id: string; task_id: string; assigned_to: string | null }>;

  if (orphans.length === 0) return;

  logger.info(`Scheduler: cleaning up ${orphans.length} orphaned run(s)`);

  for (const orphan of orphans) {
    // Complete the orphaned run
    db.prepare(`
      UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = 'Auto-completed: assigned agent was terminated' WHERE id = ?
    `).run(orphan.run_id);

    // Trigger the normal completion flow so the task advances or finishes
    onTaskRunComplete(orphan.task_id, 'complete', 'Auto-completed: assigned agent was terminated').catch(err => {
      logger.error('Scheduler: orphan cleanup failed for task', {
        taskId: orphan.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
