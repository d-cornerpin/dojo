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
  code: 'MODEL_NOT_FOUND' | 'NO_CREDENTIAL' | 'CAPABILITY_MISSING' | 'HTTP_ERROR' | 'NO_IMAGE_RETURNED' | 'DECODE_ERROR' | 'WRITE_ERROR' | 'UNKNOWN';
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

  // Build the prompt. Some image models honor an explicit aspect ratio in
  // the request parameters, others only understand it from the prompt
  // text. OpenRouter passes this through, so mentioning the ratio in the
  // prompt is the safest portable approach.
  const fullPrompt = req.aspectRatio
    ? `${req.prompt}\n\nAspect ratio: ${req.aspectRatio}`
    : req.prompt;

  const endpoint = resolveChatCompletionsEndpoint(row.provider_base_url);
  const requestBody = {
    model: row.api_model_id,
    messages: [{ role: 'user', content: fullPrompt }],
    modalities: ['image', 'text'],
  };

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
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
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

  // Surface cases where the source MIME wasn't PNG — we saved as PNG
  // regardless (browsers and Anthropic accept the extension/content
  // mismatch fine) but the caller may want to know.
  if (decoded.mimeType !== 'image/png') {
    notes.push(`Provider returned ${decoded.mimeType}; saved with .png extension for portability.`);
  }

  logger.info('Image generated successfully', {
    modelId: req.modelId,
    filePath,
    sizeBytes,
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
    apiModelId: row.api_model_id,
    providerId: row.provider_id,
    costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs,
    notes,
  };
}
