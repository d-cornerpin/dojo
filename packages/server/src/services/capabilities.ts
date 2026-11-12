// Model capability probing: asks each provider for a model's true capability set (tools, vision, thinking,
// embedding, ...) so the dashboard shows accurate badges. Probes are best-effort: a failure returns `[]` and logs,
// and never overwrites an existing capability set.
// ollama: POST /api/show. openai-compatible: OpenRouter's GET /api/v1/models, otherwise no probe.
// anthropic and openai: curated maps by model-id family. agent-sdk: the curated Anthropic map.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';

const logger = createLogger('capabilities');

export type Capability =
  | 'tools'
  | 'vision'
  | 'thinking'
  | 'embedding'
  | 'image_generation'
  | 'video_generation'
  // Speech synthesis (drives `tts_create`), distinct from music_generation.
  | 'audio_generation'
  // Music / sound-effect composition from a creative prompt (a different request shape from TTS).
  | 'music_generation'
  | 'transcription'
  | 'text';

export interface ProbeInput {
  providerId: string;
  providerType: string;
  providerBaseUrl: string | null;
  apiModelId: string;
}

// ── Curated maps for providers that don't self-report ──

// Anthropic: all Claude 3+ models support tools + vision. Thinking is
// enabled on claude-3-7-sonnet and claude-opus-4/4.5/4.6 / sonnet-4/4.5/4.6.
function anthropicCapabilities(apiModelId: string): Capability[] {
  const id = apiModelId.toLowerCase();
  const caps: Capability[] = [];

  // All Claude chat models (claude-3, claude-3-5, claude-3-7, claude-4*) support tools + vision
  if (id.includes('claude')) {
    caps.push('tools', 'vision');
  }

  // Extended thinking models
  if (
    id.includes('claude-3-7') ||
    id.includes('claude-opus-4') ||
    id.includes('claude-sonnet-4') ||
    id.includes('claude-haiku-4-5') ||
    id.includes('claude-haiku-4.5')
  ) {
    caps.push('thinking');
  }

  return caps;
}

// OpenAI: GPT-4 family supports tools + vision. o1/o3/o4 are reasoning
// (thinking) models. Embedding models are embedding-only.
function openaiCapabilities(apiModelId: string): Capability[] {
  const id = apiModelId.toLowerCase();
  const caps: Capability[] = [];

  if (id.includes('embedding') || id.startsWith('text-embedding')) {
    return ['embedding'];
  }

  // Tool-capable chat models
  if (
    id.includes('gpt-4') ||
    id.includes('gpt-5') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4')
  ) {
    caps.push('tools');
  }

  // Vision-capable (gpt-4o*, gpt-4.1*, gpt-4-turbo with vision, gpt-5*)
  if (
    id.includes('gpt-4o') ||
    id.includes('gpt-4.1') ||
    id.includes('gpt-4-turbo') ||
    id.includes('gpt-5')
  ) {
    caps.push('vision');
  }

  // Reasoning / thinking models
  if (id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) {
    caps.push('thinking');
  }

  return caps;
}

// ── Ollama probe: /api/show returns capabilities directly ──

async function probeOllama(baseUrl: string, apiModelId: string): Promise<Capability[]> {
  const url = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${url}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: apiModelId }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.debug('Ollama /api/show returned non-ok', { apiModelId, status: response.status });
      return [];
    }

    const data = await response.json() as { capabilities?: string[] };
    const raw = Array.isArray(data.capabilities) ? data.capabilities : [];

    const caps: Capability[] = [];
    for (const c of raw) {
      const norm = c.toLowerCase();
      if (norm === 'tools' && !caps.includes('tools')) caps.push('tools');
      if (norm === 'vision' && !caps.includes('vision')) caps.push('vision');
      if (norm === 'thinking' && !caps.includes('thinking')) caps.push('thinking');
      if (norm === 'embedding' && !caps.includes('embedding')) caps.push('embedding');
      // Forward-compat: recognize image generation if /api/show ever self-reports it.
      if ((norm === 'image_generation' || norm === 'image-generation' || norm === 'image') &&
          !caps.includes('image_generation')) {
        caps.push('image_generation');
      }
    }

    return caps;
  } catch (err) {
    logger.debug('Ollama probe failed', {
      apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ── OpenRouter probe: /api/v1/models has per-model metadata ──

interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
}

let openRouterCache: { at: number; models: Map<string, OpenRouterModel> } | null = null;
const OPENROUTER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Build the /models endpoint from whatever shape provider.base_url was saved in (root domain, `/api` or `/api/v1`).
// The output_modalities union is required: the default (text only) omits image, video and audio-only generators,
// so the probe could not find them. The browse and pricing-sync fetches send the same param.
function buildOpenRouterModelsEndpoint(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');
  const lower = url.toLowerCase();
  const modalities = '?output_modalities=text,image,audio,video';
  if (lower.endsWith('/api/v1')) return `${url}/models${modalities}`;
  if (lower.endsWith('/api')) return `${url}/v1/models${modalities}`;
  // Bare domain or anything else: build the full path.
  return `${url}/api/v1/models${modalities}`;
}

async function loadOpenRouterCatalog(baseUrl: string, providerId: string): Promise<Map<string, OpenRouterModel> | null> {
  if (openRouterCache && Date.now() - openRouterCache.at < OPENROUTER_CACHE_TTL_MS) {
    return openRouterCache.models;
  }

  const endpoint = buildOpenRouterModelsEndpoint(baseUrl);

  // The endpoint is public but rate-limits anonymous requests and uses Referer for attribution: send the
  // credential when there is one and always set the referer.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://dojo.dev',
    'X-Title': 'Dojo Agent Platform',
  };
  try {
    const credential = getProviderCredential(providerId);
    if (credential) headers['Authorization'] = `Bearer ${credential}`;
  } catch { /* no credential is fine, endpoint is public */ }

  try {
    const response = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('OpenRouter catalog fetch returned non-ok', {
        endpoint,
        status: response.status,
        body: body.slice(0, 200),
      });
      return null;
    }
    const data = await response.json() as { data?: OpenRouterModel[] };
    const list = Array.isArray(data.data) ? data.data : [];
    const map = new Map<string, OpenRouterModel>();
    for (const m of list) {
      if (m?.id) map.set(m.id, m);
    }
    openRouterCache = { at: Date.now(), models: map };
    logger.info('OpenRouter catalog loaded', { endpoint, modelCount: map.size });
    return map;
  } catch (err) {
    logger.warn('OpenRouter catalog fetch failed', {
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function probeOpenRouter(baseUrl: string, providerId: string, apiModelId: string): Promise<Capability[]> {
  const catalog = await loadOpenRouterCatalog(baseUrl, providerId);
  if (!catalog) return [];

  const entry = catalog.get(apiModelId);
  if (!entry) {
    logger.warn('OpenRouter: model not found in catalog', {
      apiModelId,
      hint: 'Check the api_model_id in Settings → Models matches an id from https://openrouter.ai/models exactly',
    });
    return [];
  }

  const caps: Capability[] = [];
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];

  if (params.includes('tools')) {
    caps.push('tools');
  }

  // Vision: prefer the structured `input_modalities`, else the free-form `architecture.modality` string
  // (`text+image->text`).
  const inputModalities = Array.isArray(entry.architecture?.input_modalities)
    ? entry.architecture!.input_modalities!
    : [];
  const modalityString = typeof entry.architecture?.modality === 'string'
    ? entry.architecture!.modality!.toLowerCase()
    : '';
  const hasVision = inputModalities.includes('image') || /(^|\+|\s)image/.test(modalityString);
  if (hasVision) {
    caps.push('vision');
  }

  // OpenRouter exposes reasoning-capable models via `supported_parameters`.
  if (params.includes('reasoning') || params.includes('include_reasoning')) {
    caps.push('thinking');
  }

  // Output modalities: prefer `output_modalities`; the free-form `modality` string is the fallback for older
  // catalog entries.
  const outputModalities = Array.isArray(entry.architecture?.output_modalities)
    ? entry.architecture!.output_modalities!
    : [];

  // Image generation: Gemini 2.5 Flash Image, GPT-5 Image, etc.
  const hasImageOutput = outputModalities.includes('image') ||
    /->.*(^|\+|\s)image/.test(modalityString);
  if (hasImageOutput) {
    caps.push('image_generation');
  }

  // Video generation: Sora 2, Veo 3, Runway, etc.
  const hasVideoOutput = outputModalities.includes('video') ||
    /->.*(^|\+|\s)video/.test(modalityString);
  if (hasVideoOutput) {
    caps.push('video_generation');
  }

  // Audio output is TTS (`audio_generation`, drives `tts_create`) or music (`music_generation`). The modality
  // alone cannot tell them apart, so a name allowlist routes known music models and the rest default to TTS.
  // The ModelRow Edit button overrides a wrong guess.
  const hasAudioOutput = outputModalities.includes('audio') ||
    /->.*(^|\+|\s)audio/.test(modalityString);
  if (hasAudioOutput) {
    const idLower = (entry.id ?? '').toLowerCase();
    const isMusicModel = /\b(lyria|suno|musicgen|audiocraft|stable-?audio|riffusion|mubert|udio)\b/.test(idLower);
    if (isMusicModel) {
      caps.push('music_generation');
    } else {
      caps.push('audio_generation');
    }
  }

  const hasAudioInput = inputModalities.includes('audio') ||
    /(^|\+|\s)audio.*->/.test(modalityString);
  // Transcription only when audio goes in AND text comes out (and audio
  // doesn't come out, which would be a voice-conversion model, not STT).
  if (hasAudioInput && !hasAudioOutput) {
    caps.push('transcription');
  }

  return caps;
}

// ── Dispatcher ──

function isOpenRouter(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  return baseUrl.toLowerCase().includes('openrouter.ai');
}

export async function probeModelCapabilities(input: ProbeInput): Promise<Capability[]> {
  const { providerId, providerType, providerBaseUrl, apiModelId } = input;

  try {
    switch (providerType) {
      case 'ollama': {
        const url = providerBaseUrl ?? 'http://localhost:11434';
        return await probeOllama(url, apiModelId);
      }
      case 'anthropic':
        return anthropicCapabilities(apiModelId);
      case 'openai':
        return openaiCapabilities(apiModelId);
      case 'agent-sdk':
        // Agent SDK talks to the same Claude models as the Anthropic provider.
        return anthropicCapabilities(apiModelId);
      case 'openai-compatible': {
        if (isOpenRouter(providerBaseUrl)) {
          return await probeOpenRouter(providerBaseUrl!, providerId, apiModelId);
        }
        // Generic OpenAI-compatible (MiniMax, Together, etc.): no probe.
        return [];
      }
      default:
        return [];
    }
  } catch (err) {
    logger.warn('Capability probe threw unexpectedly', {
      providerType,
      apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// Read the stored capability set. `[]` (missing row, empty or unparseable array) means "unknown, don't gate",
// so a failed probe never locks users out of a working model.
export function getModelCapabilities(modelId: string): Capability[] {
  const db = getDb();
  const row = db.prepare('SELECT capabilities FROM models WHERE id = ?').get(modelId) as
    | { capabilities: string }
    | undefined;
  // No row at all → model not in DB, don't gate (unknown model)
  if (!row) return [];
  // Row exists but capabilities column is empty/null → not yet probed, don't gate
  if (!row.capabilities) return [];
  try {
    const parsed = JSON.parse(row.capabilities);
    if (!Array.isArray(parsed)) return [];
    const caps: Capability[] = [];
    for (const c of parsed) {
      if (typeof c !== 'string') continue;
      const norm = c.toLowerCase();
      if ((norm === 'tools' || norm === 'vision' || norm === 'thinking' ||
           norm === 'embedding' || norm === 'image_generation' ||
           norm === 'video_generation' || norm === 'audio_generation' ||
           norm === 'music_generation' || norm === 'transcription' ||
           norm === 'text')
          && !caps.includes(norm as Capability)) {
        caps.push(norm as Capability);
      }
    }
    return caps;
  } catch {
    // JSON is corrupt: the row exists and was probed but the data is bad.
    // Default to text-only (safe) rather than [] (enable everything).
    return ['text'];
  }
}

// Called when a provider response proves the model cannot do `cap` (e.g. a 404 "no endpoints found that support
// image input"): drop it from the stored set so the pre-flight gate catches it later. An absent cap is a no-op.
export function removeCapability(modelId: string, cap: Capability): boolean {
  const current = getModelCapabilities(modelId);
  if (current.length === 0) {
    // Unknown caps: set the row to "everything except this cap" so the gate
    // becomes meaningful. Defaults match what most modern chat models can do.
    const inferred: Capability[] = (['text', 'tools', 'vision', 'thinking'] as Capability[]).filter(c => c !== cap);
    const db = getDb();
    db.prepare("UPDATE models SET capabilities = ?, updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(inferred), modelId,
    );
    logger.warn('Capability removed via runtime correction (caps were unknown — inferred default minus cap)', {
      modelId, removedCap: cap, newCaps: inferred,
    });
    return true;
  }
  if (!current.includes(cap)) return false;
  const next = current.filter(c => c !== cap);
  const db = getDb();
  db.prepare("UPDATE models SET capabilities = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(next), modelId,
  );
  logger.warn('Capability removed via runtime correction', {
    modelId, removedCap: cap, oldCaps: current, newCaps: next,
  });
  return true;
}

// ── DB helper: resolve provider info + persist capabilities for one model ──

export async function probeAndStoreCapabilities(modelId: string): Promise<Capability[]> {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.id, m.api_model_id, p.id AS provider_id, p.type AS provider_type, p.base_url AS provider_base_url
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId) as {
    id: string;
    api_model_id: string;
    provider_id: string;
    provider_type: string;
    provider_base_url: string | null;
  } | undefined;

  if (!row) return [];

  const caps = await probeModelCapabilities({
    providerId: row.provider_id,
    providerType: row.provider_type,
    providerBaseUrl: row.provider_base_url,
    apiModelId: row.api_model_id,
  });

  if (caps.length > 0) {
    db.prepare("UPDATE models SET capabilities = ?, updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(caps),
      modelId,
    );
    logger.info('Capabilities probed and stored', {
      modelId,
      apiModelId: row.api_model_id,
      providerType: row.provider_type,
      capabilities: caps,
    });
  } else {
    logger.debug('Capability probe returned empty — leaving existing value in place', {
      modelId,
      apiModelId: row.api_model_id,
      providerType: row.provider_type,
    });
  }

  return caps;
}

// Boot backfill: probe every model whose capabilities look stale, i.e. (1) the normalized set is empty (`[]`,
// unparseable, or only non-modern strings such as legacy Ollama `['chat']`), or (2) the raw JSON holds any string
// outside the modern vocabulary, which marks a row written by the pre-probe code path even when the
// normalizer would keep `tools`.

const MODERN_CAPABILITY_VOCAB = new Set<string>([
  'tools',
  'vision',
  'thinking',
  'embedding',
  'image_generation',
  'video_generation',
  'audio_generation',
  'music_generation',
  'transcription',
]);

export async function backfillEmptyCapabilities(): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, capabilities FROM models WHERE id != 'auto'
  `).all() as Array<{ id: string; capabilities: string }>;

  const needsBackfill = rows.filter(r => {
    const normalized = getModelCapabilities(r.id);
    if (normalized.length === 0) return true;

    // Criterion 2: raw array contains any non-modern-vocab string → legacy.
    try {
      const raw = JSON.parse(r.capabilities);
      if (Array.isArray(raw)) {
        for (const c of raw) {
          if (typeof c === 'string' && !MODERN_CAPABILITY_VOCAB.has(c)) {
            return true;
          }
        }
      }
    } catch {
      return true;
    }

    return false;
  });

  if (needsBackfill.length === 0) {
    logger.info('Capability backfill: no models need probing');
    return;
  }

  logger.info('Capability backfill starting', {
    count: needsBackfill.length,
    total: rows.length,
  });

  let probed = 0;
  let populated = 0;
  for (const r of needsBackfill) {
    try {
      const caps = await probeAndStoreCapabilities(r.id);
      probed++;
      if (caps.length > 0) populated++;
    } catch (err) {
      logger.warn('Capability backfill: probe failed', {
        modelId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Capability backfill complete', { probed, populated });
}
