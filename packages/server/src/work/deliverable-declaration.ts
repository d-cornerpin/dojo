// ════════════════════════════════════════════════════════════════════════════════
// WHICH SCHEDULED TASKS OWE A PERSON SOMETHING — SWEEP CORE-1 CT2 (2026-08-09).
//
// ── THE INCIDENT (the owner's box, his transcript, 2026-08-07) ──
// His Tomorrow Brief — a recurring scheduled task — fired on time. His agent did the work and
// wrote the brief. Then it marked the run COMPLETE and sent NOTHING. His own sentence about it
// is the rule the platform now owns: *"I won't close the run until after the message is sent."*
//
// Before a closer can refuse, something has to say WHICH runs owe a message at all. A nightly
// database backup owes nobody a word; a Tomorrow Brief is nothing BUT the word. This file is
// that something, and it has one job: decide ONCE, at definition time, and RECORD the decision
// where a person can read it.
//
// ── THE THREE RULES THIS FILE OBEYS, and each one is a refusal of a tempting shortcut ──
//
// 1. THE DECLARATION IS MADE ONCE, AT CREATE — never re-judged when the run closes. The closer
//    reads `work.task_kind` and asks nothing else. This is the whole difference between a
//    declaration and an inference: a decision taken at definition time is durable, auditable,
//    visible on the row, correctable by the owner, and identical on every run of the schedule.
//    A decision taken at close time from whatever the model happened to write would be a fresh
//    guess every morning, and the guess would be about the very output whose absence is the
//    defect. THE SCHEDULED RUN'S PROSE IS NEVER READ BY ANYTHING HERE.
//
// 2. THE SET OF DELIVERABLE-OWING KINDS IS A CLOSED, DECLARED INVENTORY (`DELIVERABLE_OWING_
//    TASK_KINDS`, below), not a predicate scattered across call sites. A new kind arrives as an
//    edit to one list that the kit's own judge mirrors, so a product change that widens the set
//    reddens a test somebody has to look at.
//
// 3. AN EXPLICIT KIND FROM THE CALLER ALWAYS WINS. `work_open(kind="reminder")` already writes
//    `task_kind='reminder'` and the reminder lane already reads it (`scheduler/runner.ts`'s
//    reminder prompt, `agent/v2/steps/execute/refusal-gates.ts`, `handoff-floors.ts`). Nothing
//    here overrides a caller who said what the task is.
//
// ── WHY THE PLATFORM DERIVES INSTEAD OF ASKING, and it is not a preference ──
// The owner's own door for creating a recurring brief is `POST /api/tracker/tasks` — the
// dashboard form — and THAT DOOR HAS NO KIND FIELD. It never has. So "just make the creator
// declare it" would leave every task the owner creates himself permanently undeclared, which is
// the population the incident came from. The tool door cannot be widened either: `work_open`'s
// schema is inside the cached prompt prefix that the kit's `check-cache-prefix` gate byte-
// compares against a golden, and moving that golden re-bills the whole cached region on every
// turn for every agent (the owner's own token-cost reference file). The derivation is what a
// declaration looks like when the surface that would have carried the parameter cannot move.
//
// ── AND WHAT IT COSTS TO BE WRONG, in each direction, because that is what sets the threshold ──
// A FALSE POSITIVE (a schedule declared owing that owes nothing): the run cannot close silently,
// so the engine steers the agent to say something, the agent says it, the run closes. The owner
// hears one line he did not need. A FALSE NEGATIVE: the run closes `complete` having reached
// nobody — today's defect, and the reason this sweep exists. The owner's own standing tie-break
// governs an asymmetry exactly this shape: *worst case he hears twice beats silence.* The rules
// below are still written narrowly, because "err toward telling him" is a tie-break and not a
// licence, and every match is recorded with the phrase that caused it so a wrong one is findable
// rather than mysterious.
//
// WRITER-MODULE LAW: this file lives under `work/` because it writes `work` and `work_events`
// (single-writer clause (a)). It does not write `work.state` — it touches one attribute column
// through `patchWork` and appends one audit event, and no close decision is made here at all.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { appendWorkEvent } from './store.js';

const logger = createLogger('deliverable-declaration');

/**
 * THE CLOSED INVENTORY. A scheduled run whose task carries one of these owes a person a
 * user-visible message, and its closer will refuse `complete` without one.
 *
 * `reminder` is not new: it is the kind the platform has always written for
 * `work_open(kind="reminder")`, and the scheduler's own reminder prompt already states this
 * file's whole thesis about it in so many words — *"The reminder message itself is the entire
 * user-facing output."* It is on the list because it was always on the list in spirit and
 * nothing enforced it.
 *
 * The other three are the shapes SWEEP CORE-1's plan names: brief / report / notify.
 *
 * The kit mirrors this list (`behavioral/lib/scheduled-run-truth.mjs`), and its selftest
 * asserts the two are the same list, so widening it here without widening it there is a red.
 */
export const DELIVERABLE_OWING_TASK_KINDS: readonly string[] = ['reminder', 'brief', 'report', 'notify'];

/** The audit marker the declaration writes on the task row. Free string inside the `audit`
 *  payload — a new `work_events.kind` carries a CHECK constraint (migration `152`) and would
 *  be a table rebuild on every lived-in body, which is why the ask ladder and the join ladder
 *  both ride `audit` too. */
export const DECLARATION_MARKER = 'ct2_deliverable_declared';

export interface DeliverableShape {
  /** The declared kind that will be written to `work.task_kind`. */
  shape: string;
  /** The exact phrase from the DEFINITION that caused it — printed on the audit row, so a
   *  declaration nobody expected can be traced to the words that produced it in one read. */
  matched: string;
  /** Which rule fired, by name. */
  rule: string;
}

/**
 * THE RULES. Three, each anchored, each narrow, each with the reason it exists beside it.
 *
 * ⚠ ORDER IS THE SPECIFICITY ORDER, most specific noun first, and it decides only the LABEL —
 * every rule below puts the task on the same declared list, so a task that matches two is
 * deliverable-owing either way and the label is what the owner reads on the row.
 *
 * ⚠ EVERY PATTERN IS WORD-BOUNDED. An unbounded substring is the defect class TB3 fixed in the
 * kit's own census (`dead-display-key-is-loud`'s bare-substring fingerprint matching a
 * reference to itself); the same mistake here would declare "debrief the logs" a brief.
 */
const DELIVERABLE_RULES: ReadonlyArray<{ shape: string; rule: string; re: RegExp; why: string }> = [
  {
    shape: 'brief', rule: 'names-a-brief',
    // "brief", "briefing", "digest", "rundown", "roundup"/"round-up". Nouns whose only purpose
    // is to be READ by somebody — there is no such thing as a brief nobody receives.
    re: /\b(?:brief|briefing|briefings|briefs|digest|digests|rundown|rundowns|round-?up|round-?ups)\b/i,
    why: 'the definition names a BRIEF — an output that exists only to be read by a person',
  },
  {
    shape: 'report', rule: 'names-a-report-for-somebody',
    // A report ADDRESSED to somebody, or one qualified as a recurring status artefact. Bare
    // "report" is deliberately NOT enough: "report any errors to the log" owes nobody a word.
    re: /\b(?:a|the|my|our|your|daily|nightly|weekly|monthly|morning|evening|status|progress)\s+report\b|\breports?\s+(?:to|for)\s+(?:me|us|him|her|them|the\s+owner)\b/i,
    why: 'the definition names a REPORT addressed to a person or issued on a cadence for one',
  },
  {
    shape: 'notify', rule: 'tells-the-agent-to-tell-a-person',
    // A verb of TELLING directed at a person. This is the rule that catches the plain-language
    // shape the owner actually types ("every morning send me what's on for tomorrow").
    re: /\b(?:send|text|email|message|notify|tell|remind|ping|update|alert)\s+(?:me|us|him|her|them|the\s+owner)\b|\blet\s+(?:me|us|the\s+owner)\s+know\b/i,
    why: 'the definition instructs the agent to say something TO A PERSON on a schedule',
  },
];

/**
 * What this task's DEFINITION declares it owes — or null.
 *
 * PURE: it reads the definition it is handed and touches no database. That is what lets the
 * unit test drive every rule and every negative control without a row existing.
 *
 * `hasSchedule` is a REQUIRED narrowing, not a convenience: this whole mechanism is about the
 * closing of scheduled RUNS. An ordinary one-shot task that happens to say "send me the file"
 * is settled by the ask/task lane, which has its own evidence discipline (`work/ask-settlement.
 * ts`, `work/tracker-store.ts:deliveryForTaskClose`), and adding a second opinion about it here
 * would be the two-deciders disease this arc exists to cure.
 */
export function declaredDeliverableShape(def: {
  kind?: string | null;
  title?: string | null;
  description?: string | null;
  goal?: string | null;
  hasSchedule: boolean;
}): DeliverableShape | null {
  // RULE 3: an explicit kind from the caller always wins, schedule or not.
  const explicit = (def.kind ?? '').trim().toLowerCase();
  if (explicit && DELIVERABLE_OWING_TASK_KINDS.includes(explicit)) {
    return { shape: explicit, matched: `kind="${explicit}"`, rule: 'declared-by-the-caller' };
  }
  if (!def.hasSchedule) return null;

  // The DEFINITION, and nothing else. Not the run's output, not a later turn's prose, not the
  // notes — the three fields that say what this task IS.
  const definition = [def.title, def.description, def.goal]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n');
  if (definition.length === 0) return null;

  for (const rule of DELIVERABLE_RULES) {
    const m = rule.re.exec(definition);
    if (m) return { shape: rule.shape, matched: m[0], rule: rule.rule };
  }
  return null;
}

/** The rule text for a shape, so the audit row can say WHY in the platform's own words. */
function whyOf(shape: DeliverableShape): string {
  if (shape.rule === 'declared-by-the-caller') return 'the caller declared this kind explicitly';
  return DELIVERABLE_RULES.find((r) => r.rule === shape.rule)?.why ?? shape.rule;
}

/**
 * Declare the deliverable this scheduled task owes, on the row, once.
 *
 * Called from the two create doors AFTER the schedule columns are written, because
 * `hasSchedule` is one of the inputs. Idempotent by construction: a task that already carries a
 * declared kind is left exactly as it is, so re-running it (an edit, a retry, a future
 * reconciliation pass) can never re-label a task the owner has since corrected.
 *
 * Returns the shape it declared, or null when the task owes nothing.
 */
export function declareDeliverableOnSchedule(taskId: string): DeliverableShape | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT title, description, goal, task_kind, schedule_status, repeat_interval, next_run_at
       FROM work WHERE id = ? AND kind = 'task'`,
  ).get(taskId) as {
    title: string | null; description: string | null; goal: string | null;
    task_kind: string | null; schedule_status: string | null;
    repeat_interval: number | null; next_run_at: number | null;
  } | undefined;
  if (!row) return null;

  // Already declared — by the caller, or by an earlier pass. Nothing here re-labels a row.
  const existing = (row.task_kind ?? '').trim().toLowerCase();
  if (existing && DELIVERABLE_OWING_TASK_KINDS.includes(existing)) {
    return { shape: existing, matched: `task_kind="${existing}"`, rule: 'already-declared' };
  }
  // A caller-supplied kind that is NOT on the list is a deliberate statement about what this
  // task is, and it is honoured: the derivation does not get to overrule it.
  if (existing) return null;

  const hasSchedule = row.schedule_status !== null || row.repeat_interval !== null
    || row.next_run_at !== null;
  const shape = declaredDeliverableShape({
    kind: null, title: row.title, description: row.description, goal: row.goal, hasSchedule,
  });
  if (!shape) return null;

  db.prepare('UPDATE work SET task_kind = ?, updated_at = ? WHERE id = ?')
    .run(shape.shape, Date.now(), taskId);
  appendWorkEvent(taskId, 'audit', 'deliverable-declaration', {
    marker: DECLARATION_MARKER,
    shape: shape.shape,
    matched: shape.matched,
    rule: shape.rule,
    reason: `this scheduled task owes the person a user-visible message: ${whyOf(shape)} `
      + `(matched "${shape.matched}"). Its runs cannot be recorded complete until one is sent. `
      + 'To change that, set the task\'s kind explicitly.',
  });
  logger.info('scheduled task declared deliverable-owing', {
    taskId, shape: shape.shape, rule: shape.rule, matched: shape.matched,
  });
  return shape;
}

/**
 * Does this task owe a person a user-visible message when its runs close?
 *
 * THE ONLY QUESTION THE CLOSER ASKS, and it reads ONE column. No prose, no heuristics, no
 * second opinion about what the run produced. If the answer here is wrong, it is wrong because
 * the DECLARATION is wrong, which is a row somebody can look at and change.
 */
export function taskOwesDeliverable(taskId: string): { owes: boolean; taskKind: string | null } {
  const r = getDb().prepare('SELECT task_kind FROM work WHERE id = ?')
    .get(taskId) as { task_kind: string | null } | undefined;
  const kind = r?.task_kind ?? null;
  return { owes: kind !== null && DELIVERABLE_OWING_TASK_KINDS.includes(kind), taskKind: kind };
}

/**
 * THE DUPLICATE-RECURRING LOOKUP — SWEEP CORE-1 CT2 Step 3.
 *
 * From the same 2026-08-07 transcript: after the timezone fix the owner recreated his two
 * briefs and never cancelled the old pair, so FOUR schedules were firing where two should.
 *
 * ⚠ IT MATCHES ON THE CADENCE AND NOT ON THE ANCHOR, and that is the load-bearing choice. He
 * recreated the briefs BECAUSE the anchor was wrong, so the twin he was trying to replace has a
 * DIFFERENT anchor by construction; matching on the anchor would have missed his case exactly.
 * `repeat_interval` + `repeat_unit` + `repeat_days_of_week` is what "the same standing
 * instruction" means.
 *
 * ⚠ AND IT HAS NO TIME WINDOW. The near-duplicate guard in `tracker/tools.ts` is scoped to five
 * minutes because it exists for a different disease — a tool-error loop minting copies inside
 * one session. His duplicate was created DAYS after its twin, deliberately. A live recurring
 * schedule is a standing instruction that fires for ever, so its twin is a duplicate whenever
 * it exists, not only when it is fresh.
 *
 * Only LIVE schedules count: a stopped or paused one fires nothing, and refusing against it
 * would block the legitimate re-creation the owner was actually attempting.
 *
 * Lives HERE rather than inline at the create door so it can be driven by a unit test without
 * the whole tool surface, and so the guard and the declaration share one definition of "the
 * same deliverable shape".
 */
export function findLiveRecurringTwin(p: {
  creatorId: string;
  shape: string;
  repeatInterval: number | null;
  repeatUnit: string | null;
  repeatDaysOfWeek: string | null;
  /** Excluded from the search — the row being created, when it already exists. */
  excludeTaskId?: string | null;
}): { id: string; title: string | null; nextRunAt: number | null } | null {
  if (!DELIVERABLE_OWING_TASK_KINDS.includes(p.shape)) return null;
  const r = getDb().prepare(
    `SELECT id, title, next_run_at FROM work
      WHERE kind = 'task' AND root_kind IN ('legacy','tracker','engine_scaffold')
        AND requester_id = ?
        AND task_kind = ?
        AND COALESCE(repeat_interval, -1) = COALESCE(?, -1)
        AND COALESCE(repeat_unit, '') = COALESCE(?, '')
        AND COALESCE(repeat_days_of_week, '') = COALESCE(?, '')
        AND schedule_status IN ('waiting', 'running')
        AND is_paused = 0
        AND state NOT IN ('done', 'failed', 'abandoned')
        AND id <> COALESCE(?, '')
      ORDER BY opened_at DESC LIMIT 1`,
  ).get(
    p.creatorId, p.shape, p.repeatInterval, p.repeatUnit, p.repeatDaysOfWeek,
    p.excludeTaskId ?? null,
  ) as { id: string; title: string | null; next_run_at: number | null } | undefined;
  return r ? { id: r.id, title: r.title, nextRunAt: r.next_run_at } : null;
}

/** The same question asked of an OCCURRENCE — its parent schedule is what carries the
 *  declaration. Returns `owes:false` for a row that is not an occurrence or has no parent. */
export function occurrenceOwesDeliverable(occurrenceId: string): {
  owes: boolean; taskKind: string | null; taskId: string | null;
} {
  const r = getDb().prepare(
    `SELECT w.parent_id AS task_id, p.task_kind AS task_kind
       FROM work w LEFT JOIN work p ON p.id = w.parent_id
      WHERE w.id = ? AND w.kind = 'occurrence'`,
  ).get(occurrenceId) as { task_id: string | null; task_kind: string | null } | undefined;
  if (!r) return { owes: false, taskKind: null, taskId: null };
  const kind = r.task_kind ?? null;
  return {
    owes: kind !== null && DELIVERABLE_OWING_TASK_KINDS.includes(kind),
    taskKind: kind,
    taskId: r.task_id,
  };
}
