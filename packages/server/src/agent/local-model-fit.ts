// ════════════════════════════════════════════════════════════════════════════
// v3.5 — A LOCAL MODEL THAT WILL NOT FIT IN THIS BOX'S MEMORY CANNOT BE SELECTED.
//
// OWNER RULING 2026-10-19: "if a user tries to select a local model for an agent or anything else
// that will not fit on the system's ram, don't let them select it. Pop up an error letting them know
// why. We already detect the system ram so let's use that info. If the user has enough ram open to
// fit the local model they are selecting then they can."
//
// The sibling of `main-model-floor.ts` (t202 D10), asked at the same doors. ASYNC because the sizes
// live in Ollama, not in this database: the weights from `/api/tags`, the per-token KV cost from
// `/api/show` — the same two reads the window recommendation makes (`services/num-ctx-calculator.ts`).
//
// open = total − the desktop reserve − the engine − the embedder − the Dojo's two models, by the
//        calculator's own reserves (`pickDesktopReserve`, `ENGINE_RESERVE_BYTES`); total is
//        `os.totalmem()` for a local Ollama and the owner's figure for a remote one, read exactly as
//        the calculator reads it (`resolveOllamaTotalRamBytes`).
// need = the model's weights + the KV cache of the calculator's smallest usable window
//        (`MIN_RECOMMENDED_NUM_CTX`). Other agents' local models are NOT subtracted: they take turns
//        through the Ollama queue, and counting them would refuse every second agent model.
//
// NOT REFUSED: a cloud model, `auto`, re-saving the model already in place, the Dojo's own two models
// (already counted), and anything whose size Ollama does not report right now — unknown is not refused.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import {
  pickDesktopReserve, ENGINE_RESERVE_BYTES, MIN_RECOMMENDED_NUM_CTX,
  resolveOllamaTotalRamBytes, fetchModelArchInfo,
} from '../services/num-ctx-calculator.js';
import { kvBytesPerTokenOf } from '../services/kv-bytes.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL, STANDARD_TAGS } from '../services/local-standard.js';

export interface FitVerdict { fits: boolean; message: string | null; openBytes: number; needBytes: number }

const GIB = 1024 ** 3;
/** Memory is spoken of the way the Mac speaks of it: a 16 GB box is 16 GiB. */
const gb = (bytes: number, digits = 1): string => (Math.max(0, bytes) / GIB).toFixed(digits);

interface Row { name: string; api_model_id: string; type: string; base_url: string | null; host_ram_gb: number | null }

function embedderName(): string {
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'embedding_config'").get() as { value: string } | undefined;
    return (row ? (JSON.parse(row.value) as { model?: string }).model : undefined) ?? 'nomic-embed-text';
  } catch {
    return 'nomic-embed-text';
  }
}

async function installedSizes(baseUrl: string): Promise<Map<string, number> | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { models?: Array<{ name: string; size?: number }> };
    return new Map((data.models ?? []).filter((m) => typeof m.size === 'number').map((m) => [m.name, m.size as number]));
  } catch {
    return null;
  }
}

/** Ollama lists an untagged pull as `name:latest`. */
const sizeOf = (sizes: Map<string, number>, name: string): number | undefined =>
  sizes.get(name) ?? (name.includes(':') ? undefined : sizes.get(`${name}:latest`));

/** The verdict for a local model, or null when it is not one this gate judges (see the header). */
export async function localModelFit(modelId: string): Promise<FitVerdict | null> {
  if (!modelId || modelId === 'auto' || modelId === '__auto__') return null;
  let row: Row | undefined;
  try {
    row = getDb().prepare(`SELECT m.name, m.api_model_id, p.type, p.base_url, p.host_ram_gb
      FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`).get(modelId) as Row | undefined;
  } catch { return null; }
  if (!row || row.type !== 'ollama' || STANDARD_TAGS.includes(row.api_model_id)) return null;
  const totalRamBytes = resolveOllamaTotalRamBytes(row.base_url, row.host_ram_gb);
  if (totalRamBytes === null) return null;
  const baseUrl = (row.base_url ?? 'http://localhost:11434').replace(/\/+$/, '');
  const sizes = await installedSizes(baseUrl);
  const weights = sizes ? sizeOf(sizes, row.api_model_id) : undefined;
  if (sizes === null || weights === undefined) return null;

  // The KV cache of the smallest window the calculator calls usable. An architecture Ollama does not
  // describe adds nothing: the weights alone are still a floor on what the model needs.
  const arch = await fetchModelArchInfo(baseUrl, row.api_model_id);
  const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
  const needBytes = weights + (typeof kv === 'number' ? kv * MIN_RECOMMENDED_NUM_CTX : 0);
  const openBytes = totalRamBytes - pickDesktopReserve(totalRamBytes) - ENGINE_RESERVE_BYTES
    - (sizeOf(sizes, embedderName()) ?? 0) - STANDARD_DECISION_MODEL.bytes - STANDARD_WRITER_MODEL.bytes;
  const fits = needBytes <= openBytes;
  return {
    fits, openBytes, needBytes,
    message: fits ? null
      : `${row.name} needs about ${gb(needBytes)} GB of memory. This box has ${gb(totalRamBytes, 0)} GB; after the desktop, `
        + `the engine, the embedder and the Dojo's own two models, about ${gb(openBytes)} GB is open. `
        + 'Choose a smaller local model or a cloud model.',
  };
}

/**
 * The refusal for SELECTING `modelId`, or null when it is fine. `currentModelId` is what the door holds
 * now: re-saving that same model is not a change and is never refused.
 */
export async function refuseUnfitLocalModel(
  modelId: string | null | undefined,
  currentModelId?: string | null,
): Promise<string | null> {
  if (!modelId || modelId === currentModelId) return null;
  return (await localModelFit(modelId))?.message ?? null;
}
