// The tracker's audit trail: every touch on a tracker row, readable in one place, newest first. This module
// is the seam (vocabulary, write, rendering); the SQL lives in `work/audit-trail.ts`, beside the spine tables it
// reads. Every writer goes through `writeTaskLog` and every reader through the readers below, so the storage
// can move without the callers changing.

import { createLogger } from '../logger.js';
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
  | 'auto_sweep'
  | 'user_verdict_request'
  | 'user_verdict_applied'
  | 'legacy_note'
  // a later owner message, served while this task was updated (`tracker/later-instruction.ts`).
  | 'newer_instruction'
  // The two verdict kinds the PM's blessings write.
  | 'claim_upheld'
  | 'claim_rejected'
  // The Dojo held back a line a task owed its owner (`tracker/owed-delivery.ts`); never counts as delivered.
  | 'delivery_held'
  | 'handed_in' | 'decided' | 'proof_opened';

export interface TaskLogEntryInput {
  taskId: string;
  /** 'agent:<id>' | 'pm' | 'engine' | 'user' | 'scheduler' | 'legacy' */
  fromEntity: string;
  entryKind: TaskLogEntryKind;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  actionTaken?: string | null;
  note?: string | null;
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
 * Write one entry to the audit trail. Best-effort: failures are logged, never thrown, because the trail must
 * not be able to abort a state change. A `transition` writes nothing and returns null: the spine records every
 * state change inside the state-change transaction, and a second record of one fact is deliberately not kept
 * (the guard lives here, in the seam, so no call site has to know).
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

/** Recent trail entries for a task, newest first; `kinds` limits it to what a reader needs. */
export function listTaskLog(
  taskId: string,
  opts?: { limit?: number; kinds?: TaskLogEntryKind[] },
): TaskLogEntry[] {
  return readAuditTrail(taskId, opts).map(mapRow);
}

/** The most recent observation/note entries, for the agent context renderer's inline task activity. */
export function getRecentObservations(taskId: string, limit = 5): TaskLogEntry[] {
  return listTaskLog(taskId, {
    limit,
    kinds: ['observation', 'directive', 'reject', 'legacy_note'],
  });
}

/** EVERY note written on a task (`work_note`, the PM's observations), oldest first: what `work_update get` reads
 *  back, since the notes FIELD never held them. No limit: the reader pages by the size of the model's view,
 *  never by how many exist. */
export function listTaskNotes(taskId: string): TaskLogEntry[] {
  return listTaskLog(taskId, { limit: Number.MAX_SAFE_INTEGER, kinds: ['observation'] }).reverse();
}

/** The most recent status-changing entries (transitions, overrides, verdicts, sweeps) for history panels and PM
 *  context. The two verdict kinds are included so the PM's own ledger is not shortened. */
export function getRecentTransitions(taskId: string, limit = 10): TaskLogEntry[] {
  return listTaskLog(taskId, {
    limit,
    kinds: ['transition', 'override', 'user_verdict_applied', 'auto_sweep',
      'claim_upheld', 'claim_rejected'],
  });
}

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
