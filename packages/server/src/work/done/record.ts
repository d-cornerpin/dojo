// THE HAND-IN RECORD: what a `handed_in` event carries and how work/done reads it; none of these is a door.
import { getDb } from '../../db/connection.js';
import { withUnit } from '../../db/unit.js';
import { PATIENCE_ENTRY } from '../../tracker/assignee-patience.js';
import type { WorkOutcome, WorkState } from '../store.js';
import type { HandInOutcome, ResolvedItem } from './proof-kinds.js';

export const OWNER_ID = 'user';

/** `run`: one run of a live schedule, which goes on; `schedule`: the scheduled work as a whole. */
export type HandInScope = 'run' | 'schedule';

export interface HandInRecord { outcome: HandInOutcome; items: ResolvedItem[]; note: string; filedBy: string; scope?: HandInScope }

/** The worker of a task: its assignee, else the agent holding it. Empty when there is no such row. */
export function workerOf(workId: string): string {
  const r = getDb().prepare('SELECT COALESCE(assignee_agent, agent_id) AS w FROM work WHERE id = ?').get(workId) as { w: string } | undefined;
  return r?.w ?? '';
}

/** The newest hand-in of a row (or the one with this event id), its event id and time, or null. */
export function latestHandIn(workId: string, eventId?: number): (HandInRecord & { eventId: number; at: number }) | null {
  const e = getDb().prepare(
    `SELECT id, payload, created_at AS at FROM work_events
      WHERE work_id = ? AND kind = 'handed_in' AND (? IS NULL OR id = ?) ORDER BY id DESC LIMIT 1`,
  ).get(workId, eventId ?? null, eventId ?? null) as { id: number; payload: string; at: number } | undefined;
  return e ? { ...(JSON.parse(e.payload) as HandInRecord), eventId: e.id, at: e.at } : null;
}

/** SQL, one `?` (epoch ms): the row under alias `a` was handed in, by its worker or for it, since then. */
export const handedInSinceExpr = (a: string): string =>
  `EXISTS (SELECT 1 FROM work_events h WHERE h.work_id = ${a}.id AND h.kind = 'handed_in' AND h.created_at >= ?)`;

export const handInNoteExpr = (a: string): string =>
  `(SELECT json_extract(h.payload, '$.note') FROM work_events h WHERE h.work_id = ${a}.id AND h.kind = 'handed_in' ORDER BY h.id DESC LIMIT 1)`;

export const handInDeliveriesExpr = (a: string): string =>
  `(SELECT json_extract(i.value, '$.ref') FROM work_events h, json_each(h.payload, '$.items') i
     WHERE h.work_id = ${a}.id AND h.kind = 'handed_in' AND json_extract(i.value, '$.kind') = 'delivery')`;

class Rollback extends Error { constructor(readonly outcome: WorkOutcome) { super('rollback'); } }

/** Run `fn` as one unit, rolled back whole when the transition inside it is not applied. */
export function unitOrRollback(fn: () => WorkOutcome): WorkOutcome {
  try {
    return withUnit(() => { const out = fn(); if (out.kind !== 'applied') throw new Rollback(out); return out; });
  } catch (err) {
    if (err instanceof Rollback) return err.outcome;
    throw err;
  }
}

/** Every agent that worked this row: its worker now, every agent that handed it in, and every holder it
 *  was moved away from. None of them decides it. */
export function workersOf(workId: string): Set<string> {
  const rows = getDb().prepare(
    `SELECT actor AS a FROM work_events WHERE work_id = ? AND kind = 'handed_in' AND actor <> 'engine'
     UNION SELECT json_extract(payload, '$.from_agent') FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?
        AND NOT (actor = json_extract(payload, '$.from_agent') AND json_extract(payload, '$.reason') LIKE 'cause=coordination%')`,
  ).all(workId, workId, PATIENCE_ENTRY.reassigned) as Array<{ a: string | null }>;
  const out = new Set(rows.map((r) => r.a).filter((a): a is string => !!a));
  const now = workerOf(workId);
  if (now) out.add(now);
  return out;
}

/** One adjudication row: the record a done move needs (migration 901's trigger reads it). */
export function recordAdjudication(workId: string, claimState: WorkState, by: string, evidenceRef: string | null, note: string, verdict: 'upheld' | 'rejected' = 'upheld'): void {
  getDb().prepare(
    `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(workId, claimState, verdict, by, evidenceRef, note, Date.now());
}
