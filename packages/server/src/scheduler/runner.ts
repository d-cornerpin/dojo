// Task scheduler runner: finds due tasks and triggers their execution.
// Model-directed text from this file rides NOTICE (postAgentNotice, role='user' origin_kind='engine'), never
// role='system', which the model-context builder strips; bare role='system' rows here are dashboard-only notes.

import { v4 as uuidv4 } from 'uuid';
import { retireEngineEventsForRun, retireEngineEventsForTask } from '../agent/v2/counterparty.js';
import { getDb } from '../db/connection.js';
import { HARD_STUCK_THRESHOLD_MINUTES } from '../agent/stuck-thresholds.js';
import {
  taskScope, dueScope, msToText, tsToMs, scheduleRowColumns,
} from '../work/tracker-view.js';
import { patchWork, setTrackerStatus, bumpWorkAttempts } from '../work/tracker-store.js';
import { engineHandIn } from '../work/done/hand-in.js';
import { clearHold, heldExpr } from '../work/done/hold.js';
import { setNextRun, clearLiveSchedule } from '../work/next-run.js';
import { noteUnsettled } from '../work/store.js';
import { RUN_STATUS_INCOMPLETE } from '../work/measure-close-gate.js';
import {
  claimOccurrence, settleOccurrence, occurrenceOf, inFlightOccurrence,
  assignOccurrence, skipOpenOccurrences, sweepOrphanedOccurrences,
  sweepTerminatedAgentOccurrences, runsReadyToCloseOnDelivery, RUN_STATUS_UNDELIVERED,
} from '../work/occurrences.js';
import { proofDelivery } from '../work/done/proof.js';
import { hintOnce, LADDER_HINT } from '../work/done/ladder.js';
import { recordFloorGhost } from '../agent/v2/floor-ghost.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getTask } from '../tracker/schema.js';
import { resumeSchedule } from '../tracker/tools.js';
import { formatTimeForAgent } from '../services/format-time.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { calculateNextRun, normalizeDbTimestamp, scheduledTaskFromRow, parseDaysOfWeek } from './engine.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { recordMove } from '../work/move-record.js';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { tellOwner, ownerToldOf, ownerConditionCleared, TOLD } from '../healer/owner-notices.js';
import { renderInstant } from '../memory/message-stamp.js';
import { PROCESS_STARTED_AT } from '../work/inherited-backlog.js';
// The liveness fact every reaper guards on: a run that is still executing must never be force-failed.
import { activeRuns } from '../agent/shared-state.js';

const logger = createLogger('scheduler');

/** Approximate ms per interval (months and years approximate by design): how long one missed run stays recent.
 *  A specific-days schedule uses its longest gap between allowed days (a Mondays-only task: a week). */
function intervalApproxMs(row: Record<string, unknown>): number | null {
  const interval = row.repeat_interval as number | null;
  const DAY = 86_400_000;
  if (row.repeat_unit === 'specific_days') {
    const d = [...(parseDaysOfWeek(row.repeat_days_of_week as string | null) ?? [])].sort();
    return d.length ? DAY * Math.max(...d.map((x, i) => (d[(i + 1) % d.length]! - x + 7) % 7 || 7)) : DAY;
  }
  if (!interval) return null;
  switch (row.repeat_unit) {
    case 'minutes': return interval * 60_000;
    case 'hours': return interval * 3_600_000;
    case 'days': return interval * DAY;
    case 'weeks': return interval * 7 * DAY;
    case 'months': return interval * 30 * DAY;
    case 'years': return interval * 365 * DAY;
    case 'weekdays': return DAY;
    default: return null;
  }
}

/** A run firing this long after its time was missed (the Dojo was off, the Mac asleep, the task on hold). */
const LATE_MS = 5 * 60_000;
const MISSED_COUNT_CAP = 100;
interface Missed { count: number; recentMs: number | null; cause: string }

/** A late repeating task's missed runs: how many (counted up to the cap), the one younger than one interval, and why. */
function missedRuns(row: Record<string, unknown>, nowMs: number, intervalMs: number): Missed {
  const after = (fromMs: number): number | null => tsToMs(calculateNextRun(scheduledTaskFromRow(row, {
    is_paused: 0, next_run_at: null, last_run_at: new Date(fromMs).toISOString(),
  }), undefined, fromMs));
  const firstMs = occurrenceOf(row)!;
  let count = 0;
  for (let s: number | null = firstMs; s !== null && s <= nowMs && count < MISSED_COUNT_CAP; s = after(s)) count++;
  const recent = after(nowMs - intervalMs);
  const held = getDb().prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'audit'
    AND json_extract(payload, '$.entry_kind') = 'hold_cleared' AND created_at >= ?`).get(row.id, firstMs);
  const cause = held ? 'the task was on hold'
    : firstMs < (tsToMs(PROCESS_STARTED_AT) ?? 0) ? 'the Dojo was not running' : 'the Mac was asleep or the Dojo was busy';
  return { count, recentMs: recent !== null && recent <= nowMs ? recent : null, cause };
}

/** Records the decision on the task's history and the log, then tells the owner on one card per task. Its count is
 *  the runs recorded since the card was told; once he has seen or dismissed it, the next miss starts a new count. */
function tellMissedRuns(row: Record<string, unknown>, nowMs: number, m: Missed, done: string): void {
  const taskId = row.id as string;
  const title = (row.title as string | null) ?? 'A scheduled task';
  writeTaskLog({ taskId, fromEntity: 'scheduler', entryKind: 'auto_sweep', reason: m.cause, evidenceJson: JSON.stringify({ missed: m.count }),
    actionTaken: m.recentMs === null ? `skipped ${m.count} missed runs` : `caught up the run due ${renderInstant(m.recentMs)}, skipped any older ones` });
  logger.warn('Scheduler: missed runs', { taskId, title, missed: m.count, cause: m.cause, decision: m.recentMs === null ? 'skipped' : 'caught_up', catchUpDue: m.recentMs });
  const key = `missedruns:${taskId}`;
  if (!ownerToldOf(key)) ownerConditionCleared(key);
  const since = (getDb().prepare('SELECT at_ms FROM healer_state WHERE scope = ? AND key = ?').get(TOLD, key) as { at_ms: number } | undefined)?.at_ms ?? nowMs;
  const { n } = getDb().prepare(`SELECT COALESCE(SUM(json_extract(json_extract(payload, '$.evidence_json'), '$.missed')), 0) AS n FROM work_events
    WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'auto_sweep' AND created_at >= ?`).get(taskId, since) as { n: number };
  tellOwner(key, `"${title}" missed ${n}${m.count >= MISSED_COUNT_CAP ? ' or more' : ''} scheduled run${n === 1 ? '' : 's'} because ${m.cause}. ${done}`);
}


// A run whose task owes a person a message, that delivered it and never handed the run in, is closed on
// that delivery once its own turn has ended (`runsReadyToCloseOnDelivery`), through the ordinary flow.
export async function closeRunsThatDelivered(): Promise<number> {
  let closed = 0;
  for (const row of runsReadyToCloseOnDelivery()) {
    try { await (await import('../agent/tools/cat/measure-door.js')).remeasureTask('scheduler', row.taskId); }   // judge the run on a fresh reading
    catch (err) { logger.warn('Scheduler: re-reading a delivered run\'s measure failed; left for the next tick', { taskId: row.taskId, runId: row.occurrenceId, error: String(err) }); continue; }   // one row never stops the sweep
    logger.info('Scheduler: a run delivered, closing it on the message', { taskId: row.taskId, runId: row.occurrenceId, deliveryId: row.deliveryId });
    if (row.handedIn) { (await import('../work/done/effects.js')).onHandedIn(row.taskId, undefined, true); closed += 1; continue; }
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
  // `steered-run-delivery-close` (closeRunsThatDelivered). Nothing the reaper runs is a precondition of the scan:
  // the occurrence claim is a UNIQUE constraint.

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

    // A repeating task that already ran and is late missed runs (a never-run task is a first fire, not a miss).
    // With none younger than one interval they are all skipped; else the claim below runs the recent one.
    const intervalMs = intervalApproxMs(taskRow);
    const dueMs = occurrenceOf(taskRow);
    const missed = intervalMs && runCount > 0 && dueMs !== null && nowMs - dueMs > LATE_MS ? missedRuns(taskRow, nowMs, intervalMs) : null;
    if (missed && missed.recentMs === null) {
      const next = resumeSchedule(taskId, 'missed runs older than one interval; skipped to the next scheduled time');
      tellMissedRuns(taskRow, nowMs, missed, `None was recent enough to run, so they were skipped. The next run is ${renderInstant(tsToMs(next)) ?? 'not set'}.`);
      continue;
    }

    const dependsOnRaw = taskRow.depends_on as string | null;
    if (dependsOnRaw) {
      try {
        const deps = JSON.parse(dependsOnRaw) as string[];
        if (deps.length > 0) {
          const rows = deps.map((depId) => db.prepare('SELECT state, title FROM work WHERE id = ?').get(depId) as { state: string; title: string | null } | undefined);
          // A dead earlier step is handed in by the reaper's `steps-after-a-dead-step`; until then this waits like any unmet step.
          const incomplete = deps.filter((_, i) => rows[i]?.state !== 'done');
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
      nowMs, nextRunMs: tsToMs(nextAtFire), scheduledForMs: missed?.recentMs,
      agentId: (taskRow.assigned_to as string | null) ?? 'scheduler',
    });
    if (!occurrenceId) {
      logger.info('Scheduler: occurrence already claimed elsewhere, skipping', { taskId, occurrence: claimedOccurrence, sequence: runNumber });
      continue;
    }
    if (missed) tellMissedRuns(taskRow, nowMs, missed, `The Dojo ran the one due ${renderInstant(missed.recentMs)} now to catch up and skipped any older ones.`);
    noteUnsettled(setTrackerStatus(taskId, 'in_progress', {
      by: 'scheduler', actorId: 'scheduler',
      reason: `scheduled occurrence ${claimedOccurrence} fired`,
    }), 'scheduler: occurrence fired', { taskId });

    // The occurrence id IS the run id (the lineage key `retireEngineEventsForRun` sweeps by).
    const runId = occurrenceId;

    let assignedAgent = (taskRow.assigned_to as string | null) ?? getPrimaryAgentId();

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
    // A run firing well after its time (the Mac was asleep or off) says so, so it is not passed off as on time.
    const late = missed ? `, late: a catch-up of the run due ${formatTimeForAgent(missed.recentMs!)}`
      : claimedOccurrenceMs !== null && nowMs - claimedOccurrenceMs > LATE_MS ? `, late: it was due ${formatTimeForAgent(claimedOccurrenceMs)}` : '';

    // Reminders get a lighter prompt: one conversational delivery in the agent's normal voice, then a silent close.
    // The wake asks for the reply ALONE and the bookkeeping in the NEXT response, because text emitted in the same
    // response as a tool call is demoted to working notes (post-call-classify/terminal-text.ts) and never heard.
    const message = taskKind === 'reminder'
      ? `[Reminder due${late}] ${taskDesc ?? taskTitle}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nDeliver this reminder to the owner now as a single short chat message in your normal voice. Do NOT prefix with "Reminder:" or "Here's your reminder", just say the thing naturally (e.g. the owner asked to be reminded to "go get coffee" → "Hey, time to go get coffee."). Say it as a SEPARATE response with no tool call in it: text that rides along with a tool call is treated as working notes and never reaches the owner. Then, in your NEXT response, silently call work_update(action="status") with task_id="${taskId}" and status="complete". That status call is internal bookkeeping; do NOT write any owner-facing message about marking the reminder complete ("Task closed", "All done", "Marked complete"). The reminder message itself is the entire owner-facing output.`
      : `[Scheduled Task, Run #${runNumber}${totalRuns}${late}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nWhen this run is finished, hand it in: work_update(action="hand_in") with task_id="${taskId}" and its proof. That call is internal bookkeeping; do NOT write any owner-facing message about marking the task complete (e.g. "Task closed", "All done", "Marked complete"). The owner already received your reminder/output above; an extra "task closed" line is just noise.`;

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
  // writes the durable row, owner-alert system note and health frame. ONE alert per run: a run already ghosted
  // stays quiet.
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
  // held for a decision), the last run with scope `schedule`, in the words the run was recorded with. A run left
  // incomplete is handed in as can't be done on its count; a failed final run too, and the owner is told at once.
  const failedFinalRun = !nextRun && status === 'failed';
  const incomplete = settled.runStatusRecorded === RUN_STATUS_INCOMPLETE;
  const ran = incomplete ? `${RUN_STATUS_INCOMPLETE}: ${settled.detail}` : settled.runStatusRecorded;
  const because = nextRun
    ? `scheduled run #${task.run_count as number} finished (${ran}); the next run is at ${nextRun}`
    : `the final scheduled run #${task.run_count as number} ${failedFinalRun ? 'failed' : `finished (${ran})`}${summary ? `: ${summary.slice(0, 200)}` : ''}`;
  const handed = engineHandIn(taskId, because, {
    scope: nextRun ? 'run' : 'schedule', outcome: failedFinalRun || incomplete ? 'cant_be_done' : undefined,
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

/** Lift every pause whose resume time (`paused_until`) has passed: a paused hold, or a paused schedule. */
export function resumeExpiredPauses(): void {
  const expired = getDb().prepare(`
    SELECT w.id AS id, w.is_paused AS is_paused FROM work w
    WHERE ${taskScope('w')} AND (${heldExpr('w', 'paused')} OR (w.is_paused = 1 AND w.schedule_status != 'completed'))
      AND w.paused_until IS NOT NULL AND w.paused_until <= ?
  `).all(Date.now()) as Array<{ id: string; is_paused: number }>;
  for (const { id, is_paused } of expired) {
    if (is_paused) {
      resumeSchedule(id, 'the schedule\'s pause reached its resume time');
      continue;
    }
    if (!clearHold(id, 'scheduler')) continue;
    logger.info('Auto-resumed paused task (pause expired)', { taskId: id });
    const fresh = getTask(id);
    if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  }
}
