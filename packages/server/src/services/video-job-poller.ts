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
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { broadcast } from '../gateway/ws.js';
import { pollProviderVideo, fetchVideoAsset } from './video-generation.js';

const logger = createLogger('video-job-poller');

const POLL_START_MS = 5_000;
const POLL_MAX_MS = 30_000;
const POLL_BACKOFF = 1.5;
// Wall-clock ceiling. A job that hasn't finished in 30 min is treated as
// failed so it stops consuming a poll loop forever.
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
}

const inFlight = new Set<string>();

function getJob(jobId: string): VideoJobRow | undefined {
  return getDb().prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRow | undefined;
}

function countActiveJobs(): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) AS n FROM video_jobs WHERE status IN ('queued','polling')"
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
      activeCount: countActiveJobs(),
    },
  });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Deliver the finished video into the agent's chat as a synthetic
 * assistant message (no LLM turn), mirroring image_create's delivery.
 */
function deliverVideo(row: VideoJobRow, assetPath: string, sizeBytes: number): void {
  // Copy into the caller's uploads dir with a friendly, title-derived
  // filename so downloads are named sensibly.
  const recipientDir = path.join(os.homedir(), '.dojo', 'uploads', row.agent_id);
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
  });
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
}

function deliverError(row: VideoJobRow, error: string): void {
  const msgId = uuidv4();
  const content =
    `I wasn't able to finish that video:\n\n> ${error}\n\n` +
    `You could try a shorter clip or a simpler description.`;
  insertMessageIfAbsent({ id: msgId, agentId: row.agent_id, role: 'assistant', content });
  broadcast({
    type: 'chat:message', agentId: row.agent_id,
    message: {
      id: msgId, agentId: row.agent_id, role: 'assistant' as const, content,
      tokenCount: null, modelId: null, cost: null, latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  broadcast({ type: 'chat:chunk', agentId: row.agent_id, messageId: msgId, content: '', done: true, modelId: null });
}

function markFailed(jobId: string, error: string): void {
  const db = getDb();
  // Only fail a job that's still active — don't clobber a cancel.
  const res = db.prepare(`
    UPDATE video_jobs SET status='failed', error=?, finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status IN ('queued','polling')
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
  const asset = await fetchVideoAsset(row.provider_id, row.provider_job_id);
  if (!asset.ok) { markFailed(row.id, `Asset download failed: ${asset.error}`); return; }

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
    WHERE id = ? AND status IN ('queued','polling')
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

async function pollLoop(jobId: string): Promise<void> {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  let delay = POLL_START_MS;
  try {
    while (true) {
      const row = getJob(jobId);
      if (!row) return;
      if (row.status === 'cancelled' || row.status === 'succeeded' || row.status === 'failed') return;
      if (!row.provider_job_id) { markFailed(jobId, 'No provider job id.'); return; }

      // Wall-clock guard.
      const age = Date.now() - new Date(row.started_at + 'Z').getTime();
      if (Number.isFinite(age) && age > MAX_JOB_AGE_MS) {
        markFailed(jobId, 'Timed out — provider did not finish within 30 minutes.');
        return;
      }

      const poll = await pollProviderVideo(row.provider_id, row.provider_job_id);

      getDb().prepare('UPDATE video_jobs SET attempt_count = attempt_count + 1, updated_at = datetime(\'now\') WHERE id = ?').run(jobId);

      if (!poll.ok) {
        if (!poll.retryable) { markFailed(jobId, poll.error); return; }
        // transient — fall through to backoff sleep
      } else if (poll.status === 'completed') {
        await handleSuccess(row, poll.durationSeconds);
        return;
      } else if (poll.status === 'failed') {
        markFailed(jobId, poll.error ?? 'Provider reported the job failed.');
        return;
      } else {
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

      await sleep(delay);
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
    }
  } catch (err) {
    logger.error('video poll loop threw', { jobId, error: err instanceof Error ? err.message : String(err) });
    markFailed(jobId, `Internal poller error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    inFlight.delete(jobId);
  }
}

/** Start polling a single job immediately (called right after submit). */
export function enqueueVideoJob(jobId: string): void {
  void pollLoop(jobId);
}

/** Boot-time resume: pick up every job still in flight and poll it. */
export function startVideoJobPoller(): void {
  let rows: Array<{ id: string }>;
  try {
    rows = getDb().prepare("SELECT id FROM video_jobs WHERE status IN ('queued','polling')").all() as Array<{ id: string }>;
  } catch (err) {
    // video_jobs table may not exist yet on a very old DB pre-migration.
    logger.warn('video poller boot scan skipped', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (rows.length === 0) return;
  logger.info('video poller: resuming in-flight jobs', { count: rows.length });
  for (const r of rows) void pollLoop(r.id);
}
