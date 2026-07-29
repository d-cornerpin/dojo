// ── THE OVERRIDE QUEUE, ON THE SPINE (PHASE-2 T8T RESUMED-2, orchestrator RULING 4) ──
//
// WHAT THIS REPLACES. `task_override_requests` (migration `052`) was the last side table with
// live production readers: 19 statements across `gateway/routes/tracker.ts`,
// `tracker/tools.ts`, `tracker/pm-agent.ts` and `scheduler/runner.ts`. Migration `135`'s own
// DDL comment says `work_events` "absorbs task_log, poke_log, override requests", and RULING 4
// separates the two questions that were being conflated: RULING 3 deferred the TABLE's death
// to T10 (the FK re-point was the interim), and it never licensed two live override mechanisms
// coexisting for two more tasks — which is the two-mechanism disease by name.
//
// requirement preserved, in one line each:
//   * an agent the hard gate refused can ASK an authority to force the move
//        -> `fileOverrideRequest`, a `work_events` row of kind 'override_request';
//   * at most ONE pending ask per (task, agent), so a thrashing model cannot flood the queue
//        -> `pendingOverrideForAgent`, the same predicate the old `WHERE task_id = ? AND
//           requested_by = ? AND status = 'pending'` expressed;
//   * the PM and the dashboard SEE the queue oldest-first with the task's title and goal
//        -> `listOverrideRequests`, which carries the join the old query did;
//   * an ask is resolvable exactly ONCE, by an authority, with a reason
//        -> `resolveOverrideRequest` returns false on an already-resolved id, which is the
//           old `if (req.status !== 'pending') return 'cannot resolve again'`;
//   * an ask nobody answers in 12 hours auto-denies and the agent is told
//        -> `staleOverrideRequests`, the same bound, read by `scheduler/runner.ts`.
//
// ── WHY "STATUS" IS A QUERY AND NOT A COLUMN ──
// The old row carried `status` + `resolved_by` + `resolved_reason` + `resolved_at`, four
// columns kept in step by hand at five call sites. Here the ask is one event and the answer is
// another, and "pending" is the ask having no answer AFTER it. That is the same shape T8c gave
// the poke ladder and T8T gave the close request, for the same reason: a fact maintained in
// two places drifts, and a fact derived from the record cannot.
//
// Ordering is by `work_events.id`, never by `created_at`. This phase has hit the
// same-millisecond defect three times (the poke ladder's window, the scheduler's occurrence
// CAS, the adjudication instant in `store.ts`); a sequence exists here, so a clock is the
// wrong instrument.
//
// ── THE VERDICT HALF, AND THE ONE PLACE OLD SEMANTICS COULD HAVE DRIFTED ──
// RULING 4 places the verdict in `adjudications`. On the APPROVE path it is already there and
// always was: approving forces the move with `claim: 'authoritative'`, and `transition()`
// files the upheld adjudication in the same transaction. Nothing here duplicates it.
//
// A DENIAL deliberately writes NO adjudication, and that is a decision rather than an
// omission. `adjudications.claim_state` is about a state the work CLAIMS to be in; an override
// request is a request to MOVE, not a claim to have moved. Writing a `rejected` row would make
// `revertCountExpr` count it — and `revert_count` drives the stalemate threshold
// (high=2 / normal=3 / low=5), so a denial would start firing the owner-verdict escalation
// earlier than it does today. That is a live behaviour change, and smuggling one in as a
// storage change is exactly what this rekey is supposed not to do. Asserted both ways in
// `__tests__/override-requests.test.ts` §5, with a real thrown-back claim as the positive
// control.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import { msToText } from './tracker-view.js';

/** The two event kinds this file owns. Declared once so a writer and a reader cannot disagree
 *  by typo — the failure mode research 03 catalogued. */
export const OVERRIDE_EVENT = {
  requested: 'override_request',
  resolved: 'override_resolved',
} as const;

export type OverrideOutcome = 'approved' | 'denied' | 'auto_denied';
export type OverrideStatus = 'pending' | OverrideOutcome;

export interface OverrideRequestRow {
  /** The uuid the agent, the PM and the dashboard pass around. Carried in the payload rather
   *  than being the event's own integer id, because the whole surface matches it by 8-char
   *  PREFIX (`work_validate(action="override", override_request_id="1a2b3c4d")`) and a prefix
   *  of an autoincrement integer means nothing. */
  id: string;
  /** `work_events.id` — the ordering key, and what "after" means below. */
  eventId: number;
  taskId: string;
  requestedBy: string;
  requestedStatus: string;
  justification: string;
  lastEngineError: string | null;
  attemptsAttached: number;
  /** SQLite-form TEXT, byte-identical to what the old `created_at TEXT` column returned. */
  createdAt: string;
  status: OverrideStatus;
  resolvedBy: string | null;
  resolvedReason: string | null;
  resolvedAt: string | null;
  taskTitle: string | null;
  taskGoal: string | null;
}

/** One request, joined to its answer (if any) and to its work row. The single shape every
 *  reader below projects, so "does the dashboard see what the PM sees?" is not a question. */
const SELECT_REQUESTS = `
  SELECT
    e.id                                              AS eventId,
    json_extract(e.payload, '$.request_id')           AS id,
    e.work_id                                         AS taskId,
    e.actor                                           AS requestedBy,
    json_extract(e.payload, '$.requested_status')     AS requestedStatus,
    json_extract(e.payload, '$.justification')        AS justification,
    json_extract(e.payload, '$.last_engine_error')    AS lastEngineError,
    COALESCE(json_extract(e.payload, '$.attempts_attached'), 1) AS attemptsAttached,
    ${msToText('e.created_at')}                       AS createdAt,
    COALESCE(json_extract(r.payload, '$.outcome'), 'pending') AS status,
    json_extract(r.payload, '$.resolved_by')          AS resolvedBy,
    json_extract(r.payload, '$.reason')               AS resolvedReason,
    ${msToText('r.created_at')}                       AS resolvedAt,
    w.title                                           AS taskTitle,
    w.goal                                            AS taskGoal
  FROM work_events e
  LEFT JOIN work_events r
    ON r.kind = '${OVERRIDE_EVENT.resolved}'
   AND json_extract(r.payload, '$.request_id') = json_extract(e.payload, '$.request_id')
  LEFT JOIN work w ON w.id = e.work_id
  WHERE e.kind = '${OVERRIDE_EVENT.requested}'
`;

/**
 * `status = 'pending'`, as a SQL fragment, for the three inline PM counts that cannot
 * round-trip through TypeScript. It is the same EXISTS/NOT EXISTS pair the projection above
 * expresses as a LEFT JOIN — one question, and the test asserts the two agree.
 */
export const PENDING_OVERRIDE_COUNT_SQL = `(
  SELECT COUNT(*) FROM work_events e
   WHERE e.kind = '${OVERRIDE_EVENT.requested}'
     AND NOT EXISTS (
       SELECT 1 FROM work_events r
        WHERE r.kind = '${OVERRIDE_EVENT.resolved}'
          AND json_extract(r.payload, '$.request_id') = json_extract(e.payload, '$.request_id')
     )
)`;

type Raw = Omit<OverrideRequestRow, 'attemptsAttached'> & { attemptsAttached: number };
const rows = (sql: string, params: unknown[] = []): OverrideRequestRow[] =>
  getDb().prepare(sql).all(...params) as Raw[];

/**
 * File an override request. Returns the id the caller quotes back to the model.
 *
 * The caller checks `pendingOverrideForAgent` first — the rate limit is a REFUSAL with a
 * steerable sentence, not a silent drop, so it stays at the call site where the sentence is.
 */
export function fileOverrideRequest(taskId: string, p: {
  requestedBy: string;
  requestedStatus: string;
  justification: string;
  lastEngineError?: string | null;
  attemptsAttached?: number;
}): string {
  const requestId = randomUUID();
  appendWorkEvent(taskId, OVERRIDE_EVENT.requested, p.requestedBy, {
    request_id: requestId,
    requested_status: p.requestedStatus,
    justification: p.justification,
    last_engine_error: p.lastEngineError ?? null,
    attempts_attached: p.attemptsAttached ?? 1,
  });
  return requestId;
}

/** The rate limit's subject: this agent's own outstanding ask on this task. */
export function pendingOverrideForAgent(taskId: string, agentId: string): OverrideRequestRow | null {
  return rows(
    `${SELECT_REQUESTS} AND e.work_id = ? AND e.actor = ? AND r.id IS NULL ORDER BY e.id DESC LIMIT 1`,
    [taskId, agentId],
  )[0] ?? null;
}

/** ANY outstanding ask on this task, whoever filed it — what `work_validate(kind=complete)`
 *  refuses on, so a close cannot be blessed around a structured ask. */
export function pendingOverrideForTask(taskId: string): OverrideRequestRow | null {
  return rows(
    `${SELECT_REQUESTS} AND e.work_id = ? AND r.id IS NULL ORDER BY e.id DESC LIMIT 1`,
    [taskId],
  )[0] ?? null;
}

/** By full id or by the 8-char prefix the PM and the dashboard are shown. */
export function findOverrideRequest(idOrPrefix: string): OverrideRequestRow | null {
  const needle = (idOrPrefix ?? '').trim();
  if (!needle) return null;
  return rows(
    `${SELECT_REQUESTS} AND (json_extract(e.payload, '$.request_id') = ?
          OR json_extract(e.payload, '$.request_id') LIKE ?) ORDER BY e.id DESC LIMIT 1`,
    [needle, `${needle}%`],
  )[0] ?? null;
}

/**
 * Answer an ask, once. `false` means "there was nothing to answer, or it was already
 * answered" — the old `if (req.status !== 'pending')` refusal, returned rather than thrown so
 * the caller keeps its own sentence.
 */
export function resolveOverrideRequest(requestId: string, p: {
  outcome: OverrideOutcome;
  resolvedBy: string;
  reason: string;
}): boolean {
  const req = findOverrideRequest(requestId);
  if (!req || req.status !== 'pending') return false;
  appendWorkEvent(req.taskId, OVERRIDE_EVENT.resolved, p.resolvedBy, {
    request_id: req.id,
    outcome: p.outcome,
    resolved_by: p.resolvedBy,
    reason: p.reason,
  });
  return true;
}

/** The dashboard's list and the PM's rung. `status` filters; omit it for everything. */
export function listOverrideRequests(o: { status?: OverrideStatus; limit?: number }): OverrideRequestRow[] {
  const limit = o.limit ?? 100;
  if (o.status === 'pending') {
    return rows(`${SELECT_REQUESTS} AND r.id IS NULL ORDER BY e.id ASC LIMIT ?`, [limit]);
  }
  if (o.status) {
    return rows(
      `${SELECT_REQUESTS} AND json_extract(r.payload, '$.outcome') = ? ORDER BY e.id DESC LIMIT ?`,
      [o.status, limit],
    );
  }
  return rows(`${SELECT_REQUESTS} ORDER BY e.id DESC LIMIT ?`, [limit]);
}

/** The dashboard's 7-day rollup, grouped by outcome exactly as the old `GROUP BY status`. */
export function overrideRollup(days: number): Array<{ status: string; count: number }> {
  const floor = Date.now() - days * 24 * 3600_000;
  return getDb().prepare(`
    SELECT COALESCE(json_extract(r.payload, '$.outcome'), 'pending') AS status, COUNT(*) AS count
      FROM work_events e
      LEFT JOIN work_events r
        ON r.kind = '${OVERRIDE_EVENT.resolved}'
       AND json_extract(r.payload, '$.request_id') = json_extract(e.payload, '$.request_id')
     WHERE e.kind = '${OVERRIDE_EVENT.requested}' AND e.created_at > ?
     GROUP BY status
  `).all(floor) as Array<{ status: string; count: number }>;
}

/** Unanswered for longer than `hours`. The 12 is the CALLER's constant (5a, carried verbatim
 *  in `scheduler/runner.ts`); nothing here invents a threshold. */
export function staleOverrideRequests(hours: number, limit: number): OverrideRequestRow[] {
  return rows(
    `${SELECT_REQUESTS} AND r.id IS NULL AND e.created_at < ? ORDER BY e.id ASC LIMIT ?`,
    [Date.now() - hours * 3600_000, limit],
  );
}
