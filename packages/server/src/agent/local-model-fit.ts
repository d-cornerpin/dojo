// A local model that cannot fit this box's memory cannot be selected: the doors refuse it with a
// plain error. Sibling of `main-model-floor.ts`; ASYNC because the sizes live in Ollama, not here.
// open = total minus desktop/engine reserves and, on the Dojo's own box, the embedder, its two
// models and the writer's working memory; need = weights + KV at the window it actually runs.
// Never a choice: the decision model. Unsizable now: allowed, told, and checked at its first load.

import { getDb } from '../db/connection.js';
import {
  pickDesktopReserve, ENGINE_RESERVE_BYTES, resolveOllamaTotalRamBytes, fetchModelArchInfo,
  isLocalOllamaBaseUrl,
} from '../services/num-ctx-calculator.js';
import { dojoWorkingBytes, writerJobWindowTokens, writerReservedWindowTokens } from '../services/dojo-working-memory.js';
import { kvBytesPerTokenOf } from '../services/kv-bytes.js';
import { localOllamaProvider, STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL, STANDARD_TAGS } from '../services/local-standard.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';
import { MAIN_MODEL_MIN_WINDOW } from './main-model-floor.js';
import { tellOwner, ownerConditionCleared, wordsOf, uncheckedFitWords } from '../healer/owner-notices.js';

export type ModelUse = 'agent' | 'job';
export interface FitVerdict {
  fits: boolean; message: string | null; openBytes: number; needBytes: number; contextTokens: number;
  /** Ollama could not size it now: allowed, and checked when it first loads. */
  unchecked?: true;
}

/** Sizes are spoken the way Ollama lists them: decimal GB. A box's RAM the way the Mac does (16 GB). */
const gb = (bytes: number): string => (Math.max(0, bytes) / 1e9).toFixed(1);
const macGb = (bytes: number): string => `${Math.round(bytes / 1024 ** 3)}`;
const kTokens = (t: number): string => `${Math.round(t / 1000)}K`;   // as the 32K floor's own sentence counts

export const decisionModelWords = (name: string): string =>
  `${name} is the Dojo's decision model: it answers the Dojo's own yes/no questions and cannot run an agent or write. Choose another model.`;
interface Row {
  name: string; api_model_id: string; capabilities: string; provider_id: string; type: string; base_url: string | null;
  host_ram_gb: number | null; context_window: number | null; num_ctx_override: number | null; num_ctx_recommended: number | null;
}

function embedderName(): string {
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'embedding_config'").get() as { value: string } | undefined;
    return (row ? (JSON.parse(row.value) as { model?: string }).model : undefined) ?? 'nomic-embed-text';
  } catch {
    return 'nomic-embed-text';
  }
}

/** `/api/tags` lists each model's file size; `/api/ps` each LOADED model and what it really
 *  holds now (weights plus its load-window KV, Ollama's figure). Both list `{ name, size }`. */
async function installedSizes(baseUrl: string, list: '/api/tags' | '/api/ps' = '/api/tags'): Promise<Map<string, number> | null> {
  try {
    const resp = await fetch(`${baseUrl}${list}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { models?: Array<{ name: string; size?: number }> };
    if (list === '/api/ps' && (data.models ?? []).some((m) => typeof m.size !== 'number')) return null;   // a loaded size unread is unknown, never 0
    return new Map((data.models ?? []).filter((m) => typeof m.size === 'number').map((m) => [m.name, m.size as number]));
  } catch {
    return null;
  }
}

/** Ollama lists an untagged pull as `name:latest`. */
const sizeOf = (sizes: Map<string, number>, name: string): number | undefined =>
  sizes.get(name) ?? (name.includes(':') ? undefined : sizes.get(`${name}:latest`));

async function contextFor(row: Row, use: ModelUse): Promise<number> {
  const configured = resolveNumCtx({ numCtxOverride: row.num_ctx_override, numCtxRecommended: row.num_ctx_recommended }).effective;
  if (use === 'job') return writerJobWindowTokens(configured ?? null);
  // The engine sends `num_ctx` = override, else the recommendation, capped by the model's own window;
  // with none configured, Ollama's default still owes the 32K floor, so the floor is what it costs.
  const window = configured && row.context_window && row.context_window > 0 ? effectiveContextWindow(row.context_window, configured) : configured ?? 0;
  return Math.max(MAIN_MODEL_MIN_WINDOW, window);
}

/** The verdict, or null when this gate does not judge it: cloud, `auto`, unknown row, no RAM entered. */
export async function localModelFit(modelId: string, use: ModelUse = 'agent'): Promise<FitVerdict | null> {
  if (!modelId || modelId === 'auto' || modelId === '__auto__') return null;
  let row: Row | undefined;
  try {
    row = getDb().prepare(`SELECT m.name, m.api_model_id, m.capabilities, m.provider_id, p.type, p.base_url, p.host_ram_gb,
      m.context_window, m.num_ctx_override, m.num_ctx_recommended
      FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`).get(modelId) as Row | undefined;
  } catch { return null; }
  if (!row) return null;
  if (row.capabilities.includes('"decision"') || row.api_model_id === STANDARD_DECISION_MODEL.windowTag) {   // its window tag too
    return { fits: false, message: decisionModelWords(row.name), openBytes: 0, needBytes: 0, contextTokens: 0 };
  }
  if (row.type !== 'ollama') return null;
  const totalRamBytes = resolveOllamaTotalRamBytes(row.base_url, row.host_ram_gb);
  if (totalRamBytes === null) return null;
  const baseUrl = (row.base_url ?? 'http://localhost:11434').replace(/\/+$/, '');
  const contextTokens = await contextFor(row, use);
  const unchecked = (): FitVerdict =>
    ({ fits: true, unchecked: true, message: uncheckedFitWords(row!.name), openBytes: 0, needBytes: 0, contextTokens });
  const sizes = await installedSizes(baseUrl);
  if (sizes === null) return unchecked();   // Ollama is not answering
  const weights = sizeOf(sizes, row.api_model_id);
  if (weights === undefined) return unchecked();   // the model is not downloaded yet

  const arch = await fetchModelArchInfo(baseUrl, row.api_model_id);
  const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
  // Unknown working memory (unread `/api/show`, missing fields) is never charged as 0: unchecked.
  if (typeof kv !== 'number') return unchecked();
  const kvBytes = kv * contextTokens;
  // The Dojo's own models live on the LOCAL Ollama: they are charged to that box only, measured when listed.
  const dojoBox = isLocalOllamaBaseUrl(row.base_url) && localOllamaProvider()?.id === row.provider_id;
  const pair = (sizes.get(STANDARD_DECISION_MODEL.tag) ?? STANDARD_DECISION_MODEL.bytes) + (sizes.get(STANDARD_WRITER_MODEL.tag) ?? STANDARD_WRITER_MODEL.bytes);
  // The writer is never charged twice: its weights are in the pair, its job KV is the room set aside.
  const isWriter = dojoBox && row.api_model_id === STANDARD_WRITER_MODEL.tag;
  const configured = resolveNumCtx({ numCtxOverride: row.num_ctx_override, numCtxRecommended: row.num_ctx_recommended }).effective ?? null;
  const writerJob = !isWriter ? 0 : use === 'job' ? await writerJobWindowTokens(configured) : await writerReservedWindowTokens(configured);
  const chargedKv = isWriter ? kv * Math.max(0, contextTokens - writerJob) : kvBytes;
  const needBytes = (isWriter ? 0 : weights) + chargedKv;
  const openBytes = totalRamBytes - pickDesktopReserve(totalRamBytes) - ENGINE_RESERVE_BYTES
    - (dojoBox ? (sizeOf(sizes, embedderName()) ?? 0) + pair + await dojoWorkingBytes(baseUrl) : 0);
  const fits = needBytes <= Math.max(0, openBytes);   // nothing more needed (the writer at its own jobs) always fits
  return {
    fits, openBytes, needBytes, contextTokens,
    message: fits ? null
      : `${row.name} needs about ${gb(needBytes)} GB of memory to run with its ${kTokens(contextTokens)}-token window `
        + `(${gb(isWriter ? 0 : weights)} GB of weights and ${gb(chargedKv)} GB of working memory). This box has ${macGb(totalRamBytes)} GB; `
        + (dojoBox
          ? `after the desktop, the engine, the embedder, the Dojo's own two models and the working memory they keep for summaries, about ${gb(openBytes)} GB is open. `
          : `after the desktop and the engine, about ${gb(openBytes)} GB is open. `)
        + 'Choose a smaller local model or a cloud model.',
  };
}

// CHECKED LATER: an unsized selection is marked in `healer_state` (scope `local_fit_unchecked`,
// key `<use>:<model id>`); the owner's card is `fitunchecked:<model id>`, ended when the fit is checked.
const UNCHECKED_SCOPE = 'local_fit_unchecked';
export const fitUncheckedKey = (modelId: string): string => `fitunchecked:${modelId}`;

function markUnchecked(modelId: string, use: ModelUse): void {
  try {
    getDb().prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms`)
      .run(UNCHECKED_SCOPE, `${use}:${modelId}`, Date.now());
    tellOwner(fitUncheckedKey(modelId), wordsOf(fitUncheckedKey(modelId)));   // checked at first load by itself
  } catch { /* best-effort: the first-load check still runs whenever the mark was written */ }
}

/** The refusal for SELECTING `modelId`, or null when it may be saved: re-saving what the door
 *  already holds is not a change. `otherRefusal` (the 32K floor) comes AFTER the fit and BEFORE
 *  marking: the refusal names the true reason, nothing is told about a pick that is refused. */
export async function refuseUnfitLocalModel(
  modelId: string | null | undefined,
  currentModelId?: string | null,
  use: ModelUse = 'agent',
  otherRefusal?: () => string | null,
): Promise<string | null> {
  if (!modelId || modelId === currentModelId) return null;
  const v = await localModelFit(modelId, use);
  if (v && !v.unchecked && !v.fits) return v.message;
  const other = otherRefusal?.() ?? null;
  if (other) return other;
  if (v?.unchecked) markUnchecked(modelId, use);
  return null;
}

/** Called before a local model's call is dialled (`agent/model.ts`): a model picked while unsized
 *  is judged now at its strictest picked use. Fits: marks and card go; unfit: the call is refused;
 *  still unsizable: it runs, still marked. */
export async function refuseUncheckedAtFirstLoad(modelId: string): Promise<void> {
  let uses: ModelUse[] = [];
  try {
    uses = (getDb().prepare('SELECT key FROM healer_state WHERE scope = ? AND key IN (?, ?)').all(UNCHECKED_SCOPE, `agent:${modelId}`, `job:${modelId}`) as Array<{ key: string }>)
      .map((r) => r.key.split(':')[0] as ModelUse);
  } catch { return; }
  if (uses.length === 0) return;
  const v = await localModelFit(modelId, uses.includes('agent') ? 'agent' : 'job');
  if (!v || v.unchecked) return;
  ownerConditionCleared(fitUncheckedKey(modelId));   // checked now: the card leaves every dashboard
  if (v.fits) { getDb().prepare('DELETE FROM healer_state WHERE scope = ? AND key IN (?, ?)').run(UNCHECKED_SCOPE, `agent:${modelId}`, `job:${modelId}`); return; }
  throw new Error(v.message ?? 'This model does not fit in this box\'s memory.');
}

/** The window a reserve-less writer job (a fallback summary when the agent's model is unreachable)
 *  can have now: its reserved room plus the open memory, less what other loaded models really hold
 *  (loaded size, their KV included, never weights alone). Null: UNKNOWN, writer never admitted. */
export async function freeWriterWindowTokens(): Promise<number | null> {
  const provider = localOllamaProvider();
  const sizes = provider ? await installedSizes(provider.baseUrl) : null;
  const loadedNow = provider ? await installedSizes(provider.baseUrl, '/api/ps') : null;
  const total = provider ? resolveOllamaTotalRamBytes(provider.baseUrl, null) : null;
  if (!provider || !sizes || !loadedNow || total === null) return null;
  const arch = await fetchModelArchInfo(provider.baseUrl, STANDARD_WRITER_MODEL.tag);
  const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
  if (typeof kv !== 'number' || kv <= 0) return null;
  const pair = (sizes.get(STANDARD_DECISION_MODEL.tag) ?? STANDARD_DECISION_MODEL.bytes) + (sizes.get(STANDARD_WRITER_MODEL.tag) ?? STANDARD_WRITER_MODEL.bytes);
  const embedder = embedderName();
  const counted = new Set([...STANDARD_TAGS, STANDARD_DECISION_MODEL.windowTag, embedder, embedder.includes(':') ? embedder : `${embedder}:latest`]);
  const loaded = [...loadedNow].filter(([name]) => !counted.has(name)).reduce((n, [, bytes]) => n + bytes, 0);
  const open = total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - (sizeOf(sizes, embedder) ?? 0) - pair - await dojoWorkingBytes(provider.baseUrl) - loaded;
  return await writerReservedWindowTokens(null) + Math.max(0, Math.floor(open / kv));
}
