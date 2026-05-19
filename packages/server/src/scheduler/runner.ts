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

// ── Anchor-time / missed-runs helpers (v2.5.45) ──

/**
 * Convert a (repeat_interval, repeat_unit) pair to approximate milliseconds.
 * Used by the missed-runs detector. Month/year are approximate by design —
 * the detector just needs to distinguish "slightly behind scheduler tick"
 * (normal) from "way past the slot" (server-was-down scenario).
 */
function intervalApproxMs(unit: string | null, interval: number | null): number | null {
  if (!interval || !unit) return null;
  const DAY = 86_400_000;
  switch (unit) {
    case 'minutes': return interval * 60_000;
    case 'hours': return interval * 3_600_000;
    case 'days': return interval * DAY;
    case 'weeks': return interval * 7 * DAY;
    case 'months': return interval * 30 * DAY;
    case 'years': return interval * 365 * DAY;
    case 'weekdays': return DAY;
    case 'specific_days': return DAY;
    default: return null;
  }
}

/**
 * Pause the task and wake the assigned (or primary) agent with a system
 * message describing the missed-runs situation and the four resolution
 * options. The agent decides via tracker_resolve_missed_runs.
 *
 * Per user spec: when many slots have gone by while the daemon was down
 * (or the task was paused), the engine doesn't get to silently decide
 * whether to backfill or skip — the agent does, because the right
 * answer depends on the task semantics. Daily-summary task that missed
 * 3 days probably wants skip. Daily-housekeeping that missed 3 days
 * might want backfill_all.
 */
function alertMissedRuns(taskRow: Record<string, unknown>, missedSlots: number): void {
  const db = getDb();
  const taskId = taskRow.id as string;
  const taskTitle = taskRow.title as string;
  const nextRunAt = taskRow.next_run_at as string;
  const lastRunAt = taskRow.last_run_at as string | null;
  const anchorTime = taskRow.anchor_time as string | null;
  const repeatInterval = taskRow.repeat_interval as number | null;
  const repeatUnit = taskRow.repeat_unit as string | null;

  let assignedAgent = (taskRow.assigned_to as string | null) ?? null;
  if (!assignedAgent) {
    const groupId = taskRow.assigned_to_group as string | null;
    if (groupId) assignedAgent = pickAvailableAgentFromGroup(groupId);
  }
  if (!assignedAgent) assignedAgent = getPrimaryAgentId();

  // Pause the task while the agent decides — prevents re-firing on every
  // scheduler tick. The agent's resolve call will unpause + apply the
  // chosen action.
  db.prepare(`
    UPDATE tasks
    SET is_paused = 1, schedule_status = 'paused', status = 'paused',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);

  const cadence = repeatInterval && repeatUnit
    ? (repeatInterval === 1 ? `every ${repeatUnit.replace(/s$/, '')}` : `every ${repeatInterval} ${repeatUnit}`)
    : 'recurring';

  const alertText = (
    `[System: scheduled task "${taskTitle}" (${taskId.slice(0, 8)}) has MISSED ${missedSlots} scheduled run${missedSlots === 1 ? '' : 's'}.\n` +
    `  - Cadence: ${cadence}\n` +
    `  - Anchor time: ${anchorTime ?? '(none)'}\n` +
    `  - Most recent slot that was supposed to fire: ${nextRunAt}\n` +
    `  - Last successful run: ${lastRunAt ?? 'never'}\n` +
    `  - Current time: ${new Date().toISOString()}\n\n` +
    `Likely cause: the platform was offline, or the task was paused longer than expected.\n` +
    `The task has been auto-paused so it doesn't fire repeatedly. Decide what to do — ` +
    `call tracker_resolve_missed_runs(task_id="${taskId}", action="<one of>"):\n` +
    `  - run_now: unpause, fire ONE catch-up run right now, then resume the normal schedule from the next anchor.\n` +
    `             Use this when the task's work is cumulative (e.g. "summarize what happened since last run") and one consolidated run will cover all the missed slots.\n` +
    `  - skip:    unpause, skip every missed slot, resume from the NEXT future anchor.\n` +
    `             Use this when each scheduled run is independent and stale (e.g. "post today's reminder") — there's nothing meaningful to do for the missed days.\n` +
    `  - pause:   leave the task paused. No runs. The user will resume manually via the dashboard.\n` +
    `             Use this when you're unsure or the situation needs a human decision.\n` +
    `Default if you do nothing within a few minutes: the task stays paused (option "pause").]`
  );

  const msgId = uuidv4();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(msgId, assignedAgent, alertText);
    broadcast({
      type: 'chat:message',
      agentId: assignedAgent,
      message: {
        id: msgId, agentId: assignedAgent, role: 'system' as const,
        content: alertText,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('alertMissedRuns: failed to persist alert message', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // Wake the agent so it sees the alert. handleMessage with a thin
  // synthetic trigger is enough — the actual alert lives in the messages
  // table and will be included in the next assembled context.
  try {
    const runtime = getAgentRuntime();
    runtime.handleMessage(assignedAgent, '[scheduler: missed-runs alert pending]').catch((err) => {
      logger.warn('alertMissedRuns: agent wake failed', {
        taskId, assignedAgent, error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch { /* runtime not ready — alert is in the table, will be read next time */ }

  logger.warn('Scheduler: missed-runs alert sent, task paused', {
    taskId, taskTitle, missedSlots, assignedAgent,
  });
}

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

  // ── Cleanup ──
  cleanupOrphanedRuns();
  cleanupStaleRuns();
  pruneTerminalTasks();
  resumeExpiredPauses();

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

    // ── v2.5.45: missed-runs detection ──
    // If a recurring task is overdue by more than 1 interval, multiple
    // anchor slots have passed without firing — almost always because the
    // platform was offline or the task was paused longer than expected.
    // Per user spec, the engine doesn't get to silently backfill or skip:
    // wake the assigned agent and let them decide via
    // tracker_resolve_missed_runs.
    const repeatInterval = taskRow.repeat_interval as number | null;
    const repeatUnit = taskRow.repeat_unit as string | null;
    if (repeatInterval && repeatUnit) {
      const nextRunIso = taskRow.next_run_at as string | null;
      const intervalMs = intervalApproxMs(repeatUnit, repeatInterval);
      if (nextRunIso && intervalMs) {
        const overdueMs = Date.now() - new Date(nextRunIso).getTime();
        if (overdueMs > intervalMs * 1.5) {
          const missedSlots = Math.max(1, Math.floor(overdueMs / intervalMs));
          alertMissedRuns(taskRow, missedSlots);
          continue;
        }
      }
    }

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

    // 3. Update task status — set both schedule_status and main status
    db.prepare(`
      UPDATE tasks SET schedule_status = 'running', status = 'in_progress', last_run_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(now, taskId);

    // 4. Update run instance
    db.prepare(`
      UPDATE task_runs SET status = 'running', started_at = ?, assigned_to = ? WHERE id = ?
    `).run(now, assignedAgent, runId);

    // 5. Trigger execution
    const taskTitle = taskRow.title as string;
    const taskDesc = taskRow.description as string | null;
    const totalRuns = taskRow.repeat_end_value ? ` of ${taskRow.repeat_end_value}` : '';
    const message = `[Scheduled Task — Run #${runNumber}${totalRuns}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nIMPORTANT: Execute this task ONCE for this run only. Do NOT loop or repeat internally — the scheduler handles repetition. When this single run is finished, call tracker_update_status with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping — do NOT write any user-facing message about marking the task complete (e.g. "Task closed", "All done", "Marked complete"). The user already received your reminder/output above; an extra "task closed" line is just noise.`;

    // Inject as user message and trigger runtime
    const msgId = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(msgId, assignedAgent, `[SOURCE: SCHEDULER — automated scheduled task trigger, not a message from the user] ${message}`);

    broadcast({
      type: 'chat:message',
      agentId: assignedAgent,
      message: {
        id: msgId,
        agentId: assignedAgent,
        role: 'user' as const,
        content: `[SOURCE: SCHEDULER — automated scheduled task trigger, not a message from the user] ${message}`,
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
    repeat_days_of_week: task.repeat_days_of_week as string | null,
    anchor_time: task.anchor_time as string | null,
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
    // Let onTaskRunComplete handle the full flow — it updates the run status,
    // increments run_count, calculates next_run_at, and resets schedule_status.
    // Do NOT update task_runs before this call — onTaskRunComplete queries for
    // status='running' and will miss the run if we change it first.
    onTaskRunComplete(orphan.task_id, 'complete', 'Auto-completed: assigned agent was terminated').catch(err => {
      logger.error('Scheduler: orphan cleanup failed for task', {
        taskId: orphan.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * Safety net: find scheduled tasks stuck in 'running' where the assigned agent
 * has gone silent. A task that takes 2 hours is fine as long as the agent is
 * actively producing messages. But if the agent's last message was 30+ minutes
 * ago, the agent has stalled and the run should be failed so the scheduler can
 * retry on the next cycle.
 */
function cleanupStaleRuns(): void {
  const db = getDb();
  const AGENT_IDLE_THRESHOLD_MINUTES = 30;
  // Hard threshold for force-recovery: any recurring task in_progress longer
  // than this without activity is structurally stuck regardless of which
  // schedule_status combination got it there. v2.3.8.
  const HARD_STUCK_THRESHOLD_MINUTES = 120;

  // 1. Standard stale-running detection. Use the OLDER of (per-task
  // updated_at, agent last message) — same per-task pattern as PM's poke
  // loop in v2.3.6. Catches a recurring run that the agent finished but
  // never called tracker_update_status on.
  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to
    FROM tasks t
    WHERE t.schedule_status = 'running'
      AND t.status != 'paused'
      AND t.assigned_to IS NOT NULL
      AND MIN(
        COALESCE(
          (SELECT MAX(m.created_at) FROM messages m WHERE m.agent_id = t.assigned_to),
          t.updated_at
        ),
        t.updated_at
      ) < datetime('now', '-' || ? || ' minutes')
  `).all(AGENT_IDLE_THRESHOLD_MINUTES) as Array<{ id: string; title: string; assigned_to: string }>;

  // 2. Also catch running tasks with no assigned agent at all
  const unassigned = db.prepare(`
    SELECT t.id, t.title
    FROM tasks t
    WHERE t.schedule_status = 'running'
      AND t.status != 'paused'
      AND t.assigned_to IS NULL
      AND t.last_run_at < datetime('now', '-5 minutes')
  `).all() as Array<{ id: string; title: string }>;

  // 3. Force-recovery for recurring tasks that are status='in_progress'
  // but schedule_status is NOT 'running' (out-of-sync state from a previous
  // run that left the row inconsistent). cleanupStaleRuns above misses
  // these because of the schedule_status='running' filter, and
  // onTaskRunComplete bails when there's no active task_runs row — so
  // they sit stuck forever. v2.3.8: catch them here and force-reset
  // directly via the helper below, bypassing onTaskRunComplete.
  const stuckOutOfSync = db.prepare(`
    SELECT t.id, t.title
    FROM tasks t
    WHERE t.status = 'in_progress'
      AND t.repeat_interval IS NOT NULL
      AND (t.schedule_status IS NULL OR t.schedule_status != 'running')
      AND t.is_paused = 0
      AND t.updated_at < datetime('now', '-' || ? || ' minutes')
  `).all(HARD_STUCK_THRESHOLD_MINUTES) as Array<{ id: string; title: string }>;

  const allStale = [
    ...staleTasks.map(t => ({ id: t.id, title: t.title, reason: `assigned agent idle for ${AGENT_IDLE_THRESHOLD_MINUTES}+ minutes`, kind: 'stale_running' as const })),
    ...unassigned.map(t => ({ id: t.id, title: t.title, reason: 'no agent assigned', kind: 'stale_running' as const })),
    ...stuckOutOfSync.map(t => ({ id: t.id, title: t.title, reason: `recurring task stuck in_progress with out-of-sync schedule_status for ${HARD_STUCK_THRESHOLD_MINUTES}+ minutes`, kind: 'stuck_out_of_sync' as const })),
  ];

  if (allStale.length === 0) return;

  logger.warn(`Scheduler: ${allStale.length} stale/stuck task(s) detected`, {
    staleRunning: staleTasks.length,
    unassigned: unassigned.length,
    stuckOutOfSync: stuckOutOfSync.length,
  });

  for (const task of allStale) {
    logger.warn('Scheduler: auto-recovering task', { taskId: task.id, title: task.title, reason: task.reason, kind: task.kind });

    if (task.kind === 'stale_running') {
      // onTaskRunComplete handles the normal case — fails the active run,
      // advances run_count, computes nextRun, resets status. If the active
      // run record is missing (already terminal), it bails — the
      // forceResetStuckRecurringTask call after handles the row directly.
      onTaskRunComplete(task.id, 'failed', `Auto-failed: ${task.reason}`)
        .then(() => forceResetStuckRecurringTask(task.id))
        .catch(err => {
          logger.error('Scheduler: stale cleanup failed', {
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
          // Still try the direct force-reset as a fallback.
          try { forceResetStuckRecurringTask(task.id); } catch { /* swallow */ }
        });
    } else {
      // stuck_out_of_sync: bypass onTaskRunComplete entirely.
      try {
        forceResetStuckRecurringTask(task.id);
      } catch (err) {
        logger.error('Scheduler: force-reset failed', {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Force-reset a recurring task whose row is structurally stuck —
 * status='in_progress' with no productive way out via the normal
 * onTaskRunComplete path (because the active task_runs row is already
 * terminal or the schedule_status got out of sync).
 *
 * Recomputes the next run from the current schedule and writes the
 * appropriate status/schedule_status directly. Idempotent: skips if the
 * task is no longer in_progress (something else recovered it first).
 */
function forceResetStuckRecurringTask(taskId: string): void {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return;
  if (task.status !== 'in_progress') return;
  if (!task.repeat_interval) return;

  const scheduledTask: ScheduledTask = {
    id: task.id as string,
    scheduled_start: task.scheduled_start as string | null,
    repeat_interval: task.repeat_interval as number | null,
    repeat_unit: task.repeat_unit as string | null,
    repeat_end_type: task.repeat_end_type as string | null,
    repeat_end_value: task.repeat_end_value as string | null,
    run_count: (task.run_count as number) ?? 0,
    is_paused: (task.is_paused as number) ?? 0,
    last_run_at: task.last_run_at as string | null,
    next_run_at: task.next_run_at as string | null,
    schedule_status: task.schedule_status as string,
    repeat_days_of_week: task.repeat_days_of_week as string | null,
    anchor_time: task.anchor_time as string | null,
  };

  const nextRun = calculateNextRun(scheduledTask);
  if (nextRun) {
    db.prepare(`
      UPDATE tasks
      SET status = 'on_deck',
          schedule_status = 'waiting',
          next_run_at = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextRun, taskId);
    logger.warn('Scheduler: force-reset stuck recurring task to on_deck/waiting', { taskId, title: task.title, nextRun });
  } else {
    db.prepare(`
      UPDATE tasks
      SET status = 'complete',
          schedule_status = 'completed',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId);
    logger.warn('Scheduler: force-reset stuck recurring task — no future runs, marked complete', { taskId, title: task.title });
  }

  broadcast({
    type: 'tracker:task_updated',
    task: { id: taskId, status: nextRun ? 'on_deck' : 'complete' },
  } as never);
}

// ── Prune terminal tasks ──

const TERMINAL_TASK_CAP = 50;
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 3600_000; // Once per hour is plenty

/**
 * Auto-resume paused tasks whose paused_until time has passed.
 * Restores the task to its pre-pause status (status_before_pause) and clears
 * the pause fields. The PM agent will then see the task in its normal state
 * and the process continues as usual.
 */
function resumeExpiredPauses(): void {
  const db = getDb();
  const now = new Date().toISOString();

  const expired = db.prepare(`
    SELECT id, title, status_before_pause, paused_until
    FROM tasks
    WHERE status = 'paused'
      AND paused_until IS NOT NULL
      AND paused_until <= ?
  `).all(now) as Array<{ id: string; title: string; status_before_pause: string | null; paused_until: string }>;

  for (const task of expired) {
    const restoreStatus = task.status_before_pause ?? 'on_deck';
    db.prepare(`
      UPDATE tasks
      SET status = ?, is_paused = 0, paused_until = NULL, status_before_pause = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(restoreStatus, task.id);

    logger.info('Auto-resumed paused task (pause expired)', {
      taskId: task.id,
      title: task.title,
      restoredStatus: restoreStatus,
      pausedUntil: task.paused_until,
    });

    broadcast({
      type: 'tracker:task_updated',
      task: { id: task.id, status: restoreStatus },
    } as never);
  }
}

/**
 * Keep each terminal state (complete, blocked, fallen) capped at 50 tasks.
 * Oldest tasks beyond the cap are deleted along with their runs and poke logs.
 */
function pruneTerminalTasks(): void {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();

  const db = getDb();

  for (const status of ['complete', 'blocked', 'fallen']) {
    const overflow = db.prepare(`
      SELECT id FROM tasks
      WHERE status = ?
      ORDER BY updated_at DESC
      LIMIT -1 OFFSET ?
    `).all(status, TERMINAL_TASK_CAP) as Array<{ id: string }>;

    if (overflow.length === 0) continue;

    const ids = overflow.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    // Clear agent references first
    db.prepare(`UPDATE agents SET task_id = NULL WHERE task_id IN (${placeholders})`).run(...ids);
    // Delete related records
    db.prepare(`DELETE FROM poke_log WHERE task_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM task_runs WHERE task_id IN (${placeholders})`).run(...ids);
    // Delete the tasks
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);

    logger.info(`Scheduler: pruned ${ids.length} old ${status} task(s)`, { status, pruned: ids.length });
  }
}
