// ════════════════════════════════════════════════════════════════════════════════════════
// t122 — A MEDIA JOB ROW NOBODY OWNS IS CLOSED AT BOOT, AND SAYS SO.
//
// ── THE REGRESSION THIS FILE IS THE ROOT FIX FOR ──
// `agent/live-work.ts` answers "is there anything a stop would cut for this agent" partly off
// the OPEN MEDIA JOB ROWS, because a row is the only standing fact during the window where a
// dial is pending but nothing is registered. That read is correct and stays. What it exposed is
// that the rows were never TRUE: a long-lived box carries non-terminal rows left by crashes and
// by versions that predate the read, and nothing closed them, because until the read existed
// nothing cared. One such row makes its agent offer a stop control for ever while the agent
// itself correctly reads `idle` — the owner saw it on agent after agent minutes after an
// upgrade, which is what a row-shaped lie looks like from the outside.
//
// The fix is at the data, not at the reader: a row that no living process can own is not open,
// it is ABANDONED, and the honest record of that is a terminal row carrying the reason.
//
// ── WHAT "NO OWNING PROCESS" MEANS, PER TABLE, AND WHY THE TWO DIFFER ──
// The discriminator is not a clock. It is adoption, and it is read from how each table is
// WRITTEN — the timestamp would only ever be a proxy for this, and a worse one (a row created
// one second before a crash is as abandoned as one from a month ago, and its `updated_at`
// cannot tell you so).
//
//   `generation_jobs` (image / audio / music) — RUN-ONCE, in-process. The worker lives inside
//   the server that started it; there is no remote job to resume and no second process that
//   could be holding one. So EVERY non-terminal row that exists before this boot's first job is
//   written is, by construction, owned by a process that is gone. Migration 063's own header
//   says it: *"a run-once job can't resume mid-flight"*.
//
//   `video_jobs` — ASYNC, and deliberately resumable. Migration 062's contract is that a row
//   outlives a restart precisely so the PROVIDER's render is not abandoned with it, and
//   `startVideoJobPoller` adopts every `queued`/`polling` row on the way up and drives it to a
//   terminal state. Those rows DO have an owner, so this sweep must not touch them — failing
//   them here would re-create t114's U4 defect (an asset the owner paid for, never fetched).
//   The one video row nothing can adopt is one with NO `provider_job_id`: no remote render was
//   ever acknowledged, so there is nothing to poll and no worker will ever be made for it.
//
// Running BEFORE either adopter is therefore load-bearing, not an ordering preference: it is
// what makes "non-terminal and unadopted" decidable without a timestamp.
//
// ── THE STATUS VOCABULARY IS READ FROM THE TERMINAL END (the census, both ways) ──
// Measured at this head, every writer of either table: `generation_jobs` ∈ {queued, running,
// succeeded, failed, cancelled} (`services/generation-jobs.ts` + the cancel door in
// `gateway/routes/config.ts`), `video_jobs` ∈ {queued, polling, succeeded, failed, cancelled}
// (`services/video-generation.ts`, `services/video-job-poller.ts`, same door). The two
// non-terminal sets differ (`running` vs `polling`); the TERMINAL set is identical.
//
// So the predicate is `status NOT IN (terminal)` rather than an IN-list of the non-terminal
// words, and that choice is the gap it closes: an IN-list is the shape that let these rows rot
// in the first place, and a status word added to either table tomorrow would be invisible to it
// — never swept, never resumed, counted as live for ever. Read from the terminal end, a new
// word defaults to "something is open", which is the direction that gets noticed.
//
// ── NEVER A DELETE ──
// The record stays. A row the owner can find, with `failed` and a reason that names what
// happened, is the difference between a bug fixed and evidence destroyed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { announceLiveWork } from '../agent/live-work.js';
import { ABANDONED_AT_BOOT, TERMINAL_JOB_STATUS_SQL as TERMINAL_SQL } from './media-job-status.js';

const logger = createLogger('job-orphans');

export { ABANDONED_AT_BOOT };

/**
 * The write, one statement per table and the table name a LITERAL in both.
 *
 * Interpolating the table into one shared statement reads tidier and is the wrong trade twice
 * over: a SQL identifier is the one thing a placeholder cannot carry, so the tidy form puts a
 * `${}` where a table name belongs — and the repository's single-writer census matches writes
 * by exactly that shape, because a dynamic table name is how a write to a table nobody audited
 * gets past an audit. Two literals cost two lines and are auditable by reading them.
 *
 * The predicate is repeated from the scan deliberately: it is a CAS, so a terminal write that
 * lands between the scan and this statement wins instead of being overwritten, and `changes`
 * is then the number of rows THIS pass actually moved.
 */
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
  /** `generation_jobs` only — the notice half reads it. `null` for a video row. */
  readonly kind: string | null;
}

/**
 * Close every media job row no living process can own, once.
 *
 * Every failure is swallowed PER ROW and per table: this runs on the boot path, and a
 * bookkeeping sweep must never be the reason a server does not come up. That is not a
 * defensive flourish — the sweep this replaces put its `setFailed` + chat delivery in a bare
 * `for` loop, so one row whose agent had since been purged threw out of the whole scan and
 * left every row behind it open for ever. One row could poison the sweep for all of them.
 *
 * Idempotent by its PREDICATE: after a pass no row matches, so a second pass moves nothing.
 *
 * @returns the rows it moved, so the caller can post the per-row notice (see
 *          `notifyAbandonedGenerationJobs`). Terminalising and telling the user are two jobs;
 *          the one that keeps the dashboard honest must not depend on the one that can throw.
 */
export function sweepAbandonedJobRows(): AbandonedJob[] {
  const found: AbandonedJob[] = [];

  // ── generation_jobs: nothing can adopt one across a boot. ──
  try {
    const rows = getDb().prepare(
      `SELECT id, agent_id, kind FROM generation_jobs WHERE status NOT IN (${TERMINAL_SQL})`,
    ).all() as Array<{ id: string; agent_id: string; kind: string | null }>;
    for (const r of rows) {
      found.push({ table: 'generation_jobs', id: r.id, agentId: r.agent_id, kind: r.kind });
    }
  } catch (err) {
    // A pre-migration body has no table at all, which is the ordinary case on a fresh install.
    logger.warn('abandoned-job scan skipped for generation_jobs', { error: msg(err) });
  }

  // ── video_jobs: only the rows the boot poller cannot adopt. ──
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
    // LOUD, and specific enough to be evidence: the count, the split, and the agents whose
    // stop control was being offered for nothing until this ran.
    const agents = [...new Set(moved.map((j) => j.agentId))];
    logger.warn('closed media job rows that no process could own — these were showing as live work', {
      total: moved.length,
      generationJobs: moved.filter((j) => j.table === 'generation_jobs').length,
      videoJobs: moved.filter((j) => j.table === 'video_jobs').length,
      agents: agents.length,
      reason: ABANDONED_AT_BOOT,
    });
    // The stop control is driven by a frame, not by a poll (`live-work.ts`'s `announceLiveWork`
    // is the composer's ONLY clearing edge), so a dashboard already open when this runs needs
    // to be told. Per agent, once, and never allowed to throw.
    for (const agentId of agents) {
      try { announceLiveWork(agentId); } catch { /* a frame must not break the sweep */ }
    }
  }

  return moved;
}

let alreadyReconciled = false;

/**
 * THE BOOT CALL. Exactly once per process, before either adopter starts.
 *
 * The once-ness is a guard, not an optimisation: called again after the video poller has
 * adopted rows and after new jobs have been written, the "no owning process" argument above is
 * no longer true, and the same sweep would close LIVE work. So a second call is refused out
 * loud rather than quietly obeyed.
 */
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
