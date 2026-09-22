// ════════════════════════════════════════
// services/generation-jobs.ts — run-once media generation worker
// (image / audio / music).
//
// Video has its own async table + poller (video_jobs, video-job-poller.ts)
// because it is a 3-legged poll-the-provider flow. Image, audio, and music
// are "run-once-then-deliver": one provider call returns the finished
// asset. We still model them as background jobs (generation_jobs table,
// migration 063) so the dashboard shows the SAME spinning-icon + popup
// indicator video uses, and so a disobedient model can't retry-storm — the
// tool fires the job, ends its turn, and this worker delivers the asset as
// a synthetic assistant message.
//
// Lifecycle: queued -> running -> succeeded | failed | cancelled.
//   audio / music — this module owns the whole run (createGenerationJob +
//                   enqueueAudioOrMusicJob; runAudioOrMusicJob does the
//                   generate + deliver + cost).
//   image         — the image_create dispatcher keeps its own delivery and
//                   just uses the lifecycle helpers (createGenerationJob,
//                   setRunning, setSucceeded/setFailed) so it shows in the
//                   same indicator.
//
// Boot behavior: unlike video (which can resume polling), a run-once job
// interrupted mid-flight can't be resumed — the in-process generate call is
// gone. So at startup we mark any leftover queued/running rows as failed.
// ════════════════════════════════════════

import * as effectFs from '../agent/effects/fs.js';
import { turnContext } from '../agent/turn-context.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { broadcast } from '../gateway/ws.js';
import { homeDir } from '../home.js';

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
  asset_mime: string | null;
  duration_seconds: number | null;
  cost_usd: number | null;
  error: string | null;
  attempt_count: number;
}

const inFlight = new Set<string>();

function getJob(jobId: string): GenerationJobRow | undefined {
  return getDb().prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as GenerationJobRow | undefined;
}

export function countActiveGenerationJobs(): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) AS n FROM generation_jobs WHERE status IN ('queued','running')"
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
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
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
  getDb().prepare(`
    INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, title, voice, status,
                                 source_message_id, turn_number, task_id, conversation_id, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, params.kind, params.agentId, params.modelId, params.providerId, params.prompt,
    params.title ?? null, params.voice ?? null,
    // P6a execution lineage from the live turn (best-effort; NULL outside a turn).
    turnContext(params.agentId)?.root?.sourceMessageId ?? null,
    turnContext(params.agentId)?.turnNumber ?? null,
    turnContext(params.agentId)?.servedWork?.taskId ?? null,
    turnContext(params.agentId)?.root?.conversationId ?? null);
  const row = getJob(id);
  if (row) emitUpdate(row);
  return id;
}

/**
 * CAS transition queued -> running.
 *
 * A-5 — THE ANSWER IS RETURNED NOW, and `image_create` reads it. This was `void`, so a caller
 * that had already been cancelled (the user pressed stop while the job sat queued —
 * `cancelAgentGenerationJobs` below) sailed past a no-op UPDATE and dialled the provider
 * anyway. The CAS always knew; nobody was asking it.
 *
 * @returns true if this call moved the row to running; false if it was no longer queued.
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
  assetMime: string;
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
    SET status='succeeded', asset_path=?, asset_mime=?, duration_seconds=?, cost_usd=?,
        finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status='running'
  `).run(f.assetPath, f.assetMime, f.durationSeconds ?? null, f.costUsd ?? null, jobId);
  if (res.changes === 0) return false;
  const row = getJob(jobId);
  if (row) emitUpdate(row);
  return true;
}

/**
 * A-5 — CAS transition to `cancelled`, the terminal state a USER STOP produces.
 *
 * Separate from `setFailed` on purpose and the distinction is the whole of requirement (b):
 * `failed` writes an `error` column, is rendered as a failure by the dashboard indicator, and
 * makes the caller post *"I wasn't able to finish that audio"* into the chat. None of that is
 * true of a job the owner deliberately stopped, and saying it would be the engine blaming a
 * provider for the owner's own button. `cancelled` is the state the manual cancel routes
 * (`gateway/routes/config.ts`) already write and every worker already honours; a stop is the
 * same event arriving through a different door.
 */
export function setCancelled(jobId: string): boolean {
  const res = getDb().prepare(`
    UPDATE generation_jobs SET status='cancelled', finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status IN ('queued','running')
  `).run(jobId);
  if (res.changes === 0) return false;
  const row = getJob(jobId);
  if (row) emitUpdate(row);
  return true;
}

/**
 * A-5 — EVERY RUN-ONCE MEDIA JOB THIS AGENT HAS OPEN, CANCELLED BY ITS STOP. Called from
 * `stopAgent`. Returns how many rows moved.
 *
 * WHY THE ABORT REGISTRY IS NOT ENOUGH ON ITS OWN, which is the measured shape of this arm:
 * `image_create`'s delivery IIFE deliberately WAITS for the requesting agent to go idle before
 * it dials (`tools/cat/media.ts`, the 60s wait loop — it exists so the finished image does not
 * land mid-reply). A stop raises the fence, the run unwinds, teardown writes idle, and the
 * run's own `finally` lowers the fence — and only THEN does the IIFE wake up and dial. There is
 * nothing registered during that wait and no fence standing by the time there could be, so the
 * registry alone cannot refuse that dial. The ROW is the durable fact that survives the run,
 * and `setRunning`'s CAS is the door the IIFE already goes through.
 *
 * Video is NOT handled here: its poll loop registers itself for its whole life
 * (`video-job-poller.ts`), so `abortInFlight` reaches it directly and it writes its own
 * cancelled row — one owner per table, rather than two writers racing the same CAS.
 */
export function cancelAgentGenerationJobs(agentId: string): number {
  let ids: string[];
  try {
    ids = (getDb().prepare(
      "SELECT id FROM generation_jobs WHERE agent_id = ? AND status IN ('queued','running')"
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

export function setFailed(jobId: string, error: string): void {
  const res = getDb().prepare(`
    UPDATE generation_jobs SET status='failed', error=?, finished_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ? AND status IN ('queued','running')
  `).run(error.slice(0, 1000), jobId);
  if (res.changes === 0) return;
  const row = getJob(jobId);
  if (row) emitUpdate(row);
  logger.warn('generation job failed', { jobId, error: error.slice(0, 200) });
}

// ── Synthetic chat delivery ──

/**
 * Deliver a finished audio/music asset into the agent's chat as a synthetic
 * assistant message (no LLM turn), mirroring the video poller's deliverVideo.
 */
function deliverAsset(row: GenerationJobRow, assetPath: string, sizeBytes: number, mime: string): void {
  const recipientDir = path.join(homeDir(), '.dojo', 'uploads', row.agent_id);
  if (!effectFs.existsSync(recipientDir)) effectFs.mkdirSync(recipientDir, { recursive: true });
  const ext = path.extname(assetPath) || '.wav';
  const titleSlug = row.title ? slugify(row.title) : '';
  const shortId = row.id.replace(/^gen_/, '').slice(0, 8);
  const stableFilename = titleSlug ? `${titleSlug}-${shortId}${ext}` : `${row.kind}_${shortId}${ext}`;
  const stablePath = path.join(recipientDir, stableFilename);
  let deliveredPath = assetPath;
  try {
    effectFs.copyFileSync(assetPath, stablePath);
    deliveredPath = stablePath;
  } catch (err) {
    logger.warn('generation delivery: copy to caller uploads dir failed — using shared path', {
      jobId: row.id, error: err instanceof Error ? err.message : String(err),
    });
  }

  const attachment = {
    fileId: uuidv4(),
    filename: path.basename(deliveredPath),
    mimeType: mime,
    size: sizeBytes,
    path: deliveredPath,
    category: 'audio' as const,
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

function deliverError(row: GenerationJobRow, error: string): void {
  const msgId = uuidv4();
  const noun = row.kind === 'music' ? 'music' : 'audio';
  const content =
    `I wasn't able to finish that ${noun}:\n\n> ${error}\n\n` +
    `You could try a simpler description.`;
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

    // A-5: the CAS is now READ. A stop that landed between create and here has already moved
    // this row to `cancelled`; dialling anyway would spend the owner's money on work he stopped.
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
      // A-5: honest stop identity. A stop is not a failure: no `error` column, no failure
      // wording, and no *"I wasn't able to finish that audio"* bubble for work the owner
      // himself called off. `setCancelled` is a no-op when `stopAgent` already wrote the row.
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

    // Record cost. Voice (GPT Audio) is token-priced; music (Lyria) is
    // per-clip, tagged as a single unit. recordCost reads the model's
    // pricing_unit to pick the math, so we pass both shapes.
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
      assetMime: result.mimeType,
      durationSeconds: result.durationSeconds,
      costUsd,
    });
    if (!delivered) {
      // A cancel raced us — the asset exists but the user asked to stop.
      logger.info('generation job: success raced a cancel, not delivering', { jobId });
      return;
    }

    const fresh = getJob(jobId);
    if (fresh) deliverAsset(fresh, result.filePath, result.sizeBytes, result.mimeType);
    logger.info('generation job succeeded + delivered', {
      jobId, kind: row.kind, durationSeconds: result.durationSeconds, costUsd,
    });
  } catch (err) {
    logger.error('generation run loop threw', { jobId, error: err instanceof Error ? err.message : String(err) });
    setFailed(jobId, `Internal generator error: ${err instanceof Error ? err.message : String(err)}`);
    const fresh = getJob(jobId);
    if (fresh) deliverError(fresh, err instanceof Error ? err.message : String(err));
  } finally {
    inFlight.delete(jobId);
  }
}

/** Kick off an audio/music job immediately (called right after create). */
export function enqueueAudioOrMusicJob(jobId: string): void {
  void runAudioOrMusicJob(jobId);
}

/**
 * Boot-time cleanup. A run-once job can't resume mid-flight, so any row
 * still queued/running after a restart is dead — mark it failed so the
 * indicator clears and the agent's chat isn't left hanging.
 */
export function startGenerationJobsWorker(): void {
  let rows: Array<{ id: string; agent_id: string; kind: GenerationKind; prompt: string }>;
  try {
    rows = getDb().prepare(
      "SELECT id, agent_id, kind, prompt FROM generation_jobs WHERE status IN ('queued','running')"
    ).all() as Array<{ id: string; agent_id: string; kind: GenerationKind; prompt: string }>;
  } catch (err) {
    logger.warn('generation-jobs boot scan skipped', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (rows.length === 0) return;
  logger.info('generation-jobs: clearing interrupted jobs from previous run', { count: rows.length });
  for (const r of rows) {
    setFailed(r.id, 'Interrupted by a server restart.');
    const fresh = getJob(r.id);
    if (fresh) deliverError(fresh, 'Interrupted by a server restart.');
  }
}
