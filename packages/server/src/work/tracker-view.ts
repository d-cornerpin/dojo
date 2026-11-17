// The tracker's read shape on the `work` spine; writes live in `tracker-store.ts` and `store.ts`
// (`work.state`, via `transition()`). Readers get the legacy status words, TEXT instants and legacy
// column names back (for example `project_id` for `parent_id`), projected from `work`.

import type { WorkEventKind } from './event-kinds.js';
import type { WorkState } from './store.js';
import { taskMovedAtSql } from './task-freshness.js';


/** The status words readers see; paused and blocked are holds on Working work (`work/done/hold.ts`). */
export type TrackerStatus =
  | 'on_deck' | 'in_progress' | 'handed_in' | 'sent_back' | 'complete' | 'fallen' | 'active' | 'cancelled';

const STATUS_TO_STATE: Record<TrackerStatus, WorkState> = {
  on_deck: 'open',
  in_progress: 'claimed',
  handed_in: 'handed_in',
  sent_back: 'sent_back',
  complete: 'done',
  fallen: 'failed',
  active: 'open',
  cancelled: 'abandoned',
};

const STATE_TO_STATUS: Record<WorkState, TrackerStatus> = {
  open: 'on_deck',
  claimed: 'in_progress',
  blocked: 'in_progress',
  handed_in: 'handed_in',
  sent_back: 'sent_back',
  done: 'complete',
  failed: 'fallen',
  abandoned: 'cancelled',
};

/** Unknown input reads as Open: surfacing work that may be finished is recoverable, terminating live work is not. */
export function statusToState(status: string): WorkState {
  return STATUS_TO_STATE[status as TrackerStatus] ?? 'open';
}

export function stateToStatus(state: string): TrackerStatus {
  return STATE_TO_STATUS[state as WorkState] ?? 'on_deck';
}

export const STATE_TO_STATUS_SQL = (col: string): string =>
  `CASE ${col}${Object.entries(STATE_TO_STATUS).map(([st, status]) => ` WHEN '${st}' THEN '${status}'`).join('')} ELSE ${col} END`;


/** Tracker rows are `kind IN ('task','project')` with root_kind 'legacy' (migrated), 'tracker' (opened
 *  since) or `engine_scaffold` (the engine's own floor, kept on the board so the PM can drive it).
 *  Join pieces are `kind='task'` rows with root_kind 'a2a_thread' and are not board rows. */
const ENGINE_SCAFFOLD_ROOT_KIND = 'engine_scaffold';
const TRACKER_ROOT_KINDS = "('legacy','tracker','engine_scaffold')";

export { ENGINE_SCAFFOLD_ROOT_KIND };

export const engineScaffoldScope = (a = 'w'): string =>
  `${a}.root_kind = '${ENGINE_SCAFFOLD_ROOT_KIND}'`;

export const taskScope = (a = 'w'): string =>
  `${a}.kind = 'task' AND ${a}.root_kind IN ${TRACKER_ROOT_KINDS}`;

export const projectScope = (a = 'w'): string =>
  `${a}.kind = 'project' AND ${a}.root_kind IN ${TRACKER_ROOT_KINDS}`;

/** Not a schedule waiting for its time and not set to start later: work that can be worked now. Emits one `?` (now, epoch ms). */
export const notWaitingForItsTimeSql = (a = 'w'): string =>
  `(${a}.scheduled_start IS NULL OR ${a}.scheduled_start <= ?) AND COALESCE(${a}.schedule_status, '') != 'waiting'`;

/**
 * What "overdue" means, declared once; emits exactly one `?` (the now-instant in epoch ms). No threshold
 * on purpose: a caller adds its own on top (`scheduler/runner.ts` decides a late repeating task's missed runs). Both paused
 * clauses are load-bearing: a row can carry `is_paused = 1` while `schedule_status` reads 'waiting'. A row
 * the owner holds, or handed in as a whole, does not fire; a run's hand-in never holds the next run.
 */
export const dueScope = (a = 'w'): string =>
  `${a}.next_run_at IS NOT NULL AND ${a}.next_run_at <= ?`
  + ` AND ${a}.schedule_status = 'waiting' AND ${a}.is_paused = 0 AND NOT ${heldByOwnerSql(a)}`
  + ` AND (${handedInExpr(a)} = 0 OR (SELECT json_extract(h.payload, '$.scope') FROM work_events h`
  + ` WHERE h.work_id = ${a}.id AND h.kind = 'handed_in' ORDER BY h.id DESC LIMIT 1) IS 'run')`;

export const TRACKER_ROOT_KIND = 'tracker';

/** `root_kind` of a service agent's own housekeeping: off the board (`work/done/housekeeping.ts`). */
export const SERVICE_ROOT_KIND = 'service';


/** epoch-ms INTEGER -> the text `datetime('now')` writes. Drops milliseconds: render with it, never compare. */
export const msToText = (col: string): string =>
  `CASE WHEN ${col} IS NULL THEN NULL ELSE strftime('%Y-%m-%d %H:%M:%S', ${col} / 1000, 'unixepoch') END`;

/** SQL: who set the hold on the row under alias `a`: the actor of its newest `hold_set` entry. */
export const holdSetBySql = (a: string): string => `(SELECT e.actor FROM work_events e WHERE e.work_id = ${a}.id AND e.kind = 'audit'
  AND json_extract(e.payload, '$.entry_kind') = 'hold_set' ORDER BY e.id DESC LIMIT 1)`;
/** SQL: the row under alias `a` carries a hold the owner set (the dashboard's actor, or the owner's id). */
export const heldByOwnerSql = (a: string): string => `(${a}.hold_kind IS NOT NULL AND ${holdSetBySql(a)} IN ('owner', 'user'))`;
/** SQL: the hold in words for the worker's hint, the PM's report and the owner's card: kind, who, why, until when ('' if none). */
export const holdWordsSql = (a: string): string => `CASE WHEN ${a}.hold_kind IS NULL THEN '' ELSE ${a}.hold_kind
  || CASE WHEN ${holdSetBySql(a)} = 'engine' THEN ' by the engine' WHEN ${heldByOwnerSql(a)} THEN ' by the owner' ELSE ' by its worker' END
  || ', waiting on: ' || rtrim(COALESCE(${a}.hold_reason, ''), '.') || COALESCE(', until ' || strftime('%Y-%m-%d %H:%M', ${a}.paused_until / 1000, 'unixepoch') || ' UTC', '') END`;

export const msToUtcText = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function tsToMs(text: string | null | undefined): number | null {
  if (text == null || text === '') return null;
  const ms = Date.parse(/[TZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}


export const handedInExpr = (a: string): string => `(CASE WHEN ${a}.state = 'handed_in' THEN 1 ELSE 0 END)`;

/** Which of an agent's claimed tasks a turn is working when nothing carried names it. An ORDER BY body over
 *  alias `a`: a filed, pending close goes last, then the newest write, then the earlier planned step. */
export const workingTaskOrder = (a: string): string =>
  `${handedInExpr(a)} ASC, ${a}.updated_at DESC, `
  + `CASE WHEN ${a}.step_number IS NULL THEN 1 ELSE 0 END ASC, ${a}.step_number ASC, ${a}.rowid DESC`;

export const WORK_EVENT = {
  /** The owner was asked about this row (the stall ladder's card). Payload: `{ thread_id }`. */
  validationEscalated: 'validation_escalated',
  /** Written by no code now; a box upgraded from an older build can hold these, and the revert count reads past the last one. */
  revertReset: 'revert_reset',
  activity: 'activity',
} as const satisfies Record<string, WorkEventKind>;

const lastEvent = (a: string, kind: string, col = 'created_at'): string =>
  `(SELECT MAX(e.${col}) FROM work_events e WHERE e.work_id = ${a}.id AND e.kind = '${kind}')`;

export const revertCountExpr = (a: string): string =>
  `(SELECT count(*) FROM adjudications adj WHERE adj.work_id = ${a}.id AND adj.verdict = 'rejected'`
  // Since the last reset by log position (`event_seq` is the work_events id of the verdict's companion row),
  // never by clock: a rejection filed in the same millisecond before the reset must not survive it.
  + `   AND adj.event_seq > COALESCE(${lastEvent(a, WORK_EVENT.revertReset, 'id')}, 0))`;


/** The `TaskRow` projection, a COMPLETE `SELECT ... FROM work` rather than a column list: the orphan gate
 *  only inspects string literals that look like SQL, so a bare fragment would hide its columns from it. */
export const taskRowColumns = (): string => `SELECT
  work.id AS id,
  work.parent_id AS project_id,
  work.title AS title,
  work.description AS description,
  ${STATE_TO_STATUS_SQL('work.state')} AS status,
  work.agent_id AS assigned_to,
  work.requester_id AS created_by,
  work.priority AS priority,
  work.step_number AS step_number,
  work.total_steps AS total_steps,
  work.phase AS phase,
  COALESCE(work.depends_on, '[]') AS depends_on,
  work.notes AS notes,
  ${msToText('work.scheduled_start')} AS scheduled_start,
  work.repeat_interval AS repeat_interval,
  work.repeat_unit AS repeat_unit,
  work.repeat_end_type AS repeat_end_type,
  work.repeat_end_value AS repeat_end_value,
  work.repeat_days_of_week AS repeat_days_of_week,
  work.anchor_local AS anchor_time,
  ${msToText('work.next_run_at')} AS next_run_at,
  work.attempts AS run_count,
  work.is_paused AS is_paused,
  ${msToText('work.paused_until')} AS paused_until,
  work.hold_kind AS hold_kind,
  work.hold_reason AS hold_reason,
  ${msToText('work.last_run_at')} AS last_run_at,
  COALESCE(work.schedule_status, 'unscheduled') AS schedule_status,
  work.assigned_to_group AS assigned_to_group,
  work.task_kind AS kind,
  ${msToText('work.opened_at')} AS created_at,
  ${msToText('work.updated_at')} AS updated_at,
  ${msToText(taskMovedAtSql('work'))} AS last_moved_at,
  COALESCE(work.assignee_agent, work.agent_id) AS worker_id,
  ${msToText('work.closed_at')} AS completed_at,
  work.goal AS goal,
  work.result AS result,
  work.evidence_json AS evidence_json
  FROM work`;

/** The `ScheduledTask` projection for the recurrence maths. `next_run_at` comes out twice: `msToText` drops
 *  milliseconds, so comparisons take the RAW `next_run_at_ms` (`work/occurrences.ts:occurrenceOf` reads it). */
export const scheduleRowColumns = (a = 'w'): string => `
  ${a}.id AS id,
  ${a}.title AS title,
  ${msToText(a + '.scheduled_start')} AS scheduled_start,
  ${a}.repeat_interval AS repeat_interval,
  ${a}.repeat_unit AS repeat_unit,
  ${a}.repeat_end_type AS repeat_end_type,
  ${a}.repeat_end_value AS repeat_end_value,
  ${a}.repeat_days_of_week AS repeat_days_of_week,
  ${a}.anchor_local AS anchor_time,
  -- the row's declared zone; NULL means the box timezone
  ${a}.tz AS tz,
  ${a}.attempts AS run_count,
  ${a}.is_paused AS is_paused,
  ${msToText(a + '.last_run_at')} AS last_run_at,
  ${msToText(a + '.next_run_at')} AS next_run_at,
  ${a}.next_run_at AS next_run_at_ms,
  ${a}.last_run_at AS last_run_at_ms,
  COALESCE(${a}.schedule_status, 'unscheduled') AS schedule_status,
  ${a}.agent_id AS assigned_to,
  ${a}.parent_id AS project_id,
  ${a}.assigned_to_group AS assigned_to_group,
  ${a}.depends_on AS depends_on,
  ${a}.task_kind AS kind,
  ${a}.description AS description,
  ${a}.goal AS goal,
  ${msToText(a + '.updated_at')} AS updated_at,
  ${STATE_TO_STATUS_SQL(a + '.state')} AS status
`;

/** The `ProjectRow` projection; an open project reads `active`. */
export const projectRowColumns = (): string => `SELECT
  work.id AS id,
  work.title AS title,
  work.description AS description,
  COALESCE(work.level, 1) AS level,
  CASE WHEN work.state = 'open' THEN 'active' ELSE ${STATE_TO_STATUS_SQL('work.state')} END AS status,
  work.requester_id AS created_by,
  COALESCE(work.phase_count, 1) AS phase_count,
  COALESCE(work.current_phase, 1) AS current_phase,
  ${msToText('work.opened_at')} AS created_at,
  ${msToText('work.updated_at')} AS updated_at,
  ${msToText('work.closed_at')} AS completed_at
  FROM work`;

/** Stamp facts are `work_events` rows of kind `activity`, each read by its own correlated subquery, newest
 *  by monotonic `id` and never by clock (two finalizes inside one millisecond are ordinary). */
const newestActivity = (a: string, field: string, where = ''): string =>
  `(SELECT ${field} FROM work_events e`
  + ` WHERE e.work_id = ${a}.id AND e.kind = '${WORK_EVENT.activity}'${where}`
  + ` ORDER BY e.id DESC LIMIT 1)`;

const ANSWERED = ` AND json_extract(e.payload, '$.answered') = 1`;
const DELIVERED = ` AND json_extract(e.payload, '$.delivery_summary') IS NOT NULL`;

export const stampColumns = (a: string): string => `
  ${newestActivity(a, "CAST(json_extract(e.payload, '$.turn') AS INTEGER)")} AS last_activity_turn,
  ${msToText(newestActivity(a, 'e.created_at'))} AS last_activity_at,
  ${newestActivity(a, "json_extract(e.payload, '$.outcome')")} AS last_activity_outcome,
  ${newestActivity(a, "CAST(json_extract(e.payload, '$.turn') AS INTEGER)", ANSWERED)} AS last_answered_turn,
  ${msToText(newestActivity(a, 'e.created_at', ANSWERED))} AS last_answered_at,
  ${newestActivity(a, "json_extract(e.payload, '$.delivery_summary')", DELIVERED)} AS last_delivery_summary`;
