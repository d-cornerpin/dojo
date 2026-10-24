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
  isLocalOllamaBaseUrl, writerWorkingBytes, writerJobWindowTokens,
} from '../services/num-ctx-calculator.js';
import { kvBytesPerTokenOf } from '../services/kv-bytes.js';
import { localOllamaProvider, STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../services/local-standard.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';
import { MAIN_MODEL_MIN_WINDOW } from './main-model-floor.js';
import { ownerCardFrame, ownerCardEnded } from '../services/owner-card-frames.js';

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
export const uncheckedFitWords = (name: string, why: string): string =>
  `${name} was selected, but its memory fit could not be checked now (${why}). It will be checked when the model first loads, and refused then if it does not fit this box's memory.`;

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
  if (row.capabilities.includes('"decision"')) {
    return { fits: false, message: decisionModelWords(row.name), openBytes: 0, needBytes: 0, contextTokens: 0 };
  }
  if (row.type !== 'ollama') return null;
  const totalRamBytes = resolveOllamaTotalRamBytes(row.base_url, row.host_ram_gb);
  if (totalRamBytes === null) return null;
  const baseUrl = (row.base_url ?? 'http://localhost:11434').replace(/\/+$/, '');
  const contextTokens = await contextFor(row, use);
  const unchecked = (why: string): FitVerdict =>
    ({ fits: true, unchecked: true, message: uncheckedFitWords(row!.name, why), openBytes: 0, needBytes: 0, contextTokens });
  const sizes = await installedSizes(baseUrl);
  if (sizes === null) return unchecked('Ollama is not answering');
  const weights = sizeOf(sizes, row.api_model_id);
  if (weights === undefined) return unchecked('the model is not downloaded yet');

  const arch = await fetchModelArchInfo(baseUrl, row.api_model_id);
  const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
  const kvBytes = typeof kv === 'number' ? kv * contextTokens : 0;
  // The Dojo's own models live on the LOCAL Ollama: they are charged to that box only, measured when listed.
  const dojoBox = isLocalOllamaBaseUrl(row.base_url) && localOllamaProvider()?.id === row.provider_id;
  const pair = (sizes.get(STANDARD_DECISION_MODEL.tag) ?? STANDARD_DECISION_MODEL.bytes) + (sizes.get(STANDARD_WRITER_MODEL.tag) ?? STANDARD_WRITER_MODEL.bytes);
  const isWriter = dojoBox && row.api_model_id === STANDARD_WRITER_MODEL.tag;   // its weights are already counted
  const needBytes = (isWriter ? 0 : weights) + kvBytes;
  const openBytes = totalRamBytes - pickDesktopReserve(totalRamBytes) - ENGINE_RESERVE_BYTES
    - (dojoBox ? (sizeOf(sizes, embedderName()) ?? 0) + pair + await writerWorkingBytes(baseUrl) : 0);
  const fits = needBytes <= openBytes;
  return {
    fits, openBytes, needBytes, contextTokens,
    message: fits ? null
      : `${row.name} needs about ${gb(needBytes)} GB of memory to run with its ${kTokens(contextTokens)}-token window `
        + `(${gb(isWriter ? 0 : weights)} GB of weights and ${gb(kvBytes)} GB of working memory). This box has ${macGb(totalRamBytes)} GB; `
        + (dojoBox
          ? `after the desktop, the engine, the embedder, the Dojo's own two models and the working memory its writer keeps for summaries, about ${gb(openBytes)} GB is open. `
          : `after the desktop and the engine, about ${gb(openBytes)} GB is open. `)
        + 'Choose a smaller local model or a cloud model.',
  };
}

// ── CHECKED LATER: an unsized selection is marked, told once, and judged at its first load ──
const UNCHECKED_SCOPE = 'local_fit_unchecked';

function markUnchecked(modelId: string, words: string): void {
  try {
    const db = getDb();
    const had = db.prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get(UNCHECKED_SCOPE, modelId);
    db.prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms`)
      .run(UNCHECKED_SCOPE, modelId, Date.now());
    if (!had) ownerCardFrame(words, 'warning');   // the existing owner card, once per unchecked model
  } catch { /* best-effort: the first-load check still runs whenever the mark was written */ }
}

/**
 * The refusal for SELECTING `modelId`, or null when it may be saved. `currentModelId` is what the door
 * holds now: re-saving that same model is not a change and is never refused. An unsized model is allowed
 * and marked for its first load (the owner is told why, once).
 */
export async function refuseUnfitLocalModel(
  modelId: string | null | undefined,
  currentModelId?: string | null,
  use: ModelUse = 'agent',
): Promise<string | null> {
  if (!modelId || modelId === currentModelId) return null;
  const v = await localModelFit(modelId, use);
  if (!v) return null;
  if (v.unchecked) { markUnchecked(modelId, v.message as string); return null; }
  return v.fits ? null : v.message;
}

/**
 * Called before a local model's call is dialled (`agent/model.ts`). A model selected while it could not be
 * sized is judged now: it fits → the mark and its card go; it does not → the call is refused with the plain
 * sentence (and keeps being refused until another model is picked); still unsizeable → it runs, still marked.
 */
export async function refuseUncheckedAtFirstLoad(modelId: string, use: ModelUse): Promise<void> {
  let marked = false;
  try { marked = !!getDb().prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get(UNCHECKED_SCOPE, modelId); } catch { return; }
  if (!marked) return;
  const v = await localModelFit(modelId, use);
  if (!v || v.unchecked) return;
  const name = (getDb().prepare('SELECT name FROM models WHERE id = ?').get(modelId) as { name: string } | undefined)?.name ?? modelId;
  ownerCardEnded(uncheckedFitWords(name, 'Ollama is not answering'));
  ownerCardEnded(uncheckedFitWords(name, 'the model is not downloaded yet'));
  if (v.fits) { getDb().prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?').run(UNCHECKED_SCOPE, modelId); return; }
  throw new Error(v.message ?? `${name} does not fit in this box's memory.`);
}
