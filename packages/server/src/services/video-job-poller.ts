// ════════════════════════════════════════
// services/video-job-poller.ts — async video job worker.
//
// Video generation is the one capability that doesn't finish inside a
// single tool call. submitVideoJob() writes a `video_jobs` row and returns
// immediately; this module owns the rest: poll the provider until the
// asset is ready, download it, record cost, and deliver the mp4 into the
// requesting agent's chat as a synthetic assistant message (same pattern
// image_create uses, just fired from here instead of the dispatcher).
//
// Boot behavior (mirrors the pricing-sync workers in index.ts step 4k/4l):
// on startup we pick up every row still in 'queued' or 'polling' and
// resume polling it, so a job survives a server restart or crash. New jobs
// call enqueueVideoJob() right after submit so polling starts without
// waiting for the next boot.
//
// Concurrency safety: `inFlight` (a Set of dojo job ids) guarantees at most
// one poll loop per job within a process. Across processes there is only
// ever one server, so a DB-level CAS isn't strictly required, but we still
// guard status transitions with WHERE clauses so a cancel landing mid-poll
// is honored on the next tick.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { deliveredResult, insertMessageIfAbsent } from '../memory/message-store.js';
import { broadcast } from '../gateway/ws.js';
import { settleAskOnAsyncResult } from '../work/ask-settlement.js';
import { announceLiveWork } from '../agent/live-work.js';
import { pollProviderVideo, fetchVideoAsset, cancelProviderVideo } from './video-generation.js';
import { openAgentCall, type AgentCallSlot } from '../agent/abortable-call.js';
import { homeDir } from '../home.js';
import { TERMINAL_JOB_STATUS_SQL } from './media-job-status.js';
import {
  pollerSignal, pollerStopped, rearmVideoJobPoller, detachPollLoop,
} from './video-poller-lifetime.js';

const logger = createLogger('video-job-poller');

/** Exported for t126's clause: the backoff a stop must CUT rather than wait out. */
export const POLL_START_MS = 5_000;
const POLL_MAX_MS = 30_000;
const POLL_BACKOFF = 1.5;
// Wall-clock window, NOT a ceiling (t114/U4). It bounds how long the loop will keep asking a
// provider that answers NOTHING usable; it does not bound a provider that answers
// `in_progress`. A provider's own status outranks this number in both directions: it ends the
// job early when the provider says `failed`, and it keeps the job alive past the window when
// the provider says the render is still running. See the guard inside the poll loop.
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
  conversation_id?: string | null; source_message_id?: string | null;  // P6a lineage (mig 116)
}

const inFlight = new Set<string>();

function getJob(jobId: string): VideoJobRow | undefined {
  return getDb().prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRow | undefined;
}

/** How many video jobs are open. t122: asked from the TERMINAL end — `media-job-status.ts`
 *  holds the census. Exported because `tools/cat/media.ts` needs the same number and a second
 *  copy of the predicate is how the vocabulary drifted in the first place. */
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
  // A-5b — as in `generation-jobs.ts`: this frame is per-job with a box-wide count, and the
  // composer's question is per-agent. A render outlives its turn by up to thirty minutes.
  announceLiveWork(row.agent_id);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

/**
 * A-5 — THE BACKOFF SLEEP IS INTERRUPTIBLE, because a poller that cannot be woken is a poller a
 * stop cannot stop. The loop spends nearly all of its life in here (up to `POLL_MAX_MS` between
 * legs), so cutting only the HTTP legs would leave a stopped job sitting in a `setTimeout` for
 * another half-minute before it noticed. RESOLVES rather than rejects: the decision about what
 * a stop means belongs to the loop's own top-of-iteration check, in one place, not to an
 * exception thrown from a timer.
 *
 * The clock itself is untouched — same `POLL_START_MS` / `POLL_BACKOFF` / `POLL_MAX_MS`, same
 * `MAX_JOB_AGE_MS` wall — this only adds a second way for the wait to END.
 */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const finish = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  // t126: the loop spends nearly all its life here, and an instrument must never be why a
  // process refuses to exit (as `stall-sentinel.ts` / `router/maintenance.ts` unref theirs).
  if (typeof timer.unref === 'function') timer.unref();
  signal?.addEventListener('abort', finish, { once: true });
});

/**
 * Deliver the finished video into the agent's chat as a synthetic
 * assistant message (no LLM turn), mirroring image_create's delivery.
 */
function deliverVideo(row: VideoJobRow, assetPath: string, sizeBytes: number): void {
  // Copy into the caller's uploads dir with a friendly, title-derived
  // filename so downloads are named sensibly.
  const recipientDir = path.join(homeDir(), '.dojo', 'uploads', row.agent_id);
  if (!fs.existsSync(recipientDir)) fs.mkdirSync(recipientDir, { recursive: true });
  const titleSlug = row.title ? slugify(row.title) : '';
  const shortId = row.id.replace(/^vid_/, '').slice(0, 8);
  const stableFilename = titleSlug ? `${titleSlug}-${shortId}.mp4` : `video_${shortId}.mp4`;
  const stablePath = path.join(recipientDir, stableFilename);
  let deliveredPath = assetPath;
  try {
    fs.copyFileSync(assetPath, stablePath);
    deliveredPath = stablePath;
  } catch (err) {
    logger.warn('video delivery: copy to caller uploads dir failed — using shared path', {
      jobId: row.id, error: err instanceof Error ? err.message : String(err),
    });
  }

  const attachment = {
    fileId: uuidv4(),
    filename: path.basename(deliveredPath),
    mimeType: 'video/mp4',
    size: sizeBytes,
    path: deliveredPath,
    category: 'video' as const,
  };

  const DELIVERY_CAPTIONS = ['Here you go.', 'Here it is.', 'All done.', 'Done.', 'Got it for you.'];
  const caption = DELIVERY_CAPTIONS[Math.floor(Math.random() * DELIVERY_CAPTIONS.length)];

  const msgId = uuidv4();
  insertMessageIfAbsent({
    id: msgId, agentId: row.agent_id, role: 'assistant', content: caption,
    attachments: JSON.stringify([attachment]),
    ...deliveredResult(row.conversation_id, row.source_message_id) });  // t141: labelled with its request
  broadcast({
    type: 'chat:message', agentId: row.agent_id,
    message: {
      id: msgId, agentId: row.agent_id, role: 'assistant' as const,
      content: caption, attachments: [attachment],
      tokenCount: null, modelId: null, cost: null, latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  broadcast({ type: 'chat:chunk', agentId: row.agent_id, messageId: msgId, content: '', done: true, modelId: null });
  settleAskOnAsyncResult({ agentId: row.agent_id, askMessageId: row.source_message_id, resultMessageId: msgId });   // t152: the work the ask waited on reached the owner
}

function deliverError(row: VideoJobRow, error: string): void {
  const msgId = uuidv4();
  const content =
    `I wasn't able to finish that video:\n\n> ${error}\n\n` +
    `You could try a shorter clip or a simpler description.`;
  insertMessageIfAbsent({ id: msgId, agentId: row.agent_id, role: 'assistant', content, ...deliveredResult(row.conversation_id, row.source_message_id) });
  broadcast({
    type: 'chat:message', agentId: row.agent_id,
    message: {
      id: msgId, agentId: row.agent_id, role: 'assistant' as const, content,
      tokenCount: null, modelId: null, cost: null, latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  broadcast({ type: 'chat:chunk', agentId: row.agent_id, messageId: msgId, content: '', done: true, modelId: null });
  settleAskOnAsyncResult({ agentId: row.agent_id, askMessageId: row.source_message_id, resultMessageId: msgId });   // t152: the work the ask waited on reached the owner
}

/**
 * A-5 — the terminal state a USER STOP produces, and it is deliberately not `markFailed`.
 *
 * Same distinction `generation-jobs.ts`'s `setCancelled` carries: `failed` writes an `error`
 * column AND posts *"I wasn't able to finish that video"* into the owner's chat. A video the
 * owner stopped did not fail and nothing should tell him it did. The provider-side job is
 * cancelled first, best-effort, so a stop also stops the minutes of GPU time he is paying for —
 * exactly what the manual cancel route does, reached through a different door.
 */
async function markCancelled(jobId: string, reason: string): Promise<void> {
  const db = getDb();
  const row = getJob(jobId);
  if (row?.provider_job_id) {
    try { await cancelProviderVideo(row.provider_id, row.provider_job_id); } catch { /* best effort */ }
  }
  // t122: the fence is "not already finished" — a terminal row still keeps its verdict.
  const res = db.prepare(`
    UPDATE video_jobs SET status='cancelled', finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
  `).run(jobId);
  if (res.changes === 0) return;
  const fresh = getJob(jobId);
  if (fresh) emitUpdate(fresh);
  logger.info('video job cancelled', { jobId, reason });
}

function markFailed(jobId: string, error: string): void {
  const db = getDb();
  // Only fail a job that's still active — don't clobber a cancel. (t122: from the terminal end.)
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
    // A-5: a stop that landed mid-download is not a download failure.
    if (asset.stopped) { await markCancelled(row.id, 'the user stopped this agent during the asset download'); return; }
    markFailed(row.id, `Asset download failed: ${asset.error}`);
    return;
  }

  // Record cost. Video is second-priced; if we couldn't determine the
  // duration, units=0 falls through to a $0 record (better than guessing).
  // recordCost owns the ledger; we additionally compute the dollar figure
  // here purely to store on the video_jobs row for the dashboard (the
  // tracker doesn't return it).
  const units = typeof durationSeconds === 'number' && durationSeconds > 0 ? durationSeconds : 0;
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
  `).run(asset.filePath, durationSeconds, costUsd, row.id);
  if (res.changes === 0) {
    // A cancel raced us — the asset is downloaded but the user asked to
    // stop. Don't deliver; leave the cancelled row as-is.
    logger.info('video job: success raced a cancel, not delivering', { jobId: row.id });
    return;
  }

  deliverVideo(row, asset.filePath, asset.sizeBytes);
  const fresh = getJob(row.id);
  if (fresh) emitUpdate(fresh);
  logger.info('video job succeeded + delivered', { jobId: row.id, durationSeconds, costUsd });
}

/**
 * A-5 — THE LOOP ITSELF IS REGISTERED, for the whole of its life, not just its legs.
 *
 * The three HTTP legs each register their own call (`video-generation.ts`), so a stop landing
 * while one is on the wire cuts it. That is not enough on its own: this loop runs for up to
 * thirty minutes and is asleep for nearly all of them, and a stop that arrives during a
 * backoff sleep has nothing to abort. It also outlives the run completely — the fence is long
 * gone by minute six — so `isStopFenced` cannot answer for it either.
 *
 * So the loop takes a slot of its own and holds it. From the stop's point of view a poll loop
 * IS one dial that happens to last minutes, and `abortInFlight` reaches it the same way it
 * reaches a model call: one registry, one abort, no second mechanism. The slot's signal wakes
 * the sleep, and the top-of-iteration check turns that into the one honest terminal state.
 */
async function pollLoop(jobId: string): Promise<void> {
  if (inFlight.has(jobId)) return;
  // t126: the fence, ABOVE the first DB read — a late `enqueueVideoJob` from an unwinding turn
  // would otherwise reach `getJob`'s `getDb()` on a closed handle.
  if (pollerStopped()) return;
  inFlight.add(jobId);
  const owner = getJob(jobId);
  // A-5 FIX ROUND (review CRITICAL C1): `background`. This loop is the clearest case the scope
  // exists for — up to THIRTY MINUTES, enqueued inside a turn that ends seconds later. Before
  // the scope, a voice barge-in or a thrown turn reached it and it wrote `cancelled` with the
  // owner's name on it.
  // t126: composed in, so a shutdown cuts the in-flight leg and wakes the sleep. The EXIT is
  // still the loop's own `pollerStopped()` check — see `video-poller-lifetime.ts` on why
  // `cutBy()` cannot answer that question.
  const slot: AgentCallSlot | null = owner ? openAgentCall(owner.agent_id, 'background', pollerSignal()) : null;
  let delay = POLL_START_MS;
  try {
    // A stop already standing when this job was enqueued: do not start polling at all, and do
    // not leave the row `queued` for the boot resume to pick up as if nothing had happened.
    if (slot?.refused) {
      await markCancelled(jobId, 'the user stopped this agent before polling began');
      return;
    }
    while (true) {
      // t126 — THE STAND-DOWN, FIRST. Above `getJob` because that is a `getDb()` call on a
      // handle that may be closed, and above the stop check because a process going down is not
      // the owner pressing stop and must never reach his chat as one.
      if (pollerStopped()) {
        logger.info('video poll loop standing down; the row stays open for the boot resume', { jobId });
        return;
      }
      const row = getJob(jobId);
      if (!row) return;
      if (row.status === 'cancelled' || row.status === 'succeeded' || row.status === 'failed') return;
      if (!row.provider_job_id) { markFailed(jobId, 'No provider job id.'); return; }

      // A-5: the stop, read where the loop can act on it. FIRST, above the wall-clock guard,
      // so a stop is never recorded as the 30-minute timeout.
      //
      // ITS `return` IS UNCONDITIONAL, and that is load-bearing rather than tidy: once the slot
      // is aborted the sleep below resolves INSTANTLY on every pass, so this is the only thing
      // standing between a stopped loop and a hot spin. (Replanting its deletion does not fail
      // a clause politely — it burns a vitest worker to an out-of-memory crash.) Do not make
      // the exit depend on `markCancelled` having moved a row: the row may already be terminal.
      //
      // A-5 FIX ROUND: THE EXIT ASKS `cutBy()`, THE MESSAGE ASKS `cutByStop()`. The scope now
      // guarantees only the owner's stop reaches a background slot — but "the loop exits on
      // exactly the aborts it recognises" is the same trap one narrowing away: asked
      // `cutByStop()` alone, an abort it did NOT recognise would leave the signal aborted, the
      // sleep resolving instantly and the loop spinning for ever. One exit covers every abort;
      // the owner's name goes on it only when the owner earned it.
      const cutBy = slot?.cutBy();
      if (cutBy) {
        await markCancelled(jobId, slot!.cutByStop()
          ? 'the user stopped this agent'
          : `the engine aborted this agent's in-flight calls (${cutBy})`);
        return;
      }

      // ── t114 (U4) — THE PROVIDER IS ASKED BEFORE THE CLOCK IS BELIEVED ──
      //
      // This guard used to KILL here, one line above `pollProviderVideo`. The measured fact —
      // the provider's own `poll.status`, and the `poll.progress` percentage it reports beside
      // it — was fetched on the very next line, and the clock pre-empted it. A render the
      // provider still called `in_progress` at 30:01 was written `failed`, an apology was
      // posted into the owner's chat, and because `startVideoJobPoller` only resumes
      // `('queued','polling')` rows, `failed` is TERMINAL: when the provider finished two
      // minutes later the asset was never fetched and the owner was billed for a video they
      // never saw.
      //
      // The campaign doctrine is that a timer may only end work it can PROVE is dead. A
      // provider answering `in_progress` is positive proof of the opposite, so the age is now
      // only COMPUTED here and carried; the decision moves below the poll, to the one branch
      // where the provider has given us no evidence of life at all. The clock stops being a
      // verdict and becomes what `log-rotation.ts` makes it: a refusal guard that acts only in
      // the absence of a fact.
      const age = Date.now() - new Date(row.started_at + 'Z').getTime();
      const pastWall = Number.isFinite(age) && age > MAX_JOB_AGE_MS;

      const poll = await pollProviderVideo(row.agent_id, row.provider_id, row.provider_job_id);

      // t126: the OTHER phase. A shutdown during that await cuts the leg, which returns a plain
      // retryable error and NOT `stopped` (that is the owner's button alone), so without this the
      // loop falls into the `attempt_count` UPDATE below on a closed handle.
      if (pollerStopped()) {
        logger.info('video poll loop standing down mid-leg; the row stays open', { jobId });
        return;
      }

      getDb().prepare('UPDATE video_jobs SET attempt_count = attempt_count + 1, updated_at = datetime(\'now\') WHERE id = ?').run(jobId);

      if (!poll.ok) {
        // A-5: a stopped leg is not a failed leg — it must not write `failed` and must not
        // post a failure into the chat.
        if (poll.stopped) { await markCancelled(jobId, 'the user stopped this agent mid-poll'); return; }
        if (!poll.retryable) { markFailed(jobId, poll.error); return; }
        // transient — fall through to backoff sleep.
        //
        // t114 (U4): THIS is the only place the wall-clock may end the job, because this is the
        // only branch where the provider has told us nothing. A transient poll error means we
        // have no evidence either way; if that has been true for the whole window, the job is
        // as dead as we can prove and the kill is honest about WHY — it names the absence of
        // evidence and the last error, not a fictitious "provider did not finish".
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
        // t114 (U4): the provider says `queued`/`in_progress` — positive proof the work is
        // ALIVE. It outranks the wall, so the loop keeps polling. The overrun is LOUD rather
        // than silent (the doctrine asks for the record, not for a quiet reprieve), and it
        // carries the provider's own progress reading so the line is evidence and not a shrug.
        // The loop stays bounded in every direction that matters: the owner's stop still cuts
        // it at the top of the iteration, and a provider that goes quiet is still ended by the
        // `pastWall` branch above.
        if (pastWall) {
          logger.warn('video job is past the 30-minute wall but the PROVIDER still reports it running — not failing it', {
            jobId,
            ageMinutes: Math.round(age / 60_000),
            providerStatus: poll.status,
            providerProgress: poll.progress,
          });
        }
        // queued / in_progress — advance the row to 'polling' the first
        // time we see it move, so the dashboard indicator reflects it.
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
    // t126: THE BACKSTOP — the path that used to re-throw out of its own handler. WARN, not
    // info: with the two checks above in place a stand-down returns and never arrives here, so
    // reaching this line means a guard was missed. The clause "a stand-down is SILENT at
    // warn-and-above" is what keeps those two checks load-bearing rather than decorative.
    if (pollerStopped()) {
      logger.warn('video poll loop unwound through its ERROR PATH on shutdown — a stand-down guard was missed; the row stays open', {
        jobId, error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // A-5: an abort unwinding through here is not an internal poller error.
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

/** Start polling a single job immediately (called right after submit). */
export function enqueueVideoJob(jobId: string): void {
  detachPollLoop(jobId, pollLoop(jobId));
}

/** Boot-time resume: pick up every job still in flight and poll it. */
export function startVideoJobPoller(): void {
  rearmVideoJobPoller();   // t126: a boot is the one thing that lifts the stand-down fence.
  let rows: Array<{ id: string }>;
  try {
    // t122: the resume adopts every OPEN row, not only the two words this file writes — the
    // boot reconciliation leaves every video row with a provider render to this scan, so a
    // vocabulary gap here is a paid-for render abandoned in silence.
    rows = getDb().prepare(
      `SELECT id FROM video_jobs WHERE status NOT IN (${TERMINAL_JOB_STATUS_SQL})`,
    ).all() as Array<{ id: string }>;
  } catch (err) {
    // video_jobs table may not exist yet on a very old DB pre-migration.
    logger.warn('video poller boot scan skipped', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (rows.length === 0) return;
  logger.info('video poller: resuming in-flight jobs', { count: rows.length });
  for (const r of rows) detachPollLoop(r.id, pollLoop(r.id));
}
