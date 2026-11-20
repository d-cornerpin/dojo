// Run-once media generation worker (image / audio / music). Video has its own async table and poller (video_jobs,
// video-job-poller.ts) because it is a poll-the-provider flow; these kinds return the finished asset from one
// call, yet are modelled as `generation_jobs` rows so the dashboard shows the same indicator and a model cannot
// retry-storm: the tool fires the job, ends its turn, and this worker hands the finished file to `deliverMedia`.
// Lifecycle: queued -> running -> succeeded | failed | cancelled. Audio and music run entirely here; image_create
// keeps its own delivery and uses only the lifecycle helpers. A run-once job cannot resume, so job-orphans.ts
// closes leftover rows at boot.

import { turnContext } from '../agent/turn-context.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { settleAskOnJobEnded } from '../work/ask-settlement.js';
import { announceLiveWork } from '../agent/live-work.js';
import { tellAgentAndWake, noteJobStartedIn, takeJobStartedInFailureTurn } from '../agent/wake-with-notice.js';
import { TERMINAL_JOB_STATUS_SQL } from './media-job-status.js';
import { deliverMedia, MEDIA_WORD } from './media-delivery.js';

const logger = createLogger('generation-jobs');

export type GenerationKind = 'image' | 'audio' | 'music';
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface GenerationJobRow {
  id: string;
  kind: GenerationKind;
  agent_id: string;
  model_id: string;
  provider_id: string;
  prompt: string;
  title: string | null;
  voice: string | null;
  status: GenerationStatus;
  asset_path: string | null;
  duration_seconds: number | null;
  cost_usd: number | null;
  error: string | null;
  attempt_count: number;
  conversation_id?: string | null; source_message_id?: string | null;  // execution lineage
}

const inFlight = new Set<string>();

function getJob(jobId: string): GenerationJobRow | undefined {
  return getDb().prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as GenerationJobRow | undefined;
}

export function countActiveGenerationJobs(): number {
  // Asked from the TERMINAL end: an enumerated open end is blind to any status word added later.
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM generation_jobs WHERE status NOT IN (${TERMINAL_JOB_STATUS_SQL})`
  ).get() as { n: number };
  return row.n;
}

function emitUpdate(row: { id: string; agent_id: string; kind: GenerationKind; status: GenerationStatus; prompt: string }): void {
  broadcast({
    type: 'generation_job:update',
    data: {
      id: row.id,
      agentId: row.agent_id,
      kind: row.kind,
      status: row.status,
      prompt: row.prompt,
      activeCount: countActiveGenerationJobs(),
    },
  });
  // The per-agent answer: this frame is per job with a box-wide count, so it cannot say whether THIS agent still has
  // work running (the row is the only standing fact during image_create's pre-dial wait).
  announceLiveWork(row.agent_id);
}

/** The live turn's lineage a media job row carries: source message, turn number, task, conversation (NULL outside a turn). */
export function jobLineage(agentId: string): [string | null, number | null, string | null, string | null] {
  const t = turnContext(agentId);
  return [t?.root?.sourceMessageId ?? null, t?.turnNumber ?? null, t?.servedWork?.taskId ?? null, t?.root?.conversationId ?? null];
}

// ── Lifecycle helpers (also used directly by image_create) ──

export interface CreateGenerationJobParams {
  kind: GenerationKind;
  agentId: string;
  modelId: string;
  providerId: string;
  prompt: string;
  title?: string | null;
  voice?: string | null;
}

/** Insert a queued job row and broadcast the initial state. Returns the id. */
export function createGenerationJob(params: CreateGenerationJobParams): string {
  const id = `gen_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  noteJobStartedIn(params.agentId, id);
  getDb().prepare(`
    INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, title, voice, status,
                                 source_message_id, turn_number, task_id, conversation_id, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, params.kind, params.agentId, params.modelId, params.providerId, params.prompt,
    params.title ?? null, params.voice ?? null,
    ...jobLineage(params.agentId));
  const row = getJob(id);
  if (row) emitUpdate(row);
  return id;
}

/**
 * CAS transition queued -> running. Returns true if this call moved the row, false if it was no longer queued, so a
 * caller cancelled while queued (`cancelAgentGenerationJobs`) does not dial the provider.
 */
export function setRunning(jobId: string): boolean {
  const res = getDb().prepare(
    "UPDATE generation_jobs SET status='running', attempt_count=attempt_count+1, updated_at=datetime('now') WHERE id = ? AND status='queued'"
  ).run(jobId);
  if (res.changes === 0) return false;
  const row = getJob(jobId);
  if (row) emitUpdate(row);
  return true;
}

export interface SucceededFields {
  assetPath: string;
  durationSeconds?: number | null;
  costUsd?: number | null;
}

/**
 * CAS transition running -> succeeded. Returns false if the row was no
 * longer 'running' (e.g. a cancel raced us), so the caller can skip
 * delivery.
 */
export function setSucceeded(jobId: string, f: SucceededFields): boolean {
  const res = getDb().prepare(`
    UPDATE generation_jobs
    SET status='succeeded', asset_path=?, duration_seconds=?, cost_usd=?,
        finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status='running'
  `).run(f.assetPath, f.durationSeconds ?? null, f.costUsd ?? null, jobId);
  if (res.changes === 0) return false;
  const row = getJob(jobId);
  if (row) emitUpdate(row);
  return true;
}

/**
 * CAS transition to `cancelled`, the terminal state a user stop produces. Separate from `setFailed` on purpose:
 * `failed` writes an error and makes the caller post a failure message, none of which is true of a job the owner
 * deliberately stopped. The manual cancel routes (`gateway/routes/config.ts`) write the same state.
 */
export function setCancelled(jobId: string): boolean {
  // Fenced on 'not already finished' so a stop can cut ANY open row, while a terminal row is never re-opened.
  const res = getDb().prepare(`
    UPDATE generation_jobs SET status='cancelled', finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
  `).run(jobId);
  if (res.changes === 0) return false;
  const row = getJob(jobId);
  if (row) { emitUpdate(row); settleAskOnJobEnded(row.agent_id, jobId); }   // the last job of a request called off
  return true;
}

/**
 * Cancel every run-once media job this agent has open; called from `stopAgent`. Returns how many rows moved.
 * The abort registry is not enough: `image_create`'s delivery waits for the agent to go idle before it dials
 * (`tools/cat/media.ts`), so during that wait nothing is registered and no fence stands; the ROW is the durable fact
 * and `setRunning`'s CAS is the door that wait goes through. Video is not handled here: its poller registers
 * itself, so `abortInFlight` reaches it and it writes its own cancelled row (one writer per table).
 */
export function cancelAgentGenerationJobs(agentId: string): number {
  let ids: string[];
  try {
    ids = (getDb().prepare(
      // Every OPEN row of this agent's, however its status is spelled.
      `SELECT id FROM generation_jobs WHERE agent_id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})`
    ).all(agentId) as Array<{ id: string }>).map((r) => r.id);
  } catch {
    // A pre-migration DB has no table. A stop must never throw out of `stopAgent`.
    return 0;
  }
  let moved = 0;
  for (const id of ids) {
    try { if (setCancelled(id)) moved += 1; } catch { /* best effort, per row */ }
  }
  if (moved > 0) logger.info('generation jobs cancelled by the user stop', { agentId, cancelled: moved });
  return moved;
}

/** Moves an open job to failed; true when it did, false when the job had already finished. */
export function setFailed(jobId: string, error: string): boolean {
  // Fenced on 'not already finished' so any open row can record a failure; a terminal row keeps its verdict.
  const res = getDb().prepare(`
    UPDATE generation_jobs SET status='failed', error=?, finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
  `).run(error.slice(0, 1000), jobId);
  if (res.changes === 0) return false;
  const row = getJob(jobId);
  if (row) emitUpdate(row);
  logger.warn('generation job failed', { jobId, error: error.slice(0, 200) });
  return true;
}

// ── Failure notice ──

function deliverError(row: GenerationJobRow, error: string): void {
  // The engine writes no failure bubble in the agent's voice: the agent is handed the failure and WOKEN
  // (agent/wake-with-notice.ts) to tell the person now.
  void tellAgentAndWake({
    agentId: row.agent_id, from: 'Media generation', inFailureTurn: takeJobStartedInFailureTurn(row.id),
    brief: `the ${MEDIA_WORD[row.kind]} you asked for could not be finished. The provider said: ${error}. Nothing was sent to the person. ` +
      'Tell them in your own words that it failed and offer a next step; do not start the same one again unless they ask.',
  });
  settleAskOnJobEnded(row.agent_id, row.id);
}

// ── Audio / music run loop ──

// GPT Audio (voice) = 24kHz mono; Lyria (music) = 48kHz stereo.
const AUDIO_SAMPLE_RATE = 24_000;
const AUDIO_CHANNELS = 1;
const MUSIC_SAMPLE_RATE = 48_000;
const MUSIC_CHANNELS = 2;

async function runAudioOrMusicJob(jobId: string): Promise<void> {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  try {
    const row = getJob(jobId);
    if (!row) return;
    if (row.status !== 'queued') return;
    if (row.kind !== 'audio' && row.kind !== 'music') {
      logger.warn('runAudioOrMusicJob called for non-audio kind — ignoring', { jobId, kind: row.kind });
      return;
    }

    // The CAS result is read: a stop between create and here already cancelled the row, so do not dial for it.
    if (!setRunning(jobId)) {
      logger.info('generation job: not dialling — the row is no longer queued (stopped or cancelled)', { jobId });
      return;
    }

    const isMusic = row.kind === 'music';
    const { generateAudio } = await import('./audio-generation.js');
    const result = await generateAudio({
      agentId: row.agent_id,
      modelId: row.model_id,
      prompt: row.prompt,
      voice: isMusic ? undefined : (row.voice ?? 'alloy'),
      speak: !isMusic,
      sampleRate: isMusic ? MUSIC_SAMPLE_RATE : AUDIO_SAMPLE_RATE,
      channels: isMusic ? MUSIC_CHANNELS : AUDIO_CHANNELS,
    });

    if (!result.ok) {
      // A stop is not a failure: no `error` column and no failure wording; `setCancelled` is a no-op if `stopAgent`
      // already wrote the row.
      if (result.code === 'STOPPED') {
        setCancelled(jobId);
        logger.info('generation job cancelled: the user stopped this agent mid-generation', { jobId, kind: row.kind });
        return;
      }
      setFailed(jobId, result.error);
      const fresh = getJob(jobId);
      if (fresh) deliverError(fresh, result.error);
      return;
    }

    // Record cost: voice is token-priced and music is per-clip, so both shapes are passed and recordCost picks by the
    // model's pricing_unit.
    let costUsd: number | null = null;
    try {
      const { recordCost } = await import('../costs/tracker.js');
      const priceRow = getDb().prepare('SELECT pricing_unit, cost_per_unit FROM models WHERE id = ?')
        .get(row.model_id) as { pricing_unit: string | null; cost_per_unit: number | null } | undefined;
      const units = isMusic ? 1 : (result.durationSeconds ?? undefined);
      recordCost({
        agentId: row.agent_id,
        modelId: row.model_id,
        providerId: result.providerId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        requestType: isMusic ? 'music_generation' : 'audio_generation',
        units,
      });
      if (priceRow && priceRow.pricing_unit !== 'token' && typeof priceRow.cost_per_unit === 'number' && typeof units === 'number') {
        costUsd = units * priceRow.cost_per_unit;
      }
    } catch (err) {
      logger.warn('generation cost record failed (non-fatal)', {
        jobId, error: err instanceof Error ? err.message : String(err),
      });
    }

    const delivered = setSucceeded(jobId, {
      assetPath: result.filePath,
      durationSeconds: result.durationSeconds,
      costUsd,
    });
    if (!delivered) {
      // A cancel raced us: the asset exists but the user asked to stop.
      logger.info('generation job: success raced a cancel, not delivering', { jobId });
      return;
    }

    const fresh = getJob(jobId);
    if (fresh) {
      await deliverMedia({ kind: fresh.kind, agentId: fresh.agent_id, jobId, title: fresh.title, filePath: result.filePath, mimeType: result.mimeType,
        sizeBytes: result.sizeBytes, conversationId: fresh.conversation_id ?? null, requestMessageId: fresh.source_message_id ?? null });
    }
    logger.info('generation job succeeded + delivered', {
      jobId, kind: row.kind, durationSeconds: result.durationSeconds, costUsd,
    });
  } catch (err) {
    logger.error('generation run loop threw', { jobId, error: err instanceof Error ? err.message : String(err) });
    // A job that already finished (it succeeded, then posting it threw) keeps its verdict and sends no failure.
    if (setFailed(jobId, `Internal generator error: ${err instanceof Error ? err.message : String(err)}`)) {
      const fresh = getJob(jobId);
      if (fresh) deliverError(fresh, err instanceof Error ? err.message : String(err));
    }
  } finally {
    inFlight.delete(jobId);
  }
}

/** Kick off an audio/music job immediately (called right after create); the promise ends when it is delivered. */
export function enqueueAudioOrMusicJob(jobId: string): Promise<void> {
  return runAudioOrMusicJob(jobId);
}

/**
 * The boot notice: `services/job-orphans.ts` closes leftover rows (both tables, each row fenced) and this posts what
 * a closed row cannot. Closing a row stays independent of delivery, which can fail (e.g. for a purged agent).
 */
export function notifyAbandonedGenerationJobs(abandoned: ReadonlyArray<{ id: string }>): void {
  if (abandoned.length === 0) return;
  logger.info('generation-jobs: telling the chat about jobs interrupted by a restart', { count: abandoned.length });
  for (const job of abandoned) {
    try {
      const fresh = getJob(job.id);
      if (fresh) deliverError(fresh, 'Interrupted by a server restart.');
    } catch (err) {
      logger.warn('generation-jobs: could not post the interrupted-job notice', {
        jobId: job.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
