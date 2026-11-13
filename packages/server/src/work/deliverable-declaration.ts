// Which scheduled tasks owe a person a message: declared once at create, never re-judged at close (the closer reads
// `work.task_kind` only, never a run's prose). A caller's kind is its declaration; otherwise the decision model judges
// the definition; with no answer, base's word list below decides. A model declaration is named by the same list's
// brief or report, else a notify. Lives in work/ because it writes `work` and `work_events`.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { Question } from '../agent/decide.js';
import { judgment } from '../agent/decision-hooks.js';
import { appendWorkEvent } from './store.js';

const logger = createLogger('deliverable-declaration');

/** Kinds that owe a person a message; the kit mirrors them in `behavioral/lib/scheduled-run-truth.mjs`. */
export const DELIVERABLE_OWING_TASK_KINDS: readonly string[] = ['reminder', 'brief', 'report', 'notify'];

/** The audit marker: a free string in the `audit` payload, since a new `work_events.kind` needs a table rebuild. */
export const DECLARATION_MARKER = 'ct2_deliverable_declared';

/** `shape` is the task kind declared; `rule` says who declared it. */
export interface DeliverableShape { shape: string; rule: string }

/** Two readings of one definition, weighed together: is its job to tell a person, and does each run end by telling one? */
const OWES: Record<string, Question> = {
  sends: { type: 'noul', instructions: 'Is the job of `task` to tell, send, remind or report something to a person, so finishing it owes a person a message?',
    criteria: { true: 'Every morning, send me the weather', false: 'Writes a file, changes a system, or works for another agent' } },
  tells: { type: 'noul', instructions: 'Will this task, each time it runs, end by telling a person something (a reminder, a heads-up, an answer, a summary or a report), going by `task`?',
    criteria: { true: "Remind me to take the vitamins / Every evening send me tomorrow's forecast / Tell the kids it is bath time at 7 / Read the statement and tell me the total", false: 'Copy the documents folder to the backup drive / Turn the heating down at night / Save the shopping list to a file / Ask the helper agent to refresh its cache' } },
};

/** The rules, most specific noun first (order sets only the label); word-bounded so "debrief" is no brief. */
const DELIVERABLE_RULES: ReadonlyArray<{ shape: string; rule: string; re: RegExp; why: string }> = [
  {
    shape: 'brief', rule: 'names-a-brief',
    re: /\b(?:brief|briefing|briefings|briefs|digest|digests|rundown|rundowns|round-?up|round-?ups)\b/i,
    why: 'the definition names a BRIEF, an output that exists only to be read by a person',
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

/** What the definition declares it owes, or null. `hasSchedule` is required: one-shot tasks are settled by the
 *  ask/task lane (`work/ask-settlement.ts`). */
export async function declaredDeliverableShape(def: {
  kind?: string | null;
  title?: string | null;
  description?: string | null;
  goal?: string | null;
  hasSchedule: boolean;
  agentId?: string;
}): Promise<DeliverableShape | null> {
  const explicit = (def.kind ?? '').trim().toLowerCase();
  if (explicit && DELIVERABLE_OWING_TASK_KINDS.includes(explicit)) return { shape: explicit, rule: 'declared-by-the-caller' };
  if (!def.hasSchedule) return null;
  const task = [def.title, def.description, def.goal].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join('\n');
  if (task.length === 0) return null;
  const said = await judgment('deliverable_declaration/owes_a_message', {
    agentId: def.agentId, state: { task }, questions: OWES, combine: (p) => (p.sends + p.tells) / 2,
  });
  const listed = DELIVERABLE_RULES.find((r) => r.re.test(task));
  if (said?.owes_a_message === undefined) return listed ? { shape: listed.shape, rule: listed.rule } : null;
  return said.owes_a_message ? { shape: listed?.shape ?? 'notify', rule: 'judged-by-the-decision-model' } : null;
}

/** Declare the deliverable once; a declared task is left as is. Call after the schedule columns are written.
 *  `judged`: the caller already asked about this definition (the twin guard), so it is not asked again. */
export async function declareDeliverableOnSchedule(taskId: string, judged?: DeliverableShape | null): Promise<DeliverableShape | null> {
  const db = getDb();
  const row = db.prepare(
    `SELECT title, description, goal, task_kind, schedule_status, repeat_interval, next_run_at, agent_id
       FROM work WHERE id = ? AND kind = 'task'`,
  ).get(taskId) as {
    title: string | null; description: string | null; goal: string | null;
    task_kind: string | null; schedule_status: string | null;
    repeat_interval: number | null; next_run_at: number | null; agent_id: string | null;
  } | undefined;
  if (!row) return null;

  const existing = (row.task_kind ?? '').trim().toLowerCase();
  if (existing && DELIVERABLE_OWING_TASK_KINDS.includes(existing)) return { shape: existing, rule: 'already-declared' };
  // A caller-supplied kind that is not on the list is a deliberate statement and is honoured.
  if (existing) return null;

  const hasSchedule = row.schedule_status !== null || row.repeat_interval !== null
    || row.next_run_at !== null;
  const shape = judged !== undefined ? judged : await declaredDeliverableShape({
    title: row.title, description: row.description, goal: row.goal, hasSchedule, agentId: row.agent_id ?? undefined,
  });
  if (!shape) return null;

  db.prepare('UPDATE work SET task_kind = ?, updated_at = ? WHERE id = ?')
    .run(shape.shape, Date.now(), taskId);
  appendWorkEvent(taskId, 'audit', 'deliverable-declaration', {
    marker: DECLARATION_MARKER,
    shape: shape.shape,
    rule: shape.rule,
    reason: `this scheduled task owes the person a user-visible message: ${DELIVERABLE_RULES.find((r) => r.rule === shape.rule)?.why
      ?? 'the decision model judged that each run ends by telling a person something'}. `
      + 'Its runs cannot be recorded complete until one is sent. '
      + 'To change that, set the task\'s kind explicitly.',
  });
  logger.info('scheduled task declared deliverable-owing', { taskId, shape: shape.shape, rule: shape.rule });
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
