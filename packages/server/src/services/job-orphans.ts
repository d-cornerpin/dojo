// At boot, closes media job rows no living process can own as `failed` with a reason (never a delete): an
// open row makes `agent/live-work.ts` offer a stop control. Runs BEFORE both adopters. `generation_jobs` are
// run-once in-process, so any non-terminal one is orphaned; of `video_jobs` (`startVideoJobPoller` adopts)
// only rows with no `provider_job_id` are swept. `NOT IN (terminal)` makes a new status word read as open.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { announceLiveWork } from '../agent/live-work.js';
import { ABANDONED_AT_BOOT, TERMINAL_JOB_STATUS_SQL as TERMINAL_SQL } from './media-job-status.js';

const logger = createLogger('job-orphans');

export { ABANDONED_AT_BOOT };

// One statement per table, the table name a LITERAL: the single-writer census matches writes by that shape.
// The predicate repeats the scan's as a CAS, so a terminal write landing in between wins.
const CLOSE_SQL = {
  generation_jobs:
    `UPDATE generation_jobs SET status = 'failed', error = ?, finished_at = datetime('now'),`
    + ` updated_at = datetime('now') WHERE id = ? AND status NOT IN (${TERMINAL_SQL})`,
  video_jobs:
    `UPDATE video_jobs SET status = 'failed', error = ?, finished_at = datetime('now'),`
    + ` updated_at = datetime('now') WHERE id = ? AND status NOT IN (${TERMINAL_SQL})`,
} as const;

export interface AbandonedJob {
  readonly table: 'generation_jobs' | 'video_jobs';
  readonly id: string;
  readonly agentId: string;
  /** `generation_jobs` only (the notice half reads it); `null` for a video row. */
  readonly kind: string | null;
}

/** Closes ownerless media job rows, swallowing each failure (the boot path must not throw). Returns the rows
 *  moved so the caller posts the notice: terminalising must not depend on delivery, which can throw. */
export function sweepAbandonedJobRows(): AbandonedJob[] {
  const found: AbandonedJob[] = [];

  try {
    const rows = getDb().prepare(
      `SELECT id, agent_id, kind FROM generation_jobs WHERE status NOT IN (${TERMINAL_SQL})`,
    ).all() as Array<{ id: string; agent_id: string; kind: string | null }>;
    for (const r of rows) {
      found.push({ table: 'generation_jobs', id: r.id, agentId: r.agent_id, kind: r.kind });
    }
  } catch (err) {
    // A pre-migration body has no table at all (a fresh install).
    logger.warn('abandoned-job scan skipped for generation_jobs', { error: msg(err) });
  }

  try {
    const rows = getDb().prepare(
      `SELECT id, agent_id FROM video_jobs
        WHERE status NOT IN (${TERMINAL_SQL})
          AND (provider_job_id IS NULL OR trim(provider_job_id) = '')`,
    ).all() as Array<{ id: string; agent_id: string }>;
    for (const r of rows) {
      found.push({ table: 'video_jobs', id: r.id, agentId: r.agent_id, kind: null });
    }
  } catch (err) {
    logger.warn('abandoned-job scan skipped for video_jobs', { error: msg(err) });
  }

  if (found.length === 0) return [];

  const moved: AbandonedJob[] = [];
  for (const job of found) {
    try {
      const res = getDb().prepare(CLOSE_SQL[job.table]).run(ABANDONED_AT_BOOT, job.id);
      if (res.changes > 0) moved.push(job);
    } catch (err) {
      logger.warn('abandoned job row could not be closed', { table: job.table, jobId: job.id, error: msg(err) });
    }
  }

  if (moved.length > 0) {
    const agents = [...new Set(moved.map((j) => j.agentId))];
    logger.warn('closed media job rows that no process could own — these were showing as live work', {
      total: moved.length,
      generationJobs: moved.filter((j) => j.table === 'generation_jobs').length,
      videoJobs: moved.filter((j) => j.table === 'video_jobs').length,
      agents: agents.length,
      reason: ABANDONED_AT_BOOT,
    });
    // The stop control is driven by a frame (`announceLiveWork`, the composer's only clearing edge), so an open
    // dashboard must be told: per agent, once, never throwing.
    for (const agentId of agents) {
      try { announceLiveWork(agentId); } catch { /* a frame must not break the sweep */ }
    }
  }

  return moved;
}

let alreadyReconciled = false;

// The boot call: exactly once per process, before either adopter starts. A second call would close LIVE
// work (an adopter owns rows by then), so it is refused loudly.
export function reconcileOrphanedJobsAtBoot(): AbandonedJob[] {
  if (alreadyReconciled) {
    logger.warn('boot reconciliation asked for twice in one process — refused (live jobs exist by now)');
    return [];
  }
  alreadyReconciled = true;
  return sweepAbandonedJobRows();
}

/** Test seam only: a fresh process is the real reset. */
export function resetBootReconciliationForTests(): void {
  alreadyReconciled = false;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
