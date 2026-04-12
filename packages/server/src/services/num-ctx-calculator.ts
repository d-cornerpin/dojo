// ════════════════════════════════════════
// Ollama num_ctx Auto-Sizer
// ════════════════════════════════════════
//
// Picks a RAM-aware default for Ollama's `num_ctx` (KV cache window) based
// on the model's architecture, its on-disk weights, and the host machine's
// total RAM. The computed value is stored in `models.num_ctx_recommended`
// and shown in the Settings → Models UI as the default that the user can
// override or reset back to.
//
// Formula (fp16 KV cache, conservative):
//
//   head_dim            = embedding_length / head_count
//   kv_heads            = head_count_kv || head_count          (fallback)
//   kv_bytes_per_token  = 2 * block_count * kv_heads * head_dim * 2
//   headroom            = clamp(total_ram * 0.125, 4 GiB, 8 GiB)
//   available_for_kv    = total_ram - headroom - weights_on_disk
//   raw_num_ctx         = available_for_kv / kv_bytes_per_token
//   recommended         = clamp(raw_num_ctx, 2048, model_max_ctx)
//   recommended         = round_down_to(recommended, 1024)
//
// The kv_bytes_per_token formula assumes fp16 K and V caches (2 tensors,
// 2 bytes each). Real Ollama runtimes may use Q8 or mixed precision which
// would halve the footprint, but fp16 is the safe default — a slightly
// conservative recommendation that leaves headroom beats one that OOMs.
//
// Returns `null` when:
//   • /api/show is unreachable or lacks the architecture fields we need
//   • The model's weights alone wouldn't fit in RAM minus headroom
//   • The computed num_ctx would be below 2048 (model is too tight to run)
//
// In those cases the runtime doesn't pass num_ctx at all, falling back to
// whatever the Modelfile specifies (Ollama's pre-existing behavior).

import os from 'node:os';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';

// Detect whether an Ollama base URL points at the host machine we're
// running on. Localhost → use os.totalmem(). Remote → use the user-entered
// host_ram_gb from the provider row (or skip if unset).
export function isLocalOllamaBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return true; // default Ollama baseUrl is localhost:11434
  const lower = baseUrl.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('[::1]') ||
    lower.includes('0.0.0.0')
  );
}

const logger = createLogger('num-ctx-calc');

// Bytes per element in the KV cache. fp16 = 2 bytes.
const KV_BYTES_PER_ELEMENT = 2;

// Floor and ceiling for the computed recommendation. 2048 is the smallest
// worth running any modern chat model at; 2M tokens is a sanity ceiling
// that matches the PATCH endpoint's validation cap.
const MIN_RECOMMENDED_NUM_CTX = 2048;
const MAX_RECOMMENDED_NUM_CTX = 2_097_152;

const GIB = 1024 ** 3;

export interface NumCtxComputation {
  recommended: number;
  archField: string;
  modelContext: number;
  kvBytesPerToken: number;
  weightsBytes: number;
  totalRamBytes: number;
  headroomBytes: number;
  availableForKvBytes: number;
  rawNumCtx: number;
  clampedByModelContext: boolean;
}

export interface NumCtxComputationFailure {
  reason: string;
}

function pickHeadroom(totalRamBytes: number): number {
  // 12.5% of total, clamped to [4 GiB, 8 GiB]. On a 16 GB Mac Mini this
  // leaves ~12 GB for weights+KV; on a 128 GB workstation it leaves ~120 GB.
  const adaptive = Math.floor(totalRamBytes * 0.125);
  return Math.max(4 * GIB, Math.min(8 * GIB, adaptive));
}

function floorToMultiple(n: number, multiple: number): number {
  return Math.floor(n / multiple) * multiple;
}

// ── Ollama probe helpers ──────────────────────────────────────────────

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; size: number }>;
}

async function fetchModelArchInfo(
  baseUrl: string,
  apiModelId: string,
): Promise<{ modelInfo: Record<string, unknown>; archField: string } | null> {
  const url = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${url}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: apiModelId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      logger.debug('num-ctx: /api/show non-ok', { apiModelId, status: response.status });
      return null;
    }
    const data = (await response.json()) as OllamaShowResponse;
    const modelInfo = data.model_info;
    if (!modelInfo || typeof modelInfo !== 'object') return null;

    const arch = modelInfo['general.architecture'];
    if (typeof arch !== 'string') return null;

    return { modelInfo, archField: arch };
  } catch (err) {
    logger.debug('num-ctx: /api/show failed', {
      apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function fetchModelWeightsBytes(
  baseUrl: string,
  apiModelId: string,
): Promise<number | null> {
  const url = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const data = (await response.json()) as OllamaTagsResponse;
    const entry = (data.models ?? []).find((m) => m.name === apiModelId);
    if (!entry || typeof entry.size !== 'number') return null;
    return entry.size;
  } catch (err) {
    logger.debug('num-ctx: /api/tags failed', {
      apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Main calculation ──────────────────────────────────────────────────

export async function computeRecommendedNumCtx(
  baseUrl: string,
  apiModelId: string,
  totalRamBytes: number,
): Promise<NumCtxComputation | NumCtxComputationFailure> {
  if (!Number.isFinite(totalRamBytes) || totalRamBytes <= 0) {
    return { reason: 'invalid total RAM (must be a positive number of bytes)' };
  }

  const arch = await fetchModelArchInfo(baseUrl, apiModelId);
  if (!arch) return { reason: 'could not read model architecture from /api/show' };

  const mi = arch.modelInfo;
  const archField = arch.archField;

  const blockCount = mi[`${archField}.block_count`];
  const headCount = mi[`${archField}.attention.head_count`];
  const headCountKvRaw = mi[`${archField}.attention.head_count_kv`];
  const embeddingLength = mi[`${archField}.embedding_length`];
  const modelContextRaw = mi[`${archField}.context_length`];

  if (typeof blockCount !== 'number' ||
      typeof headCount !== 'number' ||
      typeof embeddingLength !== 'number') {
    return {
      reason: `missing required arch fields (block_count, head_count, embedding_length) for ${archField}`,
    };
  }
  if (headCount === 0) {
    return { reason: 'head_count is zero' };
  }

  // Missing head_count_kv → fall back to full attention (head_count). This
  // is the safe direction: we'd rather recommend a smaller num_ctx than
  // an impossibly large one. Modern GQA models that omit this field will
  // still get a workable (if conservative) recommendation.
  const headCountKv = typeof headCountKvRaw === 'number' && headCountKvRaw > 0
    ? headCountKvRaw
    : headCount;

  const headDim = embeddingLength / headCount;
  const kvBytesPerToken = 2 /* K + V */ * blockCount * headCountKv * headDim * KV_BYTES_PER_ELEMENT;

  if (!Number.isFinite(kvBytesPerToken) || kvBytesPerToken <= 0) {
    return { reason: 'computed kv_bytes_per_token is non-positive or NaN' };
  }

  const weightsBytes = await fetchModelWeightsBytes(baseUrl, apiModelId);
  if (weightsBytes === null) {
    return { reason: 'could not read model weights size from /api/tags' };
  }

  const headroomBytes = pickHeadroom(totalRamBytes);
  const availableForKvBytes = totalRamBytes - headroomBytes - weightsBytes;

  if (availableForKvBytes <= 0) {
    return {
      reason: `model weights (${(weightsBytes / GIB).toFixed(1)} GiB) + headroom (${(headroomBytes / GIB).toFixed(1)} GiB) exceed total RAM (${(totalRamBytes / GIB).toFixed(1)} GiB)`,
    };
  }

  const rawNumCtx = Math.floor(availableForKvBytes / kvBytesPerToken);
  // Model's advertised max context, if present. Clamp so we never
  // recommend more than the model actually supports.
  const modelMaxContext = typeof modelContextRaw === 'number' ? modelContextRaw : MAX_RECOMMENDED_NUM_CTX;
  const capped = Math.min(rawNumCtx, modelMaxContext, MAX_RECOMMENDED_NUM_CTX);

  if (capped < MIN_RECOMMENDED_NUM_CTX) {
    return {
      reason: `computed num_ctx ${capped} is below minimum ${MIN_RECOMMENDED_NUM_CTX} — machine too small for this model`,
    };
  }

  // Round down to the nearest 1024 for a cleaner number.
  const recommended = floorToMultiple(capped, 1024);

  return {
    recommended,
    archField,
    modelContext: typeof modelContextRaw === 'number' ? modelContextRaw : 0,
    kvBytesPerToken,
    weightsBytes,
    totalRamBytes,
    headroomBytes,
    availableForKvBytes,
    rawNumCtx,
    clampedByModelContext: rawNumCtx > modelMaxContext,
  };
}

// ── DB helper: resolve provider info + persist for one model ─────────

// Resolve the right "total RAM" for an Ollama provider:
//   • Localhost → native os.totalmem() (the dojo host IS the Ollama host)
//   • Remote + host_ram_gb set → user-entered value × 1024³
//   • Remote + host_ram_gb null → return null (can't auto-size, skip)
export function resolveOllamaTotalRamBytes(
  baseUrl: string | null,
  hostRamGb: number | null,
): number | null {
  if (isLocalOllamaBaseUrl(baseUrl)) {
    return os.totalmem();
  }
  if (typeof hostRamGb === 'number' && hostRamGb > 0) {
    return hostRamGb * GIB;
  }
  return null;
}

export async function computeAndStoreRecommendedNumCtx(modelId: string): Promise<number | null> {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.api_model_id, p.type AS provider_type, p.base_url AS provider_base_url, p.host_ram_gb AS host_ram_gb
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId) as {
    api_model_id: string;
    provider_type: string;
    provider_base_url: string | null;
    host_ram_gb: number | null;
  } | undefined;

  if (!row) return null;
  if (row.provider_type !== 'ollama') return null;

  const baseUrl = row.provider_base_url ?? 'http://localhost:11434';
  const totalRamBytes = resolveOllamaTotalRamBytes(row.provider_base_url, row.host_ram_gb);

  if (totalRamBytes === null) {
    logger.info('num-ctx: remote Ollama provider missing host_ram_gb — skipping', {
      modelId,
      apiModelId: row.api_model_id,
      baseUrl,
    });
    // Clear any stale recommendation so the UI shows "default" rather
    // than a leftover value from a previous run / previous RAM setting.
    db.prepare("UPDATE models SET num_ctx_recommended = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(modelId);
    return null;
  }

  const result = await computeRecommendedNumCtx(baseUrl, row.api_model_id, totalRamBytes);

  if ('reason' in result) {
    logger.info('num-ctx: recommendation not computed', {
      modelId,
      apiModelId: row.api_model_id,
      reason: result.reason,
    });
    db.prepare("UPDATE models SET num_ctx_recommended = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(modelId);
    return null;
  }

  db.prepare("UPDATE models SET num_ctx_recommended = ?, updated_at = datetime('now') WHERE id = ?")
    .run(result.recommended, modelId);

  logger.info('num-ctx: stored recommendation', {
    modelId,
    apiModelId: row.api_model_id,
    recommended: result.recommended,
    ramSource: isLocalOllamaBaseUrl(row.provider_base_url) ? 'localhost' : 'provider.host_ram_gb',
    weightsGiB: (result.weightsBytes / GIB).toFixed(2),
    totalRamGiB: (result.totalRamBytes / GIB).toFixed(2),
    headroomGiB: (result.headroomBytes / GIB).toFixed(2),
    kvBytesPerToken: result.kvBytesPerToken,
    clampedByModelContext: result.clampedByModelContext,
  });

  return result.recommended;
}

// Recompute num_ctx recommendations for every Ollama model on a single
// provider. Called from the PATCH /providers/:id/host-ram endpoint so the
// UI sees fresh numbers immediately after the user updates their remote
// machine's RAM. Blocking since there are usually only a handful of
// models per provider and each call is local math + a local /api/show.
export async function recomputeAllModelsForProvider(providerId: string): Promise<{ probed: number; populated: number }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id FROM models WHERE provider_id = ?",
  ).all(providerId) as Array<{ id: string }>;

  let probed = 0;
  let populated = 0;
  for (const r of rows) {
    try {
      const rec = await computeAndStoreRecommendedNumCtx(r.id);
      probed++;
      if (rec !== null) populated++;
    } catch (err) {
      logger.warn('num-ctx: recompute failed for model', {
        modelId: r.id,
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('num-ctx: recomputed all models for provider', { providerId, probed, populated });
  return { probed, populated };
}

// ── Boot backfill: compute for every Ollama row missing a recommendation ──

export async function backfillRecommendedNumCtx(): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE p.type = 'ollama'
      AND m.id != 'auto'
      AND m.num_ctx_recommended IS NULL
  `).all() as Array<{ id: string }>;

  if (rows.length === 0) {
    logger.info('num-ctx backfill: nothing to compute');
    return;
  }

  logger.info('num-ctx backfill starting', { count: rows.length });

  let populated = 0;
  for (const r of rows) {
    try {
      const rec = await computeAndStoreRecommendedNumCtx(r.id);
      if (rec !== null) populated++;
    } catch (err) {
      logger.warn('num-ctx backfill: compute failed', {
        modelId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('num-ctx backfill complete', { probed: rows.length, populated });
}
