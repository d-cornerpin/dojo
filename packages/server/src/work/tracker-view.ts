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

import type { WorkEventKind } from './event-kinds.js';
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
 * BOTH paused clauses are load-bearing: `work/tracker-store.ts` (`syncSchedulePause`) sets
 * `is_paused = 1` WITHOUT touching `schedule_status`, so a row can be paused while its
 * status still reads `'waiting'`. runner excludes it by the flag, pm-agent by its own
 * active-status filter — only a predicate carrying both agrees with both.
 *
 * Reconciliation + containment measurement: `tracker/__tests__/census-wire-through-seam.test.ts`.
 */
export const dueScope = (a = 'w'): string =>
  `${a}.next_run_at IS NOT NULL AND ${a}.next_run_at <= ?`
  + ` AND ${a}.schedule_status = 'waiting' AND ${a}.is_paused = 0`;


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
 * The system closers, mirrored from `store.ts:SYSTEM_CLOSERS` as SQL. Kept as a literal
 * rather than imported-and-joined because this is a SQL fragment, and a drift between the
 * two lists is caught by `__tests__/two-key-completion.test.ts`, which asserts the roles
 * `transition()` actually stamps.
 */
const SYSTEM_CLOSER_ROLES = `('engine', 'scheduler', 'healer')`;

/**
 * `<state>_validated`: 1 when an authority upheld the CURRENT claim.
 *
 * Scoped to "at or after the row last entered that state" so the flag resets exactly where
 * the column did — a retask that sends the row back to `in_progress` and then a fresh close
 * gets a fresh, unvalidated claim, which is what `tracker/tools.ts`'s retask block
 * (`pause_validated = 0, complete_validated = 0, blocked_validated = 0`) was doing by hand.
 *
 * ── PHASE-2 T8T: `done` CARRIES ONE EXTRA CLAUSE, AND IT IS THE POINT OF THE WHOLE TASK ──
 *
 * RULING 1 makes `transition()` file an upheld `claim_state='done'` adjudication for a
 * SYSTEM closer, because migration `139`'s trigger refuses a task/project `done` without
 * one. That row is a CLOSE RECEIPT — "the engine pointed at a delivery" — and it is not a
 * verdict. `complete_validated` is the verdict: "an authority read this against the goal and
 * blessed it." Two different questions, and reading the receipt as the verdict would stamp
 * `complete_validated = 1` on every engine close, which is migration `108`'s demolished
 * forgery restored (*"engineCloseDeliveredTask wrote status='complete' AND
 * complete_validated=1"*) and a direct contradiction of the owner ruling of 2026-07-19
 * carried verbatim at `tracker/tools.ts:256-270` (*"The engine files ONLY Key 1 … the PM
 * independently validates (Key 2 untouched) and rejects/reopens garbage"*).
 *
 * The clause is `done`-ONLY on purpose. `blocked` has a deliberate engine uphold
 * (`agent/v2/loop.ts:2566`, *"blocked_validated=1 IS the engine's validation"*) and `paused`
 * has the scheduler's timed-out verdict (`scheduler/runner.ts:288`); neither is touched by
 * the trigger and neither may be scoped away. Asserted both ways in
 * `work/__tests__/two-key-completion.test.ts` §5.
 */
export const validatedExpr = (a: string, state: WorkState): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM adjudications adj`
  + ` WHERE adj.work_id = ${a}.id AND adj.claim_state = '${state}' AND adj.verdict = 'upheld'`
  + (state === 'done' ? ` AND adj.by_agent NOT IN ${SYSTEM_CLOSER_ROLES}` : '')
  + `   AND adj.created_at >= COALESCE(${lastEntryInto(a, state)}, 0)) THEN 1 ELSE 0 END)`;

/**
 * KEY 1, AS A QUERY (PHASE-2 T8T).
 *
 * Before the two-key trigger, "Key 1 is filed and Key 2 is not" was a STATE:
 * `status='complete' AND complete_validated=0`. Migration `139` makes that state
 * unrepresentable for a tracker row closed by its own worker — the row does not move — so
 * Key 1 moved from the state to an EVENT: `transition()`'s `validation_requested` row.
 *
 * "Pending" is the request being NEWER than the row's newest ANSWER, which is what makes it
 * self-clearing: the engine's receipt close, a retask, a reopen — anything that moves the row
 * — writes a `transition`, and a PM who throws the claim back writes a `claim_rejected`
 * without moving anything. Either answers the request, so both end it, and nobody has to
 * remember to clear a flag. Compared by `work_events.id`, never by `created_at`: this
 * phase has now hit the same-millisecond defect three times (the poke ladder's window, the
 * scheduler's occurrence CAS, the adjudication instant in `store.ts`), and a sequence exists
 * here, so a clock is the wrong instrument.
 *
 * requirement preserved: work whose worker says it is finished is SEEN by the validator.
 * That was the `complete_validated=0` queue; this is the same queue, keyed on the row that
 * records the claim instead of on the state the claim used to be allowed to set.
 */
export const pendingCloseRequestExpr = (a: string): string =>
  `(CASE WHEN COALESCE((SELECT MAX(e.id) FROM work_events e`
  + `    WHERE e.work_id = ${a}.id AND e.kind = 'validation_requested'`
  + `      AND json_extract(e.payload, '$.requested_state') = 'done'), -1)`
  + `  > COALESCE((SELECT MAX(e2.id) FROM work_events e2`
  + `    WHERE e2.work_id = ${a}.id AND e2.kind IN ('transition', 'claim_rejected')), -1)`
  + ` THEN 1 ELSE 0 END)`;

/**
 * WHICH ROWS HAVE A CLOSE FILED ON THEM — the subject, written ONCE (UX-REPAIR round 5 T21).
 *
 * `pendingCloseRequestExpr` above answers "is a close request outstanding". It does NOT say
 * which STATES a close can be filed from, and every reader answered that for itself, in the
 * same hand-rolled pair: `state = 'claimed' AND pendingCloseRequestExpr(...) = 1`. Ten sites,
 * four authors, one omission — `paused`. A row paused awaiting the owner's approval, then
 * finished and delivered, files exactly this request `from:'paused'` (round-5 S5, event
 * 22401) and reached NO queue: the completion lens could not see it, and the pause lens
 * picked it up and asked the PM the wrong question against the stale wait note.
 *
 * So the subject is one expression. `claimed` and `paused` are the two states a worker can
 * file a close FROM — they are the two non-terminal states a claimed job can be sitting in
 * when its work finishes — and a reader that wants one of them without the other is asking a
 * different question and must say so in its own words.
 */
export const closeRequestFiledExpr = (a: string): string =>
  `(CASE WHEN ${a}.state IN ('claimed', 'paused') AND ${pendingCloseRequestExpr(a)} = 1 THEN 1 ELSE 0 END)`;

/** "Somebody says this is finished and no authority has agreed" — the completion queue's
 *  whole subject, in its two shapes: the engine's own receipt close (`done`, unblessed) and
 *  the worker's filed close request (the row has not moved). */
export const unvalidatedCloseExpr = (a: string): string =>
  `((${a}.state = 'done' AND ${validatedExpr(a, 'done')} = 0) OR ${closeRequestFiledExpr(a)} = 1)`;

/** The pause lens's subject — v2.7.18's anti-gaming question, MINUS the rows that have since
 *  filed a close. A finished row is a completion question; asking the PM to bless its stale
 *  pause note is how S5's close was eaten. */
export const unvalidatedPauseExpr = (a: string): string =>
  `(${a}.state = 'paused' AND ${validatedExpr(a, 'paused')} = 0 AND ${closeRequestFiledExpr(a)} = 0)`;

/** The delivery the Key-1 request pointed at, so the validator closes against the receipt the
 *  worker actually had rather than resolving a fresh one. */
export const closeRequestDeliveryExpr = (a: string): string =>
  `(SELECT json_extract(e.payload, '$.result_delivery_id') FROM work_events e`
  + ` WHERE e.work_id = ${a}.id AND e.kind = 'validation_requested'`
  + `   AND json_extract(e.payload, '$.requested_state') = 'done'`
  + ` ORDER BY e.id DESC LIMIT 1)`;

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
  /** THE TICKET STAMP (PHASE-2 T8c item 2 — T8a's booked collapse). One event per ticket per
   *  turn-finalize, replacing SIX denormalized columns. Payload:
   *  `{ turn, outcome, answered, delivery_summary }`. */
  activity: 'activity',
} as const satisfies Record<string, WorkEventKind>;

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
