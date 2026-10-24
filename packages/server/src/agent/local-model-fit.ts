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
// open = total − the desktop reserve − the engine − (on the Dojo's own box) the embedder, the Dojo's two
//        models and the WRITER'S WORKING MEMORY (the KV of its largest job, `writerWorkingBytes`: fix
//        round 1 ruling, that room is set aside and never handed to an agent model). Total is
//        `os.totalmem()` locally and the owner's figure for a remote Ollama (`resolveOllamaTotalRamBytes`).
// need = the weights + the KV cache at the context the model will ACTUALLY run (fix round 1 ruling): for an
//        agent, its model window (`effectiveContextWindow`), never less than the 32K main-agent floor; for
//        an engine job (the summary writer, the voice opener, the vision fallback), the writer's largest
//        job window. Other agents' local models are not subtracted: they take turns through the lock.
//
// NEVER A CHOICE: the Dojo's DECISION model — it answers yes/no questions and cannot run an agent or a job.
// NOT JUDGED: a cloud model, `auto`, re-saving the model already in place, a remote Ollama with no RAM
// entered. CHECKED LATER (owner ruling, fix round 1): when Ollama is not answering or the model is not
// downloaded yet, the selection is ALLOWED, the owner is told in a plain sentence that the fit will be
// checked when the model first loads, and it IS checked then (`refuseUncheckedAtFirstLoad`).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import {
  pickDesktopReserve, ENGINE_RESERVE_BYTES, resolveOllamaTotalRamBytes, fetchModelArchInfo,
  isLocalOllamaBaseUrl,
} from '../services/num-ctx-calculator.js';
import { dojoWorkingBytes, writerJobWindowTokens, writerReservedWindowTokens } from '../services/dojo-working-memory.js';
import { kvBytesPerTokenOf } from '../services/kv-bytes.js';
import { localOllamaProvider, STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL, STANDARD_TAGS } from '../services/local-standard.js';
import { getOllamaLock } from '../services/ollama-lock.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';
import { MAIN_MODEL_MIN_WINDOW } from './main-model-floor.js';
import { ownerCardFrame } from '../services/owner-card-frames.js';
import { tellOwnerOnce, ownerConditionCleared, wordsOf, uncheckedFitWords } from '../healer/owner-notices.js';

/** What the model is being picked FOR: an agent's conversations, or one of the engine's own jobs. */
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

/** `/api/tags`, bounded like every other Ollama read of the Dojo's (5 s, `services/local-standard.ts`). */
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

/** The context it will actually run at, in tokens. */
async function contextFor(row: Row, use: ModelUse): Promise<number> {
  const configured = resolveNumCtx({ numCtxOverride: row.num_ctx_override, numCtxRecommended: row.num_ctx_recommended }).effective;
  if (use === 'job') return writerJobWindowTokens(configured ?? null);
  // The window the engine sends as `num_ctx` (override, else the recommendation), capped by the model's own; with
  // none, Ollama allocates its default and the agent still needs the 32K floor, so the floor is what it costs.
  const window = configured && row.context_window && row.context_window > 0 ? effectiveContextWindow(row.context_window, configured) : configured ?? 0;
  return Math.max(MAIN_MODEL_MIN_WINDOW, window);
}

/** The verdict for a local model, or null when it is not one this gate judges (see the header). */
export async function localModelFit(modelId: string, use: ModelUse = 'agent'): Promise<FitVerdict | null> {
  if (!modelId || modelId === 'auto' || modelId === '__auto__') return null;
  let row: Row | undefined;
  try {
    row = getDb().prepare(`SELECT m.name, m.api_model_id, m.capabilities, m.provider_id, p.type, p.base_url, p.host_ram_gb,
      m.context_window, m.num_ctx_override, m.num_ctx_recommended
      FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`).get(modelId) as Row | undefined;
  } catch { return null; }
  if (!row) return null;
  if (row.capabilities.includes('"decision"') || row.api_model_id === STANDARD_DECISION_MODEL.windowTag) {   // t268 (I-1): its window tag too
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
  const kvBytes = typeof kv === 'number' ? kv * contextTokens : 0;
  // The Dojo's own models live on the LOCAL Ollama: they are charged to that box only, measured when listed.
  const dojoBox = isLocalOllamaBaseUrl(row.base_url) && localOllamaProvider()?.id === row.provider_id;
  const pair = (sizes.get(STANDARD_DECISION_MODEL.tag) ?? STANDARD_DECISION_MODEL.bytes) + (sizes.get(STANDARD_WRITER_MODEL.tag) ?? STANDARD_WRITER_MODEL.bytes);
  // N1 (fix round 2): the Dojo's writer is never charged twice — its weights are counted in the pair and its
  // job's KV is the room set aside below, so its fit is only the KV it would need BEYOND that room.
  const isWriter = dojoBox && row.api_model_id === STANDARD_WRITER_MODEL.tag;
  // t268 (I-2): as an agent, beyond the room its jobs reserve now; as a job (the Summarization pick), beyond the room that pick reserves.
  const configured = resolveNumCtx({ numCtxOverride: row.num_ctx_override, numCtxRecommended: row.num_ctx_recommended }).effective ?? null;
  const writerJob = !isWriter ? 0 : use === 'job' ? await writerJobWindowTokens(configured) : await writerReservedWindowTokens(configured);
  const chargedKv = isWriter ? (typeof kv === 'number' ? kv * Math.max(0, contextTokens - writerJob) : 0) : kvBytes;
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

// ── CHECKED LATER: an unsized selection is marked, told once, and judged at its first load ──
// The mark is `healer_state` (scope `local_fit_unchecked`, key `<use>:<model id>`). Fix round 2: the owner's
// card is the persistent owner-notice card (`fitunchecked:<model id>`, re-derived from the marks on every
// dashboard load by `healerOwnerCards`), and it ends when the fit is checked.
const UNCHECKED_SCOPE = 'local_fit_unchecked';
export const fitUncheckedKey = (modelId: string): string => `fitunchecked:${modelId}`;

function markUnchecked(modelId: string, use: ModelUse): void {
  try {
    getDb().prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms`)
      .run(UNCHECKED_SCOPE, `${use}:${modelId}`, Date.now());
    if (tellOwnerOnce(fitUncheckedKey(modelId))) ownerCardFrame(wordsOf(fitUncheckedKey(modelId)), 'warning');
  } catch { /* best-effort: the first-load check still runs whenever the mark was written */ }
}

/**
 * The refusal for SELECTING `modelId`, or null when it may be saved. `currentModelId` is what the door
 * holds now: re-saving that same model is not a change and is never refused. `otherRefusal` is the door's
 * own next check (the 32K floor): asked AFTER the memory fit, so a refusal names the true reason, and
 * BEFORE an unsized model is marked, so nothing is told about a pick that is then refused (N7).
 */
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

/**
 * Called before a local model's call is dialled (`agent/model.ts`). A model selected while it could not be
 * sized is judged now, at the strictest use it was picked for (an agent pick is judged as an agent even
 * when the first call is a utility job: N8): it fits → the marks and the card go; it does not → the call
 * is refused with the plain sentence (and keeps being refused until another model is picked); still
 * unsizeable → it runs, still marked.
 */
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

/**
 * t268 fix round 2 (ruling): the window a job of the Dojo's writer that NO reserve holds (a fallback summary, when an
 * agent's own model cannot be reached) can have NOW on this box's Ollama — its reserved room plus the open memory the
 * fit computes, less the agent models the platform has loaded there (the lock's slots), at the writer's KV per
 * token. Null when it cannot be sized (then nothing is refused).
 */
export async function freeWriterWindowTokens(): Promise<number | null> {
  const provider = localOllamaProvider();
  const sizes = provider ? await installedSizes(provider.baseUrl) : null;
  const total = provider ? resolveOllamaTotalRamBytes(provider.baseUrl, null) : null;
  if (!provider || !sizes || total === null) return null;
  const arch = await fetchModelArchInfo(provider.baseUrl, STANDARD_WRITER_MODEL.tag);
  const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
  if (typeof kv !== 'number' || kv <= 0) return null;
  const pair = (sizes.get(STANDARD_DECISION_MODEL.tag) ?? STANDARD_DECISION_MODEL.bytes) + (sizes.get(STANDARD_WRITER_MODEL.tag) ?? STANDARD_WRITER_MODEL.bytes);
  const loaded = getOllamaLock().getStatus().slots.filter((s) => s.providerId === provider.id && !STANDARD_TAGS.includes(s.modelName))
    .reduce((n, s) => n + (sizeOf(sizes, s.modelName) ?? 0), 0);
  const open = total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - (sizeOf(sizes, embedderName()) ?? 0) - pair - await dojoWorkingBytes(provider.baseUrl) - loaded;
  return await writerReservedWindowTokens(null) + Math.max(0, Math.floor(open / kv));
}
