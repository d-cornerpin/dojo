// The tracker's audit trail — THE ONE HISTORY THE OWNER READS.
//
// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-2 T10G (RULING 10) — `task_log` IS ABSORBED. verdict: REKEY.
//
// requirement preserved: every touch on a tracker row, readable in one place, newest first —
// who did it, what kind of touch, what moved, why, what they did and what they wrote. Three
// surfaces render it through `formatEntryLine` and none of them changed: the Activity panel
// (`dashboard/src/pages/Tracker.tsx:293`), the PM's ledger line (`tracker/pm-agent.ts`) and
// the agent context block (`memory/assembler.ts`).
//
// This module used to own a TABLE. It is now the SEAM: the vocabulary, the write, and the
// rendering. The SQL lives in `work/audit-trail.ts`, beside the spine tables it reads. The
// seam is why the absorption is a rewrite of two files instead of a cutover of 57 call sites —
// every writer in the tree goes through `writeTaskLog` and every reader through the four
// readers below, so the storage moved and the callers did not have to.
//
// THE FULL EVIDENCE IS IN `db/migrations/146_task_log_absorbed.sql` — it is a
// DE-DUPLICATION, not a copy, and the header there carries every measurement: 40 of the 51
// row-moving `transition` entries had a spine twin within 3 s (stable from 1 s to 60 s), the
// 59 non-moving ones were PM validations ALREADY in `adjudications` on an identical work set,
// and only 11 moving entries plus the 55 prose entries held anything the spine did not.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import {
  appendAuditEntry, readAuditTrail, workExists, type TrailRow,
} from '../work/audit-trail.js';

const logger = createLogger('task-log');

export type TaskLogEntryKind =
  | 'transition'
  | 'observation'
  | 'reject'
  | 'override'
  | 'evidence'
  | 'directive'
  | 'poke'
  | 'auto_sweep'
  | 'smell_flag'
  | 'closeout_miss'
  | 'user_verdict_request'
  | 'user_verdict_applied'
  | 'legacy_note'
  // T10G: the two the spine names honestly. A PM blessing used to arrive here wearing a
  // `transition` label with `from_status = to_status`; it is a VERDICT and now says so.
  | 'claim_upheld'
  | 'claim_rejected';

export interface TaskLogEntryInput {
  taskId: string;
  /** 'agent:<id>' | 'pm' | 'engine' | 'user' | 'scheduler' | 'legacy' */
  fromEntity: string;
  entryKind: TaskLogEntryKind;
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Short structured "why". */
  reason?: string | null;
  /** Short structured "what happened". */
  actionTaken?: string | null;
  /** Freeform prose. Used by observation, legacy_note, directive bodies. */
  note?: string | null;
  /** JSON when this entry attaches evidence records. */
  evidenceJson?: string | null;
}

export interface TaskLogEntry {
  id: string;
  taskId: string;
  fromEntity: string;
  entryKind: TaskLogEntryKind;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  actionTaken: string | null;
  note: string | null;
  evidenceJson: string | null;
  createdAt: string;
}

function mapRow(row: TrailRow): TaskLogEntry {
  return {
    id: String(row.id),
    taskId: row.task_id,
    fromEntity: row.from_entity,
    entryKind: row.entry_kind as TaskLogEntryKind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actionTaken: row.action_taken,
    note: row.note,
    evidenceJson: row.evidence_json,
    createdAt: row.created_at,
  };
}

/**
 * Write one entry to the audit trail.
 *
 * Best-effort by design: failures are logged and never thrown, because the trail records a
 * state change and must not be able to abort one.
 *
 * RULING 10 — A `transition` WRITES NOTHING AND RETURNS null. The spine records every state
 * change inside the state-change transaction with strictly more fidelity (`from`/`to`/`by`/
 * `reason`/`evidence_ref`/`result_delivery_id`/`claim`/`note`), where this trail's copy was
 * best-effort and outside it. A second record of one fact is the thing this phase deletes.
 *
 * The guard is HERE, in the seam, so the de-duplication is enforced in one place rather than
 * trusted to 17 call sites. ⚠ Those 17 sites are now INERT and are NOT claimed as deliberate
 * design: they are named, measured residue owed a cleanup pass (T10G report §task_log). Two of
 * them carry an `actionTaken` gloss the spine event has no column for, so the cleanup is a
 * judgement per site — fold the prose into the transition's own `reason`, or drop it — and not
 * a blind delete. It is behaviour-neutral either way, which is why it is owed rather than
 * rushed at the end of a session.
 */
export function writeTaskLog(input: TaskLogEntryInput): string | null {
  if (input.entryKind === 'transition') return null;
  try {
    if (!workExists(input.taskId)) {
      logger.warn('writeTaskLog skipped: no such work row', {
        taskId: input.taskId, entryKind: input.entryKind,
      });
      return null;
    }
    const id = appendAuditEntry(input.taskId, input.fromEntity, input);
    broadcast({
      type: 'tracker:task_log',
      data: { taskId: input.taskId, entryKind: input.entryKind, fromEntity: input.fromEntity },
    });
    return String(id);
  } catch (err) {
    logger.warn('writeTaskLog failed (non-fatal)', {
      taskId: input.taskId,
      entryKind: input.entryKind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * List recent trail entries for a task, newest first.
 * `kinds` lets the PM situation report grab just the entries it needs without pulling the
 * whole history. The projection itself is `work/audit-trail.ts:readAuditTrail`.
 */
export function listTaskLog(
  taskId: string,
  opts?: { limit?: number; kinds?: TaskLogEntryKind[] },
): TaskLogEntry[] {
  return readAuditTrail(taskId, opts).map(mapRow);
}

/**
 * Get the most recent observation/note entries for a task. Used by the
 * agent context renderer to show recent activity inline on the task block.
 */
export function getRecentObservations(taskId: string, limit = 5): TaskLogEntry[] {
  return listTaskLog(taskId, {
    limit,
    kinds: ['observation', 'directive', 'reject', 'legacy_note'],
  });
}

/**
 * Get the most recent status-changing entries (transitions, overrides, user verdict
 * applications). Useful for "what's the recent history of this row" panels and PM context.
 *
 * T10G: the two verdict kinds join the set, because the PM's blessings used to arrive in it
 * wearing a `transition` label. Dropping them would quietly shorten the PM's own ledger.
 */
export function getRecentTransitions(taskId: string, limit = 10): TaskLogEntry[] {
  return listTaskLog(taskId, {
    limit,
    kinds: ['transition', 'override', 'user_verdict_applied', 'auto_sweep',
      'claim_upheld', 'claim_rejected'],
  });
}

/**
 * Convenience helper: format a trail entry as one human-readable line.
 * Used by PM situation report builder, dashboard renderer, agent context
 * renderer. Keeps formatting consistent across readers.
 */
export function formatEntryLine(e: TaskLogEntry): string {
  const ts = e.createdAt;
  const who = e.fromEntity;
  const kind = e.entryKind;
  const parts: string[] = [`[${ts}] [${who}] [${kind}]`];

  if (e.fromStatus || e.toStatus) {
    parts.push(`${e.fromStatus ?? '?'} → ${e.toStatus ?? '?'}`);
  }
  if (e.actionTaken) parts.push(e.actionTaken);
  if (e.reason) parts.push(`reason: ${e.reason}`);
  if (e.note) parts.push(e.note);

  return parts.join(' ');
}
