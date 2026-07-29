// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-2 T10F — WHAT `task_runs` HELD, PROJECTED OFF THE ROWS THAT REPLACED IT.
//
// verdict: STRIP. requirement preserved: the owner's run history for a scheduled task — run
// number, the instant it was for, when it started and finished, its status, who ran it and
// what it said. Every field is a clause in `__tests__/occurrence-runs.test.ts`.
//
// The table was not dead, and the drop needed this file before it was safe:
// `/api/tasks/:taskId/runs` is mounted at `gateway/server.ts:280` and
// `dashboard/src/components/TaskRunHistory.tsx` renders it from `pages/Tracker.tsx:278`. Two
// rows on the dev box is a fact about the dev box and NOT evidence (#15 — `task_runs` is that
// rule's own worked example: "0 rows -> the feature is dead" is listed there as a false
// verdict this project already made once).
//
// WHY ITS OWN MODULE, since `occurrences.ts` is the writer that owns these rows. Because it
// answers a DIFFERENT QUESTION, and this task family already made that call once: T10's
// `_migrations` checksum audit went into `db/migration-checksums.ts` rather than into
// `migrations.ts`, on the reasoning that "the chain runner applies files, the audit answers a
// different question about them". Here: `occurrences.ts` claims and settles ONE occurrence;
// this file reads WHAT HAPPENED across a schedule's runs. The growth detector refused the
// merged file and it was right.
//
// READER-ONLY. Nothing here writes; every state change still goes through `transition()` via
// `settleOccurrence` (single-writer clause (b)).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { OCCURRENCE_KIND, OCCURRENCE_EVENT } from './occurrences.js';

/** The status vocabulary the run history renders, unchanged from `task_runs.status`. The
 *  dashboard's own `statusColors` map is the enumeration: complete / running / skipped, with
 *  `failed` falling through to the neutral badge exactly as it does today. */
export type RunStatus = 'running' | 'complete' | 'failed' | 'skipped';

export interface OccurrenceRun {
  id: string;
  taskId: string;
  runNumber: number;
  /** Second-resolution text, the shape `task_runs.scheduled_for` carried and the dashboard
   *  parses with `parseUtc`. NEVER an input to a comparison — see `occurrenceOf`. */
  scheduledFor: string | null;
  /** ISO, the shape the old `started_at` / `completed_at` carried. */
  startedAt: string | null;
  completedAt: string | null;
  status: RunStatus;
  assignedTo: string | null;
  agentName: string | null;
  resultSummary: string | null;
  error: string | null;
  createdAt: string | null;
}

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString() : null;

/** `'%Y-%m-%d %H:%M:%S'` in UTC — `tracker-view.ts:msToText`'s shape, computed in JS because
 *  this projection already has the row in hand. */
const secondsText = (ms: number | null | undefined): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : null;

interface OccurrenceRunRow {
  id: string; parent_id: string; sequence: number; state: string;
  next_run_at: number | null; opened_at: number; closed_at: number | null;
  agent_id: string | null; notes: string | null; agent_name: string | null;
  run_status: string | null;
}

/** `abandoned` means two things; the settle event says which. A row with no settle event —
 *  one closed by a path older than this projection — reads as `skipped`, which is what
 *  `task_runs` said for every run closed without an outcome of its own. */
function runStatusOf(state: string, runStatusEvent: string | null): RunStatus {
  if (state === 'open' || state === 'claimed') return 'running';
  if (state === 'done') return 'complete';
  if (state === 'failed') return 'failed';
  return runStatusEvent === 'complete' ? 'complete' : 'skipped';
}

const RUN_SELECT = `
  SELECT w.id, w.parent_id, w.sequence, w.state, w.next_run_at, w.opened_at, w.closed_at,
         w.agent_id, w.notes, a.name AS agent_name,
         (SELECT json_extract(e.payload, '$.run_status') FROM work_events e
           WHERE e.work_id = w.id AND e.kind = '${OCCURRENCE_EVENT.settled}'
           ORDER BY e.id DESC LIMIT 1) AS run_status
    FROM work w
    LEFT JOIN agents a ON a.id = w.agent_id
   WHERE w.kind = '${OCCURRENCE_KIND}'`;

function mapRun(r: OccurrenceRunRow): OccurrenceRun {
  const status = runStatusOf(r.state, r.run_status);
  return {
    id: r.id,
    taskId: r.parent_id,
    runNumber: r.sequence,
    scheduledFor: secondsText(r.next_run_at),
    startedAt: iso(r.opened_at),
    completedAt: iso(r.closed_at),
    status,
    assignedTo: r.agent_id,
    agentName: r.agent_name,
    resultSummary: r.notes,
    // `task_runs.error` was only ever written by the no-agent skip, and its text was the same
    // sentence the summary now carries. One field, one fact: the dashboard reads `error` only
    // to decide whether to expand a row, and `resultSummary` already answers that.
    error: status === 'skipped' ? r.notes : null,
    createdAt: iso(r.opened_at),
  };
}

/** The run history for one schedule, newest run first — `routes/task-runs.ts`'s whole body. */
export function listOccurrenceRuns(workId: string): OccurrenceRun[] {
  const rows = getDb().prepare(
    `${RUN_SELECT} AND w.parent_id = ? ORDER BY w.sequence DESC`,
  ).all(workId) as OccurrenceRunRow[];
  return rows.map(mapRun);
}

/** One run's status by its own id. The serve boundary asks this of a trigger's `run_id` to
 *  decide whether the trigger is spent; `null` means "no such run", which it already treated
 *  as spent. A SCHEDULE id must not answer — it is not a run. */
export function occurrenceRunStatus(occurrenceId: string): RunStatus | null {
  // Deliberately NOT `RUN_SELECT`: a status read must not depend on the `agents` join the
  // history projection needs for a display name. One question, the narrowest query that
  // answers it.
  const r = getDb().prepare(
    `SELECT w.state,
            (SELECT json_extract(e.payload, '$.run_status') FROM work_events e
              WHERE e.work_id = w.id AND e.kind = '${OCCURRENCE_EVENT.settled}'
              ORDER BY e.id DESC LIMIT 1) AS run_status
       FROM work w WHERE w.kind = '${OCCURRENCE_KIND}' AND w.id = ?`,
  ).get(occurrenceId) as { state: string; run_status: string | null } | undefined;
  return r ? runStatusOf(r.state, r.run_status) : null;
}

