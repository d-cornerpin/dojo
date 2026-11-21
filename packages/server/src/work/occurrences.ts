// An occurrence is a `work` row and firing one is a claim: the claim is the INSERT of the occurrence
// row, and `ux_work_occurrence` (UNIQUE parent_id, sequence) refuses a second, so "execute once" is a
// constraint. The schedule's precondition (still waiting, not paused, pointing at this occurrence)
// is checked against the RAW epoch-ms column, never the second-resolution display text (it drops
// milliseconds, so a compare against it never matches). Every close goes through `transition()`
// in `store.ts`, never a direct write of `work.state`.

import { runItemsLeft, recordRunRemainder, RUN_STATUS_INCOMPLETE, countOf } from './measure-close-gate.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { clearReferencesToWork } from './work-refs.js';
import { createLogger } from '../logger.js';
import type { WorkEventKind } from './event-kinds.js';
// The fire-time advance and its restore live in `work/next-run.ts` and run inside this file's units.
import { advanceScheduleOnClaim } from './next-run.js';
import { transition, appendWorkEvent, type WorkOutcome } from './store.js';
import { occurrenceOwesDeliverable } from './deliverable-declaration.js';
import { proofDelivery } from './done/proof.js';

const logger = createLogger('occurrences');

/** `kind` of the rows this module owns; `store.ts:evidenceResolves` admits it as evidence. */
export const OCCURRENCE_KIND = 'occurrence';

/** The event kinds an occurrence carries; writer and reader share them so they cannot disagree by
 *  typo, and `satisfies` keeps them a view onto `event-kinds.ts`. */
export const OCCURRENCE_EVENT = {
  fired: 'occurrence_fired',
  /** The run closed, carrying ITS OWN outcome word, which `work.state` cannot hold. Payload:
   *  `{ run_status, summary }`. */
  settled: 'occurrence_settled',
} as const satisfies Record<string, WorkEventKind>;

/** The occurrence a due-scan row points at, in epoch ms: the RAW `next_run_at_ms` column, never the
 *  second-resolution `next_run_at` text beside it. */
export function occurrenceOf(row: Record<string, unknown>): number | null {
  const raw = row.next_run_at_ms;
  return typeof raw === 'number' ? raw : null;
}

export interface ClaimInput {
  workId: string;
  sequence: number;
  occurrenceMs: number | null;
  nowMs: number;
  nextRunMs: number | null;
  agentId: string;
  /** The run this occurrence is for when it is not the one the schedule waited on (a catch-up of a later missed run). */
  scheduledForMs?: number | null;
}

/** Claim an occurrence atomically and return its id, or null when this caller lost: INSERT the
 *  occurrence (the unique index refuses a duplicate), then advance the schedule; both or neither. */
export function claimOccurrence(input: ClaimInput): string | null {
  const db = getDb();
  const occurrenceId = uuidv4();
  let won = false;

  try {
    withUnit(() => {
      db.prepare(`
        INSERT INTO work (
          id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
          root_kind, root_id, state, intent, wakes, closes_thread,
          title, sequence, next_run_at, opened_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'schedule', ?, 'schedule', ?, 'open', 'occurrence', 0, 0,
                  ?, ?, ?, ?, ?)
      `).run(
        occurrenceId, OCCURRENCE_KIND, input.workId, input.agentId, input.agentId,
        input.workId, input.workId,
        `occurrence #${input.sequence}`, input.sequence, input.scheduledForMs ?? input.occurrenceMs,
        input.nowMs, input.nowMs,
      );

      const advanced = advanceScheduleOnClaim(db, {
        workId: input.workId, nowMs: input.nowMs,
        nextRunMs: input.nextRunMs, occurrenceMs: input.occurrenceMs,
      });

      // The schedule moved out from under this tick: roll the occurrence row back too.
      if (advanced !== 1) throw new LostClaim();

      appendWorkEvent(occurrenceId, OCCURRENCE_EVENT.fired, 'scheduler', {
        sequence: input.sequence, scheduled_for: input.scheduledForMs ?? input.occurrenceMs,
      });
      won = true;
    });
  } catch (err) {
    if (err instanceof LostClaim) return null;
    // A UNIQUE violation on `ux_work_occurrence` is the other way to lose; anything else is a fault.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      logger.info('occurrence already claimed (unique constraint)', {
        workId: input.workId, sequence: input.sequence,
      });
      return null;
    }
    throw err;
  }

  return won ? occurrenceId : null;
}

class LostClaim extends Error {}

/** Run word for a run that owed a person a message and reached nobody (shown with a neutral badge). */
export const RUN_STATUS_UNDELIVERED = 'undelivered';

/** A run that owes a message and delivered it, but was never handed in. */
export interface RunReadyToClose { occurrenceId: string; taskId: string; deliveryId: string }

/** Open runs that owe a message, whose turn ended and whose window holds it (`proofDelivery`). */
export function runsReadyToCloseOnDelivery(): RunReadyToClose[] {
  const rows = getDb().prepare(`
    SELECT w.id AS occurrence_id, w.parent_id AS task_id FROM work w JOIN work p ON p.id = w.parent_id
     WHERE w.kind = ? AND w.state IN ('open','claimed') AND p.task_kind IS NOT NULL AND p.state <> 'handed_in'
       AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.root_kind = w.kind AND t.root_id = w.id AND t.ended_at IS NULL)
  `).all(OCCURRENCE_KIND) as Array<{ occurrence_id: string; task_id: string }>;
  return rows.flatMap((row) => {
    const deliveryId = owedRunDelivery(row.occurrence_id);
    return deliveryId ? [{ occurrenceId: row.occurrence_id, taskId: row.task_id, deliveryId }] : [];
  });
}

/** The delivery the engine saw this run make, tied to it, when its task owes a message; else null. */
export function owedRunDelivery(occurrenceId: string): string | null {
  const o = occurrenceOwesDeliverable(occurrenceId);
  return o.owes && o.taskId ? proofDelivery(o.taskId, true) : null;
}

export interface RunSettlement {
  outcome: WorkOutcome | null;
  deliveryId: string | null;
  detail: string;
  /** The status as recorded after the deliverable and measure gates, not the caller's `runStatus`. */
  runStatusRecorded: string;
}

/**
 * Settle an occurrence when its run closes. The terminal state is the run's own outcome:
 * complete with a resolving delivery -> `done`; complete with nothing delivered -> `abandoned`
 * (`done` means DELIVERED, a DB CHECK, so no sentinel delivery is invented); failed -> `failed`;
 * skipped -> `abandoned`. A run whose task is DECLARED deliverable-owing
 * (`work/deliverable-declaration.ts`) that closes complete or failed with no delivery is recorded
 * `undelivered`, never complete, and the worker gets one hint (`scheduler/runner.ts`).
 */
export function settleOccurrence(
  occurrenceId: string, runStatus: string, deliveryId: string | null, summary: string | null,
): RunSettlement {
  let effectiveStatus = runStatus;
  let effectiveDelivery = deliveryId;
  let gateNote: string | null = null;
  const left = runStatus === 'complete' ? runItemsLeft(occurrenceId) : null;
  if ((runStatus === 'complete' || runStatus === 'failed') && !deliveryId && occurrenceOwesDeliverable(occurrenceId).owes) {
    effectiveStatus = RUN_STATUS_UNDELIVERED;
    gateNote = 'the run ended without reaching the person it owed a message';
  } else if (runStatus === 'complete' && deliveryId && occurrenceOwesDeliverable(occurrenceId).owes) {
    gateNote = 'delivered in its own window';
  }
  // After the deliverable gate: only a run it would record complete is recorded incomplete for items left.
  if (left && effectiveStatus === 'complete') { effectiveStatus = RUN_STATUS_INCOMPLETE; effectiveDelivery = null; gateNote = `${countOf(left.left, left.unit)} left by the task's measure`; }

  // The settle and the run's own word are ONE unit: the event is the only carrier of the difference
  // between "finished, reached nobody" and "never ran" (both land on `abandoned`).
  const outcome = withUnit((): WorkOutcome => {
  const runStatusInner = effectiveStatus;
  const deliveryIdInner = effectiveDelivery;
  let result: WorkOutcome;
  if (runStatusInner === 'failed') {
    result = transition(occurrenceId, {
      to: 'failed', by: 'scheduler', actorId: 'scheduler',
      reason: `the run for this occurrence failed${summary ? `: ${summary}` : ''}`,
      note: summary,
    });
  } else if (runStatusInner === 'complete' && deliveryIdInner) {
    result = transition(occurrenceId, {
      to: 'done', by: 'scheduler', actorId: 'scheduler',
      resultDeliveryId: deliveryIdInner,
      reason: `the run for this occurrence finished and delivered${gateNote ? ` (${gateNote})` : ''}`,
      note: summary,
    });
  } else {
    result = transition(occurrenceId, {
      to: 'abandoned', by: 'scheduler', actorId: 'scheduler',
      reason: runStatusInner === 'complete'
        ? 'the run for this occurrence finished with nothing delivered to a person'
        : runStatusInner === RUN_STATUS_INCOMPLETE
          ? `the run for this occurrence ended with ${gateNote}; it is recorded INCOMPLETE rather than complete`
        : runStatusInner === RUN_STATUS_UNDELIVERED
          ? 'the run for this occurrence ended and reached NOBODY: the task owes the person a '
            + 'user-visible message and none was ever sent. It is recorded UNDELIVERED rather '
            + `than ${runStatus === 'failed' ? 'failed' : 'complete'}`
          : `the occurrence was ${runStatusInner} without running`,
      note: summary,
    });
  }

  // The run's own word as an event, the gates' word (`runStatusInner`), since `abandoned` cannot hold it.
  if (result.kind === 'applied') {
    const incomplete = runStatusInner === RUN_STATUS_INCOMPLETE ? left : null;
    appendWorkEvent(occurrenceId, OCCURRENCE_EVENT.settled, 'scheduler', {
      run_status: runStatusInner, summary: summary ?? null, ...(incomplete ? { items_left: incomplete.left, unit: incomplete.unit } : {}),
    });
    if (incomplete) recordRunRemainder(occurrenceId, incomplete);
  }
  return result;
  });

  return {
    outcome,
    deliveryId: effectiveDelivery,
    detail: gateNote ?? `run settled ${effectiveStatus}`,
    runStatusRecorded: effectiveStatus,
  };
}

export function runSettleApplied(s: RunSettlement): boolean {
  return s.outcome?.kind === 'applied';
}

/** Record who actually runs this occurrence: the claim precedes assignee resolution. */
export function assignOccurrence(occurrenceId: string, agentId: string): void {
  getDb().prepare(
    `UPDATE work SET agent_id = ?, assignee_agent = ?, updated_at = ?
      WHERE id = ? AND kind = ?`,
  ).run(agentId, agentId, Date.now(), occurrenceId, OCCURRENCE_KIND);
}

/** Close every open occurrence of a schedule as skipped and return HOW MANY (the fallen path quotes it). */
export function skipOpenOccurrences(workId: string, reason: string): number {
  const open = getDb().prepare(
    `SELECT id FROM work WHERE kind = ? AND parent_id = ? AND state IN ('open','claimed')`,
  ).all(OCCURRENCE_KIND, workId) as Array<{ id: string }>;
  let closed = 0;
  for (const o of open) {
    if (runSettleApplied(settleOccurrence(o.id, 'skipped', null, `Skipped: ${reason}; schedule stopped`))) {
      closed += 1;
    }
  }
  return closed;
}

/** The age guard before an open run counts as orphaned, so the sweep never races an in-flight advance. */
export const ORPHAN_RUN_GRACE_MS = 5 * 60 * 1000;

/** Sweep open occurrences whose parent schedule is not running them (a live run always has its parent
 *  at `schedule_status='running'`). Silent by design. */
export function sweepOrphanedOccurrences(nowMs = Date.now()): number {
  const orphans = getDb().prepare(
    `SELECT w.id, w.parent_id, w.sequence FROM work w
       LEFT JOIN work p ON p.id = w.parent_id
      WHERE w.kind = ? AND w.state IN ('open','claimed')
        AND (p.id IS NULL OR p.schedule_status != 'running')
        AND w.opened_at < ?`,
  ).all(OCCURRENCE_KIND, nowMs - ORPHAN_RUN_GRACE_MS) as
    Array<{ id: string; parent_id: string; sequence: number }>;

  let swept = 0;
  for (const o of orphans) {
    const settled = settleOccurrence(
      o.id, 'skipped', null,
      'Auto-skipped: orphaned run (parent task not running this occurrence)',
    );
    if (runSettleApplied(settled)) {
      swept += 1;
      logger.warn('swept orphaned occurrence', {
        workId: o.parent_id, occurrenceId: o.id, sequence: o.sequence,
      });
    }
  }
  return swept;
}

/** Open occurrences whose assigned agent is terminated or gone. Reported, not closed: the caller
 *  runs them through the full run-complete flow, since closing without advancing stalls the cadence. */
export function sweepTerminatedAgentOccurrences(): Array<{
  occurrenceId: string; taskId: string; assignedTo: string | null;
}> {
  const rows = getDb().prepare(
    `SELECT w.id AS occurrence_id, w.parent_id AS task_id, w.agent_id AS assigned_to
       FROM work w LEFT JOIN agents a ON a.id = w.agent_id
      WHERE w.kind = ? AND w.state IN ('open','claimed')
        AND (a.id IS NULL OR a.status = 'terminated')`,
  ).all(OCCURRENCE_KIND) as Array<{
    occurrence_id: string; task_id: string; assigned_to: string | null;
  }>;
  return rows.map(r => ({
    occurrenceId: r.occurrence_id, taskId: r.task_id, assignedTo: r.assigned_to,
  }));
}

/** Delete the occurrence rows of these schedules and their events (`parent_id` has no cascade). */
export function deleteOccurrencesOf(workIds: string[]): number {
  if (workIds.length === 0) return 0;
  const db = getDb();
  const ph = workIds.map(() => '?').join(',');
  let removed = 0;
  withUnit(() => {
    const doomed = (db.prepare(`SELECT id FROM work WHERE kind = ? AND parent_id IN (${ph})`)
      .all(OCCURRENCE_KIND, ...workIds) as Array<{ id: string }>).map(r => r.id);
    clearReferencesToWork(doomed);
    removed = db.prepare(
      `DELETE FROM work WHERE kind = ? AND parent_id IN (${ph})`,
    ).run(OCCURRENCE_KIND, ...workIds).changes;
  });
  return removed;
}

/** The occurrence this schedule has in flight, if any: a crashed fire leaves exactly this row behind. */
export function inFlightOccurrence(workId: string, opts: { anyState?: true } = {}): { id: string; sequence: number } | null {
  const r = getDb().prepare(
    `SELECT id, sequence FROM work
      WHERE kind = ? AND parent_id = ? AND (? OR state = 'open')
      ORDER BY sequence DESC LIMIT 1`,
  ).get(OCCURRENCE_KIND, workId, opts.anyState ? 1 : 0) as { id: string; sequence: number } | undefined;
  return r ?? null;
}
