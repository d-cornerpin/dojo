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
import { HARD_STUCK_THRESHOLD_MINUTES } from '../agent/stuck-thresholds.js';
import { withUnit } from '../db/unit.js';
import {
  taskScope, dueScope, msToText, tsToMs, STATE_TO_STATUS_SQL, scheduleRowColumns,
  validatedExpr, awaitingUserVerdictExpr, pendingCloseRequestExpr, statusToState, type TrackerStatus,
} from '../work/tracker-view.js';
import { staleOverrideRequests, resolveOverrideRequest } from '../work/override-requests.js';
import {
  patchWork, setTrackerStatus, bumpWorkAttempts, upholdClaim, clearUserVerdict,
  recordValidationEscalation, deleteTrackerRow, deliveryForTaskClose,
  deliveryForAgentSince,
} from '../work/tracker-store.js';
// SWEEP CORE-2 item 3 — the schedule's fire time has ONE writing module.
import { setNextRun, clearLiveSchedule } from '../work/next-run.js';
import { workSettled, noteUnsettled } from '../work/store.js';
import {
  claimOccurrence, releaseOccurrence, settleOccurrence, occurrenceOf, inFlightOccurrence,
  assignOccurrence, skipOpenOccurrences, sweepOrphanedOccurrences,
  sweepTerminatedAgentOccurrences, runsReadyToCloseOnDelivery,
} from '../work/occurrences.js';
// SWEEP CORE-1 CT2 — the deliverable declaration and the steer-to-deliver ladder's verify rung.
import { RUN_STATUS_UNDELIVERED } from '../work/run-deliver-drive.js';
// SWEEP CORE-2 item 1 — the owner-escalation candidate query and the ordering law it obeys.
import {
  countRowsHeldBackFromOwner, selectRowsForOwnerEscalation, selectRowsSkippedAsDelivered,
  ownerVerdictNudgeText, escalationSteerCount, firstEscalationSteerAt, recordEscalationSteer,
} from '../work/validation-drive.js';
import { recordFloorGhost, MAX_FLOOR_STEER_ATTEMPTS } from '../agent/v2/floor-ghost.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getTask } from '../tracker/schema.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { calculateNextRun, normalizeDbTimestamp, type ScheduledTask } from './engine.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { insertEngineEventIfAbsent, insertMessage } from '../memory/message-store.js';
import { getPrimaryAgentId, getPMAgentId, getOwnerName } from '../config/platform.js';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';

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
 * options. The agent decides via work_schedule(action="resolve_missed").
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
  const alreadyPaused = db.prepare('SELECT is_paused FROM work WHERE id = ?')
    .get(taskId) as { is_paused: number } | undefined;
  const pausedRes = alreadyPaused && alreadyPaused.is_paused === 0
    ? setTrackerStatus(taskId, 'paused', {
        by: 'scheduler', actorId: 'scheduler',
        reason: 'runs were missed while the platform was down or the task was stuck',
      })
    : null;
  const paused = { changes: pausedRes && pausedRes.kind === 'applied' ? 1 : 0 };
  if (paused.changes === 1) {
    noteUnsettled(patchWork(taskId, { is_paused: 1, schedule_status: 'paused', missed_runs_paused_at: Date.now() }), 'scheduler: paused after too many missed runs', { taskId });
  }
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
  // woken agent's MODEL never saw the alert and could never call work_schedule(action="resolve_missed")
  // — the whole resolve flow was silently broken (a correctness bug). Now a brief, model-
  // visible awareness note (role='user' origin_kind='engine'); the run_now/skip/pause option
  // semantics live just-in-time in the work_schedule(action="resolve_missed") tool description the
  // agent reads WHEN it calls the tool.
  postAgentNotice({
    toAgentId: assignedAgent,
    fromName: 'Scheduler',
    selfIntro: false,
    intent: 'scheduler_missed_runs',
    brief: `Your recurring task "${taskTitle}" (${cadence}) missed ${missedSlots} run${missedSlots === 1 ? '' : 's'} while the box was offline or paused, so I auto-paused it. Call work_schedule(action="resolve_missed", task_id="${taskId}", action="run_now"|"skip"|"pause"): action="run_now" fires one catch-up run now, action="skip" jumps to the next scheduled slot, action="pause" leaves it paused. The action argument is required.`,
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
      (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.agent_id = agents.id AND w.state = 'claimed') ASC
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

/**
 * PHASE-2 T9 — the reaper's entry point for this file's two 12-hour SLAs.
 *
 * One export rather than two, because they are one kind: "a request a human never answered
 * inside `DEADLINES.stale_request` auto-resolves so the system stays honest while people are
 * away." Sequential and independently guarded — each already swallows its own failure — so a
 * failure in one cannot silence the other.
 */
export async function sweepStaleRequests(): Promise<void> {
  await sweepStaleOverrideRequests();
  await sweepStaleUserVerdictRequests();
}

async function sweepStaleOverrideRequests(): Promise<void> {
  try {
    // PHASE-2 T8T RESUMED-2 (RULING 4): the queue moved to `work_events`; the 12-hour bound
    // is unchanged and still this file's own constant (5a, carried verbatim).
    const stale = staleOverrideRequests(STALE_REQUEST_HOURS, 50);
    if (stale.length === 0) return;

    const { writeTaskLog } = await import('../tracker/task-log.js');
    let swept = 0;
    for (const r of stale) {
      // A TIMEOUT IS NOT A VERDICT, which is why the old schema had `auto_denied` as a value
      // distinct from `denied` and why nothing is written to `adjudications` here: nobody
      // ruled. The ask is answered and the requester is told.
      resolveOverrideRequest(r.id, {
        outcome: 'auto_denied', resolvedBy: 'engine',
        reason: `timed out after ${STALE_REQUEST_HOURS}h with no PM resolution`,
      });
      writeTaskLog({
        taskId: r.taskId,
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
            `Your override request on task ${r.taskId.slice(0, 8)} (status="${r.requestedStatus}") ` +
            `timed out after ${STALE_REQUEST_HOURS}h with no PM resolution. The request is auto-denied. ` +
            `Address the engine's original concern and resubmit cleanly, or file a fresh work_close_request(action="override").`,
          toAgent: r.requestedBy,
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
      SELECT w.id AS id, w.title AS title, w.agent_id AS assigned_to,
             ${STATE_TO_STATUS_SQL('w.state')} as current_status,
             ${msToText(`(SELECT MAX(e.created_at) FROM work_events e WHERE e.work_id = w.id AND e.kind = 'user_verdict_requested')`)} AS user_verdict_requested_at
      FROM work w
      WHERE ${taskScope('w')} AND ${awaitingUserVerdictExpr('w')} = 1
        AND (SELECT MAX(e.created_at) FROM work_events e WHERE e.work_id = w.id AND e.kind = 'user_verdict_requested') < ?
      LIMIT 50
    `).all(Date.now() - STALE_REQUEST_HOURS * 3600_000) as Array<{
      id: string; title: string; assigned_to: string | null;
      current_status: string; user_verdict_requested_at: string;
    }>;
    if (stale.length === 0) return;

    const dropStmt = {
      run: (id: string) => {
        const r = setTrackerStatus(id, 'blocked', {
          by: 'scheduler', actorId: 'scheduler',
          reason: `the owner's verdict was never given within ${STALE_REQUEST_HOURS}h`,
        });
        if (workSettled(r)) {
          clearUserVerdict(id, 'scheduler', 'verdict request timed out');
          // The scheduler's own timeout IS the validation of this block — the same
          // reasoning the `blocked_validated = 1` assignment carried.
          upholdClaim(id, 'blocked', 'pm', 'scheduler', 'verdict request timed out; block recorded');
        }
      },
    };
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

// EXPORTED, SWEEP-A TB8 JOB 2. This is the only clock in the product that says how long a
// row may await Key 2 before the OWNER is told about it, so it is also the only honest
// bound on how long the platform's own validator may take. `tracker/pm-agent.ts` reads it
// from here rather than declaring a second number — the two clocks must be ORDERED (the
// validator is accountable before the owner is bothered), and two copies cannot be ordered.
export const VALIDATION_ESCALATION_MIN = 5;

// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 ITEM 1 — THE ORDERING LAW LANDS HERE. TB8 handed this up and named it a
// design fork; the owner ruled it on 2026-08-06: *"Escalation to the owner only AFTER a
// recorded validation attempt."*
//
// What that fixes, measured: BATTERY6 `bmsh708xse7` — 5 of 6 owner-escalated rows never
// received an in-window verdict. BATTERY9 `bmshmu5ygd5` — 3 of 3. And the original clock,
// battery `bmsgs7qejup`: this sweep told the owner three rows were unvalidated at 01:20:00
// and its own validator upheld them at 01:23:11. An escalation naming un-attempted work is
// the defect all six denominators measured.
//
// The candidate query moved to `work/validation-drive.ts` — beside the spine tables it reads
// and beside the attempt ledger it now consults, so the law and the query cannot drift apart.
// Everything this function does with the rows is unchanged.
// ════════════════════════════════════════════════════════════════════════════════════════

export async function sweepUnvalidatedTasksForUserEscalation(): Promise<void> {
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
    const staleBefore = Date.now() - VALIDATION_ESCALATION_MIN * 60_000;
    const stale = selectRowsForOwnerEscalation(staleBefore, serviceIds);

    // THE HOLD IS SAID OUT LOUD. A row kept back by the ordering law is not a silent skip:
    // it is the platform saying "my own validator has not been asked yet, so this is not the
    // owner's problem yet" — and it must be readable when it is wrong.
    const heldBack = countRowsHeldBackFromOwner(staleBefore, serviceIds);
    if (heldBack > 0) {
      logger.info('Validation escalation HELD: these rows are past the bound but their validator has no recorded attempt', {
        heldBack, boundMin: VALIDATION_ESCALATION_MIN, escalating: stale.length,
      });
    }
    // UX-REPAIR round 2 T12 — THE REALITY CHECK, SAID OUT LOUD. A row held back because the
    // ledger says its work already reached the person is not a silent skip; and it deliberately
    // does NOT burn `validation_escalated`, which is permanent (one shot per row, forever), so
    // a row whose delivery is later undone can still be escalated.
    const skippedAsDelivered = selectRowsSkippedAsDelivered(staleBefore, serviceIds);
    if (skippedAsDelivered.length > 0) {
      logger.info('escalation_skipped_delivered: these rows are past the bound but the platform already delivered their work', {
        skipped: skippedAsDelivered.length, boundMin: VALIDATION_ESCALATION_MIN,
        rows: skippedAsDelivered.slice(0, 5).map((r) => ({ id: r.id, deliveryId: r.deliveryId })),
      });
    }
    if (stale.length === 0) return;

    const { writeTaskLog } = await import('../tracker/task-log.js');
    const { broadcast } = await import('../gateway/ws.js');
    const stamp = { run: (threadId: string, id: string) => recordValidationEscalation(id, 'scheduler', threadId) };
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
      // UX-REPAIR round 2 T12 — OR2'S SHAPE, at last. The old text was engine-composed, spoke
      // TO the owner by name, and handed the primary a canned tool call with a 36-char task id
      // in it — 732 chars, sliced to 400 by the events lane, cut MID-TASK-ID, so it could not
      // have been complied with even in principle. `ownerVerdictNudgeText` is the recorded
      // conversion pattern instead (PHASE-4.md:14, owner ruling 2026-07-30): the AGENT is told
      // the fact and asked to decide and speak. It fits the 400-char gist WHOLE, so the severed
      // instruction dies without touching the cap (O15 refused).
      const askText = ownerVerdictNudgeText({
        taskId: t.id, title: t.title, status: t.status, agentName,
        ownerName: getOwnerName(), boundMin: VALIDATION_ESCALATION_MIN,
      });

      // ── UX-REPAIR round 2 T12: VERIFY BEFORE RE-STEERING ──
      // OR2's shape is detect → steer → VERIFY VIA DELIVERY RECORDS → bounded retry → the
      // platform's own surface. The verify step: has the primary put anything in front of a
      // person since the first steer went out? If so the nudge landed and the agent spoke, and
      // the one-shot suppressor is written for that FIRED case exactly as it always was.
      const firstSteerAt = firstEscalationSteerAt(t.id);
      const spokeSince = firstSteerAt !== null
        && deliveryForAgentSince(primaryId, firstSteerAt) !== null;
      const steersSpent = escalationSteerCount(t.id);

      if (spokeSince || steersSpent >= MAX_FLOOR_STEER_ATTEMPTS) {
        // Either the agent has spoken, or it has been asked twice on two separate turns and
        // has not. The second case is a PLATFORM fault and the platform's own watchdog surface
        // is what says so — never the engine wearing the agent's face (OR2's last clause).
        if (!spokeSince) {
          recordFloorGhost({
            agentId: primaryId, turnNumber: null, floor: 'owner-verdict-unasked', workId: t.id,
            attempts: steersSpent,
            ownerLine:
              `a task has been marked ${t.status} for over ${VALIDATION_ESCALATION_MIN} minutes, `
              + `your PM cannot confirm it, and your agent has not come back to you about it — `
              + `the platform asked it twice and got no reply.`,
            detail: { steers: steersSpent, task_title: t.title },
          }, { broadcast });
        }
        stamp.run(threadId, t.id);
        writeTaskLog({
          taskId: t.id,
          fromEntity: 'engine',
          entryKind: 'directive',
          actionTaken: '5-min validation escalation: asked user',
          reason: spokeSince
            ? `the primary was steered and has since spoken; the escalation is fired and closed`
            : `task has been ${t.status} with *_validated=0 since ${t.updated}; the primary was steered `
              + `${steersSpent} time(s) and did not come back — handed to the platform surface`,
          note: askText,
        });
      } else {
        // Dead-channel demolition (Phase 0.2): the nudge is a model-VISIBLE awareness NOTICE
        // (role='user' origin_kind='engine'), the same idiom alertMissedRuns uses, NOT a bare
        // role='system' row — those are stripped by the context builder, which is how this
        // flow was silently dead before 2f302dc. What CHANGED in T12 is the voice (the agent
        // decides and speaks; see ownerVerdictNudgeText) and the fact that ONE silent turn no
        // longer ends the story: the stamp is not written until the ladder says it is over.
        postAgentNotice({
          toAgentId: primaryId,
          fromName: 'Scheduler',
          selfIntro: false,
          intent: 'validation_check',
          brief: askText,
        });
        recordEscalationSteer(t.id, {
          attempt: steersSpent + 1, bound: MAX_FLOOR_STEER_ATTEMPTS,
          turnNumber: currentTurnNumber(primaryId) || null,
        });
        logger.info('validation escalation: steered the primary to decide whether the owner needs to rule', {
          taskId: t.id, attempt: steersSpent + 1, bound: MAX_FLOOR_STEER_ATTEMPTS,
        });
      }

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
// agent to resolve via work_schedule(action="resolve_missed"). Before D12 that model
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
      SELECT ${scheduleRowColumns('w')} FROM work w
      WHERE ${taskScope('w')} AND w.is_paused = 1
        AND w.missed_runs_paused_at IS NOT NULL
        AND w.missed_runs_paused_at <= ?
      LIMIT 25
    `).all(Date.now() - MISSED_RUNS_AUTO_RESOLVE_MINUTES * 60_000) as Array<Record<string, unknown>>;
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
        const guard = db.prepare('SELECT is_paused, missed_runs_paused_at FROM work WHERE id = ?')
          .get(taskId) as { is_paused: number; missed_runs_paused_at: number | null } | undefined;
        if (!guard || guard.is_paused !== 1 || guard.missed_runs_paused_at == null) continue;
        const releasedRes = setTrackerStatus(taskId, 'on_deck', {
          by: 'scheduler', actorId: 'scheduler', expectedState: 'paused',
          reason: `missed-runs pause unresolved for ${MISSED_RUNS_AUTO_RESOLVE_MINUTES} minutes; skipped to the next anchor`,
        });
        if (releasedRes.kind !== 'applied') continue;
        noteUnsettled(setNextRun(taskId, {
          at: tsToMs(nextRun),
          alongside: { is_paused: 0, schedule_status: 'waiting', missed_runs_paused_at: null },
          reason: 'D12 auto-resolved a stale missed-runs pause; skipped to the next future anchor',
        }), 'scheduler: stale missed-run pause auto-resolved', { taskId });
        writeTaskLog({
          taskId,
          fromEntity: 'engine',
          entryKind: 'auto_sweep',
          fromStatus: 'paused',
          toStatus: 'on_deck',
          actionTaken: `engine auto-skipped ${missedSlots} missed run${missedSlots === 1 ? '' : 's'} to the next scheduled time`,
          reason: `paused-for-missed-runs was not resolved within ${MISSED_RUNS_AUTO_RESOLVE_MINUTES} minutes (work_schedule(action="resolve_missed") never ran); schedule resumed, next run at ${nextRun}`,
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

// ── Check and trigger due tasks ──

// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-1 CT2 — THE VERIFY RUNG OF THE STEER-TO-DELIVER LADDER.
//
// OR2's shape is detect → steer → VERIFY → bounded retry, and this is the verify. Without it
// the ladder is a wall: MEASURED on the first post-fix drive (behavioral run `bmslq48axkn`,
// 2026-08-09), the model called `work_update(status="complete")` BEFORE it spoke, was correctly
// refused, then went on and delivered a real brief — *"Good morning — here's tomorrow's brief
// (Monday, Aug 10): your calendar is clear…"* — and never called the tool again. The person had
// their brief and the run sat `open` for ever. A refusal that leaves the run stuck is not an
// improvement on a lie; it is a different failure.
//
// So the run closes ON THE DELIVERY, exactly as an ask does (`work/ask-settlement.ts`'s
// delivery arm). The scope is deliberately narrow and every clause of it is load-bearing:
//
//   * the run must have been STEERED at least once. The steer is the agent's own assertion
//     that the work is finished, refused only for want of evidence; without it this sweep would
//     be closing runs nobody said were done, which is a different and much worse behaviour.
//   * the evidence is re-derived by the AUTHORITY (`runDeliverableEvidence`), never by this
//     sweep. One predicate, one owner.
//   * the close goes through `onTaskRunComplete`, the ordinary full flow, so the run count, the
//     next occurrence, the audit trail and the notices are all exactly what they would have
//     been if the model had called the tool a second time itself.
//
// It rides the scheduler tick because that is where run lifecycle already lives (beside
// `cleanupOrphanedRuns` and the orphan sweep) and because the tick is the platform's existing
// 30-second clock — a cadence carried, not re-chosen.
//
// ⚠ UX-REPAIR ROUND 4 T19 (D6) — AND THE FIRST CLAUSE'S WORRY IS NOW ANSWERED WITH EVIDENCE
// RATHER THAN OBEYED AS PROSE, which is why the name lost the word "Steered". The complement
// of the case above — the model DELIVERS FIRST and never attempts a close at all — produces no
// steer marker and was uncovered. Driven, 2026-08-10 18:45Z: a one-shot reminder reached the
// owner (`agent-text`, a real `deliveries` row), the run sat `open` for twelve minutes, the
// model was refused `complete` TWICE for want of a pointer the ledger already held, and the
// run was only resolved because a PM poke dragged the model back and a second agent authorised
// a cancel. Absent that it meets the 30-minute idle reaper and a perfectly delivered reminder
// is recorded failed. A steer is the agent SAYING it is finished; `runDeliverableEvidence` is
// the ledger SHOWING the person got something, and the second is the stronger of the two.
//
// The row set — including the one narrowing the unsteered arm needs, that the agent's own turn
// has ENDED — lives with the authority in `work/occurrences.ts:runsReadyToCloseOnDelivery`,
// so this sweep still asks and never decides.
// ════════════════════════════════════════════════════════════════════════════════
export async function closeRunsThatDelivered(): Promise<number> {
  let closed = 0;
  for (const row of runsReadyToCloseOnDelivery()) {
    logger.info('Scheduler: a run delivered — closing it on the message', {
      taskId: row.taskId, runId: row.occurrenceId, deliveryId: row.deliveryId,
      tool: row.tool, steered: row.steered,
    });
    const advanced = await onTaskRunComplete(
      row.taskId, 'complete',
      row.steered
        ? 'the run was steered to deliver and the message reached the user; closed on that delivery'
        : 'the run delivered its message to the user without ever asking to close; closed on that delivery',
    ).catch((err: unknown) => {
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
  // The spine stores instants as epoch-ms; the recurrence maths still speaks ISO. Both forms
  // of the SAME instant, taken once, so a tick cannot compare two different "nows".
  const nowMs = Date.parse(now);

  // ── SWEEP CORE-2 item 3 (SWEEP-F T2): THE TICK KEEPS ONLY SCHEDULING. ──
  //
  // Six sweeps ran here and none of them was about deciding which occurrence fires now. They
  // ran here for one reason, stated in their own comments: the scheduler tick was the nearest
  // 30-second clock. That is exactly the reason PHASE-2 T9 built `work/work-reaper.ts` to
  // retire — one declared owner for every periodic obligation sweep, each with the clock its
  // cadence was CARRIED from. They are the reaper's kinds now:
  //
  //   cleanupOrphanedRuns + cleanupStaleRuns    -> `orphaned-and-stale-runs`      @30s
  //   resumeExpiredPauses                       -> `expired-pauses`               @30s
  //   sweepUnvalidatedTasksForUserEscalation    -> `validation-escalation`        @30s
  //   closeRunsThatDelivered                    -> `steered-run-delivery-close`   @30s
  //   pruneTerminalTasks                        -> `terminal-task-prune`          @1h
  //
  // (The plan wrote "the five non-scheduling sweeps". Re-derived at HEAD it is SIX: SWEEP
  // CORE-1 CT2 added `closeRunsThatDelivered` after the plan was written, and its own
  // comment gives the same reason the other five had — "it rides the scheduler tick because
  // that is where run lifecycle already lives". The two 12-hour sweeps the plan also counted
  // left at PHASE-2 T9 and were already the reaper's.)
  //
  // WHAT STAYS, AND WHY: `autoResolveStaleMissedRunPauses` advances the cadence past slots
  // that were missed while the box was down. That IS scheduling — it walks the recurrence and
  // writes the next fire time — and moving it because it happens to have a ten-minute cliff
  // would be filing a thing by its clock instead of by its job.
  //
  // ORDERING, STATED: the six no longer run immediately before the due scan in the same
  // function. Both clocks are 30 seconds, so the worst case is that a row repaired by the
  // reaper is picked up by the due scan one tick later than it would have been. Nothing in
  // the six is a PRECONDITION of the scan: the occurrence claim is a UNIQUE constraint, not
  // an assumption about what already ran.
  //
  // D12: engine fallback for missed-runs pauses the model never resolved.
  await autoResolveStaleMissedRunPauses();

  // PHASE-6 T0C-W: this WHERE was the tree's most literal statement of what "overdue"
  // means, so it IS `dueScope()` now — the one declaration `work_update(filter:"overdue")`
  // also answers from. Same SQL, same rows; the 1.5× escalation below stays this site's own.
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

    // ── v2.5.45: missed-runs detection ──
    // If a recurring task is overdue by more than 1 interval, multiple
    // anchor slots have passed without firing — almost always because the
    // platform was offline or the task was paused longer than expected.
    // Per user spec, the engine doesn't get to silently backfill or skip:
    // wake the assigned agent and let them decide via
    // work_schedule(action="resolve_missed").
    // D12: a NEVER-run task (run_count = 0) whose start is in the past is a
    // first fire, not a missed run; the old detector funneled it into the
    // pause-and-ask trap. Only a task that has genuinely fired before can
    // miss a run, so the detector requires run_count > 0 (the 1.5x-interval
    // overdue rule below is unchanged for those).
    const repeatInterval = taskRow.repeat_interval as number | null;
    const repeatUnit = taskRow.repeat_unit as string | null;
    if (repeatInterval && repeatUnit && runCount > 0) {
      // The RAW instant, not the display copy: the missed-run rule is a COMPARISON, and
      // `msToText` truncates. A second's error cannot flip the 1.5x test on any real
      // interval, but the rule for this whole surface is that comparisons take the raw
      // column — that is what stopped the CAS defect being findable for two weeks.
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

    // Check dependencies — skip if any dependency isn't complete
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
            // Push next_run_at forward by 30 seconds so we re-check soon.
            // Write an explicit ISO instant, not datetime('now','+30 seconds'):
            // SQLite's space-separated form (0x20) sorts BELOW the 'T' (0x54)
            // in the ISO `now` this scheduler string-compares against, so a
            // same-date space value reads as already due and the defer would
            // collapse to "due again next tick". ISO keeps the defer honest.
            noteUnsettled(setNextRun(taskId, {
              at: Date.now() + 30_000, touch: false,
              reason: 'a dependency is not complete; re-check this SAME occurrence in 30s',
            }), 'scheduler: fire deferred 30s after a lost claim', { taskId });
            continue;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // ── D21's occurrence claim, now a WORK ROW (PHASE-2 T8c2 item 4) ──
    // Exactly one process may fire a given occurrence, and that is now a CONSTRAINT rather
    // than a plea: the claim INSERTs `work(kind='occurrence', parent_id=<schedule>,
    // sequence=<run number>)` and `ux_work_occurrence` refuses the second one. The schedule's
    // own preconditions (still waiting, not paused, still pointing at THIS occurrence) are
    // checked in the same transaction against the RAW epoch-ms column — `occurrenceOf`, never
    // the display text, which drops milliseconds and made this CAS unwinnable for any
    // schedule started from a real clock reading. Overlapping ticks and duplicate dev
    // processes lose the claim and skip. The NEXT occurrence is still computed and written
    // HERE, at fire time, so a hung or crashed turn cannot stall the cadence; and because the
    // occurrence is a durable row, a crashed fire can no longer LOSE it either.
    const claimedOccurrenceMs = occurrenceOf(taskRow);
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
    // The occurrence id IS the claim token. The state assignment stays outside it — that is
    // `transition()`'s — and runs AFTER the claim is won, so two processes still cannot both
    // fire an occurrence.
    //
    // PHASE-4 T2, MEASURED AND DELIBERATELY LEFT SPLIT (#14). §T0-PINS B lists this as the
    // plan's "schedule advance + occurrence" cluster, un-atomic. Re-derived at 9d3507e: the
    // ADVANCE IS ALREADY INSIDE THE CLAIM — `work/occurrences.ts claimOccurrence` writes the
    // occurrence INSERT and `schedule_status='running', last_run_at, next_run_at` in ONE
    // transaction, and rolls both back on a lost CAS. The `patchWork(next_run_at + 30s)`
    // the pin points at is a different thing: the 30-second DEFER in the dependency branch
    // above, a single write followed by `continue`.
    // What remains split is claim-then-`setTrackerStatus`, and that split is the DESIGN,
    // stated two lines up: the claim must be won before anything asserts the row is running.
    // Merging them would fold a concurrency decision into a refactor.

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

    // PHASE-2 T10F — THE OCCURRENCE ID *IS* THE RUN ID, and `task_runs` is gone.
    //
    // T8c2 built the occurrence row and left the `task_runs` INSERT standing eighteen lines
    // below the claim: two records of one fact, written by this function, on every fire. The
    // second one is deleted here. Nothing downstream changes shape — `runId` is still the
    // lineage key the engine event carries and `retireEngineEventsForRun` sweeps by — and one
    // mislabel is fixed on the way past: the trigger already declared
    // `rootKind: 'occurrence', rootId: runId` while `runId` was a `task_runs` uuid. Now it is.
    const runId = occurrenceId;

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
        // PHASE-2 T10F: the `task_runs` row was marked 'skipped' HERE and the occurrence
        // released immediately after — so the old shape recorded a skipped run #N and then
        // let #N be claimed again, i.e. history could carry the same run number twice. The
        // release is the record now: `releaseOccurrence` writes `occurrence_released` with
        // this reason ON THE SCHEDULE, deliberately, because the occurrence row is about to
        // be deleted so its sequence can be re-claimed and an event on a deleted row is a
        // record nobody can find. D21's "retries on the next tick exactly as before" is the
        // requirement, and it is the one the released row serves.
        // D21: release the claim taken above and restore the occurrence and prior
        // last_run_at, so the task retries on the next tick exactly as it did before the
        // claim existed. The occurrence ROW goes with it — releasing the sequence is what
        // lets the same occurrence be claimed again once the group has somebody free.
        // Both instants are the RAW columns: restoring a truncated `last_run_at` would
        // silently shift it by up to 999ms every time a group was momentarily empty.
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

    // 4. Record who actually runs it. The claim fired on the schedule's own assignee (or
    //    'scheduler'); the group pick, the primary fallback and the terminated-agent
    //    reassignment above are all resolved after it, and the run history renders this.
    //    `started_at` needs no write: the occurrence's `opened_at` IS the instant it was
    //    claimed, which is what 'running' meant.
    assignOccurrence(runId, assignedAgent);

    // 5. Trigger execution
    const taskTitle = taskRow.title as string;
    const taskDesc = taskRow.description as string | null;
    const taskKind = taskRow.kind as string | null;
    const totalRuns = taskRow.repeat_end_value ? ` of ${taskRow.repeat_end_value}` : '';

    // Reminders get a lighter prompt — they're not "tasks" in the
    // execute-multiple-steps sense, they're a single conversational
    // delivery to the user. The agent should say the thing in its
    // normal voice and silently close out.
    //
    // ⚠ UX-REPAIR ROUND 4 T19 (D1) — "WHEN YOU'RE DONE SPEAKING, SILENTLY CALL …" WAS AN
    // INSTRUCTION TO BUILD THE ONE SHAPE THE PLATFORM DESTROYS. Text emitted in the SAME model
    // response as a tool call is classified as working notes and demoted
    // (`post-call-classify/terminal-text.ts`, G-SUP-2), so a model that reads "when you're
    // done speaking" as *in this response* loses its reminder. Measured 2026-08-10 13:45Z:
    // that is exactly what happened, twice, and the owner heard nothing. The wake now asks for
    // the ORDER it actually needs — the reply alone, the bookkeeping in the next response.
    // This is an events-lane message row, not a prompt-prefix surface; no golden moves.
    const message = taskKind === 'reminder'
      ? `[Reminder due] ${taskDesc ?? taskTitle}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nDeliver this reminder to the user now as a single short chat message in your normal voice. Do NOT prefix with "Reminder:" or "Here's your reminder", just say the thing naturally (e.g. user asked to be reminded to "go get coffee" → "Hey, time to go get coffee."). Say it as a SEPARATE response with no tool call in it — text that rides along with a tool call is treated as working notes and never reaches the user. Then, in your NEXT response, silently call work_update(action="status") with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping; do NOT write any user-facing message about marking the reminder complete ("Task closed", "All done", "Marked complete"). The reminder message itself is the entire user-facing output.`
      : `[Scheduled Task, Run #${runNumber}${totalRuns}] ${taskTitle}${taskDesc ? '\n' + taskDesc : ''}\n\nTask ID: ${taskId}\nRun ID: ${runId}\n\nWhen this run is finished, call work_update(action="status") with task_id="${taskId}" and status="complete". The close-out is internal bookkeeping; do NOT write any user-facing message about marking the task complete (e.g. "Task closed", "All done", "Marked complete"). The user already received your reminder/output above; an extra "task closed" line is just noise.`;

    // Inject as engine event and trigger runtime.
    // D-A step 4: a scheduler fire is inter-agent/engine traffic (origin_kind=
    // lane='events'), so it lands on the EVENTS lane, structurally outside the assignee's
    // `messages` chat table. The merged tail + assembler surface it as a pending
    // engine event (conv_key NULL) exactly as the old `messages` row did, and the
    // migration-084/099 delivery lifecycle applies unchanged.
    const msgId = uuidv4();
    insertEngineEventIfAbsent({
      id: msgId,
      agentId: assignedAgent,
      content: `[SOURCE: SCHEDULER — automated scheduled task trigger, not a message from the user] ${message}`,
      sourceAgentId: null,
      originIntent: 'scheduler',
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

  // Find the run in flight for this task. PHASE-2 T10F: this was a SELECT over task_runs for
  // the newest row with status 'running', sitting three statements above
  // `inFlightOccurrence(taskId)`, which asks the same question of the row that replaced it.
  // One question, one asker. (The old statement is not quoted verbatim here on purpose: the
  // SQL-prepare guard in `work/__tests__/override-sql-prepares.test.ts` scans backticked
  // spans and cannot tell a documented statement from a live one, so quoting a statement
  // against a dropped table turns a strict guard into a false red.)
  const inFlight = inFlightOccurrence(taskId);

  if (!inFlight) {
    // No active run, either a non-scheduled task or the occurrence was already
    // closed by another path. Nothing to advance. RC-17: report the no-op with a
    // boolean so callers (work_validate(action="validate")) don't misread an unchanged, already-
    // 'complete' row as a fresh terminal close and kill the whole schedule.
    return false;
  }

  const runId = inFlight.id;
  const now = new Date().toISOString();

  // PHASE-2 T8c2 item 4: settle the occurrence ROW with the run that closed it. Its terminal
  // state is the run's own outcome — a run that reached nobody cannot be `done`, because G7
  // is a DB CHECK, and no sentinel delivery is invented to pretend otherwise.
  //
  // PHASE-2 T10F — AND THIS SETTLE IS NOW THE CLOSE TOKEN. RC-17's token was
  // `UPDATE ... WHERE id=? AND status='running'` with `.changes === 1`; a row already terminal
  // cannot be transitioned again, so `applied` carries exactly the same meaning and the
  // duplicate `task_runs` write is gone. Losing the race must still NOT advance run_count /
  // recompute next_run_at (the P-5 run-counter inflation class), so it bails as a no-op.
  const occRow = db.prepare('SELECT agent_id, opened_at FROM work WHERE id = ?')
    .get(runId) as { agent_id: string; opened_at: number } | undefined;
  const delivered = occRow ? deliveryForAgentSince(occRow.agent_id, occRow.opened_at) : null;
  const settled = settleOccurrence(runId, status, delivered, summary);

  // ── SWEEP CORE-1 CT2 — THE RUN OWES A MESSAGE AND NONE WAS SENT. ──
  // The authority refused, the run is still open, and NOTHING here may advance: no run count,
  // no next occurrence, no "completed" log entry, no notice to the owner that a run finished.
  // The caller (the model's own close tool) is handed the refusal and steers on it. This is the
  // whole of the owner's sentence in code — *"I won't close the run until after the message is
  // sent."* The bound is the ladder's, inside the authority, not a loop here.
  if (settled.verdict === 'owed') {
    logger.info('Scheduler: run close REFUSED — it owes a user-visible message and none was sent', {
      taskId, runId, detail: settled.detail,
    });
    return false;
  }

  if (settled.outcome?.kind !== 'applied') {
    logger.info('Scheduler: run already closed elsewhere, skipping advance', {
      taskId, runId, result: settled.outcome?.kind,
      reason: settled.outcome && 'reason' in settled.outcome ? settled.outcome.reason : undefined,
    });
    return false;
  }

  // ── UX-REPAIR ROUND 4 T19 (D4) — AN UNDELIVERED RUN IS NOT A NEUTRAL BADGE ──
  //
  // The authority has just recorded that this run owed a person a message and reached nobody.
  // Before this, the ONLY place that fact was visible was `TaskRunHistory.tsx` — inside an
  // expanded task detail, rendered as a neutral badge, on a row the board does not even show
  // (`taskScope()` is `kind='task'`, so occurrences never appear on it). Measured on the
  // owner's box, 2026-08-10: the reminder run went terminal at 14:15:54 and NOTHING told him.
  // `DESIGN.md:46` calls that shape by name — *"it NEVER errs toward silence, a parked ticket,
  // or a quiet close."*
  //
  // OR2's last rung, and it is the surface OR2 names for exactly this: the PLATFORM's own
  // voice, never the engine wearing the agent's face, never the reminder text re-read out of
  // the work row as if the agent had said it. `recordFloorGhost` writes the durable row, the
  // owner-alert system note and the health frame — the same three parts the in-turn
  // reminder-silence ghost writes. It is not a second mechanism, it is the same one reached
  // from the run's close instead of from a turn's end.
  //
  // ONE alert per run: if the in-turn floor already ghosted this incident (the ordinary path
  // when the model is still in the loop), this arm stays quiet rather than telling the owner
  // twice. The owner's tie-break — "worst case he hears it twice" — is about the ANSWER, not
  // about platform alarms.
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
    } catch (err) {
      logger.warn('Scheduler: could not surface an undelivered run to the owner (non-fatal)', {
        taskId, runId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // P2 serve boundary, close claims its trigger BY KEY: the occurrence is
  // done, so any unserved trigger row for this run retires now instead of
  // waking a turn later to redo finished work.
  retireEngineEventsForRun(runId);

  // Update task run count
  bumpWorkAttempts(taskId);

  // Get updated task
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown>;
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

  // ── UX-REPAIR ROUND 6 T26 — THE CADENCE RESET IS ALSO A BOOKKEEPING MOVE ──
  //
  // Same rule as `forceResetStuckRecurringTask`'s guard, at the OTHER site that moves a
  // running recurring row back to `on_deck`. A worker that filed `complete_all_runs` is asking
  // for the SCHEDULE to stop; sending the row to `on_deck` while that request is outstanding
  // takes it out of the close-request subject (`closeRequestFiledExpr`: `claimed`/`paused`,
  // T21's argued pair) and leaves it held out of firing with no path to a verdict — a row
  // frozen between two mechanisms. It stays `claimed`, in front of the validator, until Key 2
  // rules; if the close is REFUSED the request is answered, the hold in `dueScope` lifts, and
  // the next tick resumes the cadence with the refusal on the row's own ledger.
  const stopPending = (getDb().prepare(
    `SELECT ${pendingCloseRequestExpr('w')} AS pending FROM work w WHERE w.id = ?`,
  ).get(taskId) as { pending: number } | undefined)?.pending === 1;

  if (nextRun && stopPending) {
    // The next occurrence is still computed and stored — a refusal must find a live cadence
    // to resume — but the row does NOT leave the validator's queue.
    noteUnsettled(setNextRun(taskId, {
      at: tsToMs(nextRun),
      alongside: { last_run_at: tsToMs(now) },
      reason: 'a run finished while a close request was pending; the cadence is recorded but the row stays with the validator',
    }), 'scheduler: run finished with a close request pending', { taskId });
    logger.info('Scheduler: run finished with a stop filed — the row stays claimed for the validator instead of rejoining its cadence', {
      taskId, nextRun,
    });
  } else if (nextRun) {
    // Recurring: set next run, go back to waiting, reset task status to on_deck
    // T2: the tracker state and the schedule columns describe ONE event — this run
    // finished and the next one is due at T. Split across two transactions they could
    // disagree, and a schedule that says `waiting` while the board still says the task is
    // running is exactly the "sleeping project" class Phase 2 closed from the other side.
    withUnit(() => {
      noteUnsettled(setTrackerStatus(taskId, 'on_deck', {
        by: 'scheduler', actorId: 'scheduler', reason: 'run finished; waiting for the next occurrence',
      }), 'scheduler: run finished, waiting for the next occurrence', { taskId });
      noteUnsettled(setNextRun(taskId, {
        at: tsToMs(nextRun),
        alongside: { schedule_status: 'waiting', last_run_at: tsToMs(now) },
        reason: 'a run finished and the schedule has another occurrence',
      }), 'scheduler: run finished, waiting for the next occurrence', { taskId });
    });
  } else if (failedFinalRun) {
    // D8: final run failed, keep the failure VISIBLE (see block comment above).
    withUnit(() => {
      noteUnsettled(setTrackerStatus(taskId, 'fallen', {
        by: 'scheduler', actorId: 'scheduler', reason: 'the final scheduled run failed',
      }), 'scheduler: final run failed', { taskId });
      noteUnsettled(patchWork(taskId, { schedule_status: 'completed', last_run_at: tsToMs(now) }), 'scheduler: final run failed, schedule completed', { taskId });
    });
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
        `${OWNER_ALERT_HEADS_UP_PREFIX} a scheduled ${noun}, "${title}"${when ? ` (set for ${when})` : ''}, failed on its final attempt and was not delivered. ` +
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
    const finalDelivery = deliveryForTaskClose(taskId);
    const finalRes = withUnit(() => {
      const res = setTrackerStatus(taskId, 'complete', {
        by: finalDelivery ? 'scheduler' : 'agent', actorId: 'scheduler',
        resultDeliveryId: finalDelivery,
        reason: 'the schedule ran out of occurrences and the last run succeeded',
      });
      noteUnsettled(patchWork(taskId, { schedule_status: 'completed', last_run_at: tsToMs(now) }), 'scheduler: occurrences ran out, schedule completed', { taskId });
      return res;
    });
    if (!workSettled(finalRes)) {
      logger.warn('Scheduler: final-run close refused by the work gate', { taskId, result: finalRes });
    }
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
// language.
//
// ── SWEEP CORE-2 item 3 (SWEEP-F T2): RE-POINTED OFF THE DEAD CHANNEL. ──
// This was the LAST site in this file still writing a bare `role='system'` chat row, and the
// comment that stood here admitted the whole defect while calling it a design: *"role='system'
// rows are dropped by the model-message builder ... this owner heads-up still rides
// role='system' (owner-facing only, the primary's model does not relay it) ... if the
// demolition is extended here, convert it to postAgentNotice the same way."* It is extended
// here, and the reason is not tidiness:
//
//   THE OWNER IS NOT AT THE DASHBOARD. This note exists for the one case where a reminder the
//   owner ASKED FOR is never going to happen. Written as a `role='system'` chat row it renders
//   in the dashboard chat history and NOWHERE ELSE — the primary's model never sees it, so it
//   cannot relay it by iMessage when the owner is away, cannot answer a question about it, and
//   cannot offer to set the reminder up again. The note reached the one surface the owner is
//   least likely to be looking at when a reminder silently dies.
//
// It is now the same idiom as the failed-final-run owner note ~130 lines above (Phase 0.1's
// conversion): a model-VISIBLE awareness NOTICE, `role='user'` / `origin_kind='engine'`, from
// the Scheduler as a SUBSYSTEM (`selfIntro: false` — "this is the Scheduler agent" would
// introduce an agent that does not exist). OR2's shape: the platform detects, the AGENT
// speaks. The owner-facing sentence is carried BYTE-FOR-BYTE, including the "Heads up:" prefix
// (`OWNER_ALERT_HEADS_UP_PREFIX`), which the visibility rules match on.
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
    // Wake the primary so it relays the skipped reminder this turn rather than waiting for an
    // unrelated trigger. Best-effort: the notice is already persisted in the awareness lane and
    // surfaces on the next assembled context regardless. Copies the alertMissedRuns wake idiom.
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
  // T18: the trail line the OWNER reads. It defaults to the string it has always written, so
  // the fallen path is byte-identical; the cancellation call sites pass their own, because
  // "terminated on fallen" stamped onto a task the owner cancelled is the same failure word
  // in the same place, one table over from the status this task just fixed.
  actionTaken = 'schedule terminated on fallen',
): { terminated: boolean; runsSkipped: number; isReminder: boolean } {
  const db = getDb();
  const row = db.prepare(
    'SELECT title, task_kind AS kind, schedule_status FROM work WHERE id = ?',
  ).get(taskId) as { title: string; kind: string | null; schedule_status: string } | undefined;
  if (!row) return { terminated: false, runsSkipped: 0, isReminder: false };
  const isReminder = row.kind === 'reminder';
  // Only 'waiting' (armed, awaiting the next fire) and 'running' (fired, a run
  // is in flight) schedules can still fire. 'completed'/'unscheduled'/'idle'
  // are already inert.
  const scheduleIsLive = row.schedule_status === 'waiting' || row.schedule_status === 'running';
  if (!scheduleIsLive) return { terminated: false, runsSkipped: 0, isReminder };

  const stopped = { changes: clearLiveSchedule(taskId) ? 1 : 0 };
  if (stopped.changes !== 1) {
    // Raced with another terminator; leave the winner's outcome intact.
    return { terminated: false, runsSkipped: 0, isReminder };
  }

  // PHASE-2 T10F: the same UPDATE, against the rows that replaced `task_runs`. The COUNT is a
  // preserved fact and not a log line — it is quoted to the owner below and it gates the
  // reminder heads-up.
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

// ── Orphan cleanup ──

/**
 * Find in-flight occurrences whose assigned agent is terminated.
 * Auto-complete them so the task can move on (or finish if it was the last run).
 */
export function cleanupOrphanedRuns(): void {
  const orphans = sweepTerminatedAgentOccurrences();

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
    onTaskRunComplete(orphan.taskId, 'failed', 'Auto-failed: assigned agent was terminated before the run completed').catch(err => {
      logger.error('Scheduler: orphan cleanup failed for task', {
        taskId: orphan.taskId,
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
export function cleanupStaleRuns(): void {
  const db = getDb();
  const AGENT_IDLE_THRESHOLD_MINUTES = 30;
  // PHASE-6 T10: the value and its v2.3.8 reasoning live in `agent/stuck-thresholds.ts`
  // beside the other three stuck cliffs. Unchanged at 120; enforced here.

  // ── RC-17.4: the orphaned-occurrence sweep ──
  // The recovery machinery below keys on TASKS (schedule_status='running'),
  // so it cannot see runs that were orphaned when a path reset the task row
  // WITHOUT closing the run: work_update(action="complete_step") closes a fired recurring
  // task with zero run bookkeeping, and the force-reset / missed-runs paths
  // rewrite schedule_status directly. Those open runs then
  // accumulate forever (transcript-proven pool drain: runs 42/43/44/45 never
  // closed), and onTaskRunComplete's "newest running run" selection can grab a
  // stale one. Invariant: a legitimately in-flight run always has its parent at
  // schedule_status='running' (the claim sets both atomically, and close-out
  // closes the run BEFORE moving schedule_status). So any open run whose parent
  // is NOT schedule_status='running' is an orphan. Close them 'skipped'. Silent
  // by design (no owner heads-up): this drains stale bookkeeping, it is not a
  // live reminder the owner needs told about. A short age guard avoids racing an
  // in-flight advance.
  // PHASE-2 T10F: the query, the age guard and the close-only-while-open race are all
  // carried into `sweepOrphanedOccurrences`, which keys on the occurrence rows that
  // replaced `task_runs`. Each clause is asserted in `work/__tests__/occurrence-runs.test.ts`,
  // including the age guard's negative control (a FRESH orphan is left alone).
  sweepOrphanedOccurrences();

  // 1. Standard stale-running detection. Use the OLDER of (per-task
  // updated_at, agent last message) — same per-task pattern as PM's poke
  // loop in v2.3.6. Catches a recurring run that the agent finished but
  // never called work_update(action="status") on.
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
    SELECT t.id AS id, t.title AS title, t.agent_id AS assigned_to
    FROM work t
    WHERE ${taskScope('t')} AND t.schedule_status = 'running'
      AND t.state != 'paused'
      AND t.agent_id IS NOT NULL
      AND MIN(
        COALESCE(
          (SELECT MAX(m.created_at) FROM messages m WHERE m.agent_id = t.agent_id),
          t.updated_at
        ),
        t.updated_at
      ) < ?
  `).all(Date.now() - AGENT_IDLE_THRESHOLD_MINUTES * 60_000) as Array<{ id: string; title: string; assigned_to: string }>;

  // 2. Also catch running tasks with no assigned agent at all
  const unassigned = db.prepare(`
    SELECT t.id AS id, t.title AS title
    FROM work t
    WHERE ${taskScope('t')} AND t.schedule_status = 'running'
      AND t.state != 'paused'
      AND t.agent_id IS NULL
      AND t.last_run_at < ?
  `).all(Date.now() - 5 * 60_000) as Array<{ id: string; title: string }>;

  // 3. Force-recovery for recurring tasks that are status='in_progress'
  // but schedule_status is NOT 'running' (out-of-sync state from a previous
  // run that left the row inconsistent). cleanupStaleRuns above misses
  // these because of the schedule_status='running' filter, and
  // onTaskRunComplete bails when there's no active task_runs row — so
  // they sit stuck forever. v2.3.8: catch them here and force-reset
  // directly via the helper below, bypassing onTaskRunComplete.
  const stuckOutOfSync = db.prepare(`
    SELECT t.id AS id, t.title AS title
    FROM work t
    WHERE ${taskScope('t')} AND t.state = 'claimed'
      AND t.repeat_interval IS NOT NULL
      AND (t.schedule_status IS NULL OR t.schedule_status != 'running')
      AND t.is_paused = 0
      AND t.updated_at < ?
  `).all(Date.now() - HARD_STUCK_THRESHOLD_MINUTES * 60_000) as Array<{ id: string; title: string }>;

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
    SELECT t.id AS id, t.title AS title
    FROM work t
    WHERE ${taskScope('t')} AND t.repeat_interval IS NOT NULL
      AND t.repeat_unit IS NOT NULL
      AND t.next_run_at IS NULL
      AND t.is_paused = 0
      AND t.state NOT IN ('done', 'failed', 'abandoned', 'paused')
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
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
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
    const recDelivery = deliveryForTaskClose(taskId);
    const recRes = setTrackerStatus(taskId, 'complete', {
      by: recDelivery ? 'scheduler' : 'agent', actorId: 'scheduler',
      resultDeliveryId: recDelivery,
      reason: 'a recurring task with no recoverable next run is finished',
    });
    if (!workSettled(recRes)) {
      logger.warn('Scheduler: recovery close refused by the work gate', { taskId, result: recRes });
    }
    noteUnsettled(patchWork(taskId, { schedule_status: 'completed' }), 'scheduler: missing next_run_at had no future occurrence, schedule completed', { taskId });
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
  const task = db.prepare(`SELECT ${scheduleRowColumns('w')} FROM work w WHERE w.id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!task) return;
  if (task.status !== 'in_progress') return;
  if (!task.repeat_interval) return;

  // ── UX-REPAIR ROUND 6 T26 — A ROW WITH A FILED CLOSE IS NOT A STUCK ROW ──
  //
  // This function's premise is "structurally stuck: in_progress with no productive way out".
  // A row whose worker has filed `complete_all_runs` looks identical from the outside and is
  // the exact opposite: it is unmoved ON PURPOSE, because the two-key wall (migration 139)
  // will not let a worker close its own work, and it is waiting for the validator.
  //
  // MEASURED, dev body 2026-08-10: event 22628 filed the stop on the duplicate weather task
  // at 23:09:10 ("agent asserts every run is done; the schedule stops here"); five seconds
  // later this function wrote event 22630, `claimed→on_deck`, "this run is failed; the
  // schedule rejoins at its next occurrence". That transition is what buried the request, and
  // four minutes after it the row's occurrence was skipped as an orphan (22632) — a run
  // recorded failed beside an answer that had already been delivered.
  //
  // Guarded HERE rather than at the three callers (the stale/stuck sweep, going-idle's
  // recurring-dangler pass, tracker-closeout's) because it is this function's own
  // precondition, and a precondition stated once cannot be forgotten by the fourth caller.
  const heldForValidation = db.prepare(
    `SELECT ${pendingCloseRequestExpr('w')} AS pending FROM work w WHERE w.id = ?`,
  ).get(taskId) as { pending: number } | undefined;
  if (heldForValidation?.pending === 1) {
    logger.info('Scheduler: force-reset SKIPPED — a close request is pending on this row; it is a validation subject, not a stuck row', {
      taskId, title: task.title,
    });
    return;
  }

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
    const frDelivery = deliveryForTaskClose(taskId);
    const frRes = setTrackerStatus(taskId, 'complete', {
      by: frDelivery ? 'scheduler' : 'agent', actorId: 'scheduler',
      resultDeliveryId: frDelivery,
      reason: 'stuck recurring task has no future runs left',
    });
    if (!workSettled(frRes)) {
      logger.warn('Scheduler: force-reset close refused by the work gate', { taskId, result: frRes });
    }
    noteUnsettled(patchWork(taskId, { schedule_status: 'completed' }), 'scheduler: stuck recurring task had no next occurrence, schedule completed', { taskId });
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

// ⟨TOMBSTONE⟩ `lastPruneAt` + `PRUNE_INTERVAL_MS = 3600_000` lived here: a module-scope
// wall-clock throttle inside a function called by a 30-second timer, so the function ran 120
// times an hour to do nothing 119 of them. SWEEP CORE-2 item 3 gave the prune its own reaper
// kind (`terminal-task-prune`, `everyMs: 3_600_000`) — the SAME hour, carried verbatim, now
// declared where every other cadence in the platform is declared and driven by the one timer.
// requirement preserved: "once per hour is plenty", asserted by
// `scheduler/__tests__/scheduler-owns-its-clock.test.ts` A5.

/**
 * Auto-resume paused tasks whose paused_until time has passed.
 * Restores the task to its pre-pause status (status_before_pause) and clears
 * the pause fields. The PM agent will then see the task in its normal state
 * and the process continues as usual.
 */
export function resumeExpiredPauses(): void {
  const db = getDb();

  const expired = db.prepare(`
    SELECT w.id AS id, w.title AS title, w.status_before_pause AS status_before_pause,
           ${msToText('w.paused_until')} AS paused_until
    FROM work w
    WHERE ${taskScope('w')} AND w.state = 'paused'
      AND w.paused_until IS NOT NULL
      AND w.paused_until <= ?
  `).all(Date.now()) as Array<{ id: string; title: string; status_before_pause: string | null; paused_until: string }>;

  for (const task of expired) {
    const restoreStatus = (task.status_before_pause ?? 'on_deck') as TrackerStatus;
    noteUnsettled(setTrackerStatus(task.id, restoreStatus, {
      by: 'scheduler', actorId: 'scheduler',
      reason: `the pause expired at ${task.paused_until}`,
    }), 'scheduler: pause expired', { taskId: task.id });

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
 * Keep each terminal state (complete, blocked, fallen, cancelled) capped at 50 tasks.
 * Oldest tasks beyond the cap are deleted along with their runs and poke logs.
 */
export function pruneTerminalTasks(): void {
  const db = getDb();

  // T18: `cancelled` joins the list. A terminal state missing from here is one that never
  // gets pruned — unbounded growth of exactly the rows nobody looks at again.
  for (const status of ['complete', 'blocked', 'fallen', 'cancelled']) {
    const overflow = db.prepare(`
      SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')} AND w.state = ?
      ORDER BY w.updated_at DESC
      LIMIT -1 OFFSET ?
    `).all(statusToState(status), TERMINAL_TASK_CAP) as Array<{ id: string }>;

    if (overflow.length === 0) continue;

    const ids = overflow.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    // Clear agent references first
    db.prepare(`UPDATE agents SET task_id = NULL WHERE task_id IN (${placeholders})`).run(...ids);
    // Delete related records. The poke rows are `work_events` now (T8c item 1), and the runs
    // are occurrence CHILDREN of each task (PHASE-2 T10F) — `deleteTrackerRow` deletes
    // children, their events and their adjudications in the same transaction as the row
    // itself, so there is no separate cleanup to do for either.
    // Delete the tasks (children, events and adjudications go with them)
    for (const id of ids) deleteTrackerRow(id);

    logger.info(`Scheduler: pruned ${ids.length} old ${status} task(s)`, { status, pruned: ids.length });
  }
}
