// A model under a 32K memory window cannot be an agent's MAIN model: the doors that set it refuse
// it plainly. Helper jobs untouched; unknown windows and the auto-router pass (unknown is not small).

import { getDb } from '../db/connection.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';
// The memory-fit gate rides every door this floor guards: exported here so each door asks both.
export { refuseUnfitLocalModel } from './local-model-fit.js';

/** The floor, in tokens. "32K" models are advertised as 32,000 or 32,768; both pass. */
export const MAIN_MODEL_MIN_WINDOW = 32_000;

interface WindowRow {
  name: string;
  context_window: number | null;
  num_ctx_override: number | null;
  num_ctx_recommended: number | null;
}

/** The window this model's calls are budgeted against (under `numCtxOverride` when given), or null when it declared none. */
export function windowOf(modelId: string, numCtxOverride?: number | null): { name: string; window: number } | null {
  if (modelId === 'auto' || modelId === '__auto__') return null;
  let row: WindowRow | undefined;
  try {
    row = getDb().prepare(
      'SELECT name, context_window, num_ctx_override, num_ctx_recommended FROM models WHERE id = ?',
    ).get(modelId) as WindowRow | undefined;
  } catch { return null; }
  if (!row) return null;
  const declared = row.context_window;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return null;
  const numCtx = resolveNumCtx({
    numCtxOverride: numCtxOverride === undefined ? row.num_ctx_override : numCtxOverride, numCtxRecommended: row.num_ctx_recommended,
  }).effective;
  return { name: row.name, window: effectiveContextWindow(declared, numCtx) };
}

function kLabel(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

export function smallMainModelMessage(name: string, window: number): string {
  return `${name} has a memory window of about ${kLabel(window)} tokens, which is too small for an agent's main model. `
    + 'An agent needs at least 32K to hold a conversation together with its tools and instructions. '
    + 'Choose a model with a bigger window for this agent; small models can still do helper jobs such as titles and summaries.';
}

/** The refusal for SETTING `modelId` as an agent's main model, or null when it is fine: re-saving
 *  the model the agent already runs is not a change and is never refused: agents keep working. */
export function refuseSmallMainModel(
  modelId: string | null | undefined,
  currentModelId?: string | null,
): string | null {
  if (!modelId || modelId === currentModelId) return null;
  const w = windowOf(modelId);
  if (!w || w.window >= MAIN_MODEL_MIN_WINDOW) return null;
  return smallMainModelMessage(w.name, w.window);
}

export function passesMainModelFloor(modelId: string, numCtxOverride?: number | null): boolean {
  const w = windowOf(modelId, numCtxOverride);
  return !w || w.window >= MAIN_MODEL_MIN_WINDOW;
}

/** Config keys picking a service agent's MAIN model; the settings route guards these before writing. */
export const MAIN_MODEL_SETTING_KEYS: readonly string[] = [
  'healer_model_id', 'dreaming_model_id', 'pm_agent_model', 'trainer_agent_model', 'imaginer_brain_model',
];

/** Config keys picking a LOCAL model the memory-fit gate judges: main models above plus the engine jobs. */
export const LOCAL_MODEL_SETTING_KEYS: readonly string[] = [...MAIN_MODEL_SETTING_KEYS, 'voice.opener_model', 'dojo_fallback_vision_model_id'];
