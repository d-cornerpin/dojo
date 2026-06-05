// Structured task audit log.
//
// Replaces freeform tasks.notes appends as the canonical record of every
// touch on a task. PM situation reports, dashboard task detail, and the
// agent context renderer all read from here instead of grepping prose.
//
// Phase B.0. Migration 050 creates the table and backfills existing notes.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';

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
  | 'legacy_note';

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

interface TaskLogRow {
  id: string;
  task_id: string;
  from_entity: string;
  entry_kind: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  action_taken: string | null;
  note: string | null;
  evidence_json: string | null;
  created_at: string;
}

function mapRow(row: TaskLogRow): TaskLogEntry {
  return {
    id: row.id,
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
 * Write one entry to the task log.
 * Best-effort: failures are logged but never thrown, since the log is an
 * audit trail and the calling status transition should not abort if the
 * log write fails.
 */
export function writeTaskLog(input: TaskLogEntryInput): string | null {
  try {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO task_log
        (id, task_id, from_entity, entry_kind, from_status, to_status,
         reason, action_taken, note, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      input.taskId,
      input.fromEntity,
      input.entryKind,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.reason ?? null,
      input.actionTaken ?? null,
      input.note ?? null,
      input.evidenceJson ?? null,
    );

    broadcast({
      type: 'tracker:task_log',
      data: { taskId: input.taskId, entryKind: input.entryKind, fromEntity: input.fromEntity },
    } as never);

    return id;
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
 * List recent log entries for a task, newest first.
 * `kinds` filter lets the PM situation report grab just the entries it
 * needs (e.g. recent smell_flag + observation + reject) without pulling
 * the whole audit trail.
 */
export function listTaskLog(
  taskId: string,
  opts?: { limit?: number; kinds?: TaskLogEntryKind[] },
): TaskLogEntry[] {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const kinds = opts?.kinds ?? null;

  let sql = `SELECT * FROM task_log WHERE task_id = ?`;
  const params: unknown[] = [taskId];

  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => '?').join(',');
    sql += ` AND entry_kind IN (${placeholders})`;
    params.push(...kinds);
  }

  sql += ` ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as TaskLogRow[];
  return rows.map(mapRow);
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
 * Get the most recent status-changing entries (transitions, overrides,
 * user verdict applications). Useful for "what's the recent history of
 * this row" panels and PM context.
 */
export function getRecentTransitions(taskId: string, limit = 10): TaskLogEntry[] {
  return listTaskLog(taskId, {
    limit,
    kinds: ['transition', 'override', 'user_verdict_applied', 'auto_sweep'],
  });
}

/**
 * Convenience helper: format a task_log entry as one human-readable line.
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
