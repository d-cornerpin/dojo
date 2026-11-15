// A model under a 32K memory window cannot be an agent's MAIN model: the doors that set it refuse
// it plainly. Helper jobs untouched; unknown windows and the auto-router pass (unknown is not small).

import { getDb } from '../db/connection.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';
import { refuseUnfitLocalModel } from './local-model-fit.js';
import { createLogger } from '../logger.js';
const logger = createLogger('main-model-floor');

/** The floor, in tokens. "32K" models are advertised as 32,000 or 32,768; both pass. */
export const MAIN_MODEL_MIN_WINDOW = 32_000;

interface WindowRow {
  name: string;
  context_window: number | null;
  num_ctx_override: number | null;
  num_ctx_recommended: number | null;
}

/** The window this model's calls are budgeted against (under `numCtxOverride` when given) and `now`, under the
 *  stored override; null when it declared none. */
export function windowOf(modelId: string, numCtxOverride?: number | null): { name: string; window: number; now: number } | null {
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
  const under = (o: number | null): number => effectiveContextWindow(declared, resolveNumCtx({ numCtxOverride: o, numCtxRecommended: row.num_ctx_recommended }).effective);
  return { name: row.name, window: under(numCtxOverride === undefined ? row.num_ctx_override : numCtxOverride), now: under(row.num_ctx_override) };
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
  numCtxOverride?: number | null,
): string | null {
  if (!modelId || modelId === currentModelId) return null;
  const w = windowOf(modelId, numCtxOverride);
  if (!w || w.window >= MAIN_MODEL_MIN_WINDOW) return null;
  return smallMainModelMessage(w.name, w.window);
}

/** THE door check for choosing a model for an agent: memory fit first (so a refusal names the true reason), then the
 *  floor. Null means the model may be set. Every route, tool and spawn that picks an agent's model asks this. */
export async function refuseAgentModel(modelId: string | null | undefined, currentModelId?: string | null): Promise<string | null> {
  return refuseUnfitLocalModel(modelId, currentModelId, 'agent', () => refuseSmallMainModel(modelId, currentModelId));
}

/** The one pick for "this agent needs another model": cheapest enabled text model outside `exclude` that clears the floor. */
export function cheapestAgentModel(exclude: readonly string[] = []): string | null {
  const rows = getDb().prepare(
    `SELECT id FROM models WHERE is_enabled = 1 AND id NOT IN (${exclude.map(() => '?').join(',')}) AND capabilities NOT LIKE '%generation%' AND capabilities NOT LIKE '%embedding%' AND capabilities NOT LIKE '%"decision"%' ORDER BY input_cost_per_m ASC, id ASC`,
  ).all(...exclude) as Array<{ id: string }>;
  return rows.find((m) => refuseSmallMainModel(m.id) === null)?.id ?? null;
}

/** The model a service agent is created or reactivated on: its setting, else the main agent's. One under the floor
 *  is replaced by the cheapest model that clears it ('auto' when none does), so it never starts on a small model. */
export function serviceAgentModelId(settingKey: string, primaryId: string): string | null {
  const db = getDb();
  const picked = (db.prepare('SELECT value FROM config WHERE key = ?').get(settingKey) as { value: string } | undefined)?.value
    || (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined)?.model_id || null;
  if (!picked || !refuseSmallMainModel(picked)) return picked;
  const replacement = cheapestAgentModel([picked, 'auto']) ?? 'auto';
  logger.warn('A service agent\'s model is under the 32K floor; replaced', { settingKey, from: picked, to: replacement });
  return replacement;
}

export function passesMainModelFloor(modelId: string): boolean { return refuseSmallMainModel(modelId) === null; }

/** Config keys picking a service agent's MAIN model; the settings route guards these before writing. */
export const MAIN_MODEL_SETTING_KEYS: readonly string[] = [
  'healer_model_id', 'dreaming_model_id', 'pm_agent_model', 'trainer_agent_model',
];

/** Config keys picking a LOCAL model the memory-fit gate judges: main models above plus the engine jobs. */
export const LOCAL_MODEL_SETTING_KEYS: readonly string[] = [...MAIN_MODEL_SETTING_KEYS, 'voice.opener_model', 'dojo_fallback_vision_model_id'];
