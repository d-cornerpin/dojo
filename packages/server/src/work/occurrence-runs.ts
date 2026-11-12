// Reader-only projection of a schedule's run history from its occurrence rows, served at
// `/api/tasks/:taskId/runs`. `occurrences.ts` claims and settles ONE occurrence; this file reads
// across a schedule's runs. State changes go through `transition()` via `settleOccurrence`.

import { getDb } from '../db/connection.js';
import { OCCURRENCE_KIND, OCCURRENCE_EVENT } from './occurrences.js';
import { RUN_STATUS_INCOMPLETE, countOf } from './measure-close-gate.js';

export type RunStatus = 'running' | 'complete' | 'failed' | 'skipped' | 'incomplete';

export interface OccurrenceRun {
  id: string;
  taskId: string;
  runNumber: number;
  /** Second-resolution text the dashboard parses with `parseUtc`. NEVER an input to a
   *  comparison, see `occurrenceOf`. */
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  status: RunStatus;
  /** The words the owner reads for a run that ended with its measure still listing items. */
  statusLabel: string | null;
  assignedTo: string | null;
  agentName: string | null;
  resultSummary: string | null;
  error: string | null;
  createdAt: string | null;
}

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString() : null;

/** UTC `'%Y-%m-%d %H:%M:%S'`, the shape `tracker-view.ts:msToText` produces. */
const secondsText = (ms: number | null | undefined): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : null;

interface OccurrenceRunRow {
  id: string; parent_id: string; sequence: number; state: string;
  next_run_at: number | null; opened_at: number; closed_at: number | null;
  agent_id: string | null; notes: string | null; agent_name: string | null;
  run_status: string | null; items_left: number | null; unit: string | null;
}

/** `abandoned` means two things; the settle event says which. With no settle event it reads as
 *  `skipped`. */
function runStatusOf(state: string, runStatusEvent: string | null): RunStatus {
  if (state === 'open' || state === 'claimed') return 'running';
  if (state === 'done') return 'complete';
  if (state === 'failed') return 'failed';
  if (runStatusEvent === RUN_STATUS_INCOMPLETE) return 'incomplete';
  return runStatusEvent === 'complete' ? 'complete' : 'skipped';
}

const RUN_SELECT = `
  SELECT w.id, w.parent_id, w.sequence, w.state, w.next_run_at, w.opened_at, w.closed_at,
         w.agent_id, w.notes, a.name AS agent_name,
         (SELECT json_extract(e.payload, '$.run_status') FROM work_events e
           WHERE e.work_id = w.id AND e.kind = '${OCCURRENCE_EVENT.settled}'
           ORDER BY e.id DESC LIMIT 1) AS run_status,
         (SELECT json_extract(e.payload, '$.items_left') FROM work_events e
           WHERE e.work_id = w.id AND e.kind = '${OCCURRENCE_EVENT.settled}'
           ORDER BY e.id DESC LIMIT 1) AS items_left,
         (SELECT json_extract(e.payload, '$.unit') FROM work_events e
           WHERE e.work_id = w.id AND e.kind = '${OCCURRENCE_EVENT.settled}'
           ORDER BY e.id DESC LIMIT 1) AS unit
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
    statusLabel: status === 'incomplete'
      ? (r.items_left === null ? 'Incomplete' : `Incomplete — ${countOf(r.items_left, r.unit ?? 'items')} left`)
      : null,
    assignedTo: r.agent_id,
    agentName: r.agent_name,
    resultSummary: r.notes,
    // A skipped run's reason doubles as its error; the dashboard shows both when the row expands.
    error: status === 'skipped' ? r.notes : null,
    createdAt: iso(r.opened_at),
  };
}

/** The run history for one schedule, newest run first. */
export function listOccurrenceRuns(workId: string): OccurrenceRun[] {
  const rows = getDb().prepare(
    `${RUN_SELECT} AND w.parent_id = ? ORDER BY w.sequence DESC`,
  ).all(workId) as OccurrenceRunRow[];
  return rows.map(mapRun);
}

/** One run's status by its own id, or null when no such run (the serve boundary treats that as
 *  spent). A SCHEDULE id must not answer: it is not a run. */
export function occurrenceRunStatus(occurrenceId: string): RunStatus | null {
  // Deliberately NOT `RUN_SELECT`: a status read must not depend on the `agents` join that only
  // the history projection needs for a display name.
  const r = getDb().prepare(
    `SELECT w.state,
            (SELECT json_extract(e.payload, '$.run_status') FROM work_events e
              WHERE e.work_id = w.id AND e.kind = '${OCCURRENCE_EVENT.settled}'
              ORDER BY e.id DESC LIMIT 1) AS run_status
       FROM work w WHERE w.kind = '${OCCURRENCE_KIND}' AND w.id = ?`,
  ).get(occurrenceId) as { state: string; run_status: string | null } | undefined;
  return r ? runStatusOf(r.state, r.run_status) : null;
}

