// Task scheduler runner: finds due tasks and triggers their execution.
// Model-directed text from this file rides NOTICE (postAgentNotice, role='user' origin_kind='engine'), never
// role='system', which the model-context builder strips; bare role='system' rows here are dashboard-only notes.

import { v4 as uuidv4 } from 'uuid';
import { retireEngineEventsForRun, retireEngineEventsForTask } from '../agent/v2/counterparty.js';
import { getDb } from '../db/connection.js';
import { HARD_STUCK_THRESHOLD_MINUTES } from '../agent/stuck-thresholds.js';
import {
  taskScope, dueScope, msToText, tsToMs, STATE_TO_STATUS_SQL, scheduleRowColumns,
} from '../work/tracker-view.js';
import { patchWork, setTrackerStatus, bumpWorkAttempts } from '../work/tracker-store.js';
import { engineHandIn } from '../work/done/hand-in.js';
import { clearHold, heldExpr, workingExpr } from '../work/done/hold.js';
import { setNextRun, clearLiveSchedule } from '../work/next-run.js';
import { noteUnsettled } from '../work/store.js';
import {
  claimOccurrence, releaseOccurrence, settleOccurrence, occurrenceOf, inFlightOccurrence,
  assignOccurrence, skipOpenOccurrences, sweepOrphanedOccurrences,
  sweepTerminatedAgentOccurrences, runsReadyToCloseOnDelivery, RUN_STATUS_UNDELIVERED,
} from '../work/occurrences.js';
import { proofDelivery } from '../work/done/proof.js';
import { hintOnce, LADDER_HINT } from '../work/done/ladder.js';
import { recordFloorGhost } from '../agent/v2/floor-ghost.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getTask } from '../tracker/schema.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { calculateNextRun, normalizeDbTimestamp, type ScheduledTask } from './engine.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { getPrimaryAgentId, getPMAgentId } from '../config/platform.js';
import { recordMove } from '../work/move-record.js';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
// The liveness fact every reaper guards on: a run that is still executing must never be force-failed.
import { activeRuns } from '../agent/shared-state.js';

const logger = createLogger('scheduler');

// Builds a `ScheduledTask` from a `work` row's projected columns, including its own zone `tz`.
function scheduledTaskFromRow(row: Record<string, unknown>, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: row.id as string,
    scheduled_start: row.scheduled_start as string | null,
    repeat_interval: row.repeat_interval as number | null,
    repeat_unit: row.repeat_unit as string | null,
    repeat_end_type: row.repeat_end_type as string | null,
    repeat_end_value: row.repeat_end_value as string | null,
    run_count: (row.run_count as number) ?? 0,
    is_paused: (row.is_paused as number) ?? 0,
    last_run_at: row.last_run_at as string | null,
    next_run_at: row.next_run_at as string | null,
    schedule_status: row.schedule_status as string,
    repeat_days_of_week: row.repeat_days_of_week as string | null,
    anchor_time: row.anchor_time as string | null,
    tz: row.tz as string | null,
    ...over,
  };
}


/** Approximate ms per interval (months and years approximate by design), for the missed-runs detector. */
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
 * Pause the task and notify its agent (assignee, else a group pick, else the primary) of the missed runs.
 * The agent decides via work_schedule(action="resolve_missed"), since backfill or skip depends on the task.
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

  // Pause while the agent decides so the task does not re-fire every tick; its resolve call unpauses, and
  // `missed_runs_paused_at` lets autoResolveStaleMissedRunPauses skip it after a whole agent turn.
  const alreadyPaused = db.prepare('SELECT is_paused FROM work WHERE id = ?')
    .get(taskId) as { is_paused: number } | undefined;
  if (!alreadyPaused || alreadyPaused.is_paused !== 0) {
    logger.info('Scheduler: missed-runs pause already set elsewhere, skipping duplicate alert', { taskId });
    return;
  }
  noteUnsettled(patchWork(taskId, { is_paused: 1, schedule_status: 'paused', missed_runs_paused_at: Date.now() }), 'scheduler: paused after too many missed runs', { taskId });

  const cadence = repeatInterval && repeatUnit
    ? (repeatInterval === 1 ? `every ${repeatUnit.replace(/s$/, '')}` : `every ${repeatInterval} ${repeatUnit}`)
    : 'recurring';

  // A brief model-visible notice (role='user' origin_kind='engine'), since role='system' rows never reach the
  // model. The run_now/skip/pause semantics live in the work_schedule tool description.
  postAgentNotice({
    toAgentId: assignedAgent,
    fromName: 'Scheduler',
    selfIntro: false,
    intent: 'scheduler_missed_runs',
    brief: `Your recurring task "${taskTitle}" (${cadence}) missed ${missedSlots} run${missedSlots === 1 ? '' : 's'} while the box was offline or paused, so I auto-paused it. Call work_schedule(action="resolve_missed", task_id="${taskId}", action="run_now"|"skip"|"pause"): action="run_now" fires one catch-up run now, action="skip" jumps to the next scheduled slot, action="pause" leaves it paused. The action argument is required.`,
  });

  try {
    const runtime = getAgentRuntime();
    runtime.handleMessage(assignedAgent, '[scheduler: missed-runs alert pending]').catch((err) => {
      logger.warn('alertMissedRuns: agent wake failed', {
        taskId, assignedAgent, error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch { /* runtime not ready: the notice is stored and read next time */ }

  logger.warn('Scheduler: missed-runs alert sent, task paused', {
    taskId, taskTitle, missedSlots, assignedAgent,
  });
}


export function pickAvailableAgentFromGroup(groupId: string): string | null {
  const db = getDb();
  const agents = db.prepare(`
    SELECT id FROM agents
    WHERE group_id = ? AND status IN ('idle', 'working') AND classification != 'sensei'
    ORDER BY
      CASE status WHEN 'idle' THEN 0 ELSE 1 END,
      (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.agent_id = agents.id AND ${workingExpr('w')}) ASC
  `).all(groupId) as Array<{ id: string }>;

  return agents.length > 0 ? agents[0].id : null;
}



// Deterministic fallback: once the agent has run a whole turn that STARTED after a missed-runs pause without
// resolving it, the engine resolves the pause as SKIP (next_run_at moves to the next future anchor, the pause
// clears back to waiting, and a task-log entry is written). The model tool wins when called first: every
// resolve action clears `missed_runs_paused_at`, which disarms this fallback. It never completes, deletes or
// reassigns a task.
const MISSED_RUNS_PASSED_OVER = 'the agent ran a whole turn after the missed-runs notice and did not resolve it';

export async function autoResolveStaleMissedRunPauses(): Promise<void> {
  const db = getDb();
  try {
    const stale = db.prepare(`
      SELECT ${scheduleRowColumns('w')} FROM work w
      WHERE ${taskScope('w')} AND w.is_paused = 1
        AND w.missed_runs_paused_at IS NOT NULL
        AND w.missed_runs_paused_at < (SELECT MAX(CAST(strftime('%s', t.started_at) AS INTEGER) * 1000) FROM turns t
              WHERE t.agent_id = COALESCE(w.agent_id, ?) AND t.ended_at IS NOT NULL)
      LIMIT 25
    `).all(getPrimaryAgentId()) as Array<Record<string, unknown>>;
    if (stale.length === 0) return;

    const { writeTaskLog } = await import('../tracker/task-log.js');
    for (const task of stale) {
      const taskId = task.id as string;
      const nowIso = new Date().toISOString();
      const nextRun = calculateNextRun(scheduledTaskFromRow(task, {
        is_paused: 0,
        last_run_at: nowIso,
        next_run_at: null,
        schedule_status: 'waiting',
      }));

      const intervalMs = intervalApproxMs(task.repeat_unit as string | null, task.repeat_interval as number | null);
      const missedIso = task.next_run_at as string | null;
      const missedSlots = intervalMs && missedIso
        ? Math.max(1, Math.floor((Date.now() - new Date(normalizeDbTimestamp(missedIso)).getTime()) / intervalMs))
        : 1;

      if (nextRun) {
        // Guarded release: the model tool clears missed_runs_paused_at when it resolves first, so a failed guard
        // means it (or another process) won the race and this fallback must not touch the task.
        const guard = db.prepare('SELECT is_paused, missed_runs_paused_at FROM work WHERE id = ?')
          .get(taskId) as { is_paused: number; missed_runs_paused_at: number | null } | undefined;
        if (!guard || guard.is_paused !== 1 || guard.missed_runs_paused_at == null) continue;
        noteUnsettled(setNextRun(taskId, {
          at: tsToMs(nextRun),
          alongside: { is_paused: 0, schedule_status: 'waiting', missed_runs_paused_at: null },
          reason: 'D12 auto-resolved a stale missed-runs pause; skipped to the next future anchor',
        }), 'scheduler: stale missed-run pause auto-resolved', { taskId });
        writeTaskLog({
          taskId,
          fromEntity: 'engine',
          entryKind: 'auto_sweep',
          actionTaken: `engine auto-skipped ${missedSlots} missed run${missedSlots === 1 ? '' : 's'} to the next scheduled time`,
          reason: `${MISSED_RUNS_PASSED_OVER} (work_schedule(action="resolve_missed") never ran); schedule resumed, next run at ${nextRun}`,
        });
        logger.warn('Scheduler: AUTO-RESOLVED stale missed-runs pause, skipped to next future anchor', {
          taskId, title: task.title, missedSlots, nextRun, pausedAt: task.missed_runs_paused_at,
        });
        try {
          const { getTask } = await import('../tracker/schema.js');
          const fresh = getTask(taskId);
          if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
        } catch { /* dashboard refresh is best-effort */ }
      } else {
        // No future anchor (past repeat end or uncomputable): never complete or delete a task from this path;
        // disarm the fallback and leave the task paused for a human or agent decision.
        const dGuard = db.prepare('SELECT is_paused, missed_runs_paused_at FROM work WHERE id = ?')
          .get(taskId) as { is_paused: number; missed_runs_paused_at: number | null } | undefined;
        if (!dGuard || dGuard.is_paused !== 1 || dGuard.missed_runs_paused_at == null) continue;
        noteUnsettled(patchWork(taskId, { missed_runs_paused_at: null }), 'scheduler: missed-run pause stamp cleared', { taskId });
        writeTaskLog({
          taskId,
          fromEntity: 'engine',
          entryKind: 'auto_sweep',
          actionTaken: 'missed-runs auto-resolve found no future run; task left paused',
          reason: 'calculateNextRun returned null (past repeat end or missing anchor); the engine does not complete or delete tasks from this path',
        });
        logger.warn('Scheduler: stale missed-runs pause has no future anchor, left paused (fallback disarmed)', {
          taskId, title: task.title,
        });
      }
    }
  } catch (err) {
    logger.warn('autoResolveStaleMissedRunPauses failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}


// A run whose task owes a person a message, that delivered it and never handed the run in, is closed on
// that delivery once its own turn has ended (`runsReadyToCloseOnDelivery`), through the ordinary flow.
export async function closeRunsThatDelivered(): Promise<number> {
  let closed = 0;
  for (const row of runsReadyToCloseOnDelivery()) {
    try { await (await import('../agent/tools/cat/measure-door.js')).remeasureTask('scheduler', row.taskId); }   // judge the run on a fresh reading
    catch (err) { logger.warn('Scheduler: re-reading a delivered run\'s measure failed; left for the next tick', { taskId: row.taskId, runId: row.occurrenceId, error: String(err) }); continue; }   // one row never stops the sweep
    logger.info('Scheduler: a run delivered, closing it on the message', { taskId: row.taskId, runId: row.occurrenceId, deliveryId: row.deliveryId });
    const advanced = await onTaskRunComplete(row.taskId, 'complete', 'the run delivered its message without being handed in; closed on that delivery').catch((err: unknown) => {
      logger.warn('Scheduler: closing a delivered run failed (non-fatal)', {
        taskId: row.taskId, runId: row.occurrenceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    if (advanced) closed += 1;
  }
  return closed;
}

export async function checkScheduledTasks(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  // One instant in both forms (ISO for recurrence maths, epoch-ms for the spine), so a tick has one "now".
  const nowMs = Date.parse(now);

  // The tick keeps only scheduling. The other periodic sweeps are kinds on work/work-reaper.ts's own 30 s
  // timer, so a row it repairs reaches this scan a tick later: `orphaned-and-stale-runs` (cleanupOrphanedRuns +
  // cleanupStaleRuns), `expired-pauses` (resumeExpiredPauses), `ladder` (runLadder) and
  // `steered-run-delivery-close` (closeRunsThatDelivered). autoResolveStaleMissedRunPauses stays here because it
  // walks the recurrence and writes the next fire time. Nothing the reaper runs is a precondition of the scan:
  // the occurrence claim is a UNIQUE constraint.
  await autoResolveStaleMissedRunPauses();

  // The due set is `dueScope()`, shared with work_update(filter:"overdue"); the 1.5x escalation is local.
  const dueTasks = db.prepare(`
    SELECT ${scheduleRowColumns('w')} FROM work w
    WHERE ${taskScope('w')} AND ${dueScope('w')}
    ORDER BY w.next_run_at ASC
  `).all(nowMs) as Array<Record<string, unknown>>;

  if (dueTasks.length === 0) return;

  logger.info(`Scheduler: ${dueTasks.length} task(s) due`, { count: dueTasks.length });

  for (const taskRow of dueTasks) {
    const taskId = taskRow.id as string;
    const runCount = (taskRow.run_count as number) ?? 0;
    const runNumber = runCount + 1;

    // A recurring task overdue by more than 1.5 intervals has missed slots (platform offline or paused): wake the
    // agent via work_schedule(action="resolve_missed") rather than silently backfill or skip. A never-run task
    // (run_count = 0) is a first fire, not a missed run.
    const repeatInterval = taskRow.repeat_interval as number | null;
    const repeatUnit = taskRow.repeat_unit as string | null;
    if (repeatInterval && repeatUnit && runCount > 0) {
      // Compare the RAW instant, never the display copy: `msToText` truncates.
      const nextRunMs = occurrenceOf(taskRow);
      const intervalMs = intervalApproxMs(repeatUnit, repeatInterval);
      if (nextRunMs !== null && intervalMs) {
        const overdueMs = Date.now() - nextRunMs;
        if (overdueMs > intervalMs * 1.5) {
          const missedSlots = Math.max(1, Math.floor(overdueMs / intervalMs));
          alertMissedRuns(taskRow, missedSlots);
          continue;
        }
      }
    }

    const dependsOnRaw = taskRow.depends_on as string | null;
    if (dependsOnRaw) {
      try {
        const deps = JSON.parse(dependsOnRaw) as string[];
        if (deps.length > 0) {
          const incomplete = deps.filter(depId => {
            const dep = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('state')} AS status FROM work WHERE id = ?`).get(depId) as { status: string } | undefined;
            return !dep || dep.status !== 'complete';
          });
          if (incomplete.length > 0) {
            logger.info('Scheduler: task has unmet dependencies, skipping', { taskId, incomplete });
            noteUnsettled(setNextRun(taskId, {
              at: Date.now() + 30_000, touch: false,
              reason: 'a dependency is not complete; re-check this SAME occurrence in 30s',
            }), 'scheduler: fire deferred 30s after a lost claim', { taskId });
            continue;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // Exactly one process may fire an occurrence: the claim INSERTs the occurrence row and `ux_work_occurrence`
    // refuses a second, so overlapping ticks and duplicate dev processes lose and skip. The schedule's
    // preconditions are checked in the same transaction against the RAW epoch-ms column (`occurrenceOf`), never
    // the display text. The NEXT occurrence is written here, at fire time, so a hung turn cannot stall the cadence.
    const claimedOccurrenceMs = occurrenceOf(taskRow);
    const claimedOccurrence = taskRow.next_run_at as string;
    const nextAtFire = calculateNextRun(scheduledTaskFromRow(taskRow, {
      run_count: runNumber, // count the run being fired now, so end conditions land exactly
      is_paused: 0,
      last_run_at: now, // the slot firing now is spent; walk to the one after it
      next_run_at: null,
      schedule_status: 'waiting',
    }));
    // The occurrence id is the claim token; the claim also writes the schedule advance in the same transaction.
    // The state assignment below stays outside it and runs only AFTER the claim is won.

    const occurrenceId = claimOccurrence({
      workId: taskId, sequence: runNumber, occurrenceMs: claimedOccurrenceMs,
      nowMs, nextRunMs: tsToMs(nextAtFire),
      agentId: (taskRow.assigned_to as string | null) ?? 'scheduler',
    });
    if (!occurrenceId) {
      logger.info('Scheduler: occurrence already claimed elsewhere, skipping', { taskId, occurrence: claimedOccurrence, sequence: runNumber });
      continue;
    }
    noteUnsettled(setTrackerStatus(taskId, 'in_progress', {
      by: 'scheduler', actorId: 'scheduler',
      reason: `scheduled occurrence ${claimedOccurrence} fired`,
    }), 'scheduler: occurrence fired', { taskId });

    // The occurrence id IS the run id (the lineage key `retireEngineEventsForRun` sweeps by).
    const runId = occurrenceId;

    let assignedAgent = taskRow.assigned_to as string | null;
    const assignedGroup = taskRow.assigned_to_group as string | null;

    if (assignedGroup && !assignedAgent) {
      assignedAgent = pickAvailableAgentFromGroup(assignedGroup);
      if (!assignedAgent) {
        const primaryId = getPrimaryAgentId();
        const groupName = (db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(assignedGroup) as { name: string } | undefined)?.name ?? assignedGroup;
        sendAgentMessage(getPMAgentId(), primaryId, 'status',
          `No available agents in group "${groupName}" for scheduled task "${taskRow.title}". Task run #${runNumber} skipped.`, {
            taskId, runId, event: 'no_agent_available',
          });
        // Release the claim and restore the occurrence and prior last_run_at so the task retries next tick. The
        // occurrence ROW goes with it, so the same occurrence can be claimed again once the group has somebody
        // free; `releaseOccurrence` records `occurrence_released` on the SCHEDULE because that row is deleted.
        // Both instants are the RAW columns: restoring a truncated `last_run_at` would shift it by up to 999ms.
        const stillRunning = db.prepare('SELECT schedule_status FROM work WHERE id = ?')
          .get(taskId) as { schedule_status: string } | undefined;
        if (stillRunning?.schedule_status === 'running') {
          noteUnsettled(setTrackerStatus(taskId, 'on_deck', {
            by: 'scheduler', actorId: 'scheduler',
            reason: 'no agent was available for this occurrence; the claim is released',
          }), 'scheduler: no agent available, claim released', { taskId });
          releaseOccurrence(
            occurrenceId, taskId, claimedOccurrenceMs,
            (taskRow.last_run_at_ms as number | null) ?? null,
            'no available agent in the assigned group',
          );
        }
        continue;
      }
    }

    if (!assignedAgent) {
      assignedAgent = getPrimaryAgentId();
    }

    const agentStatus = db.prepare('SELECT status FROM agents WHERE id = ?').get(assignedAgent) as { status: string } | undefined;
    if (!agentStatus || agentStatus.status === 'terminated') {
      logger.warn('Scheduler: assigned agent is terminated, reassigning to primary', { taskId, assignedAgent });
      const goneAgent = assignedAgent;
      assignedAgent = getPrimaryAgentId();
      try {
        recordMove({ taskId, actor: 'scheduler', from: goneAgent, to: { agentId: assignedAgent }, cause: 'assignee_gone', door: `scheduler fire #${runNumber}` });
      } catch (err) { logger.warn('scheduler: could not record the move off a gone assignee', { taskId, error: err instanceof Error ? err.message : String(err) }); }
    }

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

    // Record who actually runs it: the claim fired on the schedule's own assignee (or 'scheduler'), and the group
    // pick, primary fallback and reassignment above resolve after it. `opened_at` is the claim instant.
    assignOccurrence(runId, assignedAgent);

    const taskTitle = taskRow.title as string;
    const taskDesc = taskRow.description as string | null;
    const taskKind = taskRow.kind as string | null;
    const totalRuns = taskRow.repeat_end_value ? ` of ${taskRow.repeat_end_value}` : '';

    // Reminders get a lighter prompt: one conversational delivery in the agent's normal voice, then a silent close.
    // The wake asks for the reply ALONE and the bookkeeping in the NEXT response, because text emitted in the same
    // response as a tool call is demoted to working notes (post-call-classify/terminal-text.ts) and never heard.
    const message = taskKind === 'reminder'
      ? `[Reminder due] ${taskDesc ?? taskTitle}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nDeliver this reminder to the owner now as a single short chat message in your normal voice. Do NOT prefix with "Reminder:" or "Here's your reminder", just say the thing naturally (e.g. the owner asked to be reminded to "go get coffee" → "Hey, time to go get coffee."). Say it as a SEPARATE response with no tool call in it — text that rides along with a tool call is treated as working notes and never reaches the owner. Then, in your NEXT response, silently call work_update(action="status") with task_id="${taskId}" and status="complete". That status call is internal bookkeeping; do NOT write any owner-facing message about marking the reminder complete ("Task closed", "All done", "Marked complete"). The reminder message itself is the entire owner-facing output.`
      : `[Scheduled Task, Run #${runNumber}${totalRuns}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nWhen this run is finished, hand it in: work_update(action="hand_in") with task_id="${taskId}" and its proof. That call is internal bookkeeping; do NOT write any owner-facing message about marking the task complete (e.g. "Task closed", "All done", "Marked complete"). The owner already received your reminder/output above; an extra "task closed" line is just noise.`;

    // Inject as an engine event on the EVENTS lane, outside the assignee's `messages` chat table.
    const msgId = uuidv4();
    insertEngineEventIfAbsent({
      id: msgId,
      agentId: assignedAgent,
      content: `[SOURCE: SCHEDULER — automated scheduled task trigger, not a message from the user] ${message}`,
      sourceAgentId: null,
      originIntent: 'scheduler',
      // The trigger's referent as columns: the serve boundary retires this row when the run closes.
      work: { taskId, runId, rootKind: 'occurrence', rootId: runId },
    });

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

    const runtime = getAgentRuntime();
    runtime.handleMessage(assignedAgent, message).catch(err => {
      logger.error('Scheduler: failed to trigger agent', {
        taskId, runId, assignedAgent,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    broadcast({ type: 'task:run_started', data: { taskId, runId, agentId: assignedAgent } });

    logger.info('Scheduler: task triggered', { taskId, taskTitle, runId, runNumber, assignedAgent });
  }
}


export async function onTaskRunComplete(taskId: string, status: string, summary: string): Promise<boolean> {
  const db = getDb();

  const inFlight = inFlightOccurrence(taskId);

  if (!inFlight) {
    // No active run (a non-scheduled task, or already closed elsewhere): nothing to advance. Return false so
    // callers (work_validate) do not misread an already-'complete' row as a fresh terminal close.
    return false;
  }

  const runId = inFlight.id;
  const now = new Date().toISOString();

  // Settle the occurrence ROW with the run that closed it. Its terminal state is the run's own outcome: a run
  // that reached nobody cannot be `done` (a DB CHECK). The settle is also the close token: a row already terminal
  // cannot be transitioned again, so losing the race bails as a no-op rather than advancing run_count twice.
  const occRow = db.prepare('SELECT agent_id, opened_at FROM work WHERE id = ?')
    .get(runId) as { agent_id: string; opened_at: number } | undefined;
  // A run is judged on what it delivered in its own window to the person its schedule serves, whoever that is.
  const delivered = occRow ? proofDelivery(taskId, true) : null;
  const settled = settleOccurrence(runId, status, delivered, summary);

  if (settled.outcome?.kind !== 'applied') {
    logger.info('Scheduler: run already closed elsewhere, skipping advance', {
      taskId, runId, result: settled.outcome?.kind,
      reason: settled.outcome && 'reason' in settled.outcome ? settled.outcome.reason : undefined,
    });
    return false;
  }

  // An undelivered run is surfaced to the owner in the platform's own voice, never the agent's: `recordFloorGhost`
  // writes the durable row, owner-alert system note and health frame, the same three parts the in-turn
  // reminder-silence ghost writes. ONE alert per run: if the in-turn floor already ghosted this incident, this
  // arm stays quiet.
  if (settled.runStatusRecorded === RUN_STATUS_UNDELIVERED) {
    try {
      const alreadyGhosted = db.prepare(
        `SELECT 1 AS ok FROM work_events
          WHERE kind = 'floor_ghosted' AND work_id IN (?, ?) LIMIT 1`,
      ).get(runId, taskId) as { ok: number } | undefined;
      const title = String(
        (db.prepare('SELECT title FROM work WHERE id = ?').get(taskId) as { title?: string } | undefined)?.title
        ?? 'a scheduled task',
      );
      if (!alreadyGhosted && occRow?.agent_id) {
        recordFloorGhost({
          agentId: occRow.agent_id,
          turnNumber: null,
          floor: 'run-undelivered',
          workId: runId,
          attempts: 0,
          ownerLine:
            `a scheduled run of "${title}" finished without delivering anything to you. It owed you `
            + 'a message, the engine could find no record of one reaching you, and the run is '
            + 'recorded as undelivered rather than complete. Ask your agent what it was.',
          detail: { task_id: taskId, run_status: settled.runStatusRecorded },
        }, { broadcast });
      }
      if (occRow?.agent_id) await hintOnce(occRow.agent_id, [{ workId: taskId, text: LADDER_HINT.undelivered(title) }], `undelivered:${runId}`);
    } catch (err) {
      logger.warn('Scheduler: could not surface an undelivered run to the owner (non-fatal)', {
        taskId, runId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Close claims its trigger BY KEY: an unserved trigger row for this run retires now, not a turn later.
  retireEngineEventsForRun(runId);

  bumpWorkAttempts(taskId);

  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown>;
  const scheduledTask = scheduledTaskFromRow(task, { last_run_at: now });

  // The NEXT occurrence was written at claim time: honor it, and recompute only when the run overran its cadence
  // (the stored occurrence is already due or past), so passed slots never re-fire. NULL means no further runs.
  const storedNext = task.next_run_at as string | null;
  let nextRun: string | null = null;
  if (storedNext) {
    const storedMs = new Date(normalizeDbTimestamp(storedNext)).getTime();
    nextRun = !isNaN(storedMs) && storedMs > Date.now()
      ? storedNext
      : calculateNextRun(scheduledTask);
  }

  // The run is handed in for its worker: a run of a live schedule with scope `run` (the next run is never
  // held for a decision), the last run with scope `schedule`. A final run that failed is handed in as
  // can't be done, and the owner is told at once through the primary.
  const failedFinalRun = !nextRun && status === 'failed';
  const because = nextRun
    ? `scheduled run #${task.run_count as number} finished (${status}); the next run is at ${nextRun}`
    : `the final scheduled run #${task.run_count as number} ${failedFinalRun ? 'failed' : `finished (${status})`}${summary ? `: ${summary.slice(0, 200)}` : ''}`;
  const handed = engineHandIn(taskId, because, {
    scope: nextRun ? 'run' : 'schedule', outcome: failedFinalRun ? 'cant_be_done' : undefined,
    items: delivered && status !== 'failed' ? [{ kind: 'delivery', ref: delivered }] : undefined,
  });
  if (handed.kind === 'handed_in') {
    writeTaskLog({
      taskId, fromEntity: 'scheduler', entryKind: 'transition', fromStatus: 'in_progress', toStatus: 'handed_in',
      actionTaken: nextRun ? `scheduler ran #${task.run_count as number}, next at ${nextRun}` : `scheduler ran final run #${task.run_count as number}, no more runs`,
      reason: `run finished with status=${status}`, note: summary || null,
    });
  } else logger.info('Scheduler: the run was not handed in', { taskId, runId, why: handed.text.slice(0, 200) });

  if (nextRun) {
    noteUnsettled(setNextRun(taskId, {
      at: tsToMs(nextRun), alongside: { schedule_status: 'waiting', last_run_at: tsToMs(now) },
      reason: 'a run finished and the schedule has another occurrence',
    }), 'scheduler: run finished, waiting for the next occurrence', { taskId });
  } else {
    noteUnsettled(patchWork(taskId, { schedule_status: 'completed', last_run_at: tsToMs(now) }), 'scheduler: no more runs, schedule completed', { taskId });
  }
  if (failedFinalRun) {
    retireEngineEventsForTask(taskId, 'task_fallen');
    try {
      const title = String(task.title ?? 'untitled task');
      const noun = (task.kind as string | null) === 'reminder' ? 'reminder' : 'task';
      // A model-visible notice to the primary, which tells the owner in its own voice, and one to the worker.
      const when = (task.scheduled_start as string | null) ?? (task.anchor_time as string | null);
      const ownerMsg =
        `${OWNER_ALERT_HEADS_UP_PREFIX} a scheduled ${noun}, "${title}"${when ? ` (set for ${when})` : ''}, failed on its final attempt and was not delivered. ` +
        `Nothing more is scheduled for it, so it will not try again. Let me know if you want me to set it up again.`;
      const primaryId = getPrimaryAgentId();
      postAgentNotice({ toAgentId: primaryId, fromName: 'Scheduler', selfIntro: false, intent: 'schedule_run_failed_owner', brief: ownerMsg });
      try {
        getAgentRuntime().handleMessage(primaryId, '[scheduler: failed-run owner note pending]').catch((err) => {
          logger.warn('scheduler: failed-final-run owner note wake failed', { taskId, error: err instanceof Error ? err.message : String(err) });
        });
      } catch { /* runtime not ready, the notice is in the store, read next time */ }
      postAgentNotice({
        toAgentId: (task.assigned_to as string | null) ?? primaryId, fromName: 'Scheduler', selfIntro: false,
        intent: 'schedule_run_failed', brief: `I could not deliver a scheduled ${noun}: ${title.slice(0, 100)}`,
      });
    } catch (err) {
      logger.warn('scheduler: failed-final-run owner notice failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  broadcast({ type: 'task:run_complete', data: { taskId, runId, status, nextRun } });

  try {
    const { getTask } = await import('../tracker/schema.js');
    const updatedTask = getTask(taskId);
    if (updatedTask) {
      broadcast({ type: 'tracker:task_updated', data: updatedTask });
    }
  } catch { /* ignore */ }

  logger.info('Scheduler: run completed', { taskId, runId, status, nextRun });
  return true;
}

// A dropped reminder occurrence (its schedule terminated on 'fallen', or an orphaned run swept) is a reminder the
// owner asked for that will not happen. The heads-up is a model-visible NOTICE (role='user' origin_kind='engine')
// from the Scheduler subsystem (`selfIntro: false`), so the primary can relay it by iMessage when the owner is
// away: the platform detects, the agent speaks. The "Heads up:" prefix (`OWNER_ALERT_HEADS_UP_PREFIX`) is
// matched by the visibility rules and must stay.
export function postSkippedReminderHeadsUp(taskId: string, reason: string): void {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT title, task_kind AS kind, description, ${msToText('scheduled_start')} AS scheduled_start, anchor_local AS anchor_time FROM work WHERE id = ?`,
    ).get(taskId) as {
      title: string; kind: string | null; description: string | null;
      scheduled_start: string | null; anchor_time: string | null;
    } | undefined;
    if (!row || row.kind !== 'reminder') return;
    const what = (row.description && row.description.trim()) ? row.description.trim() : row.title;
    const when = row.scheduled_start ?? row.anchor_time;
    const ownerMsg =
      `${OWNER_ALERT_HEADS_UP_PREFIX} I skipped a reminder${when ? ` (set for ${when})` : ''}, "${what}", because ${reason}. ` +
      `Let me know if you still want it and I will set it up again.`;
    const primaryId = getPrimaryAgentId();
    postAgentNotice({
      toAgentId: primaryId,
      fromName: 'Scheduler',
      selfIntro: false,
      intent: 'reminder_skipped_owner',
      brief: ownerMsg,
    });
    // Wake the primary so it relays this turn rather than on an unrelated trigger; best-effort, since the notice
    // is already persisted and surfaces on the next assembled context.
    try {
      const runtime = getAgentRuntime();
      runtime.handleMessage(primaryId, '[scheduler: skipped-reminder note pending]').catch((err) => {
        logger.warn('postSkippedReminderHeadsUp: primary wake failed', {
          taskId, error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch { /* runtime not ready, the notice is in the store and is read next time */ }
  } catch (err) {
    logger.warn('postSkippedReminderHeadsUp failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// A task marked 'fallen' must never fire again, but the due query filters on schedule_status/is_paused, not
// status, so a 'fallen' transition alone leaves the schedule armed. Terminate it here: stop the schedule
// (schedule_status='completed', is_paused=1, drop next_run_at), close any open run as 'skipped', and for a
// reminder tell the owner. Synchronous so callers report the outcome in the same tool result; returns whether a
// live schedule was terminated and how many runs were skipped.
export function terminateLiveScheduleOnFallen(
  taskId: string,
  reason = 'the task was marked fallen (given up on)',
  // The trail line the owner reads; cancellation call sites pass their own wording.
  actionTaken = 'schedule terminated on fallen',
): { terminated: boolean; runsSkipped: number; isReminder: boolean } {
  const db = getDb();
  const row = db.prepare(
    'SELECT title, task_kind AS kind, schedule_status FROM work WHERE id = ?',
  ).get(taskId) as { title: string; kind: string | null; schedule_status: string } | undefined;
  if (!row) return { terminated: false, runsSkipped: 0, isReminder: false };
  const isReminder = row.kind === 'reminder';
  // Only 'waiting' (armed) and 'running' (a run in flight) schedules can still fire.
  const scheduleIsLive = row.schedule_status === 'waiting' || row.schedule_status === 'running';
  if (!scheduleIsLive) return { terminated: false, runsSkipped: 0, isReminder };

  const stopped = { changes: clearLiveSchedule(taskId) ? 1 : 0 };
  if (stopped.changes !== 1) {
    // Raced with another terminator; leave the winner's outcome intact.
    return { terminated: false, runsSkipped: 0, isReminder };
  }

  // The count is quoted to the owner below and gates the reminder heads-up.
  const runsSkipped = skipOpenOccurrences(taskId, reason);

  writeTaskLog({
    taskId,
    fromEntity: 'engine',
    entryKind: 'auto_sweep',
    actionTaken,
    reason: `${reason}; schedule stopped so it cannot fire again${runsSkipped > 0 ? `, ${runsSkipped} open run(s) skipped` : ''}`,
  });

  if (isReminder && runsSkipped > 0) {
    postSkippedReminderHeadsUp(taskId, reason);
  }

  try {
    const fresh = getTask(taskId);
    if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  } catch { /* dashboard refresh is best-effort */ }

  logger.warn('Scheduler: terminated live schedule on fallen transition', {
    taskId, title: row.title, runsSkipped,
  });
  return { terminated: true, runsSkipped, isReminder };
}


/** Auto-fail in-flight occurrences whose assigned agent is terminated, so the task can move on. */
export function cleanupOrphanedRuns(): void {
  const orphans = sweepTerminatedAgentOccurrences();

  if (orphans.length === 0) return;

  logger.info(`Scheduler: cleaning up ${orphans.length} orphaned run(s)`);

  for (const orphan of orphans) {
    // Do not settle the occurrence before this call: onTaskRunComplete finds the run by its open state. 'failed'
    // because a dead run did not succeed: a one-shot takes the failedFinalRun branch, a recurring one advances.
    onTaskRunComplete(orphan.taskId, 'failed', 'Auto-failed: assigned agent was terminated before the run completed').catch(err => {
      logger.error('Scheduler: orphan cleanup failed for task', {
        taskId: orphan.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/** Safety net: fail runs stuck 'running' whose agent has been silent 30+ minutes. */
export function cleanupStaleRuns(): void {
  const db = getDb();
  const AGENT_IDLE_THRESHOLD_MINUTES = 30;
  // The longer stuck cliff, HARD_STUCK_THRESHOLD_MINUTES, lives in `agent/stuck-thresholds.ts`.

  // Orphaned occurrences: the recovery below keys on TASKS (schedule_status='running'), so it cannot see runs
  // orphaned when a path reset the task row without closing the run. A legitimately in-flight run always has its
  // parent at schedule_status='running' (the claim sets both atomically, and close-out closes the run BEFORE
  // moving schedule_status), so any open run whose parent is not running is an orphan and is closed 'skipped'.
  // Silent by design (no owner heads-up), with a short age guard so it does not race an in-flight advance.
  sweepOrphanedOccurrences();

  // 1. Stale-running detection: the NEWEST evidence of life decides (the later of the agent's last message and the
  // row's `updated_at`), because `work.updated_at` only moves on an explicit work_* write and a run that emits
  // messages without calling a tracker tool is alive. Catches a recurring run the agent finished without
  // calling work_update(action="status").
  const staleTasksRaw = db.prepare(`
    SELECT t.id AS id, t.title AS title, t.agent_id AS assigned_to
    FROM work t
    WHERE ${taskScope('t')} AND t.schedule_status = 'running'
      AND NOT ${heldExpr('t', 'paused')}
      AND t.agent_id IS NOT NULL
      AND MAX(
        COALESCE(
          (SELECT MAX(m.created_at) FROM messages m WHERE m.agent_id = t.agent_id),
          t.updated_at
        ),
        t.updated_at
      ) < ?
  `).all(Date.now() - AGENT_IDLE_THRESHOLD_MINUTES * 60_000) as Array<{ id: string; title: string; assigned_to: string }>;

  // A run this process is actively executing is not stale, whatever the clocks say: `activeRuns` is checked before
  // any verdict is written, and the decline is logged so a human can see the reaper choosing not to act.
  // Force-failing a live run would re-schedule the row and could dispatch a SECOND run of the same task.
  const staleTasks = staleTasksRaw.filter((t) => {
    if (!activeRuns.has(t.assigned_to)) return true;
    logger.info('cleanupStaleRuns: declining to fail a task whose agent is RUNNING right now', {
      taskId: t.id, agentId: t.assigned_to, thresholdMinutes: AGENT_IDLE_THRESHOLD_MINUTES,
    });
    return false;
  });

  // 2. Also catch running tasks with no assigned agent at all
  const unassigned = db.prepare(`
    SELECT t.id AS id, t.title AS title
    FROM work t
    WHERE ${taskScope('t')} AND t.schedule_status = 'running'
      AND NOT ${heldExpr('t', 'paused')}
      AND t.agent_id IS NULL
      AND t.last_run_at < ?
  `).all(Date.now() - 5 * 60_000) as Array<{ id: string; title: string }>;

  // 3. Recurring tasks in state 'claimed' whose schedule_status is NOT 'running' (an out-of-sync row): the filter
  // above misses them and onTaskRunComplete bails with no active run, so they are force-reset directly.
  const stuckOutOfSyncRaw = db.prepare(`
    SELECT t.id AS id, t.title AS title, t.agent_id AS assigned_to
    FROM work t
    WHERE ${taskScope('t')} AND t.state = 'claimed'
      AND t.repeat_interval IS NOT NULL
      AND (t.schedule_status IS NULL OR t.schedule_status != 'running')
      AND t.is_paused = 0
      AND t.updated_at < ?
  `).all(Date.now() - HARD_STUCK_THRESHOLD_MINUTES * 60_000) as Array<{ id: string; title: string; assigned_to: string | null }>;

  // The same liveness guard as the 30-minute arm: this arm reads only `t.updated_at`, which a tracker-tool-quiet
  // run never moves, so an actively running task must not be force-recovered.
  const stuckOutOfSync = stuckOutOfSyncRaw.filter((t) => {
    if (!t.assigned_to || !activeRuns.has(t.assigned_to)) return true;
    logger.info('cleanupStaleRuns: declining to force-recover a recurring task whose agent is RUNNING right now', {
      taskId: t.id, agentId: t.assigned_to, thresholdMinutes: HARD_STUCK_THRESHOLD_MINUTES,
    });
    return false;
  });

  // 4. Recurring tasks with full repeat config but no next_run_at (partial schedules): the due scan's
  // `next_run_at <= now` filter excludes NULL, so they never fire. They are recomputed and restored, or finished.
  const missingNextRun = db.prepare(`
    SELECT t.id AS id, t.title AS title
    FROM work t
    WHERE ${taskScope('t')} AND t.repeat_interval IS NOT NULL
      AND t.repeat_unit IS NOT NULL
      AND t.next_run_at IS NULL
      AND t.is_paused = 0
      AND t.state NOT IN ('done', 'failed', 'abandoned', 'handed_in')
      AND t.schedule_status != 'completed'
      AND t.schedule_status != 'running'
  `).all() as Array<{ id: string; title: string }>;

  const allStale = [
    ...staleTasks.map(t => ({ id: t.id, title: t.title, reason: `assigned agent produced nothing for ${AGENT_IDLE_THRESHOLD_MINUTES}+ minutes and is not running now`, kind: 'stale_running' as const })),
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
      // onTaskRunComplete fails the active run, advances run_count and computes nextRun; when the run record is
      // already terminal it bails, and the forceResetStuckRecurringTask call after it handles the row directly.
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
      // Recompute inline with calculateNextRun: forceResetStuckRecurringTask bails on non-in_progress rows.
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
 * Recompute next_run_at on a recurring task that has repeat config but a NULL next_run_at, so the due scan can
 * see it again. A future time restores the schedule; null (uncomputable, or no future slot) hands it in.
 */
function recoverMissingNextRun(taskId: string): void {
  const db = getDb();
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return;
  if (task.next_run_at) return; // raced with another recovery path
  if (task.is_paused) return;
  // The final run of a bounded schedule has no next run while it is in flight; that is not a lost schedule.
  if (task.schedule_status === 'running') return;

  const scheduledTask = scheduledTaskFromRow(task, {
    is_paused: 0,
    next_run_at: null,
    schedule_status: (task.schedule_status as string) ?? 'waiting',
  });

  const nextRun = calculateNextRun(scheduledTask);
  if (nextRun) {
    noteUnsettled(setNextRun(taskId, {
      at: tsToMs(nextRun), alongside: { schedule_status: 'waiting' },
      reason: 'a recurring row carried its repeat config with no fire time; recomputed so it can be seen again',
    }), 'scheduler: missing next_run_at recovered', { taskId });
    if (task.status !== 'on_deck' && task.status !== 'in_progress') {
      noteUnsettled(setTrackerStatus(taskId, 'on_deck', {
        by: 'scheduler', actorId: 'scheduler',
        reason: 'recovered a recurring task whose next run was missing',
      }), 'scheduler: recovered a missing next run', { taskId });
    }
    logger.warn('Scheduler: recovered recurring task with missing next_run_at', {
      taskId, title: task.title, nextRun,
    });
  } else {
    engineHandIn(taskId, 'the schedule has no run left to fire: its repeat config yields no future occurrence', { scope: 'schedule', outcome: 'cant_be_done' });
    noteUnsettled(patchWork(taskId, { schedule_status: 'completed' }), 'scheduler: missing next_run_at had no future occurrence, schedule completed', { taskId });
    logger.warn('Scheduler: recurring task had no recoverable next run; handed in for its worker', { taskId, title: task.title });
  }

  // Re-broadcast the fresh FULL task row (a partial payload would blow away the card's other fields).
  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
}

/**
 * Force-reset a recurring task stuck at status='in_progress' with no way out through onTaskRunComplete (its
 * active run is already terminal or its schedule_status is out of sync). Recomputes the next run and writes the
 * status/schedule_status directly. Idempotent: skips if the task is no longer in_progress.
 */
export function forceResetStuckRecurringTask(taskId: string): void {
  const db = getDb();
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return;
  if (task.status !== 'in_progress') return;
  if (!task.repeat_interval) return;

  const scheduledTask = scheduledTaskFromRow(task);

  const nextRun = calculateNextRun(scheduledTask);
  if (nextRun) {
    noteUnsettled(setTrackerStatus(taskId, 'on_deck', {
      by: 'scheduler', actorId: 'scheduler',
      reason: 'this run is failed; the schedule rejoins at its next occurrence',
    }), 'scheduler: failed run rejoins at next occurrence', { taskId });
    noteUnsettled(setNextRun(taskId, {
      at: tsToMs(nextRun), alongside: { schedule_status: 'waiting' },
      reason: 'a structurally stuck recurring row was force-reset onto its next occurrence',
    }), 'scheduler: stuck recurring task reset onto its next occurrence', { taskId });
    logger.warn('Scheduler: force-reset stuck recurring task to on_deck/waiting', { taskId, title: task.title, nextRun });
  } else {
    engineHandIn(taskId, 'the stuck recurring task has no future run left', { scope: 'schedule', outcome: 'cant_be_done' });
    if (task.schedule_status !== 'completed') noteUnsettled(patchWork(taskId, { schedule_status: 'completed' }), 'scheduler: stuck recurring task had no next occurrence, schedule completed', { taskId });
    logger.warn('Scheduler: force-reset stuck recurring task with no future runs; handed in for its worker', { taskId, title: task.title });
  }

  // Re-broadcast the fresh FULL task row so the kanban card reflects the force-reset.
  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
}

// Finished tasks are never pruned: deleting work history needs the owner's say-so. The task list is paged.

/** Lift every paused hold whose resume time (`paused_until`) has passed. */
export function resumeExpiredPauses(): void {
  const expired = getDb().prepare(`
    SELECT w.id AS id FROM work w
    WHERE ${taskScope('w')} AND ${heldExpr('w', 'paused')} AND w.paused_until IS NOT NULL AND w.paused_until <= ?
  `).all(Date.now()) as Array<{ id: string }>;
  for (const { id } of expired) {
    if (!clearHold(id, 'scheduler')) continue;
    logger.info('Auto-resumed paused task (pause expired)', { taskId: id });
    const fresh = getTask(id);
    if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  }
}
