// Image generation backend, called only by the `image_create` tool (`agent/tools/cat/media.ts`).
// Request: OpenAI-compatible `/v1/chat/completions` with `modalities: ['image']` (what OpenRouter serves for image
// models); the image comes back as a base64 data URL in `choices[0].message.images[].image_url.url`.
// The decoded image is saved to ~/.dojo/uploads/generated/{uuid}.png; the caller gets the path plus cost and usage.

import * as effectFs from '../agent/effects/fs.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { imagePixelDimensions } from '../memory/budget.js';
import { openAgentCall, STOPPED_BY_USER, type AgentCallSlot } from '../agent/abortable-call.js';
import { homeDir } from '../home.js';
import { openAiCompatibleUrl } from './openai-compatible-url.js';

const logger = createLogger('image-gen');

export const GENERATED_IMAGES_DIR = path.join(homeDir(), '.dojo', 'uploads', 'generated');

export function ensureGeneratedImagesDir(): void {
  if (!effectFs.existsSync(GENERATED_IMAGES_DIR)) {
    effectFs.mkdirSync(GENERATED_IMAGES_DIR, { recursive: true });
    logger.info('Created generated-images directory', { path: GENERATED_IMAGES_DIR });
  }
}

export interface GenerateImageRequest {
  modelId: string;     // dojo models.id (not api_model_id)
  prompt: string;      // full prompt text to send the model
  aspectRatio?: string; // '1:1' | '16:9' | '9:16' | '4:3' | '3:4'; also appended to the prompt as prose
  // Whose stop cuts this call. Required: an optional agent id would be an un-abortable dial.
  agentId: string;
}

export interface GenerateImageSuccess {
  ok: true;
  filePath: string;    // absolute path, e.g. ~/.dojo/uploads/generated/<uuid>.png
  filename: string;    // just the <uuid>.png part
  mimeType: string;    // always 'image/png' for now
  sizeBytes: number;
  // Decoded pixel size (null when unparseable); the cost tracker prices megapixel-priced models from it.
  width: number | null;
  height: number | null;
  apiModelId: string;  // which model actually served the request
  providerId: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  notes: string[];     // any warnings surfaced to the caller
}

export interface GenerateImageError {
  ok: false;
  error: string;
  // `STOPPED` is the user's own button, not a provider failure; every other code is something that went wrong.
  code: 'MODEL_NOT_FOUND' | 'NO_CREDENTIAL' | 'CAPABILITY_MISSING' | 'HTTP_ERROR' | 'NO_IMAGE_RETURNED' | 'DECODE_ERROR' | 'WRITE_ERROR' | 'TIMEOUT' | 'STOPPED' | 'UNKNOWN';
}

export type GenerateImageResult = GenerateImageSuccess | GenerateImageError;

interface ModelRow {
  id: string;
  api_model_id: string;
  capabilities: string | null;
  provider_id: string;
  provider_type: string;
  provider_base_url: string | null;
}

function resolveChatCompletionsEndpoint(baseUrl: string | null): string {
  // The OpenRouter base is `https://openrouter.ai/api`; others may be `.../api/v1` or a bare root.
  return openAiCompatibleUrl(baseUrl, 'chat/completions');
}

// Parse "W:H" (e.g. "16:9") into a width/height ratio; null when unreadable, so callers skip the check
// rather than raise a false mismatch.
function parseAspectRatio(s: string): number | null {
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return w / h;
}

function capabilitiesInclude(capsJson: string | null, capability: string): boolean {
  if (!capsJson) return false;
  try {
    const parsed = JSON.parse(capsJson);
    return Array.isArray(parsed) && parsed.includes(capability);
  } catch {
    return false;
  }
}

// A real picture starts with its format's signature; a link or other text decoded as base64 does not.
function looksLikeImage(b: Buffer): boolean {
  return (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG')
    || (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8')
    || (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
}

// Decode a `data:image/png;base64,...` URL (or plain base64) into picture bytes; null when it is not a picture.
function decodeImageUrl(url: string): { bytes: Buffer; mimeType: string } | null {
  if (!url) return null;
  const match = url.startsWith('data:') ? url.match(/^data:([^;]+);base64,(.+)$/) : null;
  if (url.startsWith('data:') && !match) return null;
  const bytes = Buffer.from(match ? match[2] : url, 'base64');
  return looksLikeImage(bytes) ? { bytes, mimeType: (match && match[1]) || 'image/png' } : null;
}

// Image models routinely take several minutes (OpenRouter under load). Generation runs as a background job and
// image is one blocking call (no poller), so this ceiling is the whole budget.
const IMAGE_GEN_TIMEOUT_MS = 600_000;

// `AbortSignal.timeout` throws 'TimeoutError' and a manual abort 'AbortError'; either (or their stringified
// forms) means the deadline was hit, not a decode or transport error.
function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  return typeof e.message === 'string' && /aborted|timed?\s*out|timeout/i.test(e.message);
}

/**
 * The stop door: opens the call slot before the model row is read, so a stop that already landed is answered
 * by `refused` instead of a dial. The slot is released in a `finally` that no early return can skip.
 */
export async function generateImage(req: GenerateImageRequest): Promise<GenerateImageResult> {
  // `background`: the delivery outlives its turn (it waits for the agent to go idle before dialling), so the
  // turn ending must not kill it. Only the owner's own stop reaches this call.
  const slot = openAgentCall(req.agentId, 'background');
  try {
    if (slot.refused) {
      logger.info('Image generation refused: the user stopped this agent', { modelId: req.modelId });
      return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    }
    return await dialImage(req, slot);
  } finally {
    slot.release();
  }
}

async function dialImage(req: GenerateImageRequest, slot: AgentCallSlot): Promise<GenerateImageResult> {
  const startTime = Date.now();
  ensureGeneratedImagesDir();

  const db = getDb();
  const row = db.prepare(`
    SELECT m.id, m.api_model_id, m.capabilities,
           p.id AS provider_id, p.type AS provider_type, p.base_url AS provider_base_url
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(req.modelId) as ModelRow | undefined;

  if (!row) {
    return { ok: false, error: `Model not found: ${req.modelId}`, code: 'MODEL_NOT_FOUND' };
  }

  if (!capabilitiesInclude(row.capabilities, 'image_generation')) {
    return {
      ok: false,
      error: `Model ${row.api_model_id} does not have image_generation capability. ` +
             `Pick a different model in Settings → Models → Image Generation Model, or refresh capabilities on this row.`,
      code: 'CAPABILITY_MISSING',
    };
  }

  const credential = getProviderCredential(row.provider_id);
  if (!credential) {
    return {
      ok: false,
      error: `No API credential configured for provider ${row.provider_id}`,
      code: 'NO_CREDENTIAL',
    };
  }

  // Send the requested aspect ratio on every channel, since none is universal: `image_config.aspect_ratio` on the
  // body (Gemini-class models honor it) and prose appended to the prompt. Flux-class models honor neither, which
  // is why the dimension check below measures the delivered image.
  const fullPrompt = req.aspectRatio
    ? `${req.prompt}\n\nAspect ratio: ${req.aspectRatio}`
    : req.prompt;

  const endpoint = resolveChatCompletionsEndpoint(row.provider_base_url);
  // `modalities: ['image']`, not ['image', 'text']: pure image models (FLUX) return 404 if text is requested;
  // models that can also emit text (Gemini) still do.
  const requestBody: {
    model: string;
    messages: Array<{ role: 'user'; content: string }>;
    modalities: string[];
    image_config?: { aspect_ratio: string };
  } = {
    model: row.api_model_id,
    messages: [{ role: 'user', content: fullPrompt }],
    modalities: ['image'],
  };
  // Structured passthrough, sent only when a ratio was requested: models that support it clamp to their nearest
  // ratio, others ignore the field.
  if (req.aspectRatio) {
    requestBody.image_config = { aspect_ratio: req.aspectRatio };
  }

  logger.info('Generating image', {
    modelId: req.modelId,
    apiModelId: row.api_model_id,
    providerId: row.provider_id,
    endpoint,
    promptLength: fullPrompt.length,
    aspectRatio: req.aspectRatio ?? '(unset)',
  });

  // OpenRouter attribution headers; other providers ignore the extras.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential}`,
    'HTTP-Referer': 'https://dojo.dev',
    'X-Title': 'Dojo Agent Platform - Image Generation',
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      // The stop is composed with the 10-minute ceiling on one signal. `isTimeoutError` treats a bare `AbortError`
      // as the deadline, so the stop is checked FIRST or the user's button would read as a timeout.
      signal: AbortSignal.any([slot.signal, AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (slot.cutByStop()) {
      return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    }
    if (isTimeoutError(err)) {
      return {
        ok: false,
        error: `Image generation timed out after ${Math.round(IMAGE_GEN_TIMEOUT_MS / 60000)} minutes. The provider or model is slow or overloaded right now. Try again in a moment, switch the image model, or simplify the prompt.`,
        code: 'TIMEOUT',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Image generation request failed: ${msg}`, code: 'HTTP_ERROR' };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return {
      ok: false,
      error: `Image provider returned HTTP ${response.status}: ${errText.slice(0, 300)}`,
      code: 'HTTP_ERROR',
    };
  }

  let data: {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        images?: Array<{
          type?: string;
          image_url?: { url?: string };
        }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  };
  try {
    data = await response.json() as typeof data;
  } catch (err) {
    // The composed signal covers the body read too: a stop landing mid-download surfaces here, checked first.
    if (slot.cutByStop()) {
      return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    }
    // The same deadline governs the body read, so a slow provider trips here mid-stream: report it as a timeout.
    if (isTimeoutError(err)) {
      return {
        ok: false,
        error: `Image generation timed out after ${Math.round(IMAGE_GEN_TIMEOUT_MS / 60000)} minutes while receiving the image. The provider or model is slow or overloaded right now. Try again in a moment, switch the image model, or simplify the prompt.`,
        code: 'TIMEOUT',
      };
    }
    return {
      ok: false,
      error: `Failed to parse image provider response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      code: 'DECODE_ERROR',
    };
  }

  const message = data.choices?.[0]?.message;
  const imageEntry = message?.images?.[0];
  const imageUrl = imageEntry?.image_url?.url;

  if (!imageUrl) {
    return {
      ok: false,
      error: `Provider returned no image in response (message content: ${message?.content ? message.content.slice(0, 120) : '(empty)'})`,
      code: 'NO_IMAGE_RETURNED',
    };
  }

  const decoded = decodeImageUrl(imageUrl);
  if (!decoded) {
    return {
      ok: false,
      error: 'The image provider sent back something that is not a picture the Dojo can save (it has to be a PNG, JPEG, GIF or WEBP picture), so nothing was saved. Try again, or pick a different image model.',
      code: 'DECODE_ERROR',
    };
  }

  // Always saved as .png (universally compatible), whatever the source MIME.
  const filename = `${uuidv4()}.png`;
  const filePath = path.join(GENERATED_IMAGES_DIR, filename);

  try {
    effectFs.writeFileSync(filePath, decoded.bytes);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write image to disk: ${err instanceof Error ? err.message : String(err)}`,
      code: 'WRITE_ERROR',
    };
  }

  const latencyMs = Date.now() - startTime;
  const sizeBytes = decoded.bytes.length;
  const notes: string[] = [];
  const dimensions = imagePixelDimensions(decoded.bytes);

  // Tell the caller when the source MIME wasn't PNG: it is saved as .png regardless.
  if (decoded.mimeType !== 'image/png') {
    notes.push(`Provider returned ${decoded.mimeType}; saved with .png extension for portability.`);
  }

  // Aspect-ratio honesty floor: when the delivered image's ratio materially differs from the one asked for, add a
  // note so the agent can tell the user or retry. A 5% relative tolerance absorbs provider rounding; the
  // standard ratios are much further apart than that.
  if (req.aspectRatio && dimensions && dimensions.height > 0) {
    const requestedRatio = parseAspectRatio(req.aspectRatio);
    if (requestedRatio) {
      const actualRatio = dimensions.width / dimensions.height;
      const relDiff = Math.abs(actualRatio - requestedRatio) / requestedRatio;
      if (relDiff > 0.05) {
        notes.push(
          `Requested aspect ratio ${req.aspectRatio} was not honored: the provider returned ` +
          `${dimensions.width}x${dimensions.height}. This image model sizes to its own native ` +
          `output and ignores ratio hints. Tell the person you are talking to, or retry with a model that accepts a size parameter.`,
        );
        logger.info('Image aspect ratio not honored by provider', {
          modelId: req.modelId,
          apiModelId: row.api_model_id,
          requestedAspect: req.aspectRatio,
          actualWidth: dimensions.width,
          actualHeight: dimensions.height,
          relDiff: Number(relDiff.toFixed(3)),
        });
      }
    }
  }

  logger.info('Image generated successfully', {
    modelId: req.modelId,
    filePath,
    sizeBytes,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    latencyMs,
    cost: data.usage?.cost ?? null,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  });

  return {
    ok: true,
    filePath,
    filename,
    mimeType: 'image/png',
    sizeBytes,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    apiModelId: row.api_model_id,
    providerId: row.provider_id,
    costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
    notes,
  };
}
