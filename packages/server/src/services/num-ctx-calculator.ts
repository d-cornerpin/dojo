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

/**
 * ⚠ THE RAM-RECOMMENDATION AUDIT (t88 capture-3). THIS FORMULA RECOMMENDED A 28,672-TOKEN WINDOW FOR
 * A 4B UTILITY MODEL ON A 16 GB DESKTOP MACHINE, and the result was measured: the runtime loaded at
 * 5.4 GB resident, system wired memory went 1.3 GB → 6.4 GB, free pages collapsed to ~60 MB, and the
 * whole machine — WindowServer, screen sharing, a browser — stopped responding for the keep-alive
 * window with no agent doing anything.
 *
 * WHAT IT GOT WRONG, and it is one sentence: IT BUDGETED AGAINST INSTALLED RAM AND THIS MODEL'S
 * WEIGHTS, as though the box had nothing else to do. On that 16 GB box the old arithmetic was
 * `16 - 4 (headroom) - 2.5 (weights) = 9.5 GiB available for KV cache`, which for a small model's
 * ~90 KiB/token comes out larger than the model's own maximum — so the recommendation became "give it
 * everything the architecture allows". Meanwhile the real box was running a desktop session, a
 * browser, the engine itself, and an embedding model that Ollama keeps resident.
 *
 * ⚠ AND THE 12.5% WAS NEVER THE POLICY ON A SMALL BOX. 12.5% of 16 GiB is 2 GiB, below the 4 GiB
 * floor, so the floor WAS the answer for every box up to 32 GiB — and 4 GiB is simply not what macOS
 * plus a browser needs. The percentage only did anything on machines that were never at risk.
 *
 * SO THE BUDGET IS NOW AGAINST THE BOX'S OBLIGATIONS, each one named and each one a reserve this
 * process can state a reason for. A recommendation is a promise that the box can still work while the
 * model is loaded; it has to be made against everything else that has to keep working.
 */
export interface ObligationsInput {
  readonly totalRamBytes: number;
  /** The weights of the model being sized. */
  readonly weightsBytes: number;
  /**
   * The weights of OTHER local models this box keeps resident — the embedder above all, which is
   * loaded for the life of the process on any box using memory search. Ollama's `keep_alive` means
   * "resident", so two models each sized as if alone will both be resident and the sum is what the
   * machine actually holds.
   */
  readonly otherResidentWeightsBytes: number;
}

/**
 * The desktop session's reserve. ⚠ A FLOOR OF 6 GiB, not 4, and the number comes from the incident
 * rather than from taste: when the 4b model held 5.4 GB on a 16 GB box, free pages were ~60 MB — so
 * everything else on that machine wanted roughly 10 GB and had been promised 4. macOS with a browser
 * and a screen-sharing session is a multi-gigabyte obligation, and a recommendation that pretends
 * otherwise is how a "recommended" value takes a machine down.
 *
 * 30% of installed RAM above the floor, because a bigger box runs bigger other things, capped at
 * 12 GiB so a 128 GB workstation is not told to hold back 38.
 */
export function pickDesktopReserve(totalRamBytes: number): number {
  const proportional = Math.floor(totalRamBytes * 0.30);
  return Math.max(6 * GIB, Math.min(12 * GIB, proportional));
}

/** The engine's own process: node, the SQLite page cache, the embedder's client, the browser driver. */
export const ENGINE_RESERVE_BYTES = Math.floor(1.5 * GIB);

/**
 * How many bytes this model's KV cache may have, after everything the box owes elsewhere.
 * Negative means "this model cannot be loaded here with any window worth having" — the caller turns
 * that into the floor rather than into silence (see `computeRecommendedNumCtx`).
 *
 * Named for what it answers rather than for the field it feeds: the result object's own
 * `availableForKvBytes` reports the number, and two identifiers with one name is how a shorthand
 * property silently picked up a function instead of a value while I wrote this.
 */
export function kvBudgetBytes(input: ObligationsInput): number {
  return input.totalRamBytes
    - pickDesktopReserve(input.totalRamBytes)
    - ENGINE_RESERVE_BYTES
    - Math.max(0, input.otherResidentWeightsBytes)
    - Math.max(0, input.weightsBytes);
}

function pickHeadroom(totalRamBytes: number): number {
  // Kept as the OLD arithmetic for the one thing it is still good for: reporting what the previous
  // policy would have said, so a box's log can show both numbers during the v3.3 rollout. Nothing
  // downstream decides on it any more — `availableForKvBytes` is the policy.
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
 * Read from what the platform has registered rather than from what is loaded this second: a
 * recommendation is a steady-state promise, and the embedder in particular is resident whenever
 * memory search is on.
 *
 * Best-effort by construction — a box whose model table cannot be read gets a zero here and still
 * gets the desktop and engine reserves, which are the two that matter most on a small machine.
 */
export function otherResidentWeights(
  thisApiModelId: string,
  installed: ReadonlyArray<{ name: string; size: number }>,
  enabledApiModelIds: ReadonlyArray<string>,
): number {
  // ⚠ THE SIZES COME FROM THE RUNTIME'S OWN `/api/tags`, NOT FROM A COLUMN. My first version read
  // `models.weights_bytes` — a column that does not exist — inside a try/catch, so this reserve would
  // have been a silent zero forever: an unfalsifiable term that looks like diligence and does nothing.
  // The tags response is already fetched for this model's own weights, so the other models' sizes are
  // in hand at no extra cost.
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
    // Best-effort: a box whose model table cannot be read still gets the desktop and engine reserves,
    // which are the two that matter most on a small machine.
    return [];
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
  // ⚠ THE OBLIGATIONS BUDGET, not installed RAM minus this model. See `kvBudgetBytes`.
  const otherResidentWeightsBytes = otherResidentWeights(
    apiModelId, installed, enabledOllamaApiModelIds(),
  );
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
    // What the previous policy would have said, so a rollout can see both numbers on one line.
    previousPolicyAvailableGiB: +((totalRamBytes - headroomBytes - weightsBytes) / GIB).toFixed(1),
  });

  if (availableBytes <= 0) {
    // ⚠ FAIL CLOSED, AND THIS IS A CHANGE OF DIRECTION. Returning a failure here used to leave
    // `num_ctx_recommended` NULL, and a NULL means the runtime sends no `num_ctx` at all — so Ollama
    // falls back to the Modelfile's own default, which on a modern small model is its full trained
    // context. "This box is too tight to size a window" must not resolve to "take everything": the
    // tightest box is exactly where that is most dangerous. The floor is the answer instead.
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
  // Model's advertised max context, if present. Clamp so we never
  // recommend more than the model actually supports.
  const modelMaxContext = typeof modelContextRaw === 'number' ? modelContextRaw : MAX_RECOMMENDED_NUM_CTX;
  const capped = Math.min(rawNumCtx, modelMaxContext, MAX_RECOMMENDED_NUM_CTX);

  if (capped < MIN_RECOMMENDED_NUM_CTX) {
    // Same fail-closed direction as above: a window too small to be useful is still a BOUND, and a
    // bound is what protects the machine. Recommending the floor says "this is tight" in a way the
    // runtime can act on; recommending nothing says "unlimited".
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
    availableForKvBytes: availableBytes,
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
