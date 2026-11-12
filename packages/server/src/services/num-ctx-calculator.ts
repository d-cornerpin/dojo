// Ollama num_ctx auto-sizer: a RAM-aware default for `num_ctx` (the KV cache window), stored in
// `models.num_ctx_recommended` and shown in Settings as the default the user can override or reset to.
//
//   kv_bytes_per_token = 2 * block_count * kv_heads * head_dim * 2   (fp16 K and V, see kv-bytes.ts)
//   available_for_kv   = total_ram - desktop_reserve - engine_reserve - other_resident_weights - weights
//   recommended        = floor_to_1024(clamp(available_for_kv / kv_bytes_per_token, 2048, model_max_ctx))
//
// Fails (no recommendation, so no num_ctx is sent) only on invalid total RAM, an unreadable /api/show or
// /api/tags, missing arch fields, or a model not installed. A box too tight for a useful window
// gets the 2048 floor, never silence: no num_ctx means the Modelfile default, i.e. the full trained context.

import os from 'node:os';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { kvBytesPerTokenOf } from './kv-bytes.js';
import { STANDARD_TAGS } from './local-standard.js';
import { dojoWorkingBytes } from './dojo-working-memory.js';
import { isThisMachineUrl } from '../agent/stream-patience.js';

// Whether an Ollama base URL points at the machine we run on (an unset URL is the default localhost).
export function isLocalOllamaBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return true; // default Ollama baseUrl is localhost:11434
  // The parsed hostname decides, never a substring (`http://localhost@gpu-box` is gpu-box); the one rule
  // lives in `agent/stream-patience.ts`.
  return isThisMachineUrl(baseUrl);
}

const logger = createLogger('num-ctx-calc');

// Floor and ceiling: 2048 is the smallest useful chat window; 2M matches the cap of the
// PATCH /models/:id/num-ctx route in gateway/routes/config.ts.
export const MIN_RECOMMENDED_NUM_CTX = 2048;
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

/**
 * A recommendation is a promise that the box can still work while the model is loaded, so it is
 * budgeted against everything else the box must keep running (desktop session, engine, other resident
 * models), not against installed RAM minus this model's weights.
 */
export interface ObligationsInput {
  readonly totalRamBytes: number;
  readonly weightsBytes: number;
  /**
   * The weights of OTHER local models this box keeps resident (the embedder above all). Ollama's
   * `keep_alive` keeps them loaded, so the machine holds the sum.
   */
  readonly otherResidentWeightsBytes: number;
}

/**
 * The desktop session's reserve: 30% of installed RAM, floored at 6 GiB (macOS plus a browser and a
 * screen-sharing session is a multi-gigabyte obligation) and capped at 12 GiB for large workstations.
 */
export function pickDesktopReserve(totalRamBytes: number): number {
  const proportional = Math.floor(totalRamBytes * 0.30);
  return Math.max(6 * GIB, Math.min(12 * GIB, proportional));
}

export const ENGINE_RESERVE_BYTES = Math.floor(1.5 * GIB);

/**
 * How many bytes this model's KV cache may have after everything the box owes elsewhere. Negative means
 * the model cannot be loaded here with a useful window; the caller turns that into the floor.
 */
export function kvBudgetBytes(input: ObligationsInput): number {
  return input.totalRamBytes
    - pickDesktopReserve(input.totalRamBytes)
    - ENGINE_RESERVE_BYTES
    - Math.max(0, input.otherResidentWeightsBytes)
    - Math.max(0, input.weightsBytes);
}

function pickHeadroom(totalRamBytes: number): number {
  // Reporting only: the headroom of the earlier policy, logged beside the current budget. No decision
  // uses it; `availableForKvBytes` is the policy.
  const adaptive = Math.floor(totalRamBytes * 0.125);
  return Math.max(4 * GIB, Math.min(8 * GIB, adaptive));
}

function floorToMultiple(n: number, multiple: number): number {
  return Math.floor(n / multiple) * multiple;
}


interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; size: number }>;
}

export async function fetchModelArchInfo(
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

async function fetchInstalledModels(
  baseUrl: string,
): Promise<Array<{ name: string; size: number }> | null> {
  const url = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).filter((m) => typeof m.size === 'number');
  } catch (err) {
    logger.debug('num-ctx: /api/tags failed', {
      baseUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The weights of the OTHER enabled local models on this box, which Ollama keeps resident once used.
 * Read from what the platform has registered, not from what is loaded this second: a recommendation is
 * a steady-state promise. Best-effort: an unreadable model table gives zero here.
 */
export function otherResidentWeights(
  thisApiModelId: string,
  installed: ReadonlyArray<{ name: string; size: number }>,
  enabledApiModelIds: ReadonlyArray<string>,
): number {
  // Sizes come from the runtime's `/api/tags`, which is already fetched for this model's own weights.
  const enabled = new Set(enabledApiModelIds.filter((id) => id !== thisApiModelId));
  return installed
    .filter((m) => enabled.has(m.name))
    .reduce((sum, m) => sum + (typeof m.size === 'number' ? m.size : 0), 0);
}

/** The enabled local models this box has REGISTERED, which is what Ollama will keep resident. */
function enabledOllamaApiModelIds(): string[] {
  try {
    const rows = getDb().prepare(`
      SELECT m.api_model_id AS apiModelId
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE p.type = 'ollama' AND m.is_enabled = 1
    `).all() as Array<{ apiModelId: string }>;
    return rows.map((r) => r.apiModelId);
  } catch {
    // Best-effort: an unreadable model table still leaves the desktop and engine reserves.
    return [];
  }
}


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

  const modelContextRaw = mi[`${archField}.context_length`];
  // The per-token KV arithmetic (fp16, GQA-aware) lives in `kv-bytes.ts`, shared with the fit gate.
  const kv = kvBytesPerTokenOf(mi, archField);
  if (typeof kv !== 'number') return kv;
  const kvBytesPerToken = kv;

  const installed = await fetchInstalledModels(baseUrl);
  if (installed === null) {
    return { reason: 'could not read installed models from /api/tags' };
  }
  const thisEntry = installed.find((m) => m.name === apiModelId);
  if (!thisEntry) {
    return { reason: `model ${apiModelId} is not installed on the Ollama host` };
  }
  const weightsBytes = thisEntry.size;

  const headroomBytes = pickHeadroom(totalRamBytes);
  // Budget against the box's obligations (see `kvBudgetBytes`). On the Dojo's own box a model is also not
  // sized into the room the Dojo's writer needs for its largest job.
  const otherResidentWeightsBytes = otherResidentWeights(apiModelId, installed, enabledOllamaApiModelIds())
    + (isLocalOllamaBaseUrl(baseUrl) && !STANDARD_TAGS.includes(apiModelId) ? await dojoWorkingBytes(baseUrl) : 0);
  const availableBytes = kvBudgetBytes({
    totalRamBytes, weightsBytes, otherResidentWeightsBytes,
  });
  logger.info('num-ctx: budgeting against the box\'s obligations', {
    apiModelId,
    totalRamGiB: +(totalRamBytes / GIB).toFixed(1),
    desktopReserveGiB: +(pickDesktopReserve(totalRamBytes) / GIB).toFixed(1),
    engineReserveGiB: +(ENGINE_RESERVE_BYTES / GIB).toFixed(1),
    otherResidentWeightsGiB: +(otherResidentWeightsBytes / GIB).toFixed(1),
    weightsGiB: +(weightsBytes / GIB).toFixed(1),
    availableForKvGiB: +(availableBytes / GIB).toFixed(1),
    previousPolicyAvailableGiB: +((totalRamBytes - headroomBytes - weightsBytes) / GIB).toFixed(1),
  });

  if (availableBytes <= 0) {
    // Fail closed: a NULL recommendation sends no `num_ctx`, so Ollama would use the Modelfile default
    // (often the full trained context), most dangerous on the tightest box. The floor is the answer.
    logger.warn('num-ctx: the box has no room for a KV cache after its obligations — recommending the floor', {
      apiModelId,
      totalRamGiB: +(totalRamBytes / GIB).toFixed(1),
      weightsGiB: +(weightsBytes / GIB).toFixed(1),
    });
    return {
      recommended: MIN_RECOMMENDED_NUM_CTX,
      archField,
      modelContext: typeof modelContextRaw === 'number' ? modelContextRaw : 0,
      kvBytesPerToken,
      weightsBytes,
      totalRamBytes,
      headroomBytes,
      availableForKvBytes: 0,
      rawNumCtx: 0,
      clampedByModelContext: false,
    };
  }

  const rawNumCtx = Math.floor(availableBytes / kvBytesPerToken);
  // Clamp to the model's advertised max context.
  const modelMaxContext = typeof modelContextRaw === 'number' ? modelContextRaw : MAX_RECOMMENDED_NUM_CTX;
  const capped = Math.min(rawNumCtx, modelMaxContext, MAX_RECOMMENDED_NUM_CTX);

  if (capped < MIN_RECOMMENDED_NUM_CTX) {
    // Same fail-closed direction: a window below the floor is still a bound, and recommending nothing
    // would mean unlimited.
    logger.warn('num-ctx: computed window is below the floor — recommending the floor rather than nothing', {
      apiModelId, computed: capped, floor: MIN_RECOMMENDED_NUM_CTX,
    });
    return {
      recommended: MIN_RECOMMENDED_NUM_CTX,
      archField,
      modelContext: typeof modelContextRaw === 'number' ? modelContextRaw : 0,
      kvBytesPerToken,
      weightsBytes,
      totalRamBytes,
      headroomBytes,
      availableForKvBytes: availableBytes,
      rawNumCtx,
      clampedByModelContext: false,
    };
  }

  const recommended = floorToMultiple(capped, 1024);

  return {
    recommended,
    archField,
    modelContext: typeof modelContextRaw === 'number' ? modelContextRaw : 0,
    kvBytesPerToken,
    weightsBytes,
    totalRamBytes,
    headroomBytes,
    availableForKvBytes: availableBytes,
    rawNumCtx,
    clampedByModelContext: rawNumCtx > modelMaxContext,
  };
}


// Total RAM for an Ollama provider: this machine's RAM when local, else the user-entered `host_ram_gb`
// (null when unset, so the model cannot be auto-sized).
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
    // Clear any stale recommendation so the UI shows "default".
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

// Recompute num_ctx recommendations for every Ollama model on a provider, one at a time (a handful of
// models, each a local calculation plus a local /api/show).
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
