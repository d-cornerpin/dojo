// The audit trail as a projection over the spine.  PHASE-2 T10G (RULING 10).
//
// The tracker's history used to be its own table, `task_log`. Migration `146` absorbed it and
// dropped it; this module is where the reading now happens, under `work/` beside the tables it
// reads. `tracker/task-log.ts` is the seam the 57 writers and 3 readers still call — it holds
// the vocabulary and the rendering; this holds the SQL.
//
// The trail is ONE event kind, `audit`, with the entry's own kind inside the payload. That is
// the load-bearing decision and the migration's header carries the full argument: the trail's
// entry kinds collide BY NAME with spine event kinds (`transition`, `poke`,
// `user_verdict_request`) and several of those names are read by LIVE PREDICATES
// (`lastEntryInto` inside `validatedExpr`, `awaitingUserVerdictExpr`, the poke ladder). An
// audit line must not be able to answer a predicate that decides whether work counts as
// validated. `kind='audit'` is read here and nowhere else, which is what makes that safe.

import { getDb } from '../db/connection.js';
import type { WorkEventKind } from './event-kinds.js';
import { appendWorkEvent } from './store.js';
import { STATE_TO_STATUS_SQL, msToText } from './tracker-view.js';

/** The spine event kind the trail lives on. Read by this module only — see the header.
 *  `satisfies` (T4-SCHEMA) binds it to the declared list in `event-kinds.ts` while keeping
 *  the literal type its readers rely on. */
export const AUDIT_KIND = 'audit' as const satisfies WorkEventKind;

/** The spine's own verdict events. `upholdClaim`/`rejectClaim` write one of these beside the
 *  `adjudications` row, so the trail renders the event and never a second copy of a verdict. */
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

/** Does this work row exist? The old table's FK swallowed the violation (its writer caught
 *  everything), so an entry against a vanished row was silently dropped; this makes the same
 *  outcome explicit, with a reason the caller can log. */
export function workExists(workId: string): boolean {
  return getDb().prepare('SELECT 1 FROM work WHERE id = ?').get(workId) !== undefined;
}

/** Append one trail entry. Returns the spine event's rowid. */
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

/**
 * THE TRAIL, as one ordered projection over three spine sources:
 *
 *   (a) the trail's own `audit` events — the content with no spine counterpart;
 *   (b) the spine's `transition` events — the state changes, translated into TRACKER
 *       vocabulary on the way out;
 *   (c) the spine's verdict events — the PM's blessings and throw-backs.
 *
 * THE VOCABULARY TRANSLATION IS RULING 10's ONE OWNER-VISIBLE DECISION. The spine stores
 * `work.state` (`open|claimed|done|failed|abandoned`); this history has always rendered
 * TRACKER status (`active|in_progress|complete|fallen|cancelled`). Absorbing without
 * translating would have changed the one history the owner reads. `STATE_TO_STATUS_SQL` is
 * T2's own mapping, already used by `taskRowColumns`, so this is a re-point of an existing
 * mapping and not an invention.
 *
 * `created_at` converts back through `msToText`, so a rendered line keeps the exact
 * `YYYY-MM-DD HH:MM:SS` shape the panel has always shown.
 */
export function readAuditTrail(
  workId: string,
  opts?: { limit?: number; kinds?: readonly string[] },
): TrailRow[] {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const kinds = opts?.kinds ?? null;
  const jx = (f: string): string => `json_extract(e.payload, '$.${f}')`;

  const branches = [
    `SELECT e.id AS id, e.work_id AS task_id, e.actor AS from_entity,
            ${jx('entry_kind')} AS entry_kind,
            ${jx('from_status')} AS from_status, ${jx('to_status')} AS to_status,
            ${jx('reason')} AS reason, ${jx('action_taken')} AS action_taken,
            ${jx('note')} AS note, ${jx('evidence_json')} AS evidence_json,
            e.created_at AS created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind = '${AUDIT_KIND}'`,
    `SELECT e.id, e.work_id, e.actor, 'transition',
            ${STATE_TO_STATUS_SQL(jx('from'))}, ${STATE_TO_STATUS_SQL(jx('to'))},
            ${jx('reason')}, NULL, ${jx('note')}, ${jx('evidence_ref')}, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind = 'transition'`,
    `SELECT e.id, e.work_id, e.actor, e.kind,
            ${STATE_TO_STATUS_SQL(jx('claim_state'))}, ${STATE_TO_STATUS_SQL(jx('claim_state'))},
            NULL, NULL, ${jx('note')}, NULL, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind IN (${VERDICT_KINDS.map((k) => `'${k}'`).join(', ')})`,
    // ── (d) UX-REPAIR T40 — THE PENDING CLOSE IS A FACT THE OWNER CAN SEE. ──
    // A worker's close is Key 1 and ONLY Key 1: `validation_requested` lands and the row
    // does not move (migration 139 / RULING 1). With no branch for that kind, the three
    // branches above had NOTHING to show for the entire pending window — so the owner's
    // card read "no entries yet" whether the close had been filed and ignored, or never
    // filed at all. Those are different failures and he could not tell them apart.
    //
    // This branch RENDERS an existing event. It introduces no event kind, writes nothing,
    // and touches no predicate — `pendingCloseRequestExpr` and `unvalidatedCloseExpr` are
    // untouched, which is the T21/T26 preservation property stated as a fact about the diff.
    `SELECT e.id, e.work_id, e.actor, 'validation_requested',
            ${STATE_TO_STATUS_SQL(jx('from'))}, ${STATE_TO_STATUS_SQL(jx('requested_state'))},
            ${jx('reason')}, NULL, 'close requested — awaiting validation', NULL, e.created_at
       FROM work_events e
      WHERE e.work_id = ? AND e.kind = 'validation_requested'`,
  ];

  const params: unknown[] = [workId, workId, workId, workId];
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
