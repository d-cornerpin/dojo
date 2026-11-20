// Async video job worker: polls the provider for each `video_jobs` row, downloads the asset, records cost and
// hands the mp4 to `deliverMedia`. Open rows resume on boot; `inFlight` allows one loop
// per job, and WHERE-guarded status transitions honor a cancel landing mid-poll.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { settleAskOnJobEnded } from '../work/ask-settlement.js';
import { announceLiveWork } from '../agent/live-work.js';
import { pollProviderVideo, fetchVideoAsset, cancelProviderVideo } from './video-generation.js';
import { openAgentCall, type AgentCallSlot } from '../agent/abortable-call.js';
import { TERMINAL_JOB_STATUS_SQL } from './media-job-status.js';
import {
  pollerSignal, pollerStopped, rearmVideoJobPoller, detachPollLoop,
} from './video-poller-lifetime.js';

const logger = createLogger('video-job-poller');

/** Exported so a test can assert the backoff a stop must cut rather than wait out. */
export const POLL_START_MS = 5_000;
const POLL_MAX_MS = 30_000;
const POLL_BACKOFF = 1.5;
// Wall-clock window, not a ceiling: it bounds how long the loop keeps asking a provider that answers nothing
// usable. A provider answering `in_progress` outranks it, and `failed` ends the job early.
const MAX_JOB_AGE_MS = 30 * 60 * 1000;

interface VideoJobRow {
  id: string;
  agent_id: string;
  model_id: string;
  provider_id: string;
  provider_job_id: string | null;
  prompt: string;
  title: string | null;
  status: string;
  started_at: string;
  attempt_count: number;
  conversation_id?: string | null; source_message_id?: string | null; duration_seconds?: number | null;
}

const inFlight = new Set<string>();

function getJob(jobId: string): VideoJobRow | undefined {
  return getDb().prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRow | undefined;
}

/** How many video jobs are open. Exported because `tools/cat/media.ts` needs the same number; the terminal
 *  statuses are defined once in `media-job-status.ts`. */
export function countActiveVideoJobs(): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM video_jobs WHERE status NOT IN (${TERMINAL_JOB_STATUS_SQL})`
  ).get() as { n: number };
  return row.n;
}

function emitUpdate(row: { id: string; agent_id: string; status: string; prompt: string }): void {
  broadcast({
    type: 'video_job:update',
    data: {
      id: row.id,
      agentId: row.agent_id,
      status: row.status as 'queued' | 'polling' | 'succeeded' | 'failed' | 'cancelled',
      prompt: row.prompt,
      activeCount: countActiveVideoJobs(),
    },
  });
  // The per-agent answer: the frame above is per job with a box-wide count, so it cannot say whether
  // this agent still has work running.
  announceLiveWork(row.agent_id);
}

/**
 * The backoff sleep is interruptible so a stop can wake the loop. It resolves rather than rejects: what a
 * stop means is decided once, by the loop's own top-of-iteration check.
 */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const finish = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  if (typeof timer.unref === 'function') timer.unref();
  signal?.addEventListener('abort', finish, { once: true });
});

function deliverError(row: VideoJobRow, error: string): void {
  // No engine failure bubble in the agent's voice: the agent is told and woken so it tells the person.
  void import('../agent/wake-with-notice.js').then((w) => w.tellAgentAndWake({   // lazy: keeps the import graph light
    agentId: row.agent_id, from: 'Video generation', inFailureTurn: w.takeJobStartedInFailureTurn(row.id),
    brief: `the video you asked for could not be finished. The provider said: ${error}. Nothing was sent to the person. ` +
      'Tell them in your own words that it failed and offer a next step; do not start the same one again unless they ask.',
  })).catch(() => undefined);
  settleAskOnJobEnded(row.agent_id, row.id);
}

/**
 * The terminal state of a user stop, deliberately not `markFailed`: `failed` writes an `error` and posts a
 * failure into the chat, and a stopped video did not fail. The provider job is cancelled first (best effort)
 * so the stop also ends the provider-side render.
 */
async function markCancelled(jobId: string, reason: string): Promise<void> {
  const db = getDb();
  const row = getJob(jobId);
  if (row?.provider_job_id) {
    try { await cancelProviderVideo(row.provider_id, row.provider_job_id); } catch { /* best effort */ }
  }
  // Only a job not already finished is cancelled; a terminal row keeps its verdict.
  const res = db.prepare(`
    UPDATE video_jobs SET status='cancelled', finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
  `).run(jobId);
  if (res.changes === 0) return;
  const fresh = getJob(jobId);
  if (fresh) { emitUpdate(fresh); settleAskOnJobEnded(fresh.agent_id, jobId); }
  logger.info('video job cancelled', { jobId, reason });
}

function markFailed(jobId: string, error: string): void {
  const db = getDb();
  const res = db.prepare(`
    UPDATE video_jobs SET status='failed', error=?, finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
  `).run(error.slice(0, 1000), jobId);
  if (res.changes === 0) return;
  const row = getJob(jobId);
  if (row) {
    deliverError(row, error);
    emitUpdate(row);
  }
  logger.warn('video job failed', { jobId, error: error.slice(0, 200) });
}

async function handleSuccess(row: VideoJobRow, durationSeconds: number | null): Promise<void> {
  if (!row.provider_job_id) { markFailed(row.id, 'No provider job id on success.'); return; }
  const asset = await fetchVideoAsset(row.agent_id, row.provider_id, row.provider_job_id);
  if (!asset.ok) {
    if (asset.stopped) { await markCancelled(row.id, 'the user stopped this agent during the asset download'); return; }
    markFailed(row.id, `Asset download failed: ${asset.error}`);
    return;
  }

  // The provider's length, else the length asked for at submit: a paid video is never recorded at $0 for want of one.
  const reported = typeof durationSeconds === 'number' && durationSeconds > 0 ? durationSeconds : null;
  const asked = typeof row.duration_seconds === 'number' && row.duration_seconds > 0 ? row.duration_seconds : null;
  const units = reported ?? asked ?? 0;
  let costUsd: number | null = null;
  try {
    const { recordCost } = await import('../costs/tracker.js');
    recordCost({
      agentId: row.agent_id,
      modelId: row.model_id,
      providerId: row.provider_id,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      requestType: 'video_generation',
      units,
    });
    if (units > 0) {
      const priceRow = getDb().prepare(
        'SELECT pricing_unit, cost_per_unit FROM models WHERE id = ?'
      ).get(row.model_id) as { pricing_unit: string | null; cost_per_unit: number | null } | undefined;
      if (priceRow && priceRow.pricing_unit === 'second' && typeof priceRow.cost_per_unit === 'number') {
        costUsd = units * priceRow.cost_per_unit;
      }
    }
  } catch (err) {
    logger.warn('video cost record failed (non-fatal)', { jobId: row.id, error: err instanceof Error ? err.message : String(err) });
  }

  const db = getDb();
  const res = db.prepare(`
    UPDATE video_jobs
    SET status='succeeded', asset_path=?, duration_seconds=?, cost_usd=?, finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
  `).run(asset.filePath, units > 0 ? units : null, costUsd, row.id);
  if (res.changes === 0) {
    // A cancel raced us: the asset is downloaded but the user asked to stop, so do not deliver.
    logger.info('video job: success raced a cancel, not delivering', { jobId: row.id });
    return;
  }

  const { deliverMedia } = await import('./media-delivery.js');   // lazy: keeps the poller's import graph light
  await deliverMedia({ kind: 'video', agentId: row.agent_id, jobId: row.id, title: row.title, filePath: asset.filePath, mimeType: 'video/mp4',
    sizeBytes: asset.sizeBytes, conversationId: row.conversation_id ?? null, requestMessageId: row.source_message_id ?? null });
  const fresh = getJob(row.id);
  if (fresh) emitUpdate(fresh);
  logger.info('video job succeeded + delivered', { jobId: row.id, durationSeconds, costUsd });
}

/**
 * The loop holds one abortable slot for its whole life, not just its legs: it sleeps for most of up to
 * thirty minutes and outlives the run's stop fence, so `abortInFlight` reaches it like any other call. The
 * slot's signal wakes the sleep and the top-of-iteration check turns that into the terminal state.
 */
async function pollLoop(jobId: string): Promise<void> {
  if (inFlight.has(jobId)) return;
  // The shutdown fence sits above the first DB read: a late enqueue must not reach `getJob` on a closed handle.
  if (pollerStopped()) return;
  inFlight.add(jobId);
  const owner = getJob(jobId);
  // 'background' scope: the loop is enqueued inside a turn that ends seconds later. The pollerSignal is
  // composed in so a shutdown cuts the leg and wakes the sleep; the exit is still the loop's own
  // `pollerStopped()` check (see video-poller-lifetime.ts).
  const slot: AgentCallSlot | null = owner ? openAgentCall(owner.agent_id, 'background', pollerSignal()) : null;
  let delay = POLL_START_MS;
  try {
    // A stop already standing at enqueue: do not start polling, and do not leave the row `queued` for the boot resume.
    if (slot?.refused) {
      await markCancelled(jobId, 'the user stopped this agent before polling began');
      return;
    }
    while (true) {
      // Stand-down first: above `getJob` (the handle may be closed) and above the stop check (a process
      // going down is not the owner pressing stop).
      if (pollerStopped()) {
        logger.info('video poll loop standing down; the row stays open for the boot resume', { jobId });
        return;
      }
      const row = getJob(jobId);
      if (!row) return;
      if (row.status === 'cancelled' || row.status === 'succeeded' || row.status === 'failed') return;
      if (!row.provider_job_id) { markFailed(jobId, 'No provider job id.'); return; }

      // The stop check sits above the wall-clock guard so a stop is never recorded as the timeout. Its
      // `return` must stay unconditional: once the slot is aborted the sleep resolves instantly, so this
      // is the only thing preventing a hot spin, whether or not `markCancelled` moved a row. The exit
      // asks `cutBy()` (any abort); the owner's name goes on it only when `cutByStop()`.
      const cutBy = slot?.cutBy();
      if (cutBy) {
        await markCancelled(jobId, slot!.cutByStop()
          ? 'the user stopped this agent'
          : `the engine aborted this agent's in-flight calls (${cutBy})`);
        return;
      }

      // The age is only computed here; the wall-clock decision is made after the poll, where the
      // provider has given no evidence of life. A timer may only end work it can prove is dead.
      const age = Date.now() - new Date(row.started_at + 'Z').getTime();
      const pastWall = Number.isFinite(age) && age > MAX_JOB_AGE_MS;

      const poll = await pollProviderVideo(row.agent_id, row.provider_id, row.provider_job_id);

      // A shutdown during the poll await cuts the leg with a plain retryable error (not `stopped`), so
      // stand down before the `attempt_count` UPDATE hits a closed handle.
      if (pollerStopped()) {
        logger.info('video poll loop standing down mid-leg; the row stays open', { jobId });
        return;
      }

      getDb().prepare('UPDATE video_jobs SET attempt_count = attempt_count + 1, updated_at = datetime(\'now\') WHERE id = ?').run(jobId);

      if (!poll.ok) {
        // A stopped leg is not a failed leg: no `failed` row and no failure posted into the chat.
        if (poll.stopped) { await markCancelled(jobId, 'the user stopped this agent mid-poll'); return; }
        if (!poll.retryable) { markFailed(jobId, poll.error); return; }
        // Transient error: the only branch where the wall may end the job, since the provider has told us
        // nothing. The failure names the absence of evidence and the last error.
        if (pastWall) {
          markFailed(jobId, `Timed out — the provider gave no usable answer for ${Math.round(MAX_JOB_AGE_MS / 60_000)} minutes; last poll error: ${poll.error}`);
          return;
        }
      } else if (poll.status === 'completed') {
        await handleSuccess(row, poll.durationSeconds);
        return;
      } else if (poll.status === 'failed') {
        markFailed(jobId, poll.error ?? 'Provider reported the job failed.');
        return;
      } else {
        // The provider says `queued`/`in_progress`: positive proof of life, which outranks the wall, so
        // polling continues and the overrun is logged with the provider's own progress. The owner's stop
        // and a provider gone quiet (the `pastWall` branch above) still end the loop.
        if (pastWall) {
          logger.warn('video job is past the 30-minute wall but the PROVIDER still reports it running — not failing it', {
            jobId,
            ageMinutes: Math.round(age / 60_000),
            providerStatus: poll.status,
            providerProgress: poll.progress,
          });
        }
        if (row.status === 'queued') {
          const res = getDb().prepare(
            "UPDATE video_jobs SET status='polling', updated_at=datetime('now') WHERE id = ? AND status='queued'"
          ).run(jobId);
          if (res.changes > 0) {
            const fresh = getJob(jobId);
            if (fresh) emitUpdate(fresh);
          }
        }
      }

      await sleep(delay, slot?.signal);
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
    }
  } catch (err) {
    // Backstop: a stand-down returns before here, so reaching it on shutdown means a guard was missed.
    if (pollerStopped()) {
      logger.warn('video poll loop unwound through its ERROR PATH on shutdown — a stand-down guard was missed; the row stays open', {
        jobId, error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // An abort unwinding through here is not an internal poller error.
    if (slot?.cutBy()) {
      await markCancelled(jobId, slot.cutByStop()
        ? 'the user stopped this agent'
        : `the engine aborted this agent's in-flight calls (${slot.cutBy()})`);
      return;
    }
    logger.error('video poll loop threw', { jobId, error: err instanceof Error ? err.message : String(err) });
    markFailed(jobId, `Internal poller error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    slot?.release();
    inFlight.delete(jobId);
  }
}

/** Start polling a single job immediately (called right after submit); the promise ends with the loop. */
export function enqueueVideoJob(jobId: string): Promise<void> {
  const loop = pollLoop(jobId);
  detachPollLoop(jobId, loop);
  return loop;
}

/** Boot-time resume: pick up every job still in flight and poll it. */
export function startVideoJobPoller(): void {
  rearmVideoJobPoller();   // a boot is the one thing that lifts the stand-down fence
  let rows: Array<{ id: string }>;
  try {
    // Resume adopts every open row, so a paid-for render is never abandoned by a status-vocabulary gap.
    rows = getDb().prepare(
      `SELECT id FROM video_jobs WHERE status NOT IN (${TERMINAL_JOB_STATUS_SQL})`,
    ).all() as Array<{ id: string }>;
  } catch (err) {
    // video_jobs may not exist yet on a DB that predates its migration.
    logger.warn('video poller boot scan skipped', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (rows.length === 0) return;
  logger.info('video poller: resuming in-flight jobs', { count: rows.length });
  for (const r of rows) detachPollLoop(r.id, pollLoop(r.id));
}
