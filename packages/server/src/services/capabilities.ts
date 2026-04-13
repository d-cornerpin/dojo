// ════════════════════════════════════════
// Model Capability Probing
// ════════════════════════════════════════
//
// Queries each provider for the true capability set of a given model
// (tools, vision, thinking, embedding) so the dashboard can render accurate
// badges and the runtime can eventually gate requests that require
// unsupported capabilities.
//
// Provider strategy:
//   - ollama            → POST /api/show (returns `capabilities` array natively)
//   - openai-compatible → if OpenRouter, GET /api/v1/models; otherwise skip
//   - anthropic         → curated map by model-id family
//   - openai            → curated map by model-id family
//   - agent-sdk         → curated Anthropic map (same underlying models)
//
// All probes are best-effort: failures return `[]` and log, never overwrite
// an existing capability set with junk.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';

const logger = createLogger('capabilities');

export type Capability = 'tools' | 'vision' | 'thinking' | 'embedding' | 'image_generation' | 'text';

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
      // Forward-compat: if a future Ollama model self-reports image
      // generation via /api/show, we recognize it. Nothing in today's
      // Ollama model catalog returns this yet, but the detection is
      // cheap and consistent with the other capability checks.
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

// Build the /models endpoint from whatever shape the provider.base_url was
// saved in. Dojo stores OpenRouter as `https://openrouter.ai/api` (see
// config.ts:662), but users may type it as the root domain or with `/api/v1`
// appended. Normalize all three shapes.
function buildOpenRouterModelsEndpoint(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');
  const lower = url.toLowerCase();
  if (lower.endsWith('/api/v1')) return `${url}/models`;
  if (lower.endsWith('/api')) return `${url}/v1/models`;
  // Bare domain (https://openrouter.ai) or anything else — construct the
  // full path from scratch.
  return `${url}/api/v1/models`;
}

async function loadOpenRouterCatalog(baseUrl: string, providerId: string): Promise<Map<string, OpenRouterModel> | null> {
  if (openRouterCache && Date.now() - openRouterCache.at < OPENROUTER_CACHE_TTL_MS) {
    return openRouterCache.models;
  }

  const endpoint = buildOpenRouterModelsEndpoint(baseUrl);

  // /api/v1/models is publicly readable, but OpenRouter rate-limits anon
  // requests aggressively and uses Referer for attribution. Send the
  // credential when we have one and always set the referer.
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

  // Vision detection: prefer the structured `input_modalities` array, but
  // fall back to the free-form `architecture.modality` string (`text->text`,
  // `text+image->text`, `text+image+video->text`) which OpenRouter has
  // populated for every model since day one.
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

  // Image generation: check `architecture.output_modalities` for 'image',
  // which OpenRouter populates for models like Gemini 2.5 Flash Image,
  // GPT-5 Image, and the Gemini 3 image previews. These models return
  // images inline in the chat completion response when the request
  // includes `modalities: ['image', 'text']`.
  const outputModalities = Array.isArray(entry.architecture?.output_modalities)
    ? entry.architecture!.output_modalities!
    : [];
  const hasImageOutput = outputModalities.includes('image') ||
    /->.*(^|\+|\s)image/.test(modalityString);
  if (hasImageOutput) {
    caps.push('image_generation');
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
        // Generic OpenAI-compatible (MiniMax, Together, etc.) — no probe.
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

// ── DB helper: read the stored capability set for a model ──
//
// Returns `[]` if the row is missing, the JSON fails to parse, or the array
// is literally empty. Callers should treat `[]` as "unknown — don't gate" so
// a failed probe never locks users out of a working model.
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
           norm === 'embedding' || norm === 'image_generation' || norm === 'text')
          && !caps.includes(norm as Capability)) {
        caps.push(norm as Capability);
      }
    }
    return caps;
  } catch {
    // JSON is corrupt — the row exists and was probed but the data is bad.
    // Default to text-only (safe) rather than [] (enable everything).
    return ['text'];
  }
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

// ── Boot backfill: probe every model whose capabilities look stale ──
//
// A row "looks stale" when EITHER of these is true:
//   1. Its normalized capability set (what the UI renders) is empty — the
//      row is literally `[]`, unparseable, or contains only non-modern
//      strings that the normalizer drops. Example: legacy Ollama rows with
//      `['chat']`.
//   2. Its raw JSON contains ANY string that isn't in the modern vocabulary
//      (`tools`/`vision`/`thinking`/`embedding`). This catches rows like
//      Anthropic's old hardcoded `['chat','code','analysis','tools']` where
//      the normalizer *would* keep `tools` — so criterion 1 alone wouldn't
//      fire — but the row is still stale and missing vision/thinking info
//      because the heuristic never detected them. One non-modern string in
//      the raw array is an unambiguous "this was written by the pre-probe
//      code path" tell.
//
// This replaces the earlier length-only check that was passing Anthropic
// models through unchanged.

const MODERN_CAPABILITY_VOCAB = new Set<string>(['tools', 'vision', 'thinking', 'embedding', 'image_generation']);

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
