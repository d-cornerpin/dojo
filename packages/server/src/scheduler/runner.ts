// ════════════════════════════════════════
// Task Scheduler Runner (Phase 6)
// Checks for due tasks and triggers execution
//
// DEAD-CHANNEL DOCTRINE (RC-19 / demolition Phase 0): model-directed text from this
// subsystem rides NOTICE (postAgentNotice, role='user' origin_kind='engine', VISIBLE
// to the model), never role='system' (STRIPPED by the model-context builder). Bare
// role='system' rows here may carry only dashboard/owner-only informational notes,
// never an imperative the model is expected to ACT on. The RC-19 conformance test
// (agent/v2/__tests__/engine-steer.test.ts) source-scans this file for bare
// role='system' INSERTs carrying imperative model-directed text.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { retireEngineEventsForRun, retireEngineEventsForTask } from '../agent/v2/counterparty.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getTask } from '../tracker/schema.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { calculateNextRun, normalizeDbTimestamp, type ScheduledTask } from './engine.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { insertInterAgentEngineRow } from '../memory/interagent.js';
import { insertMessage } from '../memory/message-store.js';
import { getPrimaryAgentId, getPMAgentId, getOwnerName } from '../config/platform.js';

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

  // Pause the task while the agent decides (prevents re-firing on every
  // scheduler tick). The agent's resolve call will unpause + apply the
  // chosen action. D12: stamp missed_runs_paused_at so the engine can
  // deterministically auto-resolve as SKIP when nothing resolves this
  // pause within MISSED_RUNS_AUTO_RESOLVE_MINUTES; the model tool clears
  // the stamp on every action and therefore takes precedence when called
  // first. The UPDATE is guarded on is_paused = 0 so overlapping ticks or
  // processes pause and notify exactly once.
  //
  // Demolition Phase 1 (two-key restoration): this pause lands UNVALIDATED
  // (pause_validated stays 0). It used to stamp pause_validated=1, an
  // engine pre-blessing that made the pause authoritative so the PM's two-key
  // validation could never re-flag it. Per the restoration, no engine path
  // pre-blesses: the pause lands unvalidated so the PM sweep SEES it and can
  // adjudicate it (validate or reject). The engine still OWNS the resolution of
  // this specific pause via D12: autoResolveStaleMissedRunPauses keys ONLY on
  // is_paused + missed_runs_paused_at (never pause_validated) and skips to the
  // next future anchor within MISSED_RUNS_AUTO_RESOLVE_MINUTES, so it is a
  // transient pause, not a forever-unvalidated dangler. The OWNER-facing
  // validation sweep (sweepUnvalidatedTasksForUserEscalation) still skips it via
  // its missed_runs_paused_at guard (now load-bearing, see there), so the owner
  // is never asked to validate an engine missed-runs pause; the PM is the one
  // that sees and adjudicates it. The PM sweep's stableId dedup keeps this from
  // pathological re-poking.
  const paused = db.prepare(`
    UPDATE tasks
    SET is_paused = 1, schedule_status = 'paused', status = 'paused',
        missed_runs_paused_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ? AND is_paused = 0
  `).run(taskId);
  if (paused.changes === 0) {
    logger.info('Scheduler: missed-runs pause already set elsewhere, skipping duplicate alert', { taskId });
    return;
  }

  const cadence = repeatInterval && repeatUnit
    ? (repeatInterval === 1 ? `every ${repeatUnit.replace(/s$/, '')}` : `every ${repeatInterval} ${repeatUnit}`)
    : 'recurring';

  // comms-audit rank 9: this used to dump a role='system' block — cadence, anchor, last
  // run, current time, likely cause, plus a FOUR-option resolution matrix each with a
  // 2-line explanation and a call template — into the agent's messages + dashboard chat.
  // Worse than verbose: role='system' is SKIPPED by the model-context builder, so the
  // woken agent's MODEL never saw the alert and could never call tracker_resolve_missed_runs
  // — the whole resolve flow was silently broken (a correctness bug). Now a brief, model-
  // visible awareness note (role='user' origin_kind='engine'); the run_now/skip/pause option
  // semantics live just-in-time in the tracker_resolve_missed_runs tool description the
  // agent reads WHEN it calls the tool.
  postAgentNotice({
    toAgentId: assignedAgent,
    fromName: 'Scheduler',
    selfIntro: false,
    intent: 'scheduler_missed_runs',
    brief: `Your recurring task "${taskTitle}" (${cadence}) missed ${missedSlots} run${missedSlots === 1 ? '' : 's'} while the box was offline or paused, so I auto-paused it. Call tracker_resolve_missed_runs(task_id="${taskId}", action="run_now"|"skip"|"pause"): action="run_now" fires one catch-up run now, action="skip" jumps to the next scheduled slot, action="pause" leaves it paused. The action argument is required.`,
  });

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
      // Re-select the FULL row so the board doesn't blank every other column on
      // this card (a 2-field partial under `data:` cleared the guard but wiped
      // the rest of the kanban card until reload). Same idiom as the resume path.
      const freshBlocked = getTask(t.id);
      if (freshBlocked) bcast({ type: 'tracker:task_updated', data: freshBlocked });
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
    // OWNER-SCOPE RULE (owner ruling, 2026-07-18): the ask-the-user escalation
    // exists for USER-meaningful work: the user asked for something, the PM
    // cannot verify it, so the user adjudicates. Engine-resident maintenance
    // (dreamer archive batches, healer/trainer/imaginer housekeeping, PM
    // self-tasks) is categorically NOT the user's to sign off: the user has no
    // way to know whether an archive batch distilled correctly, and the engine
    // holds its own receipts (the dream report records archives processed).
    // Those tasks stay in the PM sweep's jurisdiction and NEVER escalate here.
    // Production incident: first boot on the release that made this sweep's
    // channel visible surfaced stale churn-era dreamer tasks to the owner as
    // "was it actually done?" yes/no questions the owner cannot answer.
    const { getSystemServiceAgentIds } = await import('../config/platform.js');
    const serviceIds = getSystemServiceAgentIds().filter((id): id is string => Boolean(id));
    // Impossible-sentinel fallback so an empty list yields NOT IN ('__none__'),
    // which matches nothing (a bare '' would wrongly exclude NULL assignees via
    // the COALESCE below).
    const serviceParams = serviceIds.length > 0 ? serviceIds : ['__none__'];
    const servicePlaceholders = serviceParams.map(() => '?').join(',');
    const stale = db.prepare(`
      SELECT id, title, status, assigned_to, datetime(updated_at) as updated
      FROM tasks
      WHERE validation_escalated_at IS NULL
        AND awaiting_user_verdict = 0
        AND COALESCE(assigned_to, '') NOT IN (${servicePlaceholders})
        AND COALESCE(created_by, '') NOT IN (${servicePlaceholders})
        AND (
          (status = 'complete' AND complete_validated = 0)
          -- An active missed_runs_paused_at means the ENGINE paused this task for
          -- missed runs (alertMissedRuns), not the agent. Demolition Phase 1
          -- stopped alertMissedRuns pre-blessing it (it now lands
          -- pause_validated=0), so this missed_runs_paused_at guard is now
          -- LOAD-BEARING (no longer belt-and-suspenders): without it, this
          -- OWNER-facing sweep would ask the owner to validate an engine
          -- missed-runs pause, which is not the owner's call. The PM sweep is the
          -- one that adjudicates that unvalidated pause; the ENGINE still owns its
          -- resolution via D12 (autoResolveStaleMissedRunPauses, keyed on
          -- missed_runs_paused_at) within 10 minutes. Genuine agent pauses carry
          -- no missed_runs_paused_at, so they still escalate to the owner here.
          OR (status = 'paused' AND pause_validated = 0 AND missed_runs_paused_at IS NULL)
          OR (status = 'blocked' AND blocked_validated = 0)
        )
        AND datetime(updated_at) < datetime('now', '-${VALIDATION_ESCALATION_MIN} minutes')
      LIMIT 20
    `).all(...serviceParams, ...serviceParams) as Array<{ id: string; title: string; status: string; assigned_to: string | null; updated: string }>;
    if (stale.length === 0) return;

    const { writeTaskLog } = await import('../tracker/task-log.js');
    const { broadcast } = await import('../gateway/ws.js');
    const stamp = db.prepare(`
      UPDATE tasks SET validation_escalated_at = datetime('now'), validation_thread_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const primaryId = getPrimaryAgentId();
    const { v4: uuidv4 } = await import('uuid');

    // P5b: validation_thread_id becomes REAL. Written since 2026-06-01 and
    // read by nothing, it now records the CONVERSATION the verdict ask goes
    // to (the owner's dashboard conversation), so the apply side can verify
    // the reply came from where the question was asked.
    const { resolveOrCreateConversation } = await import('../memory/conversations.js');
    const ownerConvId = resolveOrCreateConversation(primaryId, {
      channel: 'dashboard', provider: null, counterpartyId: 'owner', threadRoot: null,
    });
    for (const t of stale) {
      const threadId = ownerConvId ?? uuidv4();
      const agentName = t.assigned_to
        ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(t.assigned_to) as { name: string } | undefined)?.name ?? t.assigned_to
        : 'an agent';
      const askText =
        `[VALIDATION CHECK] Task "${t.title}" (id=${t.id}) was marked ${t.status} by ${agentName} ${VALIDATION_ESCALATION_MIN}+ minutes ago, ` +
        `but the PM agent has not validated it. ` +
        `${getOwnerName()}, is this actually ${t.status === 'complete' ? 'done' : t.status}? Reply yes/no with any context. ` +
        `\n\n` +
        `**Primary agent**: when ${getOwnerName()} replies, call tracker_apply_user_validation(task_id="${t.id}", validated=<true if yes / false if no>, user_quote="<the user's exact reply>", feedback="<optional details if validated=false>"). ` +
        `validated=true clears the bug icon; validated=false reverts to in_progress and notifies the assigned agent with the user's feedback.`;

      // Dead-channel demolition (Phase 0.2): deliver the validation question AND the
      // primary's tracker_apply_user_validation instruction as a model-VISIBLE
      // awareness NOTICE (role='user' origin_kind='engine'), the same idiom
      // alertMissedRuns uses above, NOT a bare role='system' row. role='system' rows
      // are stripped by the model-context builder, so the primary's model never saw
      // the "when the owner replies, call tracker_apply_user_validation(...)"
      // instruction and the validation-relay flow was silently dead. As a NOTICE the
      // primary sees it, relays the question to the owner in its own voice (dashboard
      // chat, or imessage_send when the owner is away), and calls the tool when the
      // owner answers. The note text is unchanged.
      postAgentNotice({
        toAgentId: primaryId,
        fromName: 'Scheduler',
        selfIntro: false,
        intent: 'validation_check',
        brief: askText,
      });

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
      // "user has been asked" indicator (the bug icon pulse). Send the FULL
      // row (getTask) rather than a 2-field partial, which would blank every
      // other column on the card until reload.
      const fresh = getTask(t.id);
      if (fresh) {
        broadcast({ type: 'tracker:task_updated', data: fresh });
      }
    }
    // Wake the primary once so it sees the validation NOTICE(s) and relays the
    // question(s) to the owner this turn instead of waiting for an unrelated
    // trigger. Best-effort: the notices are already persisted in the awareness
    // lane and will surface on the next assembled context regardless. Copies the
    // alertMissedRuns wake idiom above.
    try {
      const runtime = getAgentRuntime();
      runtime.handleMessage(primaryId, '[scheduler: validation check pending]').catch((err) => {
        logger.warn('sweepUnvalidatedTasksForUserEscalation: primary wake failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch { /* runtime not ready, notices are in the store, read next time */ }
    logger.info('Validation escalation: asked user about unvalidated tasks', { count: stale.length });
  } catch (err) {
    logger.warn('sweepUnvalidatedTasksForUserEscalation failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── D12: deterministic missed-runs fallback ──
//
// alertMissedRuns pauses an overdue recurring task and asks the assigned
// agent to resolve via tracker_resolve_missed_runs. Before D12 that model
// call was the ONLY path back to 'waiting': a model that ignored the notice
// once left the recurring task paused forever, silently. The engine now
// auto-resolves as SKIP once the pause has sat unresolved for more than
// MISSED_RUNS_AUTO_RESOLVE_MINUTES: advance next_run_at to the next FUTURE
// anchor for its cadence, clear the pause back to the waiting convention,
// record a task_log note, and log loudly. The model tool takes precedence
// when called first because every resolve action clears
// missed_runs_paused_at, which disarms this fallback. The fallback never
// completes, deletes, or reassigns a task.

const MISSED_RUNS_AUTO_RESOLVE_MINUTES = 10;

async function autoResolveStaleMissedRunPauses(): Promise<void> {
  const db = getDb();
  try {
    const stale = db.prepare(`
      SELECT * FROM tasks
      WHERE is_paused = 1
        AND missed_runs_paused_at IS NOT NULL
        AND datetime(missed_runs_paused_at) <= datetime('now', '-${MISSED_RUNS_AUTO_RESOLVE_MINUTES} minutes')
      LIMIT 25
    `).all() as Array<Record<string, unknown>>;
    if (stale.length === 0) return;

    const { writeTaskLog } = await import('../tracker/task-log.js');
    for (const task of stale) {
      const taskId = task.id as string;
      const nowIso = new Date().toISOString();
      // Same computation as the model tool's SKIP action: pretend a run
      // just happened so the walk lands strictly on the next FUTURE anchor.
      const nextRun = calculateNextRun({
        id: taskId,
        scheduled_start: task.scheduled_start as string | null,
        repeat_interval: task.repeat_interval as number | null,
        repeat_unit: task.repeat_unit as string | null,
        repeat_end_type: task.repeat_end_type as string | null,
        repeat_end_value: task.repeat_end_value as string | null,
        run_count: (task.run_count as number) ?? 0,
        is_paused: 0,
        last_run_at: nowIso,
        next_run_at: null,
        schedule_status: 'waiting',
        repeat_days_of_week: task.repeat_days_of_week as string | null,
        anchor_time: task.anchor_time as string | null,
      });

      // Informational skip count, same approximation the detector used.
      const intervalMs = intervalApproxMs(task.repeat_unit as string | null, task.repeat_interval as number | null);
      const missedIso = task.next_run_at as string | null;
      const missedSlots = intervalMs && missedIso
        ? Math.max(1, Math.floor((Date.now() - new Date(normalizeDbTimestamp(missedIso)).getTime()) / intervalMs))
        : 1;

      if (nextRun) {
        // Guarded release: the model tool clears missed_runs_paused_at when
        // it resolves first, so .changes === 0 means the model (or another
        // process) won the race and this fallback must not touch the task.
        const released = db.prepare(`
          UPDATE tasks
          SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck',
              next_run_at = ?, missed_runs_paused_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND is_paused = 1 AND missed_runs_paused_at IS NOT NULL
        `).run(nextRun, taskId);
        if (released.changes !== 1) continue;
        writeTaskLog({
          taskId,
          fromEntity: 'engine',
          entryKind: 'auto_sweep',
          fromStatus: 'paused',
          toStatus: 'on_deck',
          actionTaken: `engine auto-skipped ${missedSlots} missed run${missedSlots === 1 ? '' : 's'} to the next scheduled time`,
          reason: `paused-for-missed-runs was not resolved within ${MISSED_RUNS_AUTO_RESOLVE_MINUTES} minutes (tracker_resolve_missed_runs never ran); schedule resumed, next run at ${nextRun}`,
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
        // No future anchor exists (past repeat end, or the anchor is
        // uncomputable). Never complete or delete a task from this path:
        // disarm the fallback and leave the task paused for a human or
        // agent decision.
        const disarmed = db.prepare(`
          UPDATE tasks
          SET missed_runs_paused_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND is_paused = 1 AND missed_runs_paused_at IS NOT NULL
        `).run(taskId);
        if (disarmed.changes !== 1) continue;
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

// ── Check and trigger due tasks ──

export async function checkScheduledTasks(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  // ── Cleanup ──
  cleanupOrphanedRuns();
  cleanupStaleRuns();
  pruneTerminalTasks();
  resumeExpiredPauses();
  // D12: engine fallback for missed-runs pauses the model never resolved.
  await autoResolveStaleMissedRunPauses();
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
    // D12: a NEVER-run task (run_count = 0) whose start is in the past is a
    // first fire, not a missed run; the old detector funneled it into the
    // pause-and-ask trap. Only a task that has genuinely fired before can
    // miss a run, so the detector requires run_count > 0 (the 1.5x-interval
    // overdue rule below is unchanged for those).
    const repeatInterval = taskRow.repeat_interval as number | null;
    const repeatUnit = taskRow.repeat_unit as string | null;
    if (repeatInterval && repeatUnit && runCount > 0) {
      const nextRunIso = taskRow.next_run_at as string | null;
      const intervalMs = intervalApproxMs(repeatUnit, repeatInterval);
      if (nextRunIso && intervalMs) {
        const overdueMs = Date.now() - new Date(normalizeDbTimestamp(nextRunIso)).getTime();
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
            // Push next_run_at forward by 30 seconds so we re-check soon.
            // Write an explicit ISO instant, not datetime('now','+30 seconds'):
            // SQLite's space-separated form (0x20) sorts BELOW the 'T' (0x54)
            // in the ISO `now` this scheduler string-compares against, so a
            // same-date space value reads as already due and the defer would
            // collapse to "due again next tick". ISO keeps the defer honest.
            db.prepare('UPDATE tasks SET next_run_at = ? WHERE id = ?')
              .run(new Date(Date.now() + 30_000).toISOString(), taskId);
            continue;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // ── D21: atomic occurrence claim + advance-at-fire ──
    // Exactly one process may fire a given occurrence: the claim UPDATE is
    // keyed on the exact occurrence value this tick read (next_run_at = ?)
    // plus the not-already-claimed convention (schedule_status = 'waiting',
    // is_paused = 0), and .changes === 1 is the claim token. Overlapping
    // ticks and duplicate dev processes lose the claim and skip. The NEXT
    // occurrence is computed and written HERE, at fire time, instead of at
    // model close-out, so a hung or crashed turn can no longer stall the
    // cadence: close-out (onTaskRunComplete) only flips the schedule back
    // to 'waiting' and honors the already-advanced next_run_at.
    const claimedOccurrence = taskRow.next_run_at as string;
    const nextAtFire = calculateNextRun({
      id: taskId,
      scheduled_start: taskRow.scheduled_start as string | null,
      repeat_interval: repeatInterval,
      repeat_unit: repeatUnit,
      repeat_end_type: taskRow.repeat_end_type as string | null,
      repeat_end_value: taskRow.repeat_end_value as string | null,
      run_count: runNumber, // count the run being fired now, so end conditions land exactly
      is_paused: 0,
      last_run_at: now, // the slot firing now is spent; walk to the one after it
      next_run_at: null,
      schedule_status: 'waiting',
      repeat_days_of_week: taskRow.repeat_days_of_week as string | null,
      anchor_time: taskRow.anchor_time as string | null,
    });
    const claim = db.prepare(`
      UPDATE tasks
      SET schedule_status = 'running', status = 'in_progress',
          last_run_at = ?, next_run_at = ?, updated_at = datetime('now')
      WHERE id = ? AND schedule_status = 'waiting' AND is_paused = 0
        AND next_run_at = ? AND next_run_at <= ?
    `).run(now, nextAtFire, taskId, claimedOccurrence, now);
    if (claim.changes !== 1) {
      logger.info('Scheduler: occurrence already claimed elsewhere, skipping', { taskId, occurrence: claimedOccurrence });
      continue;
    }

    const runId = uuidv4();

    // 1. Create run instance for the claimed occurrence
    db.prepare(`
      INSERT INTO task_runs (id, task_id, run_number, scheduled_for, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
    `).run(runId, taskId, runNumber, claimedOccurrence);

    // 2. Determine who runs it
    let assignedAgent = taskRow.assigned_to as string | null;
    const assignedGroup = taskRow.assigned_to_group as string | null;

    if (assignedGroup && !assignedAgent) {
      assignedAgent = pickAvailableAgentFromGroup(assignedGroup);
      if (!assignedAgent) {
        // No agent available, notify primary agent
        const primaryId = getPrimaryAgentId();
        const groupName = (db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(assignedGroup) as { name: string } | undefined)?.name ?? assignedGroup;
        sendAgentMessage(getPMAgentId(), primaryId, 'status',
          `No available agents in group "${groupName}" for scheduled task "${taskRow.title}". Task run #${runNumber} skipped.`, {
            taskId, runId, event: 'no_agent_available',
          });
        // Mark run as skipped
        db.prepare("UPDATE task_runs SET status = 'skipped', error = 'No available agent in group' WHERE id = ?").run(runId);
        // D21: release the claim taken above and restore the occurrence and
        // prior last_run_at, so the task retries on the next tick exactly as
        // it did before the claim existed.
        db.prepare(`
          UPDATE tasks
          SET schedule_status = 'waiting', status = 'on_deck',
              next_run_at = ?, last_run_at = ?, updated_at = datetime('now')
          WHERE id = ? AND schedule_status = 'running'
        `).run(claimedOccurrence, taskRow.last_run_at as string | null, taskId);
        continue;
      }
    }

    if (!assignedAgent) {
      assignedAgent = getPrimaryAgentId();
    }

    // Check if assigned agent is alive; if terminated, reassign to primary
    const agentStatus = db.prepare('SELECT status FROM agents WHERE id = ?').get(assignedAgent) as { status: string } | undefined;
    if (!agentStatus || agentStatus.status === 'terminated') {
      logger.warn('Scheduler: assigned agent is terminated, reassigning to primary', { taskId, assignedAgent });
      assignedAgent = getPrimaryAgentId();
    }

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
      ? `[Reminder due] ${taskDesc ?? taskTitle}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nDeliver this reminder to the user now as a single short chat message in your normal voice. Do NOT prefix with "Reminder:" or "Here's your reminder", just say the thing naturally (e.g. user asked to be reminded to "go get coffee" → "Hey, time to go get coffee."). When you're done speaking, silently call tracker_update_status with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping; do NOT write any user-facing message about marking the reminder complete ("Task closed", "All done", "Marked complete"). The reminder message itself is the entire user-facing output.`
      : `[Scheduled Task, Run #${runNumber}${totalRuns}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nWhen this run is finished, call tracker_update_status with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping; do NOT write any user-facing message about marking the task complete (e.g. "Task closed", "All done", "Marked complete"). The user already received your reminder/output above; an extra "task closed" line is just noise.`;

    // Inject as engine event and trigger runtime.
    // D-A step 4: a scheduler fire is inter-agent/engine traffic (origin_kind=
    // lane='events'), so it lands on the EVENTS lane, structurally outside the assignee's
    // `messages` chat table. The merged tail + assembler surface it as a pending
    // engine event (conv_key NULL) exactly as the old `messages` row did, and the
    // migration-084/099 delivery lifecycle applies unchanged.
    const msgId = uuidv4();
    insertInterAgentEngineRow({
      id: msgId,
      agentId: assignedAgent,
      content: `[SOURCE: SCHEDULER — automated scheduled task trigger, not a message from the user] ${message}`,
      sourceAgentId: null,
      originIntent: 'scheduler',
      convKey: null,
      // P1 lineage spine: the trigger's referent as COLUMNS. The P2 serve
      // boundary retires this row the moment the run closes or the task goes
      // terminal, instead of asking the model to "skip stale triggers".
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

    // Trigger agent runtime
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

// ── Called when a task run completes ──

export async function onTaskRunComplete(taskId: string, status: string, summary: string): Promise<boolean> {
  const db = getDb();

  // Find the latest running run for this task
  const run = db.prepare(`
    SELECT * FROM task_runs WHERE task_id = ? AND status = 'running' ORDER BY run_number DESC LIMIT 1
  `).get(taskId) as Record<string, unknown> | undefined;

  if (!run) {
    // No active run, either a non-scheduled task or the occurrence was already
    // closed by another path. Nothing to advance. RC-17: report the no-op with a
    // boolean so callers (tracker_validate) don't misread an unchanged, already-
    // 'complete' row as a fresh terminal close and kill the whole schedule.
    return false;
  }

  const runId = run.id as string;
  const now = new Date().toISOString();

  // Update the run BY ID, but only while it is still 'running'. RC-17: .changes
  // === 1 is the close token. If a concurrent tick or a duplicate dev process
  // already closed this exact occurrence, we lose the race and must NOT advance
  // run_count / recompute next_run_at again (that is the P-5 run-counter
  // inflation class). Bail as a no-op instead.
  const closed = db.prepare(`
    UPDATE task_runs SET status = ?, completed_at = ?, result_summary = ? WHERE id = ? AND status = 'running'
  `).run(status, now, summary, runId);
  if (closed.changes !== 1) {
    logger.info('Scheduler: run already closed elsewhere, skipping advance', { taskId, runId });
    return false;
  }

  // P2 serve boundary, close claims its trigger BY KEY: the occurrence is
  // done, so any unserved trigger row for this run retires now instead of
  // waking a turn later to redo finished work.
  retireEngineEventsForRun(runId);

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

  // D21 advance-at-fire: the NEXT occurrence was already computed and
  // written when this run's occurrence was claimed. Honor the stored value;
  // recompute only when the run overran its own cadence (the stored next
  // occurrence is already due or past), which matches the old close-out
  // behavior of never re-firing slots that passed while the run executed.
  // A NULL stored value means the schedule has no further runs (one-shot,
  // or an end condition was reached at fire time). Legacy in-flight rows
  // claimed by pre-change code still carry the just-fired PAST occurrence,
  // so they land in the recompute branch and advance exactly as before.
  const storedNext = task.next_run_at as string | null;
  let nextRun: string | null = null;
  if (storedNext) {
    const storedMs = new Date(normalizeDbTimestamp(storedNext)).getTime();
    nextRun = !isNaN(storedMs) && storedMs > Date.now()
      ? storedNext
      : calculateNextRun(scheduledTask);
  }

  // D8 (owner-approved tracker change, the ONLY one): a one-shot task whose final
  // run FAILED must not be auto-marked complete. "Remind me at 3pm" that was never
  // spoken used to end as schedule_status='completed' / status='complete', reading
  // as done in the tracker with the owner never told. The failed no-next-run case
  // now lands on the tracker's EXISTING failed convention, status='fallen'
  // (migration 012: failed -> fallen; the dashboard counts 'fallen' as failed and
  // the PM treats it as terminal, so there is no re-fire and no PM churn), with
  // schedule_status='completed' still recording that the schedule itself has no
  // more runs. The owner is told two ways: a plain-language owner-facing NOTICE
  // (postAgentNotice, role='user' origin_kind='engine') to the primary so its model
  // sees the failure and surfaces it to the owner in its own voice, PLUS an
  // assigned-agent awareness notice via the same path so the assigned agent can
  // relay/follow up. Phase 0.1 dead-channel demolition: this used to be a bare
  // role='system' chat row (dropped by the model-message builder, so the primary's
  // model never saw it and could never relay it, e.g. via iMessage when the owner is
  // away). Recurring tasks and successful one-shots are byte-for-byte unchanged.
  const failedFinalRun = !nextRun && status === 'failed';

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
      toStatus: nextRun ? 'on_deck' : (failedFinalRun ? 'fallen' : 'complete'),
      actionTaken: nextRun
        ? `scheduler ran #${(task.run_count as number) + 1}, next at ${nextRun}`
        : (failedFinalRun
            ? `scheduler ran final run #${(task.run_count as number) + 1}, run FAILED, task marked fallen (not complete) and owner notified`
            : `scheduler ran final run #${(task.run_count as number) + 1}, no more runs`),
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
  } else if (failedFinalRun) {
    // D8: final run failed, keep the failure VISIBLE (see block comment above).
    db.prepare(`
      UPDATE tasks SET schedule_status = 'completed', status = 'fallen', completed_at = datetime('now'), last_run_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(now, taskId);
      retireEngineEventsForTask(taskId, 'task_fallen');
    try {
      const title = String(task.title ?? 'untitled task');
      const noun = (task.kind as string | null) === 'reminder' ? 'reminder' : 'task';

      // Dead-channel demolition (Phase 0.1): deliver the owner-facing failure note as
      // a model-VISIBLE awareness NOTICE (role='user' origin_kind='engine'), the same
      // idiom alertMissedRuns uses, NOT a bare role='system' row. role='system' rows
      // are stripped by the model-context builder, so a note posted that way never
      // reached the primary's model and could never be relayed to the owner (e.g. via
      // imessage_send when the owner is away). As a NOTICE the primary sees it and
      // surfaces the failure to the owner in its own voice. Plain language for a
      // non-technical owner, naming the task and its scheduled time. Note text unchanged.
      const when = (task.scheduled_start as string | null) ?? (task.anchor_time as string | null);
      const ownerMsg =
        `Heads up: a scheduled ${noun}, "${title}"${when ? ` (set for ${when})` : ''}, failed on its final attempt and was not delivered. ` +
        `Nothing more is scheduled for it, so it will not try again. Let me know if you want me to set it up again.`;
      const primaryId = getPrimaryAgentId();
      postAgentNotice({
        toAgentId: primaryId,
        fromName: 'Scheduler',
        selfIntro: false,
        intent: 'schedule_run_failed_owner',
        brief: ownerMsg,
      });
      // Wake the primary so it sees the failure NOTICE and relays it to the owner this
      // turn instead of waiting for an unrelated trigger. Best-effort: the notice is
      // already persisted in the awareness lane and surfaces on the next assembled
      // context regardless. Copies the alertMissedRuns wake idiom above.
      try {
        const runtime = getAgentRuntime();
        runtime.handleMessage(primaryId, '[scheduler: failed-run owner note pending]').catch((err) => {
          logger.warn('scheduler: failed-final-run owner note wake failed', {
            taskId, error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch { /* runtime not ready, notice is in the store, read next time */ }

      // Keep the assigned-agent awareness notice so the assigned agent (which may
      // own the follow-up) still learns the delivery failed and can relay.
      postAgentNotice({
        toAgentId: (task.assigned_to as string | null) ?? getPrimaryAgentId(),
        fromName: 'Scheduler',
        selfIntro: false,
        intent: 'schedule_run_failed',
        brief: `I could not deliver a scheduled ${noun}: ${title.slice(0, 100)}`,
      });
    } catch (err) {
      logger.warn('scheduler: failed-final-run owner notice failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
    // D-K: this fallen transition can be the one that empties the task's project
    // of open tasks, so run the success-vs-fail-open check (idempotent) so the
    // project gets labelled needs-attention instead of staying silently active.
    // Dynamic import: tracker/tools.ts statically imports onTaskRunComplete from
    // this module, a static back-import would cycle.
    try {
      const { checkProjectCompletion } = await import('../tracker/tools.js');
      checkProjectCompletion((task.project_id as string | null) ?? null, getPMAgentId());
    } catch (err) {
      logger.warn('scheduler: checkProjectCompletion after failed final run failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
    logger.warn('Scheduler: final run failed; task marked fallen (not complete) and owner notified', { taskId, runId, status });
  } else {
    // No more runs: mark everything as completed
    db.prepare(`
      UPDATE tasks SET schedule_status = 'completed', status = 'complete', last_run_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(now, taskId);
  }

  // Broadcast the run completion event
  broadcast({ type: 'task:run_complete', data: { taskId, runId, status, nextRun } });

  // Also broadcast the task update so the kanban card moves
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

// ── Skipped-reminder owner heads-up (RC-17.6) ──
//
// When a reminder occurrence is dropped (its schedule is terminated on a
// 'fallen' transition, or an orphaned run is swept), the owner asked to be
// reminded of something and it is NOT going to happen. Tell them, in plain
// language: a role='system' message straight into the primary agent's chat + a
// chat:message broadcast, so it renders in the owner's chat history without
// waking any agent turn (role='system' rows are dropped by the model-message
// builder and matched by neither the pending-engine-event nor the waiting-human
// selector). The "Heads up:" prefix is load-bearing: it makes the note render
// in the owner's DEFAULT (non-wordy) chat, not just wordy mode.
// NOTE: unlike the failed-final-run owner note above (converted to a model-visible
// NOTICE in Phase 0.1), this owner heads-up still rides role='system' (owner-facing
// only, the primary's model does not relay it). This site is outside the Phase 0
// scope; if the demolition is extended here, convert it to postAgentNotice the
// same way.
export function postSkippedReminderHeadsUp(taskId: string, reason: string): void {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT title, kind, description, scheduled_start, anchor_time FROM tasks WHERE id = ?',
    ).get(taskId) as {
      title: string; kind: string | null; description: string | null;
      scheduled_start: string | null; anchor_time: string | null;
    } | undefined;
    if (!row || row.kind !== 'reminder') return;
    const what = (row.description && row.description.trim()) ? row.description.trim() : row.title;
    const when = row.scheduled_start ?? row.anchor_time;
    const ownerMsg =
      `Heads up: I skipped a reminder${when ? ` (set for ${when})` : ''}, "${what}", because ${reason}. ` +
      `Let me know if you still want it and I will set it up again.`;
    const primaryId = getPrimaryAgentId();
    const ownerMsgId = uuidv4();
    insertMessage({ id: ownerMsgId, agentId: primaryId, role: 'system', content: ownerMsg });
    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: ownerMsgId, agentId: primaryId, role: 'system' as const,
        content: ownerMsg,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('postSkippedReminderHeadsUp failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Fallen-terminates-schedule (RC-17.5) ──
//
// A task marked 'fallen' (given up on) must never fire again, but the due
// query filters only on schedule_status/is_paused, not status, so a 'fallen'
// transition alone leaves a live recurring/one-shot schedule armed and it keeps
// firing (F-17: a cancelled reminder fired anyway two hours later). Terminate
// the schedule here: stop it (schedule_status='completed', is_paused=1, drop
// next_run_at), close any still-open run as 'skipped', and, for a reminder,
// tell the owner it was skipped. Synchronous so callers can report the outcome
// in the same tool result. Returns whether it actually terminated a live
// schedule and how many runs it skipped, so callers can SAY so.
export function terminateLiveScheduleOnFallen(
  taskId: string,
  reason = 'the task was marked fallen (given up on)',
): { terminated: boolean; runsSkipped: number; isReminder: boolean } {
  const db = getDb();
  const row = db.prepare(
    'SELECT title, kind, schedule_status FROM tasks WHERE id = ?',
  ).get(taskId) as { title: string; kind: string | null; schedule_status: string } | undefined;
  if (!row) return { terminated: false, runsSkipped: 0, isReminder: false };
  const isReminder = row.kind === 'reminder';
  // Only 'waiting' (armed, awaiting the next fire) and 'running' (fired, a run
  // is in flight) schedules can still fire. 'completed'/'unscheduled'/'idle'
  // are already inert.
  const scheduleIsLive = row.schedule_status === 'waiting' || row.schedule_status === 'running';
  if (!scheduleIsLive) return { terminated: false, runsSkipped: 0, isReminder };

  const stopped = db.prepare(`
    UPDATE tasks
    SET schedule_status = 'completed', is_paused = 1, next_run_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND schedule_status IN ('waiting', 'running')
  `).run(taskId);
  if (stopped.changes !== 1) {
    // Raced with another terminator; leave the winner's outcome intact.
    return { terminated: false, runsSkipped: 0, isReminder };
  }

  const skipped = db.prepare(`
    UPDATE task_runs
    SET status = 'skipped', completed_at = datetime('now'),
        result_summary = ?
    WHERE task_id = ? AND status IN ('pending', 'running')
  `).run(`Skipped: ${reason}; schedule stopped`, taskId);
  const runsSkipped = skipped.changes;

  writeTaskLog({
    taskId,
    fromEntity: 'engine',
    entryKind: 'auto_sweep',
    actionTaken: 'schedule terminated on fallen',
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
    // FA-S1: pass 'failed' (not 'complete'). A dead orphaned run did NOT succeed,
    // so a one-shot must not land status='complete' silently: 'failed' routes a
    // terminal one-shot through the D8 failedFinalRun branch (fallen + owner
    // notices), the truth for "remind me at 3pm" whose agent was terminated
    // before it ever spoke. A recurring occurrence advances identically either
    // way (the next occurrence was written at claim time and run_count increments
    // regardless of status), so the cleanup still unblocks the schedule; it just
    // records the dead run truthfully. Mirrors cleanupStaleRuns, which already
    // passes 'failed' for the same class of dead run.
    onTaskRunComplete(orphan.task_id, 'failed', 'Auto-failed: assigned agent was terminated before the run completed').catch(err => {
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

  // ── RC-17.4: task_runs-keyed orphan sweep ──
  // The recovery machinery below keys on TASKS (schedule_status='running'),
  // so it cannot see runs that were orphaned when a path reset the task row
  // WITHOUT closing the run: tracker_complete_step closes a fired recurring
  // task with zero run bookkeeping, and the force-reset / missed-runs paths
  // rewrite schedule_status directly. Those 'running' task_runs rows then
  // accumulate forever (transcript-proven pool drain: runs 42/43/44/45 never
  // closed), and onTaskRunComplete's "newest running run" selection can grab a
  // stale one. Invariant: a legitimately in-flight run always has its parent at
  // schedule_status='running' (the claim sets both atomically, and close-out
  // closes the run BEFORE moving schedule_status). So any open run whose parent
  // is NOT schedule_status='running' is an orphan. Close them 'skipped'. Silent
  // by design (no owner heads-up): this drains stale bookkeeping, it is not a
  // live reminder the owner needs told about. A short age guard avoids racing an
  // in-flight advance.
  const orphanRuns = db.prepare(`
    SELECT tr.id AS run_id, tr.task_id, tr.run_number
    FROM task_runs tr
    LEFT JOIN tasks t ON t.id = tr.task_id
    WHERE tr.status IN ('pending', 'running')
      AND (t.id IS NULL OR t.schedule_status != 'running')
      AND COALESCE(tr.started_at, tr.created_at) < datetime('now', '-5 minutes')
  `).all() as Array<{ run_id: string; task_id: string; run_number: number }>;
  if (orphanRuns.length > 0) {
    for (const o of orphanRuns) {
      // Close BY ID and only while still open, so a concurrent advance wins
      // the race instead of us clobbering its close.
      const closed = db.prepare(`
        UPDATE task_runs
        SET status = 'skipped', completed_at = datetime('now'),
            result_summary = 'Auto-skipped: orphaned run (parent task not running this occurrence)'
        WHERE id = ? AND status IN ('pending', 'running')
      `).run(o.run_id);
      if (closed.changes === 1) {
        logger.warn('Scheduler: swept orphaned task_run', { taskId: o.task_id, runId: o.run_id, runNumber: o.run_number });
      }
    }
  }

  // 1. Standard stale-running detection. Use the OLDER of (per-task
  // updated_at, agent last message) — same per-task pattern as PM's poke
  // loop in v2.3.6. Catches a recurring run that the agent finished but
  // never called tracker_update_status on.
  //
  // PHASE-1 T6b — THE SILENT INVERSION, and why `MAX(m.created_at)` is wrapped.
  // `messages.created_at` is epoch-ms INTEGER from migration 131; `tasks.updated_at` is
  // TEXT and is not on the spine, so this scalar MIN() compares an INTEGER against a TEXT
  // datetime. SQLite orders INTEGER before TEXT UNCONDITIONALLY — so MIN() would return the
  // epoch number whenever the messages side existed at all, and `<integer> < '<datetime>'`
  // is TRUE for every integer there is. Every running scheduled task would be declared
  // stale, with no error, no log line and no failing test.
  // It is not hypothetical: rehearsed on a VACUUM INTO copy of this box, the unwrapped form
  // returned 50 stale tasks where the true answer was 44 — six live tasks killed per pass.
  // Projecting the messages side back to the TEXT shape keeps BOTH sides of the comparison
  // one type and reproduces the pre-migration answer exactly (44 = 44 in the same rehearsal).
  // If `tasks.updated_at` ever converts too, this wrap comes off and both sides go numeric.
  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to
    FROM tasks t
    WHERE t.schedule_status = 'running'
      AND t.status != 'paused'
      AND t.assigned_to IS NOT NULL
      AND MIN(
        COALESCE(
          (SELECT datetime(MAX(m.created_at)/1000, 'unixepoch') FROM messages m WHERE m.agent_id = t.assigned_to),
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

  // Re-broadcast the fresh FULL task row so the kanban card reflects the
  // recovered schedule. Matches the canonical emitters (data: <full row>,
  // no cast); a partial payload would blow away the card's other fields.
  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
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
// The one-time recovery for hardcap-paused recurring tasks (v2.9.13's
// recoverEnginePausedRecurringTasks) was retired 2026-07-21: its pause-writer
// was demolished in the two-key wave, so the victim set is fixed and
// migration 110 releases it once as data instead of a boot-time prose scan.

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

  // Re-broadcast the fresh FULL task row so the kanban card reflects the
  // force-reset. Matches the canonical emitters (data: <full row>, no cast);
  // a partial payload would blow away the card's other fields.
  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
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

    // Re-broadcast the fresh FULL task row so the kanban card reflects the
    // auto-resume. Matches the canonical emitters (data: <full row>, no cast);
    // a partial payload would blow away the card's other fields.
    const fresh = getTask(task.id);
    if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
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
