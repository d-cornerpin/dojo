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

// ── Phase B.1: 12h auto-expire sweeps ──
//
// Override requests that PM hasn't resolved within 12 hours auto-deny,
// with a notice to the agent. Tasks flagged awaiting_user_verdict that
// the user hasn't replied to within 12 hours drop to 'blocked' with
// the timeout reason logged. Both keep the system honest when humans
// are away.

const STALE_REQUEST_HOURS = 12;

async function sweepStaleOverrideRequests(): Promise<void> {
  const db = getDb();
  try {
    const stale = db.prepare(`
      SELECT id, task_id, requested_by, requested_status, justification
      FROM task_override_requests
      WHERE status = 'pending'
        AND datetime(created_at) < datetime('now', '-${STALE_REQUEST_HOURS} hours')
      LIMIT 50
    `).all() as Array<{
      id: string; task_id: string; requested_by: string;
      requested_status: string; justification: string;
    }>;
    if (stale.length === 0) return;

    const denyStmt = db.prepare(`
      UPDATE task_override_requests
      SET status = 'auto_denied', resolved_by = 'engine',
          resolved_reason = 'timed out after ${STALE_REQUEST_HOURS}h with no PM resolution',
          resolved_at = datetime('now')
      WHERE id = ?
    `);
    const { writeTaskLog } = await import('../tracker/task-log.js');
    let swept = 0;
    for (const r of stale) {
      denyStmt.run(r.id);
      writeTaskLog({
        taskId: r.task_id,
        fromEntity: 'engine',
        entryKind: 'auto_sweep',
        actionTaken: `override request auto-denied (id=${r.id.slice(0, 8)})`,
        reason: `pending more than ${STALE_REQUEST_HOURS}h without PM resolution; original justification: ${r.justification.slice(0, 200)}`,
      });

      // Notify the requesting agent via A2A.
      try {
        const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
        await deliverA2AMessage({
          intent: 'QUESTION',
          threadId: '',
          requiresResponse: true,
          payload:
            `Your override request on task ${r.task_id.slice(0, 8)} (status="${r.requested_status}") ` +
            `timed out after ${STALE_REQUEST_HOURS}h with no PM resolution. The request is auto-denied. ` +
            `Address the engine's original concern and resubmit cleanly, or file a fresh tracker_request_override.`,
          toAgent: r.requested_by,
          fromAgent: getPMAgentId(),
        });
      } catch { /* best-effort */ }
      swept++;
    }
    if (swept > 0) {
      logger.info('Auto-expired override requests', { swept, hours: STALE_REQUEST_HOURS });
    }
  } catch (err) {
    logger.warn('sweepStaleOverrideRequests failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sweepStaleUserVerdictRequests(): Promise<void> {
  const db = getDb();
  try {
    const stale = db.prepare(`
      SELECT id, title, assigned_to, status as current_status, user_verdict_requested_at
      FROM tasks
      WHERE awaiting_user_verdict = 1
        AND user_verdict_requested_at IS NOT NULL
        AND datetime(user_verdict_requested_at) < datetime('now', '-${STALE_REQUEST_HOURS} hours')
      LIMIT 50
    `).all() as Array<{
      id: string; title: string; assigned_to: string | null;
      current_status: string; user_verdict_requested_at: string;
    }>;
    if (stale.length === 0) return;

    const dropStmt = db.prepare(`
      UPDATE tasks
      SET status = 'blocked',
          awaiting_user_verdict = 0,
          user_verdict_requested_at = NULL,
          blocked_validated = 1,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    const { writeTaskLog } = await import('../tracker/task-log.js');
    const { broadcast: bcast } = await import('../gateway/ws.js');
    let swept = 0;
    for (const t of stale) {
      dropStmt.run(t.id);
      writeTaskLog({
        taskId: t.id,
        fromEntity: 'engine',
        entryKind: 'auto_sweep',
        fromStatus: t.current_status,
        toStatus: 'blocked',
        actionTaken: 'user verdict timed out',
        reason: `pending more than ${STALE_REQUEST_HOURS}h since user_verdict_requested_at=${t.user_verdict_requested_at}; dropped to blocked, please review`,
      });
      bcast({ type: 'tracker:task_updated', data: { id: t.id, status: 'blocked' } } as never);
      swept++;
    }
    if (swept > 0) {
      logger.info('Auto-expired user verdict requests', { swept, hours: STALE_REQUEST_HOURS });
    }
  } catch (err) {
    logger.warn('sweepStaleUserVerdictRequests failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── 5-minute validation escalation ──
//
// If a task has been sitting in complete/paused/blocked with the matching
// *_validated flag at 0 for more than 5 minutes AND we haven't asked the
// user yet, the engine asks the user directly via primary-agent chat (and
// iMessage when the user-away setting is on). One ask, then we leave the
// task alone — the dashboard bug icon stays until either PM, the user, or
// the assigned agent (acting on user feedback) validates.

const VALIDATION_ESCALATION_MIN = 5;

async function sweepUnvalidatedTasksForUserEscalation(): Promise<void> {
  const db = getDb();
  try {
    const stale = db.prepare(`
      SELECT id, title, status, assigned_to, datetime(updated_at) as updated
      FROM tasks
      WHERE validation_escalated_at IS NULL
        AND awaiting_user_verdict = 0
        AND (
          (status = 'complete' AND complete_validated = 0)
          OR (status = 'paused' AND pause_validated = 0)
          OR (status = 'blocked' AND blocked_validated = 0)
        )
        AND datetime(updated_at) < datetime('now', '-${VALIDATION_ESCALATION_MIN} minutes')
      LIMIT 20
    `).all() as Array<{ id: string; title: string; status: string; assigned_to: string | null; updated: string }>;
    if (stale.length === 0) return;

    const { writeTaskLog } = await import('../tracker/task-log.js');
    const { broadcast } = await import('../gateway/ws.js');
    const stamp = db.prepare(`
      UPDATE tasks SET validation_escalated_at = datetime('now'), validation_thread_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const primaryId = getPrimaryAgentId();
    const { v4: uuidv4 } = await import('uuid');

    for (const t of stale) {
      const threadId = uuidv4();
      const agentName = t.assigned_to
        ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(t.assigned_to) as { name: string } | undefined)?.name ?? t.assigned_to
        : 'an agent';
      const askText =
        `[VALIDATION CHECK] Task "${t.title}" (id=${t.id}) was marked ${t.status} by ${agentName} ${VALIDATION_ESCALATION_MIN}+ minutes ago, ` +
        `but the PM agent has not validated it. ` +
        `David, is this actually ${t.status === 'complete' ? 'done' : t.status}? Reply yes/no with any context. ` +
        `\n\n` +
        `**Primary agent**: when David replies, call tracker_apply_user_validation(task_id="${t.id}", validated=<true if yes / false if no>, user_quote="<David's exact reply>", feedback="<optional details if validated=false>"). ` +
        `validated=true clears the bug icon; validated=false reverts to in_progress and notifies the assigned agent with David's feedback.`;

      // Post as a user-facing system message in the primary agent's chat
      // so the user sees the question alongside their normal chat history.
      const msgId = uuidv4();
      db.prepare(`
        INSERT INTO messages (id, agent_id, role, content, created_at)
        VALUES (?, ?, 'system', ?, datetime('now'))
      `).run(msgId, primaryId, askText);
      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: msgId, agentId: primaryId, role: 'system' as const,
          content: askText,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });

      // For iMessage delivery when David is away from the dojo: the system
      // message above is also broadcast to the primary agent, who has the
      // imessage_send tool. When the primary is woken by the message they
      // can forward via iMessage naturally. We do not call iMessage
      // directly from the engine because it requires the agent tool path.

      stamp.run(threadId, t.id);
      writeTaskLog({
        taskId: t.id,
        fromEntity: 'engine',
        entryKind: 'directive',
        actionTaken: '5-min validation escalation: asked user',
        reason: `task has been ${t.status} with *_validated=0 since ${t.updated}; PM hasn't acted`,
        note: askText,
      });

      // Re-broadcast the task so the dashboard re-renders with the
      // "user has been asked" indicator (the bug icon pulse).
      const fresh = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id) as Record<string, unknown> | undefined;
      if (fresh) {
        broadcast({ type: 'tracker:task_updated', data: { id: t.id, validation_escalated_at: fresh.validation_escalated_at } } as never);
      }
    }
    logger.info('Validation escalation: asked user about unvalidated tasks', { count: stale.length });
  } catch (err) {
    logger.warn('sweepUnvalidatedTasksForUserEscalation failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  // Phase B.1: 12-hour auto-expire sweeps.
  await sweepStaleOverrideRequests();
  await sweepStaleUserVerdictRequests();
  // 5-minute validation escalation: if PM hasn't validated within the
  // threshold, ask the user via primary chat (and iMessage if available).
  await sweepUnvalidatedTasksForUserEscalation();

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

    // Phase B.0: audit trail of scheduler-driven transition.
    try {
      const { writeTaskLog } = await import('../tracker/task-log.js');
      writeTaskLog({
        taskId,
        fromEntity: 'scheduler',
        entryKind: 'transition',
        fromStatus: 'on_deck',
        toStatus: 'in_progress',
        actionTaken: `scheduler fired run #${runNumber}`,
        reason: `next_run_at reached; assigned to ${assignedAgent}`,
      });
    } catch (err) {
      logger.warn('scheduler: writeTaskLog on fire failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }

    // 4. Update run instance
    db.prepare(`
      UPDATE task_runs SET status = 'running', started_at = ?, assigned_to = ? WHERE id = ?
    `).run(now, assignedAgent, runId);

    // 5. Trigger execution
    const taskTitle = taskRow.title as string;
    const taskDesc = taskRow.description as string | null;
    const taskKind = taskRow.kind as string | null;
    const totalRuns = taskRow.repeat_end_value ? ` of ${taskRow.repeat_end_value}` : '';

    // Reminders get a lighter prompt — they're not "tasks" in the
    // execute-multiple-steps sense, they're a single conversational
    // delivery to the user. The agent should say the thing in its
    // normal voice and silently close out.
    const message = taskKind === 'reminder'
      ? `[Reminder due] ${taskDesc ?? taskTitle}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nDeliver this reminder to the user now as a single short chat message in your normal voice. Do NOT prefix with "Reminder:" or "Here's your reminder" — just say the thing naturally (e.g. user asked to be reminded to "go get coffee" → "Hey, time to go get coffee."). When you're done speaking, silently call tracker_update_status with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping — do NOT write any user-facing message about marking the reminder complete ("Task closed", "All done", "Marked complete"). The reminder message itself is the entire user-facing output.`
      : `[Scheduled Task — Run #${runNumber}${totalRuns}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nIMPORTANT: Execute this task ONCE for this run only. Do NOT loop or repeat internally — the scheduler handles repetition. When this single run is finished, call tracker_update_status with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping — do NOT write any user-facing message about marking the task complete (e.g. "Task closed", "All done", "Marked complete"). The user already received your reminder/output above; an extra "task closed" line is just noise.`;

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

  // Phase B.0/B.1: audit the per-run completion with whatever
  // result_summary the scheduler/agent provided. For terminal closes
  // the validation flow still expects result+evidence on the task row;
  // per-run completions here are scheduler bookkeeping, not user-facing
  // closes.
  try {
    const { writeTaskLog } = await import('../tracker/task-log.js');
    writeTaskLog({
      taskId,
      fromEntity: 'scheduler',
      entryKind: 'transition',
      fromStatus: 'in_progress',
      toStatus: nextRun ? 'on_deck' : 'complete',
      actionTaken: nextRun
        ? `scheduler ran #${(task.run_count as number) + 1}, next at ${nextRun}`
        : `scheduler ran final run #${(task.run_count as number) + 1}, no more runs`,
      reason: `run finished with status=${status}`,
      note: summary || null,
    });
  } catch (err) {
    logger.warn('scheduler: writeTaskLog on run-complete failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
  }

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

  // 4. Recurring task with full repeat config but next_run_at not
  //    populated. Pre-2.9.x the create/edit paths could write a partial
  //    schedule (interval+unit but no scheduled_start, or invalid unit
  //    that calculateNextRun returns null for) and leave next_run_at
  //    null. The dispatch gates now prevent this on new rows, but
  //    legacy rows that landed in this state silently never fire — the
  //    scheduler's `WHERE next_run_at <= now` filter excludes NULL.
  //    Find them and recompute, then either restore the schedule or
  //    mark the task complete if there are no more runs.
  const missingNextRun = db.prepare(`
    SELECT t.id, t.title
    FROM tasks t
    WHERE t.repeat_interval IS NOT NULL
      AND t.repeat_unit IS NOT NULL
      AND t.next_run_at IS NULL
      AND t.is_paused = 0
      AND t.status NOT IN ('complete', 'fallen', 'paused')
      AND t.schedule_status != 'completed'
  `).all() as Array<{ id: string; title: string }>;

  const allStale = [
    ...staleTasks.map(t => ({ id: t.id, title: t.title, reason: `assigned agent idle for ${AGENT_IDLE_THRESHOLD_MINUTES}+ minutes`, kind: 'stale_running' as const })),
    ...unassigned.map(t => ({ id: t.id, title: t.title, reason: 'no agent assigned', kind: 'stale_running' as const })),
    ...stuckOutOfSync.map(t => ({ id: t.id, title: t.title, reason: `recurring task stuck in_progress with out-of-sync schedule_status for ${HARD_STUCK_THRESHOLD_MINUTES}+ minutes`, kind: 'stuck_out_of_sync' as const })),
    ...missingNextRun.map(t => ({ id: t.id, title: t.title, reason: 'recurring task has repeat_interval+repeat_unit but next_run_at is NULL — scheduler can\'t see it', kind: 'missing_next_run' as const })),
  ];

  if (allStale.length === 0) return;

  logger.warn(`Scheduler: ${allStale.length} stale/stuck task(s) detected`, {
    staleRunning: staleTasks.length,
    unassigned: unassigned.length,
    stuckOutOfSync: stuckOutOfSync.length,
    missingNextRun: missingNextRun.length,
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
    } else if (task.kind === 'missing_next_run') {
      // Recover a recurring task that has the repeat config but no
      // next_run_at. forceResetStuckRecurringTask already does the
      // recompute-or-finalize logic we want here; reuse it. It bails on
      // non-in_progress rows by default, so for the missing-next-run
      // case we recompute inline using the same calculateNextRun path
      // and write the appropriate state directly.
      try {
        recoverMissingNextRun(task.id);
      } catch (err) {
        logger.error('Scheduler: missing-next-run recovery failed', {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
 * Recompute next_run_at on a recurring task whose row has the repeat
 * config (repeat_interval + repeat_unit) but next_run_at is NULL. This
 * happens when a legacy create/edit path wrote partial schedule fields
 * before the dispatch gates were in place — the scheduler's
 * `WHERE next_run_at <= now` filter excludes NULL, so these tasks sit
 * permanently invisible until someone manually intervenes.
 *
 * If calculateNextRun returns a future time, restore the schedule. If
 * it returns null (config is genuinely uncomputable or all runs are in
 * the past with no future slot), mark the task complete so it stops
 * being a zombie.
 */
function recoverMissingNextRun(taskId: string): void {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return;
  if (task.next_run_at) return; // raced with another recovery path
  if (task.is_paused) return;

  const scheduledTask: ScheduledTask = {
    id: task.id as string,
    scheduled_start: task.scheduled_start as string | null,
    repeat_interval: task.repeat_interval as number | null,
    repeat_unit: task.repeat_unit as string | null,
    repeat_end_type: task.repeat_end_type as string | null,
    repeat_end_value: task.repeat_end_value as string | null,
    run_count: (task.run_count as number) ?? 0,
    is_paused: 0,
    last_run_at: task.last_run_at as string | null,
    next_run_at: null,
    schedule_status: (task.schedule_status as string) ?? 'waiting',
    repeat_days_of_week: task.repeat_days_of_week as string | null,
    anchor_time: task.anchor_time as string | null,
  };

  const nextRun = calculateNextRun(scheduledTask);
  if (nextRun) {
    db.prepare(`
      UPDATE tasks
      SET next_run_at = ?,
          schedule_status = 'waiting',
          status = CASE WHEN status IN ('on_deck', 'in_progress') THEN status ELSE 'on_deck' END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextRun, taskId);
    logger.warn('Scheduler: recovered recurring task with missing next_run_at', {
      taskId, title: task.title, nextRun,
    });
  } else {
    db.prepare(`
      UPDATE tasks
      SET schedule_status = 'completed',
          status = 'complete',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId);
    logger.warn('Scheduler: recurring task had no recoverable next run, marked complete', {
      taskId, title: task.title,
    });
  }

  broadcast({
    type: 'tracker:task_updated',
    task: { id: taskId, status: nextRun ? 'on_deck' : 'complete' },
  } as never);
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
/**
 * One-time recovery for recurring tasks that were paused by the
 * (now-fixed) engine close-out hardcap. Pre-fix, the hardcap in
 * agent/v2/loop.ts ran `UPDATE tasks SET is_paused=1, status='paused'`
 * on every dangling in_progress task without checking
 * `repeat_interval`, so a single missed close-out on a daily recurring
 * task (Tomorrow Brief, etc.) silently killed the whole recurring
 * schedule. The fix landed in v2.9.13 but every previously-stuck task
 * still needs to be released.
 *
 * Filter: paused + pause_validated=0 (engine-driven, not user-validated)
 * + repeat_interval set + notes contain the engine's pause signature.
 * For each match: clear is_paused, recompute next_run_at via
 * calculateNextRun, reset to status='on_deck', schedule_status='waiting'.
 * Idempotent — runs once at boot, then no-ops on future boots.
 */
export function recoverEnginePausedRecurringTasks(): void {
  try {
    const db = getDb();
    const stuck = db.prepare(`
      SELECT id, title FROM tasks
      WHERE is_paused = 1
        AND status = 'paused'
        AND pause_validated = 0
        AND repeat_interval IS NOT NULL
        AND repeat_unit IS NOT NULL
        AND (notes LIKE '%Auto-paused by engine%' OR notes LIKE '%idle-with-in_progress%' OR notes LIKE '%pre-turn close-out gate%')
    `).all() as Array<{ id: string; title: string }>;
    if (stuck.length === 0) return;
    let recovered = 0;
    for (const row of stuck) {
      try {
        // forceResetStuckRecurringTask's outer guard bails when status
        // isn't in_progress; flip the row to in_progress first so the
        // helper's recompute path runs end-to-end.
        db.prepare(`UPDATE tasks SET status = 'in_progress', is_paused = 0, updated_at = datetime('now') WHERE id = ?`).run(row.id);
        forceResetStuckRecurringTask(row.id);
        recovered++;
      } catch (err) {
        logger.warn('recover: failed to release engine-paused recurring task', {
          taskId: row.id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (recovered > 0) {
      logger.info('Released engine-paused recurring tasks back to schedule', {
        recovered, sample: stuck.slice(0, 5).map((r) => ({ id: r.id.slice(0, 8), title: r.title })),
      });
    }
  } catch (err) {
    logger.warn('recoverEnginePausedRecurringTasks failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function forceResetStuckRecurringTask(taskId: string): void {
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
