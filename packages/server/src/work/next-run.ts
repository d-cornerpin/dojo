// THE ONE WRITER OF THE SCHEDULE'S FIRE TIME (`work.next_run_at`), kept out of `WorkPatch`'s generic union so a
// caller that names it fails to compile. Instants come from `calculateNextRun` (`scheduler/engine.ts`), except the
// dependency defer (`scheduler/runner.ts`), which re-fires the SAME occurrence.

import type Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { patchAssignments } from '../db/patch.js';
import { createLogger } from '../logger.js';
import { isTerminalName } from './terminal-states.js';
import { noSuchWorkDetail, type WorkPatchOutcome } from './outcome.js';
import type { WorkPatch } from './tracker-store.js';

const logger = createLogger('next-run');

export type ScheduleCompanions = WorkPatch;

export interface NextRunWrite {
  /** The instant the next occurrence is due, epoch-ms. `null` disarms the schedule. */
  readonly at: number | null;
  /** Columns of the same event, in the same UPDATE, so fire time and schedule status never disagree. */
  readonly alongside?: ScheduleCompanions;
  readonly reason: string;
  /** `false` keeps `updated_at`; only the dependency defer passes it (PM ladder reads it as last moved). */
  readonly touch?: boolean;
}

function refuseNoSuchWork(id: string): WorkPatchOutcome {
  return { kind: 'refused', workId: id, reason: 'no-such-work', detail: noSuchWorkDetail(id) };
}

export function setNextRun(workId: string, w: NextRunWrite): WorkPatchOutcome {
  // A settled row never keeps a live schedule: arming one records it as ended instead.
  const state = (getDb().prepare('SELECT state FROM work WHERE id = ?').get(workId) as { state: string } | undefined)?.state;
  const settledRow = w.alongside?.schedule_status === 'waiting' && isTerminalName(state);
  const write: NextRunWrite = settledRow ? { ...w, at: null, alongside: { ...w.alongside, schedule_status: 'completed', is_paused: 1 } } : w;
  const { sets, values } = patchAssignments({ ...(write.alongside ?? {}), next_run_at: write.at });
  if (write.touch !== false) {
    sets.push('updated_at = ?');
    values.push(Date.now());
  }
  values.push(workId);
  const changes = getDb()
    .prepare(`UPDATE work SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
  if (changes === 0) return refuseNoSuchWork(workId);
  logger.debug('next run written', { workId, at: write.at, reason: write.reason });
  return { kind: 'applied', value: changes };
}

/** Disarm a live schedule; true when THIS caller did it. The race token `terminateLiveScheduleOnFallen` reads. */
export function clearLiveSchedule(workId: string): boolean {
  const r = getDb().prepare(`
    UPDATE work
       SET schedule_status = 'completed', is_paused = 1, next_run_at = NULL, updated_at = ?
     WHERE id = ? AND schedule_status IN ('waiting', 'running')
  `).run(Date.now(), workId);
  return r.changes === 1;
}

/** The fire-time advance, one guarded statement that runs INSIDE the caller's transaction (`.changes` other than 1
 *  means the CAS was lost); it compares the RAW epoch-ms column, since display text drops milliseconds. */
export function advanceScheduleOnClaim(db: Database.Database, input: {
  workId: string; nowMs: number; nextRunMs: number | null; occurrenceMs: number | null;
}): number {
  return db.prepare(`
    UPDATE work
       SET schedule_status = 'running', last_run_at = ?, next_run_at = ?, updated_at = ?
     WHERE id = ? AND schedule_status = 'waiting' AND is_paused = 0
       AND next_run_at = ? AND next_run_at <= ?
  `).run(input.nowMs, input.nextRunMs, input.nowMs, input.workId,
         input.occurrenceMs, input.nowMs).changes;
}

