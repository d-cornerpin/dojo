// The audit trail: a projection over the work spine, read here only; `tracker/task-log.ts` calls it for the SQL.
// The trail is one event kind, `audit`, with the entry kind inside the payload: entry kinds collide by
// name with spine kinds (`transition`, `poke`, `user_verdict_request`), so an audit line must never
// answer a predicate over spine events.

import { getDb } from '../db/connection.js';
import type { WorkEventKind } from './event-kinds.js';
import { appendWorkEvent } from './store.js';
import { STATE_TO_STATUS_SQL, msToText } from './tracker-view.js';

export const AUDIT_KIND = 'audit' as const satisfies WorkEventKind;

/** The spine's own verdict events; the trail renders these, never a second copy of a verdict. */
const VERDICT_KINDS = ['claim_upheld', 'claim_rejected'] as const;

export interface TrailRow {
  id: number;
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

export interface AuditEntryFields {
  entryKind: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  actionTaken?: string | null;
  note?: string | null;
  evidenceJson?: string | null;
}

/** Does this work row exist? Lets a caller skip an entry for a vanished row and log why. */
export function workExists(workId: string): boolean {
  return getDb().prepare('SELECT 1 FROM work WHERE id = ?').get(workId) !== undefined;
}

export function appendAuditEntry(workId: string, actor: string, f: AuditEntryFields): number {
  return appendWorkEvent(workId, AUDIT_KIND, actor, {
    entry_kind: f.entryKind,
    from_status: f.fromStatus ?? null,
    to_status: f.toStatus ?? null,
    reason: f.reason ?? null,
    action_taken: f.actionTaken ?? null,
    note: f.note ?? null,
    evidence_json: f.evidenceJson ?? null,
  });
}

/** An old bookkeeping marker some rows still carry: never shown in the trail. */
export const LADDER_HELD_ENTRY = 'ladder_held';

/**
 * The trail as one ordered projection over spine sources: the trail's own `audit` events, the
 * `transition` events, the verdict events, a pending close request, and hand-in/decision/proof events.
 * The spine stores `work.state`; the panel renders tracker status, so `STATE_TO_STATUS_SQL` translates.
 * `created_at` goes back through `msToText` so a line keeps the `YYYY-MM-DD HH:MM:SS` shape.
 */
export function readAuditTrail(
  workId: string,
  opts?: { limit?: number; kinds?: readonly string[] },
): TrailRow[] {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const kinds = opts?.kinds ?? null;
  const jx = (f: string): string => `json_extract(e.payload, '$.${f}')`;

  // What the PM looked at rides under its verdict: a PM-moved close keeps it as JSON in the transition's
  // evidence_ref, a throw-back in the claim event. An uphold's own note already says it.
  const underNote = (note: string, summary: string): string =>
    `CASE WHEN ${summary} IS NOT NULL THEN coalesce(${note} || char(10), '') || 'Looked at: ' || ${summary} ELSE ${note} END`;
  const movedSummary = `CASE WHEN json_valid(${jx('evidence_ref')}) THEN json_extract(${jx('evidence_ref')}, '$.summary') END`;
  const rejectSummary = `CASE WHEN e.kind = 'claim_rejected' THEN ${jx('looked_at.summary')} END`;

  const branches = [
    `SELECT e.id AS id, e.work_id AS task_id, e.actor AS from_entity,
            ${jx('entry_kind')} AS entry_kind,
            ${jx('from_status')} AS from_status, ${jx('to_status')} AS to_status,
            ${jx('reason')} AS reason, ${jx('action_taken')} AS action_taken,
            ${jx('note')} AS note, ${jx('evidence_json')} AS evidence_json,
            e.created_at AS created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind = '${AUDIT_KIND}' AND ${jx('entry_kind')} IS NOT '${LADDER_HELD_ENTRY}'`,
    `SELECT e.id, e.work_id, e.actor, 'transition',
            ${STATE_TO_STATUS_SQL(jx('from'))}, ${STATE_TO_STATUS_SQL(jx('to'))},
            ${jx('reason')}, NULL, ${underNote(jx('note'), movedSummary)}, ${jx('evidence_ref')}, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind = 'transition'`,
    `SELECT e.id, e.work_id, e.actor, e.kind,
            ${STATE_TO_STATUS_SQL(jx('claim_state'))}, ${STATE_TO_STATUS_SQL(jx('claim_state'))},
            NULL, NULL, ${underNote(jx('note'), rejectSummary)}, NULL, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind IN (${VERDICT_KINDS.map((k) => `'${k}'`).join(', ')})`,
    // A worker's close files `validation_requested` and the row does not move; this renders that event so
    // the card shows the pending close. It adds no event kind and writes nothing.
    `SELECT e.id, e.work_id, e.actor, 'validation_requested',
            ${STATE_TO_STATUS_SQL(jx('from'))}, ${STATE_TO_STATUS_SQL(jx('requested_state'))},
            ${jx('reason')}, NULL, 'close requested — awaiting validation', NULL, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind = 'validation_requested'`,
    `SELECT e.id, e.work_id, e.actor, e.kind, NULL, NULL, CASE e.kind WHEN 'handed_in' THEN ${jx('note')} ELSE ${jx('reason')} END,
            CASE e.kind WHEN 'proof_opened' THEN 'opened proof item ' || ${jx('index')} WHEN 'handed_in' THEN ${jx('outcome')} ELSE ${jx('verdict')} END,
            CASE WHEN ${jx('relayedBy')} IS NOT NULL THEN 'relayed by ' || ${jx('relayedBy')} || ', quoting the owner: "' || ${jx('quote')} || '"' END, NULL, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind IN ('handed_in', 'decided', 'proof_opened')`,
  ];

  const params: unknown[] = [workId, workId, workId, workId, workId];
  let sql =
    `SELECT id, task_id, from_entity, entry_kind, from_status, to_status, reason,
            action_taken, note, evidence_json,
            ${msToText('created_at')} AS created_at
       FROM (${branches.join(' UNION ALL ')})`;

  if (kinds && kinds.length > 0) {
    sql += ` WHERE entry_kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as TrailRow[];
}
