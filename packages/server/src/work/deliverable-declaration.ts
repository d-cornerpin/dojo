// Which scheduled tasks owe a person a message: declared once at create, never re-judged at close (the
// closer reads `work.task_kind` only, never a run's prose). It derives rather than asks: `POST /api/tracker/tasks`
// has no kind field, and `work_open`'s schema sits in the cached prompt prefix that `check-cache-prefix`
// byte-compares. A false negative closes a run having reached nobody, so the rules err toward telling.
// Lives in work/ because it writes `work` and `work_events` (never `work.state`).

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { appendWorkEvent } from './store.js';

const logger = createLogger('deliverable-declaration');

/** Kinds that owe a person a message; the kit mirrors them in `behavioral/lib/scheduled-run-truth.mjs`. */
export const DELIVERABLE_OWING_TASK_KINDS: readonly string[] = ['reminder', 'brief', 'report', 'notify'];

/** The audit marker: a free string in the `audit` payload, since a new `work_events.kind` needs a table rebuild. */
export const DECLARATION_MARKER = 'ct2_deliverable_declared';

export interface DeliverableShape {
  shape: string;
  /** The exact phrase from the definition that caused it, printed on the audit row. */
  matched: string;
  rule: string;
}

/** The rules, most specific noun first (order sets only the label); word-bounded so "debrief" is no brief. */
const DELIVERABLE_RULES: ReadonlyArray<{ shape: string; rule: string; re: RegExp; why: string }> = [
  {
    shape: 'brief', rule: 'names-a-brief',
    re: /\b(?:brief|briefing|briefings|briefs|digest|digests|rundown|rundowns|round-?up|round-?ups)\b/i,
    why: 'the definition names a BRIEF — an output that exists only to be read by a person',
  },
  {
    shape: 'report', rule: 'names-a-report-for-somebody',
    // A report addressed to somebody or on a cadence; bare "report" alone is not enough.
    re: /\b(?:a|the|my|our|your|daily|nightly|weekly|monthly|morning|evening|status|progress)\s+report\b|\breports?\s+(?:to|for)\s+(?:me|us|him|her|them|the\s+owner)\b/i,
    why: 'the definition names a REPORT addressed to a person or issued on a cadence for one',
  },
  {
    shape: 'notify', rule: 'tells-the-agent-to-tell-a-person',
    re: /\b(?:send|text|email|message|notify|tell|remind|ping|update|alert)\s+(?:me|us|him|her|them|the\s+owner)\b|\blet\s+(?:me|us|the\s+owner)\s+know\b/i,
    why: 'the definition instructs the agent to say something TO A PERSON on a schedule',
  },
];

/** What the definition declares it owes, or null; pure, no database. `hasSchedule` is required: one-shot
 *  tasks are settled by the ask/task lane (`work/ask-settlement.ts`). */
export function declaredDeliverableShape(def: {
  kind?: string | null;
  title?: string | null;
  description?: string | null;
  goal?: string | null;
  hasSchedule: boolean;
}): DeliverableShape | null {
  const explicit = (def.kind ?? '').trim().toLowerCase();
  if (explicit && DELIVERABLE_OWING_TASK_KINDS.includes(explicit)) {
    return { shape: explicit, matched: `kind="${explicit}"`, rule: 'declared-by-the-caller' };
  }
  if (!def.hasSchedule) return null;

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

function whyOf(shape: DeliverableShape): string {
  if (shape.rule === 'declared-by-the-caller') return 'the caller declared this kind explicitly';
  return DELIVERABLE_RULES.find((r) => r.rule === shape.rule)?.why ?? shape.rule;
}

/** Declare the deliverable once; a declared task is left as is. Call after the schedule columns are written. */
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

  const existing = (row.task_kind ?? '').trim().toLowerCase();
  if (existing && DELIVERABLE_OWING_TASK_KINDS.includes(existing)) {
    return { shape: existing, matched: `task_kind="${existing}"`, rule: 'already-declared' };
  }
  // A caller-supplied kind that is not on the list is a deliberate statement and is honoured.
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

/** Does this task owe a person a message when its runs close? The closer's only question. */
export function taskOwesDeliverable(taskId: string): { owes: boolean; taskKind: string | null } {
  const r = getDb().prepare('SELECT task_kind FROM work WHERE id = ?')
    .get(taskId) as { task_kind: string | null } | undefined;
  const kind = r?.task_kind ?? null;
  return { owes: kind !== null && DELIVERABLE_OWING_TASK_KINDS.includes(kind), taskKind: kind };
}

/** A live recurring twin for the duplicate guard: matched on cadence, not anchor (a recreated twin's anchor
 *  differs), with no time window. A stopped or paused schedule never counts. */
export function findLiveRecurringTwin(p: {
  creatorId: string;
  shape: string;
  repeatInterval: number | null;
  repeatUnit: string | null;
  repeatDaysOfWeek: string | null;
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

/** The same question for an occurrence: its parent schedule carries the declaration. */
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
