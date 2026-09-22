// ════════════════════════════════════════
// services/video-generation.ts — async video job submit + poll + fetch.
//
// Unlike image_create / tts_create (synchronous single HTTP call), video
// generation is long-running (1 to 10 min). The flow is three-legged:
//
//   1. submitVideoJob()      POST /v1/videos        -> provider job id
//   2. pollProviderVideo()   GET  /v1/videos/{id}   -> status / progress
//   3. fetchVideoAsset()     GET  /v1/videos/{id}/content -> mp4 bytes
//
// This matches the OpenAI Sora async video API, which is the de-facto
// shape OpenRouter and OpenAI-compatible providers expose. submitVideoJob
// writes a `video_jobs` row (status='queued'); the boot-time poller in
// video-job-poller.ts owns legs 2 and 3 and the chat delivery.
//
// We resolve provider base_url + credential from the DB by provider_id so
// the poller only needs the row's provider_id / provider_job_id to drive
// each leg — no extra state threaded through.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { buildWireBody } from './generation-params.js';
import { openAgentCall, STOPPED_BY_USER, type AgentCallSlot } from '../agent/abortable-call.js';
import type { GenerationParamSpec } from '@dojo/shared';
import { homeDir } from '../home.js';

const logger = createLogger('video-generation');

export const GENERATED_DIR = path.join(homeDir(), '.dojo', 'uploads', 'generated');
function ensureGeneratedDir(): void {
  if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    logger.info('Created generated video directory', { path: GENERATED_DIR });
  }
}

export interface SubmitVideoRequest {
  modelId: string;        // dojo models.id
  agentId: string;        // caller — used for delivery + cost attribution
  prompt: string;
  title?: string;
  // Per-model generation spec + the agent's validated canonical values
  // (duration / aspect_ratio / resolution). The wire body is composed from
  // these via buildWireBody — no hardcoded size/seconds mapping.
  paramSpec: GenerationParamSpec;
  canonicalParams: Record<string, string | number>;
  refImagePath?: string;  // optional reference image (absolute path)
}

export interface SubmitVideoSuccess {
  ok: true;
  jobId: string;          // dojo video_jobs.id (not the provider's)
  providerJobId: string;
  status: 'queued' | 'polling';
}

export interface SubmitVideoError {
  ok: false;
  error: string;
  // A-5: `STOPPED` is the user's own button, not a provider failure. See `image-generation.ts`.
  code: 'MODEL_NOT_FOUND' | 'NO_CREDENTIAL' | 'HTTP_ERROR' | 'NO_JOB_ID' | 'STOPPED' | 'UNKNOWN';
}

export type SubmitVideoResult = SubmitVideoSuccess | SubmitVideoError;

interface ProviderRow { id: string; type: string; base_url: string | null }
interface ModelRow { id: string; api_model_id: string; provider_id: string }

// Provider job state, normalized across the small variations we've seen.
// OpenAI returns queued | in_progress | completed | failed; some
// passthroughs use 'processing' / 'succeeded'. We collapse to four.
export interface ProviderPollResult {
  ok: true;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress: number | null;   // 0-100 when the provider reports it
  error: string | null;
  durationSeconds: number | null;
}
// A-5: `stopped` is how the poller tells a user stop apart from a provider failure. A stopped
// leg is NOT retryable and must NOT reach `markFailed` — a job the owner stopped did not fail.
export interface ProviderPollError { ok: false; error: string; retryable: boolean; stopped?: true }
export type ProviderPollOutcome = ProviderPollResult | ProviderPollError;

function resolveVideosBase(baseUrl: string | null): string {
  const root = (baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  if (root.toLowerCase().endsWith('/api/v1')) return root;          // already has /v1
  if (root.toLowerCase().endsWith('/api')) return `${root}/v1`;     // OpenRouter-style
  if (root.toLowerCase().endsWith('/v1')) return root;
  return `${root}/v1`;
}

function getModelProvider(modelId: string): { model: ModelRow; provider: ProviderRow; credential: string } | { error: SubmitVideoError } {
  const db = getDb();
  const model = db.prepare('SELECT id, api_model_id, provider_id FROM models WHERE id = ?')
    .get(modelId) as ModelRow | undefined;
  if (!model) return { error: { ok: false, error: `Model ${modelId} not found.`, code: 'MODEL_NOT_FOUND' } };
  const provider = db.prepare('SELECT id, type, base_url FROM providers WHERE id = ?')
    .get(model.provider_id) as ProviderRow | undefined;
  if (!provider) return { error: { ok: false, error: `Provider ${model.provider_id} not found.`, code: 'MODEL_NOT_FOUND' } };
  const credential = getProviderCredential(provider.id);
  if (!credential) {
    return { error: { ok: false, error: `No credential for provider ${provider.id}. Add it in Settings → Providers.`, code: 'NO_CREDENTIAL' } };
  }
  return { model, provider, credential };
}

function resolveProvider(providerId: string): { base: string; credential: string } | null {
  const db = getDb();
  const provider = db.prepare('SELECT id, type, base_url FROM providers WHERE id = ?')
    .get(providerId) as ProviderRow | undefined;
  if (!provider) return null;
  const credential = getProviderCredential(provider.id);
  if (!credential) return null;
  return { base: resolveVideosBase(provider.base_url), credential };
}

const COMMON_HEADERS = (credential: string): Record<string, string> => ({
  Authorization: `Bearer ${credential}`,
  'HTTP-Referer': 'https://dojo.dev',
  'X-Title': 'Dojo Agent Platform',
});

/**
 * Submit a new video job. Writes a `video_jobs` row (status='queued') and
 * returns the dojo job id. The poller takes it from here.
 */
/** A-5 — the stop door. Same shape as `generateImage`'s: see that function's note. */
export async function submitVideoJob(req: SubmitVideoRequest): Promise<SubmitVideoResult> {
  // A-5 FIX ROUND: `turn` — this leg runs INSIDE `video_create`, synchronously, and the tool
  // is still waiting on it. A turn that dies here has nothing to protect: the job does not
  // exist yet. The two legs the POLLER drives are the background ones.
  const slot = openAgentCall(req.agentId, 'turn');
  try {
    if (slot.refused) {
      logger.info('Video submit refused: the user stopped this agent', { modelId: req.modelId });
      return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    }
    return await dialVideoSubmit(req, slot);
  } finally {
    slot.release();
  }
}

async function dialVideoSubmit(req: SubmitVideoRequest, slot: AgentCallSlot): Promise<SubmitVideoResult> {
  ensureGeneratedDir();
  const resolved = getModelProvider(req.modelId);
  if ('error' in resolved) return resolved.error;
  const { model, provider, credential } = resolved;

  const base = resolveVideosBase(provider.base_url);
  const endpoint = `${base}/videos`;

  // Compose the provider-specific wire fields from the agent's validated
  // canonical values (duration / aspect_ratio / resolution) per this model's
  // spec. This is the tool → model mapping layer — no silent param drop.
  const wire = buildWireBody(req.paramSpec, req.canonicalParams);

  // When the agent supplied a reference image we must send multipart
  // form-data (the OpenAI video API takes the reference as a file part
  // named `input_reference`). Otherwise a plain JSON body is simpler and
  // works everywhere.
  let requestInit: RequestInit;
  const hasRef = !!req.refImagePath && fs.existsSync(req.refImagePath);
  if (hasRef) {
    const form = new FormData();
    form.append('model', model.api_model_id);
    form.append('prompt', req.prompt);
    for (const [k, v] of Object.entries(wire)) form.append(k, String(v));
    try {
      const refBytes = fs.readFileSync(req.refImagePath!);
      const ext = path.extname(req.refImagePath!).toLowerCase();
      const refMime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp' : 'image/png';
      form.append('input_reference', new Blob([refBytes], { type: refMime }), `reference${ext || '.png'}`);
    } catch (err) {
      return { ok: false, error: `Failed to read reference image: ${err instanceof Error ? err.message : String(err)}`, code: 'HTTP_ERROR' };
    }
    // A-5: COMPOSED, not replaced — the 60s submit ceiling is unchanged and still armed here.
    requestInit = { method: 'POST', headers: COMMON_HEADERS(credential), body: form, signal: AbortSignal.any([slot.signal, AbortSignal.timeout(60_000)]) };
  } else {
    const body: Record<string, unknown> = { model: model.api_model_id, prompt: req.prompt, ...wire };
    requestInit = {
      method: 'POST',
      headers: { ...COMMON_HEADERS(credential), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([slot.signal, AbortSignal.timeout(60_000)]),
    };
  }

  logger.info('Video gen: submitting job', {
    endpoint, modelId: req.modelId, apiModelId: model.api_model_id,
    wire, hasRefImage: hasRef, promptLength: req.prompt.length,
  });

  let response: Response;
  try {
    response = await fetch(endpoint, requestInit);
  } catch (err) {
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    return { ok: false, error: `Video submit request failed: ${err instanceof Error ? err.message : String(err)}`, code: 'HTTP_ERROR' };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return { ok: false, error: `Video provider returned HTTP ${response.status}: ${errText.slice(0, 400)}`, code: 'HTTP_ERROR' };
  }

  let data: { id?: string; status?: string; error?: { message?: string } | string };
  try {
    data = await response.json() as typeof data;
  } catch (err) {
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    return { ok: false, error: `Failed to parse video submit response: ${err instanceof Error ? err.message : String(err)}`, code: 'HTTP_ERROR' };
  }

  const providerJobId = data.id;
  if (!providerJobId) {
    return { ok: false, error: 'Video provider response had no job id.', code: 'NO_JOB_ID' };
  }

  const jobId = `vid_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  getDb().prepare(`
    INSERT INTO video_jobs
      (id, agent_id, model_id, provider_id, provider_job_id, prompt, title, status, attempt_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0)
  `).run(jobId, req.agentId, model.id, provider.id, providerJobId, req.prompt, req.title ?? null);

  logger.info('Video gen: job queued', { jobId, providerJobId, agentId: req.agentId });
  return { ok: true, jobId, providerJobId, status: 'queued' };
}

/**
 * Poll the provider for a job's current state.
 *
 * A-5: `agentId` is the requesting agent, so each poll leg registers as one abortable call of
 * that agent's — the poller outlives the turn, and a stop pressed at minute six of a ten-minute
 * video has to reach the leg that is on the wire right then, not only the loop around it.
 */
export async function pollProviderVideo(agentId: string, providerId: string, providerJobId: string): Promise<ProviderPollOutcome> {
  // A-5 FIX ROUND: `background` — driven by the poll loop, minutes after its turn ended.
  const slot = openAgentCall(agentId, 'background');
  try {
    if (slot.refused) return { ok: false, error: STOPPED_BY_USER, retryable: false, stopped: true };
    return await dialVideoPoll(slot, providerId, providerJobId);
  } finally {
    slot.release();
  }
}

async function dialVideoPoll(slot: AgentCallSlot, providerId: string, providerJobId: string): Promise<ProviderPollOutcome> {
  const resolved = resolveProvider(providerId);
  if (!resolved) return { ok: false, error: `Provider ${providerId} unavailable (no credential?).`, retryable: false };

  let response: Response;
  try {
    response = await fetch(`${resolved.base}/videos/${encodeURIComponent(providerJobId)}`, {
      method: 'GET',
      headers: COMMON_HEADERS(resolved.credential),
      // A-5: COMPOSED — the 30s poll ceiling is unchanged and still armed here.
      signal: AbortSignal.any([slot.signal, AbortSignal.timeout(30_000)]),
    });
  } catch (err) {
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, retryable: false, stopped: true };
    return { ok: false, error: `Poll request failed: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    // 5xx and 429 are transient; 4xx (other than 429) means the job id is
    // bad or gone — not worth retrying forever.
    const retryable = response.status >= 500 || response.status === 429;
    return { ok: false, error: `Poll HTTP ${response.status}: ${errText.slice(0, 300)}`, retryable };
  }

  let data: {
    status?: string;
    progress?: number;
    error?: { message?: string } | string | null;
    seconds?: number | string;
    duration_seconds?: number;
  };
  try {
    data = await response.json() as typeof data;
  } catch (err) {
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, retryable: false, stopped: true };
    return { ok: false, error: `Poll parse failed: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }

  const raw = (data.status ?? '').toLowerCase();
  const status: ProviderPollResult['status'] =
    raw === 'completed' || raw === 'succeeded' || raw === 'success' ? 'completed'
    : raw === 'failed' || raw === 'error' || raw === 'cancelled' ? 'failed'
    : raw === 'queued' || raw === 'pending' ? 'queued'
    : 'in_progress';

  const errMsg = typeof data.error === 'string' ? data.error
    : data.error && typeof data.error === 'object' ? (data.error.message ?? null)
    : null;

  const durRaw = data.duration_seconds ?? (typeof data.seconds === 'string' ? Number(data.seconds) : data.seconds);
  const durationSeconds = typeof durRaw === 'number' && Number.isFinite(durRaw) ? durRaw : null;

  return {
    ok: true,
    status,
    progress: typeof data.progress === 'number' ? data.progress : null,
    error: errMsg,
    durationSeconds,
  };
}

/** A-5: `stopped` marks the user's own button so the poller does not record it as a failure. */
export type VideoAssetOutcome =
  | { ok: true; filePath: string; filename: string; sizeBytes: number }
  | { ok: false; error: string; stopped?: true };

/**
 * Download the finished asset to ~/.dojo/uploads/generated/<uuid>.mp4.
 * Returns the absolute path + byte size on success.
 */
export async function fetchVideoAsset(agentId: string, providerId: string, providerJobId: string): Promise<VideoAssetOutcome> {
  // A-5: the download leg registers too — it is the longest single wire of the three.
  // A-5 FIX ROUND: `background` — same reason as the poll leg; the turn is long gone.
  const slot = openAgentCall(agentId, 'background');
  try {
    if (slot.refused) return { ok: false, error: STOPPED_BY_USER, stopped: true };
    return await dialVideoAsset(slot, providerId, providerJobId);
  } finally {
    slot.release();
  }
}

async function dialVideoAsset(slot: AgentCallSlot, providerId: string, providerJobId: string): Promise<VideoAssetOutcome> {
  ensureGeneratedDir();
  const resolved = resolveProvider(providerId);
  if (!resolved) return { ok: false, error: `Provider ${providerId} unavailable.` };

  let response: Response;
  try {
    response = await fetch(`${resolved.base}/videos/${encodeURIComponent(providerJobId)}/content`, {
      method: 'GET',
      headers: COMMON_HEADERS(resolved.credential),
      // A-5: COMPOSED — the 120s download ceiling (SUSPECT clock U9) is unchanged.
      signal: AbortSignal.any([slot.signal, AbortSignal.timeout(120_000)]),
    });
  } catch (err) {
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, stopped: true };
    return { ok: false, error: `Asset download failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return { ok: false, error: `Asset HTTP ${response.status}: ${errText.slice(0, 300)}` };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    // A-5: a stop landing while tens of megabytes of mp4 are arriving surfaces here.
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, stopped: true };
    return { ok: false, error: `Asset download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (bytes.length === 0) return { ok: false, error: 'Asset download returned an empty body.' };

  const filename = `${uuidv4()}.mp4`;
  const filePath = path.join(GENERATED_DIR, filename);
  try {
    fs.writeFileSync(filePath, bytes);
  } catch (err) {
    return { ok: false, error: `Failed to write video to disk: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, filePath, filename, sizeBytes: bytes.length };
}

/**
 * Best-effort provider-side cancel. Returns true if the provider accepted it.
 *
 * A-5 — DELIBERATELY NOT REGISTERED, and this is the one media dial in the tree that must not
 * be. It is the call that ENACTS a cancel; registering it would let the very stop that asked
 * for the cancel abort the request that delivers it, leaving the provider generating (and
 * billing for) a clip nobody will ever see. The stop reaches this call by CALLING it.
 */
export async function cancelProviderVideo(providerId: string, providerJobId: string): Promise<boolean> {
  const resolved = resolveProvider(providerId);
  if (!resolved) return false;
  try {
    const response = await fetch(`${resolved.base}/videos/${encodeURIComponent(providerJobId)}/cancel`, {
      method: 'POST',
      headers: COMMON_HEADERS(resolved.credential),
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
