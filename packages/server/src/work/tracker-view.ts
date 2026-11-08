// PHASE-2 T8b — THE TRACKER'S READ SHAPE, EXPRESSED ON THE SPINE.
//
// What this file is for, in one sentence: `legacy_tasks` / `legacy_projects` stop being the
// tracker's storage and `work` becomes it, WITHOUT the row shape every consumer already reads
// changing underneath them. This module owns the translation and nothing else owns any part
// of it — one mapping, one place (Part I §3, "one authority per fact").
//
// THREE translations happen here and they are separate facts:
//
//   1. VOCABULARY. The status words the tracker's readers see, from `work.state` and back.
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

import type { WorkEventKind } from './event-kinds.js';
import type { WorkState } from './store.js';
import { TERMINAL_STATE_NAMES } from './terminal-states.js';

// ════════════════════════════════════════════════════════════════════════════════
// 1 — VOCABULARY
// ════════════════════════════════════════════════════════════════════════════════

/** The status words the tracker's readers see. A task waiting in Open reads `on_deck`, a project
 *  `active`. Paused and blocked are holds on Working work (`work/done/hold.ts`), not statuses. */
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

/** Translate a status word to the spine state. Unknown input reads as Open: surfacing work that may be
 *  finished is recoverable, silently terminating live work is not. */
export function statusToState(status: string): WorkState {
  return STATUS_TO_STATE[status as TrackerStatus] ?? 'open';
}

/** Translate a spine state back to the status word a task's readers see. */
export function stateToStatus(state: string): TrackerStatus {
  return STATE_TO_STATUS[state as WorkState] ?? 'on_deck';
}

/** Both directions as SQL, for the predicates and projections that cannot round-trip
 *  through TypeScript (a `WHERE status = 'complete'` inside a bigger statement). */
export const STATE_TO_STATUS_SQL = (col: string): string =>
  `CASE ${col}`
  + ` WHEN 'claimed' THEN 'in_progress'`
  + ` WHEN 'done' THEN 'complete'`
  + ` WHEN 'failed' THEN 'fallen'`
  + ` WHEN 'open' THEN 'on_deck'`
  + ` WHEN 'blocked' THEN 'in_progress'`
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
/**
 * PHASE-2 T8c item 3 — `engine_scaffold` is the THIRD tracker root kind, and it is the
 * `ENGINE_AUTO_MARKER` rekey.
 *
 * The marker used to be the prose prefix `'[engine:multistep] '` on a PROJECT's description,
 * declared in `classifiers/multistep.ts` and MIRRORED by hand in two other files, matched by
 * `LIKE '[engine:multistep] %'` and `startsWith(...)` in five places, and defended by an
 * edit-guard in `work_update:edit` that re-prefixed the string whenever the model tried to
 * rewrite the description. A fact about who opened a row, carried in editable prose, with
 * three declarations and a guard to stop it being edited away.
 *
 * It is a COLUMN now: the row's own `root_kind`, stamped at creation, unreachable from every
 * tool surface. Scaffold rows stay inside `taskScope` — the PM must still see and drive them,
 * and dropping them out of the board would be a far bigger change than the marker.
 */
const ENGINE_SCAFFOLD_ROOT_KIND = 'engine_scaffold';
const TRACKER_ROOT_KINDS = "('legacy','tracker','engine_scaffold')";

export { ENGINE_SCAFFOLD_ROOT_KIND };

/** "this row was opened by the engine's own floor, not by an agent" — the successor to the
 *  `ENGINE_AUTO_MARKER` prose prefix. */
export const engineScaffoldScope = (a = 'w'): string =>
  `${a}.root_kind = '${ENGINE_SCAFFOLD_ROOT_KIND}'`;

/** The tracker's task rows. `a` is the table alias the caller used for `work`. */
export const taskScope = (a = 'w'): string =>
  `${a}.kind = 'task' AND ${a}.root_kind IN ${TRACKER_ROOT_KINDS}`;

/** The tracker's project rows. */
export const projectScope = (a = 'w'): string =>
  `${a}.kind = 'project' AND ${a}.root_kind IN ${TRACKER_ROOT_KINDS}`;

/**
 * PHASE-6 T0C-W — **WHAT "OVERDUE" MEANS, DECLARED ONCE.** Emits exactly ONE `?`, the
 * now-instant in epoch ms; `a` is the caller's table alias.
 *
 * Two live meanings existed and inventing a third inside a list filter was the banned
 * move: `scheduler/runner.ts` (recurring, has fired, >1.5× its interval late → auto-pause
 * and ask) and `tracker/pm-agent.ts` (active and waiting, >5 min late → a PM advisory).
 * Neither is a meaning of the word: each is THIS predicate plus its own noise floor, sized
 * to the cost of the action it takes — and runner.ts computes this predicate LITERALLY, as
 * the `dueTasks` query it lays the 1.5× test on top of. Measured on boundary rows spanning
 * both thresholds, neither site selects a row this predicate does not. The thresholds
 * belong to the ACTIONS; the word belongs here, with no threshold at all.
 *
 * BOTH paused clauses are load-bearing: a row can carry `is_paused = 1` while its
 * `schedule_status` still reads `'waiting'`, and runner and pm-agent both exclude it by the flag.
 *
 * Reconciliation + containment measurement: `tracker/__tests__/census-wire-through-seam.test.ts`.
 *
 * A row handed in as a whole waits for its decision and does not fire; a run's hand-in never holds
 * the next run. `work_update(filter:"overdue")` reads this same expression.
 */
export const dueScope = (a = 'w'): string =>
  `${a}.next_run_at IS NOT NULL AND ${a}.next_run_at <= ?`
  + ` AND ${a}.schedule_status = 'waiting' AND ${a}.is_paused = 0`
  + ` AND (${handedInExpr(a)} = 0 OR (SELECT json_extract(h.payload, '$.scope') FROM work_events h`
  + ` WHERE h.work_id = ${a}.id AND h.kind = 'handed_in' ORDER BY h.id DESC LIMIT 1) IS 'run')`;

/** `root_kind` for rows this platform opens from now on. Migrated rows keep `'legacy'`;
 *  both are in scope, and the pair is the whole enumeration. */
export const TRACKER_ROOT_KIND = 'tracker';

/** `root_kind` of a service agent's own housekeeping: off the board (`work/done/housekeeping.ts`). */
export const SERVICE_ROOT_KIND = 'service';

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

/**
 * WHERE this row last entered a state, as a position on its own event log: the
 * `work_events.id` of the newest `transition` whose `to` is that state, or NULL when the log
 * holds none (a row born in the state, or migrated without its history).
 *
 * ── t142: AN ID, NOT AN INSTANT ──
 * ⟨TOMBSTONE⟩ This was `MAX(e.created_at)` and every caller compared it against another
 * table's clock. A millisecond tie then read in the wrong direction (a verdict filed for the
 * PREVIOUS episode counted for the new one), which `work/override-requests.ts` had already
 * written down as the law this codebase keeps relearning: "Ordering is by `work_events.id`,
 * never by `created_at` … a sequence exists here, so a clock is the wrong instrument."
 * requirement preserved: "the newest entry into this state" is the same row it always was;
 * only the unit it is returned in changed, and every caller compares in that unit.
 *
 * `stateSql` is a SQL expression, so a caller can ask about a literal state (`'blocked'`) or
 * about the row's CURRENT state (`w.state`) — the latter is the ESCALATION EPISODE, see
 * `work/validation-drive.ts:ownerEpisodeSettledExpr`. One definition serves both, so a verdict
 * and a "the owner was told" record are scoped to the same boundary by construction.
 */
export const lastEntryEventIdExpr = (a: string, stateSql: string): string =>
  `(SELECT MAX(e.id) FROM work_events e`
  + ` WHERE e.work_id = ${a}.id AND e.kind = 'transition'`
  + `   AND json_extract(e.payload, '$.to') = ${stateSql})`;

/**
 * The system closers, mirrored from `store.ts:SYSTEM_CLOSERS` as SQL. Kept as a literal
 * rather than imported-and-joined because this is a SQL fragment, and a drift between the
 * two lists is caught by `__tests__/two-key-completion.test.ts`, which asserts the roles
 * `transition()` actually stamps.
 */
const SYSTEM_CLOSER_ROLES = `('engine', 'scheduler', 'healer')`;

/**
 * `<state>_validated`: 1 when an authority upheld the CURRENT claim, scoped on the event log to at or
 * after the row last entered that state (`adjudications.event_seq`, migration 189c). For `done` a
 * system closer's receipt is not a verdict, so those roles are excluded.
 */
export const validatedExpr = (a: string, state: WorkState): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM adjudications adj`
  + ` WHERE adj.work_id = ${a}.id AND adj.claim_state = '${state}' AND adj.verdict = 'upheld'`
  + (state === 'done' ? ` AND adj.by_agent NOT IN ${SYSTEM_CLOSER_ROLES}` : '')
  + `   AND adj.event_seq >= COALESCE(${lastEntryEventIdExpr(a, `'${state}'`)}, 0)) THEN 1 ELSE 0 END)`;

/** Board work handed in and waiting for its decision (`work/done/`), as 1/0. The readers of the
 *  filed-close question all read this one fact now; 2d replaces them with the one ladder. */
export const handedInExpr = (a: string): string => `(CASE WHEN ${a}.state = 'handed_in' THEN 1 ELSE 0 END)`;

/**
 * C5 (v3.5 field fix 3 evidence round): WHICH OF AN AGENT'S CLAIMED TASKS A TURN IS WORKING, when
 * nothing carried names it (the job pick, `job-turn-end.ts`, and the charge, `tracker-counting.ts`,
 * both order by this; a carried job still wins over it). An ORDER BY body over alias `a`.
 *
 * Measured on the owner's box: a planned project opened its two steps in one millisecond, so their
 * `updated_at` tied and the old `rowid DESC` tiebreak booked the step-1 shell commands the turn ran
 * next to step 2 ("Reply to ..."). Step 1's own close then read an empty ledger and was refused.
 *   1. A task whose close is filed and pending is not being worked (its worker owes nothing more,
 *      t152) and goes last.
 *   2. The task the agent's own latest write touched (`updated_at`), as before.
 *   3. On a tie, the EARLIER step of a planned project: steps are worked in order, so the open step
 *      with the lowest number is the one in hand. A row with no step keeps the old newest-first tiebreak.
 */
export const workingTaskOrder = (a: string): string =>
  `${handedInExpr(a)} ASC, ${a}.updated_at DESC, `
  + `CASE WHEN ${a}.step_number IS NULL THEN 1 ELSE 0 END ASC, ${a}.step_number ASC, ${a}.rowid DESC`;

export const WORK_EVENT = {
  /** The 5-minute unvalidated-transition escalation (was `validation_escalated_at` +
   *  `validation_thread_id`). Payload: `{ thread_id }`. */
  validationEscalated: 'validation_escalated',
  /** `revert_count = 0`. The count itself is `COUNT(adjudications rejected)`, so a RESET has
   *  to be a marker the count reads past rather than an assignment. */
  revertReset: 'revert_reset',
  /** THE TICKET STAMP (PHASE-2 T8c item 2 — T8a's booked collapse). One event per ticket per
   *  turn-finalize, replacing SIX denormalized columns. Payload:
   *  `{ turn, outcome, answered, delivery_summary }`. */
  activity: 'activity',
  /** v3.3.3 t142 (migration 189) — A PERSON WAS TOLD ABOUT THIS WORK. Written only by
   *  `work/validation-drive.ts:recordPersonTold`, by a path that structurally holds the work
   *  id. Payload: `{ delivery_id, via, channel }`; it counts only while that delivery is still
   *  `delivered` (an outbound scope can downgrade its row to `failed` after the fact). */
  personTold: 'person_told',
} as const satisfies Record<string, WorkEventKind>;

const lastEvent = (a: string, kind: string, col = 'created_at'): string =>
  `(SELECT MAX(e.${col}) FROM work_events e WHERE e.work_id = ${a}.id AND e.kind = '${kind}')`;

/** `validation_escalated_at` — the newest stamp's instant, for DISPLAY (the dashboard's "user
 *  has been asked" label). It is deliberately unscoped, and since t142 that is a known gap: the
 *  escalation sweep reads stamps PER EPISODE for a blocked row (`validation-drive.ts:
 *  ownerEpisodeSettledExpr`), so after a re-block this label still shows the previous episode's
 *  ask until the ladder runs again. Migration 189d's carried stamps copy the original instant,
 *  so the upgrade itself moves no label. */
export const validationEscalatedAtExpr = (a: string): string =>
  msToText(lastEvent(a, WORK_EVENT.validationEscalated));

/** `revert_count` — a COUNT of thrown-back claims since the last reset, never a maintained
 *  integer. `work/store.ts:revertCount()` is the same count without the reset window; this
 *  expression is the one the tracker's own surfaces read because the legacy column WAS
 *  reset (by override and by an applied user verdict). */
export const revertCountExpr = (a: string): string =>
  `(SELECT count(*) FROM adjudications adj WHERE adj.work_id = ${a}.id AND adj.verdict = 'rejected'`
  // t142: "since the last reset" is a position on the log. A rejection's `event_seq` is its
  // own `claim_rejected` row (migration 189c), so it is AFTER the reset exactly when that row
  // is — `>`, because the two can never be the same row. It compared instants with `>=`, so a
  // rejection filed in the same millisecond BEFORE the reset survived it and kept counting
  // toward the owner-verdict threshold.
  + `   AND adj.event_seq > COALESCE(${lastEvent(a, WORK_EVENT.revertReset, 'id')}, 0))`;

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
  work.hold_kind AS hold_kind,
  work.hold_reason AS hold_reason,
  ${msToText('work.last_run_at')} AS last_run_at,
  COALESCE(work.schedule_status, 'unscheduled') AS schedule_status,
  work.assigned_to_group AS assigned_to_group,
  work.task_kind AS kind,
  ${msToText('work.opened_at')} AS created_at,
  ${msToText('work.updated_at')} AS updated_at,
  ${msToText('work.closed_at')} AS completed_at,
  ${validatedExpr('work', 'done')} AS complete_validated,
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
 *
 * ⚠ PHASE-2 T8c2 item 4 — `next_run_at` COMES OUT TWICE, AND THAT IS THE FIX FOR A REAL
 * DEFECT. `msToText` is `strftime('%Y-%m-%d %H:%M:%S', col/1000, 'unixepoch')`, so it drops
 * milliseconds BY CONSTRUCTION. That is right for everything that RENDERS an instant (the
 * tracker's readers and the dashboard have always printed this form) and fatal for anything
 * that COMPARES one: the scheduler's occurrence CAS read the text, converted it back with
 * `tsToMs`, and compared 1785316028000 against a stored 1785316028089 — so any schedule whose
 * start carried milliseconds could never be claimed, and the server logged "1 task(s) due"
 * followed by "occurrence already claimed elsewhere" forever. `next_run_at_ms` is the RAW
 * column; every comparison takes it. `work/occurrences.ts:occurrenceOf` is its only reader,
 * so the claim's input is derived in exactly one place.
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
  -- UX-REPAIR round 2 T13: the declared per-reminder zone, finally projected. NULL on every
  -- row that predates the write, and NULL means "the box timezone" — exactly today's answer.
  ${a}.tz AS tz,
  ${a}.attempts AS run_count,
  ${a}.is_paused AS is_paused,
  ${msToText(a + '.last_run_at')} AS last_run_at,
  ${msToText(a + '.next_run_at')} AS next_run_at,
  ${a}.next_run_at AS next_run_at_ms,
  ${a}.last_run_at AS last_run_at_ms,
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

/** The legacy `ProjectRow` projection. `legacy_projects` had no `assigned_to`; an open project
 *  reads `active`. */
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

// ════════════════════════════════════════════════════════════════════════════════
// 6 — THE TICKET STAMPS, WHICH ARE NOW EVENTS (PHASE-2 T8c item 2)
// ════════════════════════════════════════════════════════════════════════════════
//
// T8a booked this and named it: "the six stamp columns' collapse into a view over
// `work_events` + `deliveries`". T8b moved their STORAGE onto `work` and said out loud that
// moving storage is not the collapse. This is the collapse.
//
// `last_activity_turn`, `last_activity_at`, `last_activity_outcome`, `last_answered_turn`,
// `last_answered_at` and `last_delivery_summary` were six columns carrying facts the spine
// already records: a turn happened, it ended with an outcome, and something was delivered on
// it. They existed because nothing tied a TICKET to a TURN — and the stamp write was itself
// that tie. So the tie becomes a row: one `work_events` row of kind `activity` per ticket per
// finalize, and the six facts are read back off it.
//
// WHY THIS IS A COLLAPSE AND NOT A RELOCATION: the columns were a write-time freeze with a
// COALESCE ladder maintaining "the last time this ANSWERED" and "the last delivery summary"
// across turns that did neither. Three separate facts had to be kept in step by one UPDATE
// statement getting its COALESCEs right. Here they are three reads of one log, each saying
// what it means — "the newest activity", "the newest activity that answered", "the newest
// activity that delivered" — and they cannot drift from each other because there is nothing
// to keep in step.
//
// The expressions follow the same pattern as the two-key facts above (a correlated subquery
// per fact), and every reader of these is a single-row `WHERE id = ?` lookup — measured, all
// four of them — so this is not on any board-render path.
//
// requirement preserved: `renderTaskStamps` receives byte-identical `TaskStampFields` and the
// COALESCE semantics are reproduced exactly, including "keep the prior answered stamp when
// this turn did not answer".

/** The newest `activity` event for this row, by monotonic id (not by clock — two finalizes
 *  inside one millisecond are ordinary, and `work_events.id` is the sequence that survives
 *  it; same lesson as `work/poke-ladder.ts`). */
const newestActivity = (a: string, field: string, where = ''): string =>
  `(SELECT ${field} FROM work_events e`
  + ` WHERE e.work_id = ${a}.id AND e.kind = '${WORK_EVENT.activity}'${where}`
  + ` ORDER BY e.id DESC LIMIT 1)`;

const ANSWERED = ` AND json_extract(e.payload, '$.answered') = 1`;
const DELIVERED = ` AND json_extract(e.payload, '$.delivery_summary') IS NOT NULL`;

/**
 * The six stamp fields, as a projection fragment.
 *
 * Every reader used to spell these out itself — FOUR near-identical copies across
 * `tracker/tools.ts`, `tracker/pm-agent.ts`, `memory/assembler.ts` and `agent/v2/loop.ts`,
 * which is the duplicated-reader shape research 03 catalogued and exactly how a projection
 * drifts from the type it fills. One fragment now, named once.
 */
export const stampColumns = (a: string): string => `
  ${newestActivity(a, "CAST(json_extract(e.payload, '$.turn') AS INTEGER)")} AS last_activity_turn,
  ${msToText(newestActivity(a, 'e.created_at'))} AS last_activity_at,
  ${newestActivity(a, "json_extract(e.payload, '$.outcome')")} AS last_activity_outcome,
  ${newestActivity(a, "CAST(json_extract(e.payload, '$.turn') AS INTEGER)", ANSWERED)} AS last_answered_turn,
  ${msToText(newestActivity(a, 'e.created_at', ANSWERED))} AS last_answered_at,
  ${newestActivity(a, "json_extract(e.payload, '$.delivery_summary')", DELIVERED)} AS last_delivery_summary`;
