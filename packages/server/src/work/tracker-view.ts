// PHASE-2 T8b — THE TRACKER'S READ SHAPE, EXPRESSED ON THE SPINE.
//
// What this file is for, in one sentence: `legacy_tasks` / `legacy_projects` stop being the
// tracker's storage and `work` becomes it, WITHOUT the row shape every consumer already reads
// changing underneath them. This module owns the translation and nothing else owns any part
// of it — one mapping, one place (Part I §3, "one authority per fact").
//
// THREE translations happen here and they are separate facts:
//
//   1. VOCABULARY. `legacy_tasks.status` is `on_deck | in_progress | complete | blocked |
//      fallen | paused` and `legacy_projects.status` adds `active | cancelled`. `work.state`
//      is the spine's eight-value enum. Migration `135_work_spine.sql:290-300` and `:351-360`
//      already fixed the forward map when it backfilled the table; this file carries the SAME
//      map and its exact inverse, and `tracker-view.test.ts` proves the round trip rather
//      than trusting it.
//
//   2. TIME. The legacy tables store instants as SQLite-form TEXT (`datetime('now')`),
//      `work` as INTEGER epoch-ms (migration `137`'s own header says so). Readers get the
//      TEXT form back byte-identically — `strftime('%Y-%m-%d %H:%M:%S', …)` is exactly what
//      `datetime('now')` produces — because a consumer doing `new Date(created_at)` must not
//      silently change meaning inside a task whose job is the STORAGE move.
//
//   3. NAMES. Fifteen columns are already on `work` under a spine name (T8a report §2.3a).
//      `project_id`→`parent_id`, `assigned_to`→`agent_id`, `created_by`→`requester_id`,
//      `created_at`→`opened_at`, `completed_at`→`closed_at`, `anchor_time`→`anchor_local`,
//      `run_count`→`attempts`, `kind`→`task_kind`. The other 40 kept their names at `137`.
//
// WHAT IS NOT HERE: any write. Writes live in `tracker-store.ts` (attributes) and
// `store.ts` (`work.state`, via `transition()`), which is the two-clause property the
// single-writer walk enforces.

import type { WorkState } from './store.js';

// ════════════════════════════════════════════════════════════════════════════════
// 1 — VOCABULARY
// ════════════════════════════════════════════════════════════════════════════════

/** Every status value the two legacy tables could hold. Measured, not guessed: migration
 *  `135`'s CASE arms are the enumeration (it read the lived-in body, where projects carry
 *  `complete`, `cancelled` and `active`), and the task side adds nothing beyond them. */
export type TrackerStatus =
  | 'on_deck' | 'in_progress' | 'complete' | 'blocked' | 'fallen' | 'paused'
  | 'active' | 'cancelled';

/** The forward map, character for character the one migration `135` used. */
const STATUS_TO_STATE: Record<TrackerStatus, WorkState> = {
  on_deck: 'on_deck',
  in_progress: 'claimed',
  complete: 'done',
  blocked: 'blocked',
  fallen: 'failed',
  paused: 'paused',
  active: 'open',
  cancelled: 'abandoned',
};

/** Its exact inverse. Total in both directions — that is the property the test asserts, and
 *  it is why `open`/`abandoned` come back as `active`/`cancelled` rather than being folded
 *  into a nearby task status: a lossy arm here would silently rewrite a row's meaning. */
const STATE_TO_STATUS: Record<WorkState, TrackerStatus> = {
  on_deck: 'on_deck',
  claimed: 'in_progress',
  done: 'complete',
  blocked: 'blocked',
  failed: 'fallen',
  paused: 'paused',
  open: 'active',
  abandoned: 'cancelled',
};

/** Translate a legacy tracker status to the spine state. Unknown input follows `135`'s own
 *  default arm (`ELSE 'open'`) for the same reason it gave: surfacing work that may be
 *  finished is recoverable, silently terminating live work is not. */
export function statusToState(status: string): WorkState {
  return STATUS_TO_STATE[status as TrackerStatus] ?? 'open';
}

/** Translate a spine state back to the status the tracker's consumers read. */
export function stateToStatus(state: string): TrackerStatus {
  return STATE_TO_STATUS[state as WorkState] ?? 'active';
}

/** Both directions as SQL, for the predicates and projections that cannot round-trip
 *  through TypeScript (a `WHERE status = 'complete'` inside a bigger statement). */
export const STATE_TO_STATUS_SQL = (col: string): string =>
  `CASE ${col}`
  + ` WHEN 'claimed' THEN 'in_progress'`
  + ` WHEN 'done' THEN 'complete'`
  + ` WHEN 'failed' THEN 'fallen'`
  + ` WHEN 'open' THEN 'active'`
  + ` WHEN 'abandoned' THEN 'cancelled'`
  + ` ELSE ${col} END`;

// ════════════════════════════════════════════════════════════════════════════════
// 2 — SCOPE: which `work` rows are the tracker's
// ════════════════════════════════════════════════════════════════════════════════

/**
 * OR1 put five nouns in one table, so "the tracker's rows" is a predicate, not a table name.
 *
 * `kind IN ('task','project')` is the board's filter and it is nearly right — but T4's
 * delegation join opens its countdown children as `kind='task'` too (`store.ts`
 * `openDelegationJoin`, ids shaped `piece:<parent>:<thread>`). Those are pieces of an ask,
 * not board rows, and surfacing them would be this task changing what the tracker shows.
 *
 * The discriminator is POSITIVE and enumerable rather than a "not a piece" exclusion: every
 * INSERT of a `kind IN ('task','project')` row in the tree sets `root_kind`, and there are
 * exactly three producers —
 *   * migration `135`'s backfill      -> root_kind 'legacy'      (the pre-spine population)
 *   * `work/tracker-store.ts`         -> root_kind 'tracker'     (every row opened since)
 *   * `store.ts:openDelegationJoin`   -> root_kind 'a2a_thread'  (join pieces, NOT the board)
 * Command: `git grep -n "INTO work" -- packages/server/src | grep -v __tests__`.
 */
const TRACKER_ROOT_KINDS = "('legacy','tracker')";

/** The tracker's task rows. `a` is the table alias the caller used for `work`. */
export const taskScope = (a = 'w'): string =>
  `${a}.kind = 'task' AND ${a}.root_kind IN ${TRACKER_ROOT_KINDS}`;

/** The tracker's project rows. */
export const projectScope = (a = 'w'): string =>
  `${a}.kind = 'project' AND ${a}.root_kind IN ${TRACKER_ROOT_KINDS}`;


/** `root_kind` for rows this platform opens from now on. Migrated rows keep `'legacy'`;
 *  both are in scope, and the pair is the whole enumeration. */
export const TRACKER_ROOT_KIND = 'tracker';

// ════════════════════════════════════════════════════════════════════════════════
// 3 — TIME
// ════════════════════════════════════════════════════════════════════════════════

/**
 * epoch-ms INTEGER -> the exact text `datetime('now')` writes.
 *
 * Proven identical rather than assumed (T8a report §4): `strftime('%s', '2026-02-26 10:00:00')`
 * and `strftime('%s','2026-02-26T10:00:00.000Z')` return the same integer, so the round trip
 * through `137`'s backfill and back through this expression is byte-stable for every instant
 * the legacy tables could hold.
 */
export const msToText = (col: string): string =>
  `CASE WHEN ${col} IS NULL THEN NULL ELSE strftime('%Y-%m-%d %H:%M:%S', ${col} / 1000, 'unixepoch') END`;


/** TypeScript side of the same conversion, for values crossing the boundary in code. */
export function tsToMs(text: string | null | undefined): number | null {
  if (text == null || text === '') return null;
  const ms = Date.parse(/[TZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}


// ════════════════════════════════════════════════════════════════════════════════
// 4 — THE TWO-KEY FACTS, WHICH ARE NOW ROWS
// ════════════════════════════════════════════════════════════════════════════════
//
// `legacy_tasks` carried eight columns for the two-key contract: three `*_validated` flags,
// `revert_count`, `awaiting_user_verdict` + `user_verdict_requested_at`, and
// `validation_escalated_at` + `validation_thread_id`. Migration `137` deliberately did NOT
// move them (T8a report §2.3b): research 19 §1c makes them `adjudications` rows, and
// `work/store.ts` already writes that table — the verdict is a ROW, the count is a COUNT.
//
// The expressions below are that re-expression, and they are MECHANICAL: same fact, same
// answer, different store. The POLICY that changes what the facts MEAN — the two-key trigger
// as migration `138`, the ladder rekey — is T8c's and is not here.

/** The last time this row entered `state`, from its own event log. `transition()` writes one
 *  `transition` event per move with `to` in the payload, so this is a read of the record the
 *  spine already keeps rather than a second clock. */
const lastEntryInto = (a: string, state: WorkState): string =>
  `(SELECT MAX(e.created_at) FROM work_events e`
  + ` WHERE e.work_id = ${a}.id AND e.kind = 'transition'`
  + `   AND json_extract(e.payload, '$.to') = '${state}')`;

/**
 * `<state>_validated`: 1 when an authority upheld the CURRENT claim.
 *
 * Scoped to "at or after the row last entered that state" so the flag resets exactly where
 * the column did — a retask that sends the row back to `in_progress` and then a fresh close
 * gets a fresh, unvalidated claim, which is what `tracker/tools.ts`'s retask block
 * (`pause_validated = 0, complete_validated = 0, blocked_validated = 0`) was doing by hand.
 */
export const validatedExpr = (a: string, state: WorkState): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM adjudications adj`
  + ` WHERE adj.work_id = ${a}.id AND adj.claim_state = '${state}' AND adj.verdict = 'upheld'`
  + `   AND adj.created_at >= COALESCE(${lastEntryInto(a, state)}, 0)) THEN 1 ELSE 0 END)`;

/** Event kinds this file and `tracker-store.ts` agree on. Declared once so a typo cannot make
 *  a writer and a reader disagree silently — the failure mode research 03 catalogued. */
export const WORK_EVENT = {
  /** The 5-minute unvalidated-transition escalation (was `validation_escalated_at` +
   *  `validation_thread_id`). Payload: `{ thread_id }`. */
  validationEscalated: 'validation_escalated',
  /** The stalemate flag (was `awaiting_user_verdict` + `user_verdict_requested_at`). */
  userVerdictRequested: 'user_verdict_requested',
  /** Its clear (override, applied verdict, the scheduler's staleness sweep). */
  userVerdictCleared: 'user_verdict_cleared',
  /** `revert_count = 0`. The count itself is `COUNT(adjudications rejected)`, so a RESET has
   *  to be a marker the count reads past rather than an assignment. */
  revertReset: 'revert_reset',
} as const;

const lastEvent = (a: string, kind: string, col = 'created_at'): string =>
  `(SELECT MAX(e.${col}) FROM work_events e WHERE e.work_id = ${a}.id AND e.kind = '${kind}')`;

/** `validation_escalated_at` — a permanent stamp in the legacy schema (nothing cleared it;
 *  the scheduler's own predicate is `validation_escalated_at IS NULL`), so no scoping. */
export const validationEscalatedAtExpr = (a: string): string =>
  msToText(lastEvent(a, WORK_EVENT.validationEscalated));

/** `validation_thread_id` — the payload of that same event. */
export const validationThreadIdExpr = (a: string): string =>
  `(SELECT json_extract(e.payload, '$.thread_id') FROM work_events e`
  + ` WHERE e.work_id = ${a}.id AND e.kind = '${WORK_EVENT.validationEscalated}'`
  + ` ORDER BY e.created_at DESC, e.id DESC LIMIT 1)`;

/** `awaiting_user_verdict` — set by a request, cleared by an apply/override/staleness sweep.
 *  Expressed as "the newest request is newer than the newest clear". */
export const awaitingUserVerdictExpr = (a: string): string =>
  `(CASE WHEN COALESCE(${lastEvent(a, WORK_EVENT.userVerdictRequested)}, -1)`
  + ` > COALESCE(${lastEvent(a, WORK_EVENT.userVerdictCleared)}, -1) THEN 1 ELSE 0 END)`;

/** `user_verdict_requested_at` — the request's own instant, and NULL once cleared, which is
 *  exactly what the column did. */
export const userVerdictRequestedAtExpr = (a: string): string =>
  `CASE WHEN ${awaitingUserVerdictExpr(a)} = 1`
  + ` THEN ${msToText(lastEvent(a, WORK_EVENT.userVerdictRequested))} ELSE NULL END`;

/** `revert_count` — a COUNT of thrown-back claims since the last reset, never a maintained
 *  integer. `work/store.ts:revertCount()` is the same count without the reset window; this
 *  expression is the one the tracker's own surfaces read because the legacy column WAS
 *  reset (by override and by an applied user verdict). */
export const revertCountExpr = (a: string): string =>
  `(SELECT count(*) FROM adjudications adj WHERE adj.work_id = ${a}.id AND adj.verdict = 'rejected'`
  + `   AND adj.created_at >= COALESCE(${lastEvent(a, WORK_EVENT.revertReset)}, 0))`;

// ════════════════════════════════════════════════════════════════════════════════
// 5 — THE ROW SHAPES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * The legacy `TaskRow` projection, built from `work` — a COMPLETE `SELECT … FROM work`, not a
 * bare column list. That is deliberate and it is not style: the orphan gate only inspects
 * string literals that look like SQL (`SELECT|INSERT INTO|UPDATE|DELETE FROM`), so a fragment
 * holding only columns is invisible to it and four real readers — `phase`, `level`,
 * `phase_count`, `current_phase` — declared as spine structures would have looked like orphans
 * and cost four of the arc's five waivers to explain away. Naming the table and the verb in
 * the same literal is free, reads better at the call sites, and keeps the gate able to see.
 *
 * Every consumer that did `SELECT * FROM legacy_tasks` gets this instead, so `mapTaskRow`
 * and the shared `Task` type — and therefore the dashboard board — do not move at all.
 */
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
  work.status_before_pause AS status_before_pause,
  ${msToText('work.last_run_at')} AS last_run_at,
  COALESCE(work.schedule_status, 'unscheduled') AS schedule_status,
  work.assigned_to_group AS assigned_to_group,
  work.task_kind AS kind,
  ${msToText('work.opened_at')} AS created_at,
  ${msToText('work.updated_at')} AS updated_at,
  ${msToText('work.closed_at')} AS completed_at,
  ${validatedExpr('work', 'paused')} AS pause_validated,
  ${validatedExpr('work', 'done')} AS complete_validated,
  ${validatedExpr('work', 'blocked')} AS blocked_validated,
  ${validationEscalatedAtExpr('work')} AS validation_escalated_at,
  work.goal AS goal,
  work.result AS result,
  work.evidence_json AS evidence_json
  FROM work`;

/**
 * The `ScheduledTask` projection the scheduler's recurrence maths takes.
 *
 * `scheduler/engine.ts:calculateNextRun` reads TEXT instants and the legacy column names, and
 * it is pure arithmetic over them — nothing this task touches. So the storage moved and the
 * function did not: the columns come out of `work` in the shape it already reads. The
 * thirteen schedule columns collapse into `schedule_json`/`tz`/`sequence` at T8c, and this
 * projection is what that collapse replaces.
 */
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
  ${a}.attempts AS run_count,
  ${a}.is_paused AS is_paused,
  ${msToText(a + '.last_run_at')} AS last_run_at,
  ${msToText(a + '.next_run_at')} AS next_run_at,
  COALESCE(${a}.schedule_status, 'unscheduled') AS schedule_status,
  ${msToText(a + '.missed_runs_paused_at')} AS missed_runs_paused_at,
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

/** The legacy `ProjectRow` projection. `legacy_projects` had no `assigned_to`; its status
 *  vocabulary is the `active | complete | cancelled` arm of the same map. */
export const projectRowColumns = (): string => `SELECT
  work.id AS id,
  work.title AS title,
  work.description AS description,
  COALESCE(work.level, 1) AS level,
  ${STATE_TO_STATUS_SQL('work.state')} AS status,
  work.requester_id AS created_by,
  COALESCE(work.phase_count, 1) AS phase_count,
  COALESCE(work.current_phase, 1) AS current_phase,
  ${msToText('work.opened_at')} AS created_at,
  ${msToText('work.updated_at')} AS updated_at,
  ${msToText('work.closed_at')} AS completed_at
  FROM work`;
