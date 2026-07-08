// ════════════════════════════════════════
// Image Generation Backend
// ════════════════════════════════════════
//
// Low-level HTTP call to an image-generation model. Used by the Imaginer
// agent's dedicated image tool — it's NOT called directly by any other
// agent. The brain-model-text-turn path goes through `callModel` as usual;
// this module is only invoked when the `image_generate_internal` tool runs.
//
// Supported request shape: OpenAI-compatible `/v1/chat/completions` with
// `modalities: ['image', 'text']`. This is what OpenRouter serves for its
// image-output models (google/gemini-2.5-flash-image,
// openai/gpt-5-image, etc). The response has the image as a base64
// data URL in `choices[0].message.images[].image_url.url`.
//
// If the platform is ever extended to support the classic
// `/v1/images/generations` endpoint (OpenAI DALL-E, etc.) that's a
// separate code path — add a new branch here keyed on some provider
// metadata. For now, the chat-completions-with-modalities pattern is
// the most universally supported.
//
// Output: image is decoded and saved to ~/.dojo/uploads/generated/{uuid}.png
// and the caller receives the absolute path + cost/token usage.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';

const logger = createLogger('image-gen');

export const GENERATED_IMAGES_DIR = path.join(os.homedir(), '.dojo', 'uploads', 'generated');

export function ensureGeneratedImagesDir(): void {
  if (!fs.existsSync(GENERATED_IMAGES_DIR)) {
    fs.mkdirSync(GENERATED_IMAGES_DIR, { recursive: true });
    logger.info('Created generated-images directory', { path: GENERATED_IMAGES_DIR });
  }
}

export interface GenerateImageRequest {
  modelId: string;     // dojo models.id (not api_model_id)
  prompt: string;      // full prompt text to send the model
  aspectRatio?: string; // '1:1' | '16:9' | '9:16' | '4:3' | '3:4' — appended to the prompt if the provider doesn't accept a dedicated param
}

export interface GenerateImageSuccess {
  ok: true;
  filePath: string;    // absolute path, e.g. ~/.dojo/uploads/generated/<uuid>.png
  filename: string;    // just the <uuid>.png part
  mimeType: string;    // always 'image/png' for now
  sizeBytes: number;
  // Decoded pixel dimensions of the saved image. Null for formats we
  // couldn't parse (rare). Used by the cost tracker for megapixel-priced
  // image-gen models so we can compute `(W * H / 1e6) * $/MP` instead of
  // falling back to bogus token math.
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
  code: 'MODEL_NOT_FOUND' | 'NO_CREDENTIAL' | 'CAPABILITY_MISSING' | 'HTTP_ERROR' | 'NO_IMAGE_RETURNED' | 'DECODE_ERROR' | 'WRITE_ERROR' | 'TIMEOUT' | 'UNKNOWN';
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
  const root = (baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  // Common OpenRouter base is `https://openrouter.ai/api`; others may be
  // `.../api/v1` or bare root.
  if (root.toLowerCase().endsWith('/api/v1')) return `${root}/chat/completions`;
  if (root.toLowerCase().endsWith('/api')) return `${root}/v1/chat/completions`;
  return `${root}/v1/chat/completions`;
}

// Parse pixel dimensions from a raw image buffer by sniffing the file
// magic. Used by the cost tracker for megapixel-priced models.
// Returns null for unrecognized formats — caller falls back to token
// math in that case.
function getImageDimensions(bytes: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature 89 50 4E 47 0D 0A 1A 0A, then IHDR chunk with
  // width at offset 16 and height at offset 20 (both big-endian uint32).
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: starts with FF D8. Scan segments for an SOFn marker
  // (FF C0..CF, excluding C4/C8/CC which are DHT/JPG/DAC). The 5 bytes
  // after the marker are: 1 byte precision, 2 bytes height, 2 bytes
  // width — all big-endian.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      const segLen = bytes.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
  }
  // WebP: RIFF....WEBPVP8?
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const fourcc = bytes.subarray(12, 16).toString('ascii');
    if (fourcc === 'VP8X') {
      // Extended: 4-byte flags @ offset 20, then 3-byte (width-1) LE, 3-byte (height-1) LE.
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h };
    }
    if (fourcc === 'VP8L') {
      // Lossless: 1 byte signature 0x2F at offset 20, then 14-bit (width-1), 14-bit (height-1).
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
      const w = 1 + ((b1 | (b2 << 8)) & 0x3fff);
      const h = 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff);
      return { width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
      // Lossy: dimensions at offset 26 (frame tag + start code already past).
      const w = bytes.readUInt16LE(26) & 0x3fff;
      const h = bytes.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h };
    }
  }
  return null;
}

// Parse a "W:H" aspect-ratio string (e.g. "16:9") into a numeric width/height
// ratio. Returns null for anything we can't read so callers skip the check
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

// Decode a `data:image/png;base64,....` URL into raw bytes. Also handles
// plain base64 strings for providers that skip the `data:` prefix.
function decodeImageUrl(url: string): { bytes: Buffer; mimeType: string } | null {
  if (!url) return null;
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1] || 'image/png';
    try {
      return { bytes: Buffer.from(match[2], 'base64'), mimeType };
    } catch { return null; }
  }
  // Plain base64 (no data prefix)
  try {
    return { bytes: Buffer.from(url, 'base64'), mimeType: 'image/png' };
  } catch { return null; }
}

// Image models (especially routed through OpenRouter under load) routinely take
// several minutes. The old 120s cap timed out on them AND the abort fired
// mid-body-read, surfacing as a misleading "failed to parse JSON" error. Image
// generation runs as a background job (the agent already acked and ended its
// turn), so holding the request open this long is fine. Unlike video — which is
// submit-then-poll with a 30-minute poller window — image is a single blocking
// call, so this ceiling IS the budget. 10 minutes is generous without waiting
// forever on a truly hung provider.
const IMAGE_GEN_TIMEOUT_MS = 600_000;

// AbortSignal.timeout throws a DOMException named 'TimeoutError'; a manual abort
// throws 'AbortError'. Either, plus the stringified variants, means we hit the
// deadline — not a real decode/transport error.
function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  return typeof e.message === 'string' && /aborted|timed?\s*out|timeout/i.test(e.message);
}

export async function generateImage(req: GenerateImageRequest): Promise<GenerateImageResult> {
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
             `Pick a different model in Settings → Dojo → Imaginer, or refresh capabilities on this row.`,
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

  // Convey the requested aspect ratio through every channel available, because
  // none of them is universal:
  //   1. Structured: image_config.aspect_ratio on the request body (added just
  //      below). image_config-aware models (the Gemini image family) honor it.
  //   2. Prose: appended to the prompt here, for models that only read the
  //      prompt text and ignore image_config.
  // Flux-class models honor neither reliably, so the post-generation dimension
  // check further down is the honesty floor: it measures the delivered image
  // and tells the caller when the ratio was not applied.
  const fullPrompt = req.aspectRatio
    ? `${req.prompt}\n\nAspect ratio: ${req.aspectRatio}`
    : req.prompt;

  const endpoint = resolveChatCompletionsEndpoint(row.provider_base_url);
  // Use modalities: ['image'] (not ['image', 'text']). Pure image models
  // like FLUX only support image output and return 404 if text is
  // requested. Models that CAN output text alongside (Gemini) will still
  // include it even when only 'image' is specified.
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
  // Structured aspect-ratio passthrough. OpenRouter documents
  // `image_config.aspect_ratio` on the chat-completions image path; models that
  // support it (the Gemini image family) clamp to their nearest supported ratio,
  // models that do not simply ignore the field. Sent only when a ratio was
  // requested; the tool's ratios (1:1, 16:9, 9:16, 4:3, 3:4) are all within the
  // documented supported set.
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

  // OpenRouter convention (HTTP-Referer / X-Title for attribution) — safe
  // to send for non-OpenRouter providers since they just ignore extra
  // headers.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential}`,
    'HTTP-Referer': 'https://dojo.dev',
    'X-Title': 'Dojo Agent Platform - Imaginer',
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS),
    });
  } catch (err) {
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
    // The same deadline governs the body read, so a slow provider trips here
    // mid-stream. Report it as the timeout it is, not a parse failure.
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
      error: 'Failed to decode base64 image data from provider response',
      code: 'DECODE_ERROR',
    };
  }

  // Always save as .png for now. If we ever want to preserve the source
  // MIME (some providers return webp / jpeg) we can key the extension off
  // decoded.mimeType, but PNG is universally compatible.
  const filename = `${uuidv4()}.png`;
  const filePath = path.join(GENERATED_IMAGES_DIR, filename);

  try {
    fs.writeFileSync(filePath, decoded.bytes);
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
  const dimensions = getImageDimensions(decoded.bytes);

  // Surface cases where the source MIME wasn't PNG — we saved as PNG
  // regardless (browsers and Anthropic accept the extension/content
  // mismatch fine) but the caller may want to know.
  if (decoded.mimeType !== 'image/png') {
    notes.push(`Provider returned ${decoded.mimeType}; saved with .png extension for portability.`);
  }

  // Honesty floor for aspect_ratio. The ratio is requested via image_config
  // and prompt prose (see requestBody/fullPrompt above), but neither channel
  // is universal; Flux-class models ignore both and return their own native
  // size. Rather than let that pass silently,
  // measure the delivered image and, when it materially differs from what was
  // asked, tell the truth in a note the agent sees so it can inform the user or
  // retry. A relative tolerance of 5% absorbs provider rounding while still
  // catching a real mismatch (the standard ratios are far more than 5% apart).
  if (req.aspectRatio && dimensions && dimensions.height > 0) {
    const requestedRatio = parseAspectRatio(req.aspectRatio);
    if (requestedRatio) {
      const actualRatio = dimensions.width / dimensions.height;
      const relDiff = Math.abs(actualRatio - requestedRatio) / requestedRatio;
      if (relDiff > 0.05) {
        notes.push(
          `Requested aspect ratio ${req.aspectRatio} was not honored: the provider returned ` +
          `${dimensions.width}x${dimensions.height}. This image model sizes to its own native ` +
          `output and ignores ratio hints. Tell the user, or retry with a model that accepts a size parameter.`,
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
